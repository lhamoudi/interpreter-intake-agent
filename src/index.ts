/**
 * Entry point: wires the stock Fastify TACServer to the Claude tool loop in
 * src/agent.ts. Deliberately thin — TAC owns TwiML, the WebSocket loop, and
 * session lifecycle; this file only bridges its callbacks to our agent and
 * adds two read-only routes for the demo/coordinator.
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TAC, TACConfig, VoiceChannel, TACServer, createLogger } from 'twilio-agent-connect';
import { initCall, runAgent, endCall } from './agent.js';
import { listRequests, lookupCallerByAddress } from './memory.js';
import { returningGreeting, twimlPresetFor, SUPPORTED_LANGUAGE_DECLARATIONS } from './language.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DECK_PATH = path.join(__dirname, '..', 'public', 'deck.html');
// Not committed to git — see .gitignore. Present only when this checkout's
// private/ has the real file; served only if it does, so a fresh clone
// without it still runs cleanly (no route is registered).
const BRIEF_PATH = path.join(__dirname, '..', 'private', 'fde-take-home-brief.pdf');

const log = createLogger({ name: 'server' });

// Trilingual invitation: the agent can converse in English, Spanish, or French,
// and detects which the caller uses from their first reply. Spoken by the base
// English voice until the first utterance is classified.
const NEW_CALLER_GREETING =
  'Thanks for calling. I can connect you with an interpreter — you can speak to me in English, ' +
  'Spanish, or French. Puede hablarme en español. Vous pouvez me parler en français. ' +
  'How can I help you today?';

async function main() {
  const config = TACConfig.fromEnv();
  const tac = await TAC.create({ config });

  // Human handoff: when TWILIO_STUDIO_HANDOFF_FLOW_SID is set, TACConfig picks it
  // up and TAC automatically wires the ConversationRelay `<Connect action>` URL
  // to that Studio Flow (precedence layer 4 in resolveActionUrl). We set
  // session.pendingHandoffData on the human tier (see agent.ts); when
  // ConversationRelay ends the session it triggers the Flow carrying handoffData,
  // and the Flow transfers the live call into Flex via TaskRouter. Nothing to wire here.
  if (config.studioHandoffFlowSid) {
    log.info({ flowSid: config.studioHandoffFlowSid }, 'handoff: Studio Flow configured');
  }

  const voiceChannel = new VoiceChannel(tac, {
    defaultTwimlOptions: {
      welcomeGreeting: NEW_CALLER_GREETING,
      // Declare every supported locale as a <Language> child WITH a voice, so a
      // mid-call switch to any of them has a voice to use (a bare declaration or
      // an undeclared locale silently keeps TTS on English).
      languages: SUPPORTED_LANGUAGE_DECLARATIONS,
    },
  });

  // Greet a returning caller before the first agent turn, using the number in
  // hand at answer time. If we know the language they last spoke to us in, greet
  // them in it AND preset the STT/TTS voice so the first word is already in their
  // language. Every return re-declares `languages` — the array replaces wholesale,
  // so omitting it would drop the <Language> children and revert TTS to English.
  voiceChannel.onInboundCallTwiml(async (req) => {
    const memory = await lookupCallerByAddress(req.from);
    if (memory && memory.callCount > 0) {
      const localizedWelcome = returningGreeting(memory.callerLanguage);
      const preset = twimlPresetFor(memory.callerLanguage);
      return {
        languages: SUPPORTED_LANGUAGE_DECLARATIONS,
        welcomeGreeting:
          localizedWelcome ??
          'Welcome back! I can help you set up an interpreter again. What do you need today?',
        ...(preset ?? {}),
      };
    }
    return { languages: SUPPORTED_LANGUAGE_DECLARATIONS, welcomeGreeting: NEW_CALLER_GREETING };
  });

  tac.registerChannel(voiceChannel);

  tac.onMessageReady(async ({ conversationId, message, session }) => {
    // Seed caller memory from the real PSTN address the first time we see this call.
    await initCall(conversationId as string, session.authorInfo?.address);
    return runAgent(message, { conversationId, session, voice: voiceChannel });
  });

  tac.onConversationEnded(async ({ session }) => {
    await endCall(session.conversationId as string);
  });

  const server = new TACServer(tac);

  // Read-back for a coordinator/reviewer — not part of TAC's own routes.
  server.fastify.get('/health', async () => ({ status: 'ok' }));
  server.fastify.get('/requests', async () => ({ requests: await listRequests() }));

  // Static demo-companion deck — one file, read once at startup, served as-is.
  const deckHtml = await readFile(DECK_PATH, 'utf8');
  server.fastify.get('/deck', async (_req, reply) => {
    reply.type('text/html; charset=utf-8').send(deckHtml);
  });

  // Personal reference copy of the take-home brief — not repo content, not
  // linked from anywhere; only registered if this checkout's private/ has
  // the file (see .gitignore), so it's silently absent everywhere else.
  const brief = await readFile(BRIEF_PATH).catch(() => null);
  if (brief) {
    server.fastify.get('/private/brief.pdf', async (_req, reply) => {
      reply.type('application/pdf').send(brief);
    });
    log.info('personal reference route registered: /private/brief.pdf');
  }

  await server.start();
}

main().catch((err) => {
  log.error({ err }, 'fatal startup error');
  process.exit(1);
});
