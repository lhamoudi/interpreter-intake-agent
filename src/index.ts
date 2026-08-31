/**
 * Entry point: wires the stock Fastify TACServer to the Claude tool loop in
 * src/agent.ts. Deliberately thin — TAC owns TwiML, the WebSocket loop, and
 * session lifecycle; this file only bridges its callbacks to our agent and
 * adds two read-only routes for the demo/coordinator.
 */

import 'dotenv/config';
import { TAC, TACConfig, VoiceChannel, TACServer, createLogger } from 'twilio-agent-connect';
import { initCall, runAgent, endCall } from './agent.js';
import { listRequests, lookupCallerByAddress } from './memory.js';

const log = createLogger({ name: 'server' });

const NEW_CALLER_GREETING =
  "Thanks for calling. I can connect you with an interpreter. What language do you need one for?";

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
    defaultTwimlOptions: { welcomeGreeting: NEW_CALLER_GREETING },
  });

  // Greet a returning caller warmly before the first agent turn, using the number
  // in hand at answer time. (The agent operates in English; the caller's spoken
  // language is captured as intake data for the interpreter, not used to switch
  // the bot's own TTS.)
  voiceChannel.onInboundCallTwiml(async (req) => {
    const memory = await lookupCallerByAddress(req.from);
    if (memory && memory.callCount > 0) {
      return {
        welcomeGreeting:
          'Welcome back! I can help you set up an interpreter again. What do you need today?',
      };
    }
    return { welcomeGreeting: NEW_CALLER_GREETING };
  });

  tac.registerChannel(voiceChannel);

  tac.onMessageReady(async ({ conversationId, message, session }) => {
    // Seed caller memory from the real PSTN address the first time we see this call.
    await initCall(conversationId as string, session.authorInfo?.address);
    return runAgent(message, { conversationId, session });
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
  log.error({ err }, 'fatal startup error');
  process.exit(1);
});
