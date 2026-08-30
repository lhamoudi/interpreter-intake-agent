/**
 * The conversational core: a Claude tool-use loop that runs once per caller turn.
 *
 * Called from TAC's `onMessageReady` with the caller's transcribed utterance.
 * Returns the words to speak back. State for the in-flight call lives in an
 * explicit in-process store keyed by conversationId — deliberately simple, and
 * correct on a single always-on instance. The scale path (per-call actor so any
 * node can serve any socket) is documented in the README, not built here.
 */

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { createLogger, maskPhone, type VoiceChannel, type ConversationId } from 'twilio-agent-connect';
import { TOOLS } from './tools.js';
import { switchLanguage, isSupported } from './language.js';
import {
  type IntakeRecord,
  checkComplete,
  mergeIntake,
  summarize,
} from './intake.js';
import {
  hashCaller,
  getCallerMemory,
  rememberCaller,
  saveRequest,
  type CallerMemory,
} from './memory.js';

const MODEL = 'claude-haiku-4-5';

const anthropic = new Anthropic();
const log = createLogger({ name: 'agent' });

/** Everything we hold for one live call. */
interface CallState {
  history: Anthropic.MessageParam[];
  intake: IntakeRecord;
  callerHash: string | null;
  callerAddress: string | null;
  memory: CallerMemory | null;
  handoffDone: boolean;
  persisted: boolean;
}

const calls = new Map<string, CallState>();

function baseSystemPrompt(): string {
  return [
    'You are the intake voice agent for an over-the-phone interpretation service.',
    'A caller needs a human interpreter. Your job is to warmly and efficiently collect',
    'the details needed to secure the right interpreter, then hand off to a human.',
    '',
    'Collect, working the questions naturally into the conversation (never a rigid checklist):',
    '  - the language they speak, and the language they need it interpreted to (usually English)',
    '  - whether they prefer a male or female interpreter, or have no preference',
    '  - whether they need someone right now or are scheduling for later',
    '  - the best callback number',
    '  - optionally the subject area (medical, legal, community) and anything else that matters',
    '',
    'Rules:',
    '  - Call record_intake as soon as you learn each detail — do not wait until the end.',
    '  - If the caller is clearly more comfortable in another language, call set_language.',
    '  - Handle "I don\'t know yet", interruptions, and corrections gracefully.',
    '  - Confirm the collected details back before you finish.',
    '  - When you have everything, call request_handoff. If it reports missing fields, ask for them.',
    '  - You are speaking aloud. No markdown, asterisks, bullets, or emojis. Keep replies to a',
    '    sentence or two, plain and calm.',
    '  - Always finish your turn with something spoken to the caller — even a brief acknowledgement —',
    '    whether or not you also call a tool along the way. The caller cannot see tool calls, only',
    '    hear you, so a turn that ends in silence sounds like the line went dead.',
    '  - When you read a phone number back, speak it in natural groups — area code, then three digits,',
    '    then four — with a brief pause between groups, the way a person reads a number aloud. Drop a',
    '    leading US country code ("+1") entirely; do not read it as "one".',
  ].join('\n');
}

/**
 * Surface the live caller-ID number so Claude can resolve "use the number I'm
 * calling from" (or default to it without being asked to confirm nothing else
 * fits). Without this the model has no idea what number that phrase refers to —
 * the exact gap a real test call exposed.
 */
function callerAddressPreamble(callerAddress: string | null): string {
  if (!callerAddress) return '';
  return (
    `\n\nThe number this caller is dialing in from (their caller ID) is ${callerAddress}. ` +
    'If they ask you to use the number they\'re calling from, or don\'t volunteer a different ' +
    'callback number, use this one — call record_intake with it and confirm it back to them ' +
    'as you would any other detail.'
  );
}

function memoryPreamble(memory: CallerMemory | null): string {
  if (!memory || memory.callCount === 0) return '';
  const known = [
    memory.sourceLanguage && `they usually need ${memory.sourceLanguage}`,
    memory.genderPreference &&
      memory.genderPreference !== 'no_preference' &&
      `they prefer a ${memory.genderPreference} interpreter`,
    memory.industry && `often ${memory.industry}`,
    memory.callbackNumber && `their usual callback number is ${memory.callbackNumber}`,
  ].filter(Boolean);
  if (known.length === 0) return '';
  return (
    '\n\nThis is a returning caller. From previous calls: ' +
    known.join('; ') +
    '. Greet them as a returning caller, confirm rather than re-ask what you already know, ' +
    'and only fill the gaps.'
  );
}

/** Look up returning-caller memory and seed the intake with what we know. */
export async function initCall(conversationId: string, callerAddress: string | undefined): Promise<void> {
  if (calls.has(conversationId)) return;
  const callerHash = hashCaller(callerAddress);
  let memory: CallerMemory | null = null;
  try {
    memory = await getCallerMemory(callerHash);
  } catch (err) {
    log.error({ conversationId, err }, 'memory lookup failed');
  }
  log.info(
    { conversationId, returningCaller: Boolean(memory && memory.callCount > 0) },
    'call started',
  );
  const seed: IntakeRecord = memory
    ? {
        sourceLanguage: memory.sourceLanguage,
        targetLanguage: memory.targetLanguage,
        genderPreference: memory.genderPreference as IntakeRecord['genderPreference'],
        industry: memory.industry as IntakeRecord['industry'],
        callbackNumber: memory.callbackNumber,
      }
    : {};
  calls.set(conversationId, {
    history: [],
    intake: seed,
    callerHash,
    callerAddress: callerAddress ?? null,
    memory,
    handoffDone: false,
    persisted: false,
  });
}

