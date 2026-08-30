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
  type ServiceTier,
  checkComplete,
  mergeIntake,
  summarize,
} from './intake.js';
import { deflectToVideoRoom } from './deflection.js';
import { buildHandoffData, notifyDutyInterpreter } from './handoff.js';
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
    '  - the subject area, so we can match a specialised interpreter: medical, legal, or general',
    '    community. Ask what the call is about (for example a doctor visit, a court or legal',
    '    matter, or something else) and map their answer to medical, legal, or community. This is',
    '    helpful but NOT required — if they are unsure or would rather not say, do not press; move on.',
    '  - anything else that matters most to them (open text — capture as notes)',
    '',
    'Once you have all the required details and have confirmed them, offer the caller three ways',
    'to be served, briefly and naturally (do not lecture — a sentence is enough):',
    '  1. An AI interpreter can help right at low cost, on this call.',
    '  2. A professional human interpreter can call them back — higher cost, best for sensitive',
    '     or complex situations.',
    '  3. We can email them a link to join a video session — voice or video, and they can share',
    '     their screen or a document like a form or letter. Also lower cost than a phone interpreter.',
    'When they pick one, call choose_service_tier with their choice. For the video option you must',
    'have their email address — ask for it if you don\'t have it, then pass it to choose_service_tier',
    '(the link is emailed, not texted). The system will set up the video session (for video), or you',
    'should call request_handoff (for human, or if AI/video is unavailable and it falls back).',
    '',
    'Rules:',
    '  - Call record_intake as soon as you learn each detail — do not wait until the end.',
    '  - If the caller is clearly more comfortable in another language, call set_language.',
    '  - Handle "I don\'t know yet", interruptions, and corrections gracefully.',
    '  - Confirm the collected details back before you offer the service options.',
    '  - Do not offer the service options until every required detail is collected.',
    '  - After choose_service_tier: for "video", tell them to watch for the text; for "human"',
    '    (or a fallback), call request_handoff. If request_handoff reports missing fields, ask.',
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
  /**
   * The live TAC session, when present (real calls). Handoff sets
   * `session.pendingHandoffData` on it so the voice channel emits the
   * ConversationRelay `end` message with the handoff payload. Optional so
   * smoke tests without a real session still run.
   */
  session?: { pendingHandoffData?: { type?: 'end'; handoffData: string } };
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

    case 'choose_service_tier': {
      const input = block.input as { tier?: string; email?: string };
      const tier = input.tier as ServiceTier | undefined;
      if (input.email) state.intake.email = input.email.trim();
      const { complete, missing } = checkComplete(state.intake);
      if (!complete) {
        // Don't let the caller be routed before the intake is actually complete.
        log.info(
          { conversationId, tool: 'choose_service_tier', tier, complete: false, missing },
          'tool call',
        );
        return JSON.stringify({
          ok: false,
          reason: 'Intake is not complete yet; collect the missing details first.',
          missing,
        });
      }
      if (tier !== 'ai' && tier !== 'human' && tier !== 'video') {
        return JSON.stringify({ ok: false, reason: `Unknown tier "${tier}".` });
      }
      state.intake.serviceTier = tier;

      if (tier === 'video') {
        // Email the caller a Video Room join link (SMS is 10DLC-gated).
        if (!state.intake.email) {
          return JSON.stringify({
            ok: false,
            reason: 'Need the caller\'s email to send the video link. Ask for it, then call again.',
          });
        }
        const result = await deflectToVideoRoom(conversationId, state.intake.email);
        if (result.ok) {
          // Video tier: caller joins by link, so no human callback notification.
          await finalizeComplete(state, deps, false); // persist + remember, tier recorded
          log.info({ conversationId, tool: 'choose_service_tier', tier, videoOk: true }, 'tool call');
          return JSON.stringify({
            ok: true,
            tier,
            action: 'video_link_sent',
            message: 'Video session created and join link emailed to the caller.',
          });
        }
        // Video setup failed — fall back to a human callback rather than dead-end.
        state.intake.serviceTier = 'human';
        log.warn(
          { conversationId, tool: 'choose_service_tier', tier, videoOk: false, reason: result.reason },
          'video deflection failed, falling back to human',
        );
        return JSON.stringify({
          ok: false,
          tier: 'human',
          action: 'fallback_to_human',
          reason: result.reason,
          message:
            'Could not set up the video session. Tell the caller you will have a human ' +
            'interpreter call them back instead, then call request_handoff.',
        });
      }

      if (tier === 'ai') {
        // Live AI interpretation is roadmap, not a built operating mode. Offer it
        // as chosen, but route to a human so the caller is never stranded.
        state.intake.serviceTier = 'human';
        log.info({ conversationId, tool: 'choose_service_tier', tier: 'ai', fallback: 'human' }, 'tool call');
        return JSON.stringify({
          ok: true,
          tier: 'ai',
          action: 'fallback_to_human',
          message:
            'AI live interpretation is not available yet on this line. Let the caller know a ' +
            'human interpreter will call them back shortly, then call request_handoff.',
        });
      }

      // tier === 'human'
      log.info({ conversationId, tool: 'choose_service_tier', tier: 'human' }, 'tool call');
      return JSON.stringify({
        ok: true,
        tier: 'human',
        action: 'proceed_to_handoff',
        message: 'Proceed to call request_handoff to secure the human interpreter callback.',
      });
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

/**
 * Persist a completed intake and remember the caller. For the human-callback
 * path (`notifyHuman`), also (a) set the TAC voice-handoff payload on the live
 * session so ConversationRelay emits the `end` message with `handoffData`, and
 * (b) email the duty interpreter the lead so they can call the caller back.
 * Both are best-effort and never block completion — the request is persisted
 * regardless.
 */
async function finalizeComplete(
  state: CallState,
  deps: Deps,
  notifyHuman = true,
): Promise<void> {
  if (state.handoffDone) return;
  state.handoffDone = true;
  const conversationId = deps.conversationId as string;
  try {
    await saveRequest({
      id: randomUUID(),
      conversationId,
      callerHash: state.callerHash,
      status: 'complete',
      record: state.intake,
    });
    await rememberCaller(state.callerHash, state.intake);
    state.persisted = true;
  } catch (err) {
    log.error({ conversationId, err }, 'failed to persist completed intake');
  }

  if (notifyHuman) {
    // Primary handoff: set the TAC voice-handoff payload on the live session.
    // The voice channel emits the ConversationRelay `end` with it after the
    // final reply; if a Studio Flow is configured (TWILIO_STUDIO_HANDOFF_FLOW_SID)
    // ConversationRelay triggers it and it routes the call into Flex via
    // TaskRouter, carrying this lead context.
    if (deps.session) {
      deps.session.pendingHandoffData = {
        type: 'end',
        handoffData: buildHandoffData(conversationId, state.intake),
      };
      log.info({ conversationId }, 'handoff payload set on session (voice end → Studio/Flex)');
    }
    // Fallback only: if no Studio Flow is configured, email the duty interpreter
    // so a lead is never dropped. With Flex wired, this stays dormant.
    if (!process.env.TWILIO_STUDIO_HANDOFF_FLOW_SID) {
      await notifyDutyInterpreter(conversationId, state.intake);
    }
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
