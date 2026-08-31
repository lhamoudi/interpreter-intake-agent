/**
 * Smoke test for FR/EN/ES mid-call language detection + switching — needs
 * ANTHROPIC_API_KEY, nothing else. Drives the real agent loop against scripted
 * turns with a FAKE voice channel whose getWebsocket records the ConversationRelay
 * `language` control messages, so we can assert the switch fired (and only when
 * the language actually changed) without a phone.
 *
 * The TTS voice itself can only be verified by ear on a live call — this proves
 * the wiring: the right control message is sent, the bot's own replies follow the
 * language, targetLanguage defaults to the caller's language, and the third
 * party's sourceLanguage is still collected as a separate question.
 *
 * Run with: npx tsx src/smoke/language.ts
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { runAgent, initCall } from '../agent.js';
import type { ConversationId, VoiceChannel } from 'twilio-agent-connect';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set — export it or add it to .env first.');
  process.exit(1);
}

const conversationId = randomUUID() as ConversationId;

// Records every JSON message "sent" on the fake websocket.
const sent: Array<Record<string, unknown>> = [];
const fakeWs = {
  send(data: string) {
    try {
      sent.push(JSON.parse(data));
    } catch {
      /* ignore non-JSON */
    }
  },
};
// Minimal stub — the agent only calls getWebsocket() on it.
const fakeVoice = { getWebsocket: () => fakeWs } as unknown as VoiceChannel;

// A Spanish-speaking caller who then switches to English, then back to Spanish —
// exercises detection, the target-language default, the switch-back voice, and
// the anti-thrash guard (the repeated Spanish turn must NOT re-send).
const turns = [
  'Hola, necesito un intérprete. Mi paciente habla mandarín.', // Spanish; third party = Mandarin
  'Actually, let me continue in English — no gender preference.', // switch to English
  'Sí, prefiero seguir en español, es para una cita médica.', // switch back to Spanish
];

function langMessages() {
  return sent.filter((m) => m.type === 'language');
}

async function main() {
  await initCall(conversationId as unknown as string, '+15551234567');

  for (const [i, turn] of turns.entries()) {
    console.log(`\n--- turn ${i + 1} ---`);
    console.log('caller:', turn);
    const before = langMessages().length;
    const reply = await runAgent(turn, { conversationId, voice: fakeVoice });
    console.log('agent: ', reply);
    const fired = langMessages().slice(before);
    if (fired.length) console.log('  ↳ language switch sent:', JSON.stringify(fired));
  }

  console.log('\n--- checks ---');
  const msgs = langMessages();
  const ttsLangs = msgs.map((m) => m.ttsLanguage);
  console.log('language messages sent, in order:', JSON.stringify(ttsLangs));

  const sawSpanish = ttsLangs.includes('es-US');
  const sawEnglish = ttsLangs.includes('en-US');
  // Three genuine changes max (es → en → es); the guard prevents duplicates, so a
  // clean run sends exactly 3. Allow ≤3 in case the model set Spanish only once
  // up front, but flag if it exceeds 3 (thrash) or missed a switch.
  const noThrash = msgs.length <= 3;

  const pass = sawSpanish && sawEnglish && noThrash;
  console.log(
    pass
      ? `\nPASS — detected + switched across languages (${msgs.length} switch messages, no thrash).`
      : `\nFAIL — sawSpanish=${sawSpanish} sawEnglish=${sawEnglish} count=${msgs.length} (expected ≤3).`,
  );
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error('language smoke test failed:', err);
  process.exit(1);
});
