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
import { createLogger, type ConversationId, type VoiceChannel } from 'twilio-agent-connect';
import { TOOLS } from './tools.js';
import { canonicalLanguage, resolveLanguage, switchAck, switchLanguage } from './language.js';
import {
  type IntakeRecord,
  type ServiceTier,
  checkComplete,
  mergeIntake,
  summarize,
} from './intake.js';
import { deflectToVideoRoom } from './deflection.js';
import { buildHandoffData, buildTerminateData } from './handoff.js';
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
  memory: CallerMemory | null;
  handoffDone: boolean;
  declined: boolean;
  persisted: boolean;
  /**
   * The language the CALLER is currently speaking to the agent (canonical name:
   * "English" | "Spanish" | "French"), or null while undetermined / English.
   * Drives the bot's own reply language and the mid-call STT/TTS switch. Distinct
   * from intake.sourceLanguage (the third party) and intake.targetLanguage.
   */
  activeLanguage: string | null;
}

const calls = new Map<string, CallState>();

function baseSystemPrompt(): string {
  return [
    'You are the intake voice agent for an over-the-phone interpretation service.',
    'A caller needs a human interpreter. Your job is to warmly and efficiently collect',
    'the details needed to secure the right interpreter, then hand off to a human.',
    '',
    'You can speak with the caller in English, Spanish, or French. You start in English (or, for a',
    'returning caller, whatever language was preset). If the caller ASKS to continue in Spanish or',
    'French, or clearly tells you which language they want to use, call set_caller_language with it',
    'and speak that language for the rest of the call. Do NOT try to guess their language from a',
    'garbled first utterance — wait until they make it clear (by asking, or by switching once you',
    'are already conversing). When you do switch, that language is the caller\'s own language, which',
    'is also what their third party should be interpreted INTO (targetLanguage) — default',
    'targetLanguage to it and simply confirm, do not ask it cold.',
    '',
    'Collect, working the questions naturally into the conversation (never a rigid checklist):',
    '  - which language the caller needs an interpreter FOR — this is the language of the OTHER',
    '    person (their patient, client, or whoever they are trying to talk to), NOT the language',
    '    the caller is speaking to you. Ask for it and record it as sourceLanguage. For example a',
    '    caller speaking to you in English who needs to talk to a Spanish-speaking patient has',
    '    sourceLanguage "Spanish", targetLanguage "English".',
    '  - whether they prefer a male or female interpreter, or have no preference',
    '  - the subject area, so we can match a specialised interpreter: medical, legal, or general',
    '    community. Ask what the call is about (for example a doctor visit, a court or legal',
    '    matter, or something else) and map their answer to medical, legal, or community. This is',
    '    helpful but NOT required — if they are unsure or would rather not say, do not press; move on.',
    '  - anything else that matters most to them (open text — capture as notes)',
    '',
    'Once you have all the required details and have confirmed them, offer three ways to be served,',
    'briefly and naturally (one sentence):',
    '  1. An AI interpreter can help right now on this call at low cost.',
    '  2. A professional human interpreter, connected on this call now — higher cost, best for',
    '     sensitive or complex situations.',
    '  3. A link emailed to join a video session — voice or video, share screen or documents.',
    'When they pick one, call choose_service_tier. For "video" you must have their email (ask if',
    'needed). Email addresses are easy to mishear on a phone line, so a freshly-given email is NOT',
    'ready to use yet: after they say it, read it back spelling out any ambiguous part letter by',
    'letter (say "M as in Mike", "S as in Sam", and call out dot, dash, or underscore explicitly)',
    'rather than just repeating it as a word, and wait for an explicit yes. Only call',
    'choose_service_tier with the email AFTER they have confirmed it — never on the same turn you',
    'first hear it.',
    'For "human" (or an AI/video fallback), then call request_handoff — this connects them',
    'live, so tell them to stay on the line while the call transfers. Do NOT say "call you back".',
    '',
    'Rules:',
    '  - Ask ONE question, then STOP and wait for the caller to answer. Never answer your own',
    '    question, never write the caller\'s side of the dialogue, and never chain multiple',
    '    questions into one turn ("Are you a healthcare provider? Excellent, ..." is wrong —',
    '    ask, then end your turn).',
    '  - Call record_intake as soon as you learn each detail — do not wait until the end.',
    '  - Handle "I don\'t know yet", interruptions, and corrections gracefully.',
    '  - Confirm the collected details back before you offer options.',
    '  - Do not proceed until every required detail is collected.',
    '  - After choose_service_tier: for "video", tell them to watch for the email; otherwise call',
    '    request_handoff. If request_handoff reports missing fields, ask for them.',
    '  - You are speaking aloud. No markdown, asterisks, bullets, or emojis. Keep replies to a',
    '    sentence or two, plain and calm.',
    '  - Always finish your turn with something spoken to the caller — even a brief acknowledgement —',
    '    whether or not you also call a tool along the way. The caller cannot see tool calls, only',
    '    hear you, so a turn that ends in silence sounds like the line went dead.',
    '',
    'Edge cases:',
    '  - CONTRADICTION: if the caller changes a detail they gave earlier (e.g. first "Spanish",',
    '    later "actually Portuguese"), do not silently overwrite. Briefly note the change and',
    '    confirm the new value ("Got it — Portuguese, not Spanish?"), then record_intake with it.',
    '  - CAN\'T ANSWER: you only arrange interpreters. If asked something outside that (legal advice,',
    '    medical advice, pricing you don\'t know, unrelated questions), say plainly you can\'t help',
    '    with that but you can connect them with an interpreter, and steer back. Never guess or',
    '    invent facts.',
    '  - NOT A QUALIFIED LEAD: if the caller clearly does not want an interpreter — wrong number, a',
    '    sales/spam call, just testing, or being abusive — do not push through intake. Politely say',
    '    this line is only for interpreter requests and call decline_request to end. Give the caller',
    '    the benefit of the doubt first; only decline when it is clear.',
  ].join('\n');
}

