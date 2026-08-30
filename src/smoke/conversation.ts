/**
 * Smoke test for the Claude tool loop — needs ANTHROPIC_API_KEY, nothing else.
 * Fakes a VoiceChannel (its methods are never exercised by this flow).
 *
 * Run with: npx tsx src/smoke/conversation.ts
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { runAgent, initCall } from '../agent.js';
import type { VoiceChannel, ConversationId } from 'twilio-agent-connect';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set — export it or add it to .env first.');
  process.exit(1);
}

const fakeVoice = { getWebsocket: () => null } as unknown as VoiceChannel;
const conversationId = randomUUID() as ConversationId;

// A caller who volunteers info out of order, hesitates once, and confirms at the end —
// exercises natural-language slot filling, not a rigid form.
const turns = [
  "Hi, I need someone who speaks Spanish, I'm having trouble with my landlord.",
  "Um, either a man or a woman is fine, I don't really care.",
  "Human interpreter please.",
  "Yes, that's all correct, go ahead.",
];

async function main() {
  await initCall(conversationId as unknown as string, '+15559998888');

  for (const [i, turn] of turns.entries()) {
    console.log(`\n--- turn ${i + 1} ---`);
    console.log('caller:', turn);
    const reply = await runAgent(turn, { voice: fakeVoice, conversationId });
    console.log('agent: ', reply);
  }
}

main().catch((err) => {
  console.error('conversation smoke test failed:', err);
  process.exit(1);
});
