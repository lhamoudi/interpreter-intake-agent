/**
 * Entry point: wires the stock Fastify TACServer to the Claude tool loop in
 * src/agent.ts. Deliberately thin — TAC owns TwiML, the WebSocket loop, and
 * session lifecycle; this file only bridges its callbacks to our agent and
 * adds two read-only routes for the demo/coordinator.
 */

import 'dotenv/config';
import { TAC, TACConfig, VoiceChannel, TACServer } from 'twilio-agent-connect';
import { initCall, runAgent, endCall } from './agent.js';
import { listRequests, lookupCallerByAddress } from './memory.js';
import { resolveLanguage, SUPPORTED_LANGUAGE_DECLARATIONS } from './language.js';

const NEW_CALLER_GREETING =
  "Thanks for calling. I can connect you with an interpreter. What language do you speak? " +
  "We'll interpret to English unless you need another language.";

async function main() {
  const config = TACConfig.fromEnv();
  const tac = await TAC.create({ config });

  // Human handoff: when TWILIO_STUDIO_HANDOFF_FLOW_SID is set, TACConfig picks it
  // up and TAC automatically wires the ConversationRelay `<Connect action>` URL
  // to that Studio Flow (precedence layer 4 in resolveActionUrl). We set
  // session.pendingHandoffData on the human-callback tier (see agent.ts); when
  // ConversationRelay ends the session it triggers the Flow carrying handoffData,
  // and the Flow routes the call into Flex via TaskRouter. Nothing to wire here.
  if (config.studioHandoffFlowSid) {
    console.log('handoff: Studio Flow configured, TAC will wire the voice action URL',
      config.studioHandoffFlowSid);
  }

  const voiceChannel = new VoiceChannel(tac, {
    defaultTwimlOptions: {
      welcomeGreeting: NEW_CALLER_GREETING,
      // Declare every supported locale as a <Language> child so a mid-call
      // set_language switch actually has a voice to use. Without this the TTS
      // stays English after switching (the live-French-call bug).
      languages: SUPPORTED_LANGUAGE_DECLARATIONS,
    },
  });

  // Personalize BEFORE the greeting is spoken. This runs at answer time with the
  // caller's number in hand, so we look up their profile here — a returning
  // caller is greeted by name-of-language in their own language, and STT/TTS is
  // preset to that language, instead of hearing the generic English prompt and
  // only being recognized a turn later (which read as "off").
  voiceChannel.onInboundCallTwiml(async (req) => {
    // The customizer is the highest-precedence TwiML layer and `languages`
    // replaces wholesale, so re-declare the supported <Language> children on
    // every return or they get dropped and mid-call switching breaks again.
    const base = { languages: SUPPORTED_LANGUAGE_DECLARATIONS };

    const memory = await lookupCallerByAddress(req.from);
    if (!memory || memory.callCount === 0) {
      return { ...base, welcomeGreeting: NEW_CALLER_GREETING };
    }

    const lang = memory.sourceLanguage;
    const codes = resolveLanguage(lang);
    if (lang && codes && codes.tts !== 'en-US') {
      // Returning caller with a known non-English language: greet and listen in it.
      return {
        ...base,
        welcomeGreeting: `Welcome back. I can set you up with a ${lang} interpreter again — shall we go ahead?`,
        ttsLanguage: codes.tts,
        transcriptionLanguage: codes.transcription,
      };
    }
    // Returning caller we know, but English (or unmapped) — warm greeting, default language.
    return {
      ...base,
      welcomeGreeting: lang
        ? `Welcome back. I can help you with a ${lang} interpreter again — what do you need today?`
        : "Welcome back. I can connect you with an interpreter again — which language do you speak?",
    };
  });

  tac.registerChannel(voiceChannel);

  tac.onMessageReady(async ({ conversationId, message, session }) => {
    // Seed caller memory from the real PSTN address the first time we see this call.
    await initCall(conversationId as string, session.authorInfo?.address);
    return runAgent(message, { voice: voiceChannel, conversationId, session });
  });

  tac.onConversationEnded(async ({ session }) => {
    await endCall(session.conversationId as string);
  });

  const server = new TACServer(tac);

  // Read-back for a coordinator/reviewer — not part of TAC's own routes.
  server.fastify.get('/health', async () => ({ status: 'ok' }));
  server.fastify.get('/requests', async () => ({ requests: await listRequests() }));

  await server.start();
}

main().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