interface Deps {
  voice: VoiceChannel;
  conversationId: ConversationId;
}

/** Run one caller turn. Returns the text to speak back. */
export async function runAgent(userMessage: string, deps: Deps): Promise<string> {
  const convId = deps.conversationId as string;
  if (!calls.has(convId)) await initCall(convId, undefined);
  const state = calls.get(convId)!;

  state.history.push({ role: 'user', content: userMessage });

  const system =
    baseSystemPrompt() + callerAddressPreamble(state.callerAddress) + memoryPreamble(state.memory);

  // Tool loop: Claude may speak AND call a tool in the same hop (a text block
  // alongside tool_use blocks) — that spoken text must not be dropped just
  // because the turn isn't done yet. Accumulate text across every hop and
  // return it all once the turn ends, rather than only reading the final hop.
  const spoken: string[] = [];
  for (let hop = 0; hop < 6; hop++) {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: TOOLS,
      messages: state.history,
    });

    state.history.push({ role: 'assistant', content: res.content });

    const text = textOf(res.content);
    if (text) spoken.push(text);

    if (res.stop_reason !== 'tool_use') break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: await dispatchTool(block, state, deps),
      });
    }
    state.history.push({ role: 'user', content: results });

    if (hop === 5) {
      spoken.push("Let me get a colleague to help you finish this — one moment.");
    }
  }

  // Belt-and-suspenders: if every hop somehow produced only tool calls and no
  // words, don't hand the channel an empty string — on a live call that reads
  // as dead air.
  return spoken.join(' ') || 'Got it, thank you.';
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();
}

/** Execute one tool call and return the string result fed back to the model. */
async function dispatchTool(
  block: Anthropic.ToolUseBlock,
  state: CallState,
  deps: Deps,
): Promise<string> {
  const conversationId = deps.conversationId as string;

  switch (block.name) {
    case 'record_intake': {
      const patch = block.input as Partial<IntakeRecord>;
      state.intake = mergeIntake(state.intake, patch);
      const { complete, missing } = checkComplete(state.intake);
      log.info(
        {
          conversationId,
          tool: 'record_intake',
          fields: Object.keys(patch),
          callbackNumberProvided: Boolean(patch.callbackNumber),
          complete,
          missing,
        },
        'tool call',
      );
      return JSON.stringify({ ok: true, complete, missing });
    }

    case 'set_language': {
      const language = String((block.input as { language?: string }).language ?? '');
      if (!isSupported(language)) {
        log.info({ conversationId, tool: 'set_language', language, ok: false }, 'tool call');
        return JSON.stringify({ ok: false, reason: `Language "${language}" is not supported for switching.` });
      }
      const switched = switchLanguage(deps.voice, deps.conversationId, language);
      log.info({ conversationId, tool: 'set_language', language, ok: switched }, 'tool call');
      return JSON.stringify({ ok: switched, language });
    }

    case 'request_handoff': {
      const { complete, missing } = checkComplete(state.intake);
      if (!complete) {
        log.info({ conversationId, tool: 'request_handoff', complete: false, missing }, 'tool call');
        return JSON.stringify({ ok: false, complete: false, missing });
      }
      await finalizeComplete(state, deps);
      log.info(
        {
          conversationId,
          tool: 'request_handoff',
          complete: true,
          callbackNumber: state.intake.callbackNumber ? maskPhone(state.intake.callbackNumber) : undefined,
        },
        'tool call',
      );
      return JSON.stringify({ ok: true, complete: true, summary: summarize(state.intake) });
    }

    default:
      log.warn({ conversationId, tool: block.name }, 'unknown tool call');
      return JSON.stringify({ ok: false, reason: `Unknown tool ${block.name}` });
  }
}

/** Persist a completed intake and remember the caller. Handoff SMS is Phase 5. */
async function finalizeComplete(state: CallState, deps: Deps): Promise<void> {
  if (state.handoffDone) return;
  state.handoffDone = true;
  try {
    await saveRequest({
      id: randomUUID(),
      conversationId: deps.conversationId as string,
      callerHash: state.callerHash,
      status: 'complete',
      record: state.intake,
    });
    await rememberCaller(state.callerHash, state.intake);
    state.persisted = true;
  } catch (err) {
    log.error({ conversationId: deps.conversationId, err }, 'failed to persist completed intake');
  }
}

/**
 * Called when the call ends. If the caller hung up before we completed, persist
 * whatever partial record we have, marked abandoned — so no lead is silently lost.
 */
export async function endCall(conversationId: string): Promise<void> {
  const state = calls.get(conversationId);
  if (!state) return;
  log.info(
    { conversationId, status: state.handoffDone ? 'complete' : 'abandoned' },
    'call ended',
  );
  try {
    if (!state.persisted) {
      await saveRequest({
        id: randomUUID(),
        conversationId,
        callerHash: state.callerHash,
        status: state.handoffDone ? 'complete' : 'abandoned',
        record: state.intake,
      });
    }
  } catch (err) {
    log.error({ conversationId, err }, 'failed to persist on call end');
  } finally {
    calls.delete(conversationId);
  }
}
