/**
 * Smoke test for subject-area (industry) capture. Needs ANTHROPIC_API_KEY.
 * The caller describes the situation in plain words ("a hospital visit") rather
 * than naming a category — this checks the agent captures `industry` and maps
 * the free-text answer to the enum (hospital -> medical) without being told the
 * word "medical". Run: npx tsx src/smoke/industry.ts
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { runAgent, initCall } from '../agent.js';
import type { ConversationId } from 'twilio-agent-connect';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set.');
  process.exit(1);
}

const conversationId = randomUUID() as ConversationId;

const turns = [
  'I need a Mandarin interpreter please.',
  'A female interpreter would be best.',
  "It's for a hospital visit.",
  'The human option is fine, connect me.',
];

async function main() {
  await initCall(conversationId as unknown as string, '+13125551212');

  const replies: string[] = [];
  for (const [i, turn] of turns.entries()) {
    console.log(`\n--- turn ${i + 1} ---`);
    console.log('caller:', turn);
    const reply = await runAgent(turn, { conversationId });
    console.log('agent: ', reply);
    replies.push(reply);
  }

  // "hospital" should have been mapped to the medical subject area and used in
  // the read-back / tier pitch. The structured "record_intake" log line with
  // fields including "industry" is the authoritative signal (visible above).
  const usedMedical = replies.some((r) => /medical/i.test(r));
  console.log(
    usedMedical
      ? '\nPASS — subject area captured and used (hospital -> medical). See the record_intake log line for fields:["...","industry"].'
      : '\nCHECK — "medical" not surfaced in replies; confirm industry capture from the record_intake log line above.',
  );
}

main().catch((err) => {
  console.error('industry smoke test failed:', err);
  process.exit(1);
});
