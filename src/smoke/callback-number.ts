/**
 * Regression check for the real bug found on the first live test call: the
 * caller said "use the number I'm calling from" and the agent had no live
 * caller-ID number to resolve that to (initCall only ever hashed it for memory
 * lookup, never surfaced it to the model). Fixed via callerAddressPreamble in
 * agent.ts. Run with: npx tsx src/smoke/callback-number.ts
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
const CALLER_ID = '+13125551212';

const turns = [
  "I need a French interpreter, no preference on gender.",
  "I need it scheduled for later, not urgent.",
  "Just use the number I'm calling from for the callback.",
  "Yes, go ahead.",
];

async function main() {
  await initCall(conversationId as unknown as string, CALLER_ID);
  console.log(`(caller ID for this simulated call: ${CALLER_ID})`);

  const replies: string[] = [];
  for (const [i, turn] of turns.entries()) {
    console.log(`\n--- turn ${i + 1} ---`);
    console.log('caller:', turn);
    const reply = await runAgent(turn, { voice: fakeVoice, conversationId });
    console.log('agent: ', reply);
    replies.push(reply);
  }

  // Claude may render the callback number as literal digits ("312-555-1212") or
  // spoken out in words ("three one two...") — either is a correct resolution of
  // "the number I'm calling from", so accept both forms.
  const heardTheNumber = replies.some(
    (r) => r.includes('312') || r.toLowerCase().includes('three one two'),
  );

  console.log(
    heardTheNumber
      ? '\nPASS — the caller\'s live number appears in a confirmation. Read the transcript above to confirm the agent never asked them to repeat it.'
      : '\nFAIL — the caller\'s live number never appeared in any confirmation.',
  );
  if (!heardTheNumber) process.exit(1);
}

main().catch((err) => {
  console.error('callback-number smoke test failed:', err);
  process.exit(1);
});
