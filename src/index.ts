/**
 * Entry point: wires the stock Fastify TACServer to the Claude tool loop in
 * src/agent.ts. Deliberately thin — TAC owns TwiML, the WebSocket loop, and
 * session lifecycle; this file only bridges its callbacks to our agent and
 * adds two read-only routes for the demo/coordinator.
 */

import 'dotenv/config';
import { TAC, TACConfig, VoiceChannel, TACServer } from 'twilio-agent-connect';
import { initCall, runAgent, endCall } from './agent.js';
import { listRequests } from './memory.js';

async function main() {
  const tac = await TAC.create({ config: TACConfig.fromEnv() });

  const voiceChannel = new VoiceChannel(tac, {
    defaultTwimlOptions: {
      welcomeGreeting:
        "Thanks for calling. I can help set you up with an interpreter — what language do you need?",
    },
  });
  tac.registerChannel(voiceChannel);

  tac.onMessageReady(async ({ conversationId, message, session }) => {
    // Seed caller memory from the real PSTN address the first time we see this call.
    await initCall(conversationId as string, session.authorInfo?.address);
    return runAgent(message, { voice: voiceChannel, conversationId });
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