function memoryPreamble(memory: CallerMemory | null): string {
  if (!memory || memory.callCount === 0) return '';
  const known = [
    memory.sourceLanguage && `they usually need ${memory.sourceLanguage}`,
    memory.genderPreference &&
      memory.genderPreference !== 'no_preference' &&
      `they prefer a ${memory.genderPreference} interpreter`,
    memory.industry && `often ${memory.industry}`,
    memory.email &&
      `their email on file is ${memory.email} — it was already confirmed on a prior call, so if ` +
        'they choose the video tier just say you have it on file and briefly name it in plain ' +
        'speech (no need to spell it out letter by letter); only ask again if they say it has changed',
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

/**
 * Per-turn directive keeping the model's SPOKEN replies in the caller's language.
 * Empty for English (the base) — no directive needed. Injected into the system
 * prompt every turn, so it tracks `state.activeLanguage` as it changes.
 */
function languagePreamble(activeLanguage: string | null): string {
  if (!activeLanguage || activeLanguage === 'English') return '';
  return (
    `\n\nThis caller is being served in ${activeLanguage}. Write EVERY reply to them entirely ` +
    `in ${activeLanguage} — every word you speak aloud. Only the words you SAY change; the values ` +
    'you put in tool fields stay as normal English data (e.g. record the third party\'s language ' +
    'as "Spanish", industry as "medical"). If the caller switches to another language, call ' +
    'set_caller_language again and follow it.'
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
  // Seed known preferences from memory so a returning caller can skip questions.
  const seed: IntakeRecord = memory
    ? {
        sourceLanguage: memory.sourceLanguage,
        targetLanguage: memory.targetLanguage,
        genderPreference: memory.genderPreference as IntakeRecord['genderPreference'],
        industry: memory.industry as IntakeRecord['industry'],
        email: memory.email,
      }
    : {};

  // A returning caller whose spoken language we know starts the call already in
  // that language (the TwiML customizer also preset the STT/TTS voice). A new
  // caller starts undetermined — the first utterance sets it.
  const seededLanguage = memory ? canonicalLanguage(memory.callerLanguage) ?? null : null;

  calls.set(conversationId, {
    history: [],
    intake: seed,
    callerHash,
    memory,
    handoffDone: false,
    declined: false,
    persisted: false,
    activeLanguage: seededLanguage,
  });
}

interface Deps {
  conversationId: ConversationId;
  /**
   * The live TAC session, when present (real calls). Handoff sets
   * `session.pendingHandoffData` on it so the voice channel emits the
   * ConversationRelay `end` message with the handoff payload. Optional so
   * smoke tests without a real session still run.
   */
  session?: { pendingHandoffData?: { type?: 'end'; handoffData: string } };
  /**
   * The voice channel, when present (real calls). Used to send the mid-call
   * ConversationRelay `language` control message on a caller-language switch.
   * Optional so smoke tests can pass a stub or omit it.
   */
  voice?: VoiceChannel;
}

/** Run one caller turn. Returns the text to speak back. */
export async function runAgent(userMessage: string, deps: Deps): Promise<string> {
  const convId = deps.conversationId as string;
  if (!calls.has(convId)) await initCall(convId, undefined);
  const state = calls.get(convId)!;

  state.history.push({ role: 'user', content: userMessage });

  // Tool loop: Claude may speak AND call a tool in the same hop (a text block
  // alongside tool_use blocks) — that spoken text must not be dropped just
  // because the turn isn't done yet. Accumulate text across every hop and
  // return it all once the turn ends, rather than only reading the final hop.
  const spoken: string[] = [];
  for (let hop = 0; hop < 6; hop++) {
    // Rebuilt each hop so a mid-turn set_caller_language switch reaches the
    // model on its very next hop, not just the next turn.
    const system =
      baseSystemPrompt() + memoryPreamble(state.memory) + languagePreamble(state.activeLanguage);
    let res: Anthropic.Message;
    try {
      res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system,
        tools: TOOLS,
        messages: state.history,
      });
    } catch (err) {
      // The model is unreachable (out of credits, outage, timeout). Never leave
      // the caller in dead air: apologise in their language and route the live
      // call into the human queue via the same Studio→Flex handoff path.
      log.error({ conversationId: convId, err }, 'model call failed — routing caller to queue');
      return failToQueue(state, deps);
    }

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
      // Hop cap reached with tool_results as the last history entry. Push the
      // fallback line into history as an assistant message too, so the next
      // turn's user message doesn't create two consecutive user-role messages.
      const fallback = 'Let me get a colleague to help you finish this — one moment.';
      spoken.push(fallback);
      state.history.push({ role: 'assistant', content: fallback });
    }
  }

  // Belt-and-suspenders: if every hop somehow produced only tool calls and no
  // words, don't hand the channel an empty string — on a live call that reads
  // as dead air.
  return spoken.join(' ') || 'Got it, thank you.';
}

