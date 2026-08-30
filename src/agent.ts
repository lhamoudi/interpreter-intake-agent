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
import {
  type IntakeRecord,
  type ServiceTier,
  checkComplete,
  mergeIntake,
  summarize,
} from './intake.js';
import { deflectToVideoRoom } from './deflection.js';
import { buildHandoffData, createCallbackTask } from './handoff.js';
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
    `The current date and time is ${new Date().toISOString()} (UTC). Use it to resolve any ` +
    'relative callback time the caller gives ("in 5 minutes", "tomorrow at 3pm") into an ISO ' +
    'timestamp. US callers usually mean their local time; if the timezone is unclear, ask briefly.',
    '',
    'Collect, working the questions naturally into the conversation (never a rigid checklist):',
    '  - which language the caller needs an interpreter for (their language), interpreted INTO',
    '    English by default. Record it as sourceLanguage; default targetLanguage to English unless',
    '    they say otherwise. You yourself speak English throughout.',
    '  - whether they prefer a male or female interpreter, or have no preference',
    '  - whether they need someone right now or are scheduling for later',
    '  - ONLY IF they are scheduling for later: a callback number AND when they want the callback.',
    '    Accept relative ("in 5 minutes", "in an hour") or absolute ("tomorrow at 3pm") times.',
    '    Record the caller\'s exact words as scheduledTimeText and your ISO resolution as',
    '    scheduledTimeISO. Confirm the time back to them. If they need someone NOW, do not ask for',
    '    a callback number or time, and do not read one back — they are connected on this call.',
    '  - the subject area, so we can match a specialised interpreter: medical, legal, or general',
    '    community. Ask what the call is about (for example a doctor visit, a court or legal',
    '    matter, or something else) and map their answer to medical, legal, or community. This is',
    '    helpful but NOT required — if they are unsure or would rather not say, do not press; move on.',
    '  - anything else that matters most to them (open text — capture as notes)',
    '',
    'Once you have all the required details and have confirmed them, proceed by urgency:',
    '',
    'IF they need someone NOW: offer three ways to be served, briefly and naturally (one sentence):',
    '  1. An AI interpreter can help right now on this call at low cost.',
    '  2. A professional human interpreter — connected on this call now, higher cost, best for',
    '     sensitive or complex situations.',
    '  3. A link emailed to join a video session — voice or video, share screen or documents.',
    'When they pick one, call choose_service_tier. For "video" you must have their email (ask if',
    'needed). For "human" (or an AI/video fallback), then call request_handoff — this connects them',
    'live, so tell them to stay on the line while the call transfers. Do NOT say "call you back".',
    '',
    'IF they are SCHEDULING for later: do NOT offer the live options. Just confirm a human',
    'interpreter will call them back at the agreed time and number, call choose_service_tier with',
    '"human", then request_handoff. Tell them they can hang up and will be called back — do NOT',
    'say to stay on the line.',
    '',
    'Rules:',
    '  - Call record_intake as soon as you learn each detail — do not wait until the end.',
    '  - Handle "I don\'t know yet", interruptions, and corrections gracefully.',
    '  - Confirm the collected details back before you offer options / arrange the callback.',
    '  - Do not proceed until every required detail is collected.',
    '  - After choose_service_tier: for "video", tell them to watch for the email; otherwise call',
    '    request_handoff. If request_handoff reports missing fields, ask for them.',
    '  - You are speaking aloud. No markdown, asterisks, bullets, or emojis. Keep replies to a',
    '    sentence or two, plain and calm.',
    '  - Always finish your turn with something spoken to the caller — even a brief acknowledgement —',
    '    whether or not you also call a tool along the way. The caller cannot see tool calls, only',
    '    hear you, so a turn that ends in silence sounds like the line went dead.',
    '  - When you SAY a phone number aloud, write out the digit NAMES with spaces so it is read',
    '    digit by digit, not as one big number. Drop the US country code (+1). For example for',
    '    +13125551212 say: "three one two, five five five, one two one two". Never write it as',
    '    "3125551212" in your spoken reply — that gets read as a single number, which is wrong.',
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
    '. They have ALREADY heard a "welcome back" greeting before you — do not greet them ' +
    'again or say "welcome back" a second time; just continue naturally. Confirm rather than ' +
    're-ask what you already know, and only fill the gaps.'
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
  // Seed known preferences from memory, but NOT callbackNumber — it's only needed
  // for scheduled callers, and seeding it made the agent read a stale number back
  // to now-callers who are connected live.
  const seed: IntakeRecord = memory
    ? {
        sourceLanguage: memory.sourceLanguage,
        targetLanguage: memory.targetLanguage,
        genderPreference: memory.genderPreference as IntakeRecord['genderPreference'],
        industry: memory.industry as IntakeRecord['industry'],
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

  if (!notifyHuman) return;

  if (state.intake.urgency === 'scheduled') {
    // Scheduled: DON'T transfer the live call — the caller wants to hang up and
    // be called back. Create a TaskRouter task directly; the caller then ends the
    // call normally. No pendingHandoffData (that would transfer the live call).
    await createCallbackTask(conversationId, state.intake);
    return;
  }

  // Now/urgent human: transfer the LIVE call to Flex. Set the TAC voice-handoff
  // payload; the voice channel emits the ConversationRelay `end` with it, and the
  // Studio Flow (TWILIO_STUDIO_HANDOFF_FLOW_SID) routes the call into Flex.
  if (deps.session) {
    deps.session.pendingHandoffData = {
      type: 'end',
      handoffData: buildHandoffData(conversationId, state.intake),
    };
    log.info({ conversationId }, 'handoff payload set on session (voice end → Studio/Flex)');
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
