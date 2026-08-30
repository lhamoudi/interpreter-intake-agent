/**
 * Smoke test for the human-handoff path. Needs ANTHROPIC_API_KEY.
 *
 * Verifies that on the human-callback tier, session.pendingHandoffData is set
 * with the full lead context — the TAC voice-only handoff wire mechanism that
 * ConversationRelay delivers to the Studio Flow (→ Flex). The actual Flex
 * routing lives in the Studio Flow and is exercised on a live call.
 *
 * Run: npx tsx src/smoke/handoff.ts
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { runAgent, initCall } from '../agent.js';
import type { VoiceChannel, ConversationId } from 'twilio-agent-connect';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set.');
  process.exit(1);
}

const fakeVoice = { getWebsocket: () => null } as unknown as VoiceChannel;
// A mutable fake session so we can observe pendingHandoffData being set.
const session: { pendingHandoffData?: { type?: 'end'; handoffData: string } } = {};
const conversationId = randomUUID() as ConversationId;

const turns = [
  'I need a Spanish interpreter, no gender preference, for a doctor visit.',
  "It's urgent, I need someone now. Use the number I'm calling from.",
  'A human interpreter calling me back is best.',
  'Yes, thanks.',
];

async function main() {
  await initCall(conversationId as unknown as string, '+13125551212');

  for (const [i, turn] of turns.entries()) {
    console.log(`\n--- turn ${i + 1} ---`);
    console.log('caller:', turn);
    const reply = await runAgent(turn, { voice: fakeVoice, conversationId, session });
    console.log('agent: ', reply);
  }

  console.log('\n--- checks ---');
  const hasHandoff = Boolean(session.pendingHandoffData?.handoffData);
  console.log(`pendingHandoffData set: ${hasHandoff ? 'YES' : 'NO'}`);
  if (hasHandoff) {
    const parsed = JSON.parse(session.pendingHandoffData!.handoffData);
    console.log('handoff payload:', JSON.stringify(parsed, null, 2));
  }
  console.log(hasHandoff ? '\nPASS — voice handoff payload was set.' : '\nFAIL — no handoff payload.');
  if (!hasHandoff) process.exit(1);
}

main().catch((err) => {
  console.error('handoff smoke test failed:', err);
  process.exit(1);
});