/** Apology spoken when the model is unreachable, in the caller's active language. */
const QUEUE_FALLBACK: Record<string, string> = {
  English:
    "I'm sorry — I'm having a technical problem on my end. Let me connect you with a person who " +
    'can help. Please stay on the line.',
  Spanish:
    'Lo siento, tengo un problema técnico. Le voy a comunicar con una persona que puede ayudarle. ' +
    'Por favor, no cuelgue.',
  French:
    'Je suis désolé, je rencontre un problème technique. Je vais vous mettre en relation avec une ' +
    'personne qui peut vous aider. Veuillez rester en ligne.',
};

/**
 * Graceful degradation when the model call fails (out of credits, outage,
 * timeout). Routes the LIVE call into the human queue via the same Studio→Flex
 * handoff mechanism the human tier uses, and returns a spoken apology in the
 * caller's language — never dead air. Best-effort: even if persistence or the
 * session payload fails, we still return words to speak.
 */
function failToQueue(state: CallState, deps: Deps): string {
  const conversationId = deps.conversationId as string;
  try {
    if (deps.session && !state.handoffDone) {
      state.handoffDone = true;
      deps.session.pendingHandoffData = {
        type: 'end',
        handoffData: buildHandoffData(conversationId, state.intake),
      };
      log.info({ conversationId }, 'fallback handoff payload set — routing to Flex queue');
    }
  } catch (err) {
    log.error({ conversationId, err }, 'failed to set fallback handoff payload');
  }
  return QUEUE_FALLBACK[state.activeLanguage ?? 'English'] ?? QUEUE_FALLBACK.English;
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
    case 'set_caller_language': {
      const { language } = block.input as { language?: string };
      const codes = resolveLanguage(language);
      if (!codes || !language) {
        return JSON.stringify({ ok: false, reason: `Unsupported language "${language}".` });
      }
      const canonical = canonicalLanguage(language)!;
      const prev = state.activeLanguage;
      const prevCodes = resolveLanguage(prev ?? 'English');
      const changed = codes.tts !== prevCodes?.tts;

      // The interpreter's target language IS the caller's own language: the third
      // party is interpreted INTO whatever the caller speaks. So it must track the
      // caller language, including when they switch mid-call — not just get
      // defaulted once. (Set it whenever the caller language is (re)confirmed.)
      state.intake.targetLanguage = canonical;

      if (!changed) {
        // No-op: same language as we're already on. Send nothing (anti-thrash).
        log.info({ conversationId, tool: 'set_caller_language', language: canonical, changed: false }, 'tool call');
        return JSON.stringify({ ok: true, language: canonical, changed: false });
      }

      state.activeLanguage = canonical;
      let switched = false;
      if (deps.voice) switched = switchLanguage(deps.voice, deps.conversationId, language);
      log.info(
        { conversationId, tool: 'set_caller_language', language: canonical, changed: true, switched },
        'tool call',
      );
      // Same-turn steer: the model reads this tool_result before its next hop, so
      // instruct it to switch its own spoken language immediately, leading with a
      // brief acknowledgement in the new language.
      return JSON.stringify({
        ok: true,
        language: canonical,
        changed: true,
        speakIn: canonical,
        instruction:
          `Reply to the caller entirely in ${canonical} from now on. Begin your next reply with a ` +
          `brief acknowledgement in ${canonical}, for example: "${switchAck(language) ?? ''}"`,
      });
    }

    case 'record_intake': {
      const patch = block.input as Partial<IntakeRecord>;
      state.intake = mergeIntake(state.intake, patch);
      const { complete, missing } = checkComplete(state.intake);
      log.info(
        {
          conversationId,
          tool: 'record_intake',
          fields: Object.keys(patch),
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
          // Video tier: caller joins by link, so no live transfer to Flex.
          await finalizeComplete(state, deps, false); // persist + remember, tier recorded
          log.info({ conversationId, tool: 'choose_service_tier', tier, videoOk: true }, 'tool call');
          return JSON.stringify({
            ok: true,
            tier,
            action: 'video_link_sent',
            message: 'Video session created and join link emailed to the caller.',
          });
        }
        // Video setup failed — fall back to a live human transfer rather than dead-end.
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
            'Could not set up the video session. Tell the caller you will connect them with a ' +
            'human interpreter on this call instead, then call request_handoff.',
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
            'AI live interpretation is not available yet on this line. Let the caller know you ' +
            'will connect them with a human interpreter on this call, then call request_handoff.',
        });
      }

      // tier === 'human'
      log.info({ conversationId, tool: 'choose_service_tier', tier: 'human' }, 'tool call');
      return JSON.stringify({
        ok: true,
        tier: 'human',
        action: 'proceed_to_handoff',
        message: 'Proceed to call request_handoff to transfer this live call to a human interpreter.',
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
        },
        'tool call',
      );
      return JSON.stringify({ ok: true, complete: true, summary: summarize(state.intake) });
    }

    case 'decline_request': {
      const reason = String((block.input as { reason?: string }).reason ?? 'other');
      state.declined = true;
      log.info({ conversationId, tool: 'decline_request', reason }, 'tool call');
      // Persist a declined record so non-leads are auditable, then end.
      try {
        await saveRequest({
          id: randomUUID(),
          conversationId,
          callerHash: state.callerHash,
          status: 'declined',
          record: { ...state.intake, notes: `declined: ${reason}` },
        });
        state.persisted = true;
      } catch (err) {
        log.error({ conversationId, err }, 'failed to persist declined request');
      }
      // End the LIVE call after the goodbye: set the ConversationRelay handoff
      // payload marked as a decline. When ConversationRelay emits `end`, control
      // returns to the <Connect action> Studio Flow, which branches on
      // attributes.disposition === 'declined' to hang up (instead of Send-to-Flex).
      if (deps.session) {
        deps.session.pendingHandoffData = {
          type: 'end',
          handoffData: buildTerminateData(conversationId, reason, state.intake),
        };
        log.info({ conversationId }, 'decline: end payload set (Studio Flow will hang up)');
      }
      return JSON.stringify({
        ok: true,
        declined: true,
        message: 'Say a brief polite goodbye — the call will end automatically after you speak.',
      });
    }

    default:
      log.warn({ conversationId, tool: block.name }, 'unknown tool call');
      return JSON.stringify({ ok: false, reason: `Unknown tool ${block.name}` });
  }
}

/**
 * Persist a completed intake and remember the caller. For the human tier
 * (`notifyHuman`), also set the TAC voice-handoff payload on the live session so
 * ConversationRelay emits the `end` message with `handoffData` and the Studio
 * Flow transfers the call into Flex. Best-effort: persistence failures are
 * logged, never block completion.
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
    await rememberCaller(state.callerHash, state.intake, state.activeLanguage);
    state.persisted = true;
  } catch (err) {
    log.error({ conversationId, err }, 'failed to persist completed intake');
  }

  if (!notifyHuman) return;

  // Transfer the LIVE call to Flex. Set the TAC voice-handoff payload; the voice
  // channel emits the ConversationRelay `end` with it, and the Studio Flow
  // (TWILIO_STUDIO_HANDOFF_FLOW_SID) routes the call into Flex.
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
  const endStatus = state.declined ? 'declined' : state.handoffDone ? 'complete' : 'abandoned';
  log.info({ conversationId, status: endStatus }, 'call ended');
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
