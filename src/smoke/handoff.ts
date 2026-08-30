/**
 * Smoke test for the human-handoff path. Needs ANTHROPIC_API_KEY.
 *
 * Verifies two things on the human-callback tier:
 *   1. session.pendingHandoffData is set (TAC voice-only handoff wire mechanism).
 *   2. the duty interpreter is emailed — gated behind LIVE_HANDOFF=1 so a routine
 *      run doesn't send mail. Set DUTY_INTERPRETER_EMAIL + SENDGRID_* for a live
 *      run.
 *
 * Run:  npx tsx src/smoke/handoff.ts
 *       LIVE_HANDOFF=1 DUTY_INTERPRETER_EMAIL=you@example.com npx tsx src/smoke/handoff.ts
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { runAgent, initCall } from '../agent.js';
import type { VoiceChannel, ConversationId } from 'twilio-agent-connect';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set.');
  process.exit(1);
}
const live = process.env.LIVE_HANDOFF === '1';
if (!live) {
  // Avoid a real duty-interpreter email on a routine run.
  delete process.env.DUTY_INTERPRETER_EMAIL;
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
  console.log(`(mode: ${live ? 'LIVE — will email the duty interpreter' : 'dry — no email'})`);
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
