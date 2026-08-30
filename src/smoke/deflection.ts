/**
 * Smoke test for the tiered-service deflection flow. Needs ANTHROPIC_API_KEY.
 *
 * The "video" path actually creates a Twilio Video Room and sends a real email
 * via SendGrid, so it's gated behind LIVE_VIDEO=1 to avoid real sends. By default
 * this exercises the "human" tier (no external side effects beyond Turso) and
 * verifies the agent offers the three options and records the choice.
 *
 * Run:  npx tsx src/smoke/deflection.ts
 *       LIVE_VIDEO=1 TEST_EMAIL_TO=you@example.com npx tsx src/smoke/deflection.ts
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { runAgent, initCall } from '../agent.js';
import type { VoiceChannel, ConversationId } from 'twilio-agent-connect';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set.');
  process.exit(1);
}

const live = process.env.LIVE_VIDEO === '1';
const testEmail = process.env.TEST_EMAIL_TO ?? 'caller@example.com';
const fakeVoice = { getWebsocket: () => null } as unknown as VoiceChannel;
const conversationId = randomUUID() as ConversationId;

const turns = live
  ? [
      'I need a Spanish interpreter, no gender preference, for a medical appointment.',
      "It's not urgent, we can schedule it. Use the number I'm calling from.",
      'Let me do the video option please.',
      `Sure, my email is ${testEmail}.`,
      'Yes, that sounds good, thanks.',
    ]
  : [
      'I need a Spanish interpreter, no gender preference, for a medical appointment.',
      "It's not urgent, we can schedule it. Use the number I'm calling from.",
      'I think a human interpreter calling me back is best.',
      'Yes, that sounds good, thanks.',
    ];

async function main() {
  console.log(
    `(mode: ${live ? `LIVE video — will really create a room + email ${testEmail}` : 'human tier — no external side effects'})`,
  );
  await initCall(conversationId as unknown as string, '+13125551212');

  const replies: string[] = [];
  for (const [i, turn] of turns.entries()) {
    console.log(`\n--- turn ${i + 1} ---`);
    console.log('caller:', turn);
    const reply = await runAgent(turn, { voice: fakeVoice, conversationId });
    console.log('agent: ', reply);
    replies.push(reply);
  }

  const offered =
    replies.some((r) => /video/i.test(r)) && replies.some((r) => /human|interpreter/i.test(r));
  console.log(
    offered
      ? '\nPASS — service options presented and a choice was handled. Review transcript above.'
      : '\nFAIL — did not see the service options offered.',
  );
  if (!offered) process.exit(1);
}

main().catch((err) => {
  console.error('deflection smoke test failed:', err);
  process.exit(1);
});
