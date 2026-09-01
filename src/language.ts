/**
 * Language handling — the accessibility feature that makes this an interpreter
 * product rather than a generic form-filler. A caller who speaks Spanish or
 * French should be met in their own language, not forced into English.
 *
 * IMPORTANT — three distinct languages are in play; do not conflate them:
 *   - CALLER-spoken language: what the caller speaks to THIS agent (English,
 *     Spanish, or French). Detected each turn; drives the bot's STT/TTS/reply
 *     language via the machinery here. This is what this file is about.
 *   - sourceLanguage (in intake.ts): the THIRD PARTY's language the caller needs
 *     interpreted (their patient/client). Asked, never detected. Not here.
 *   - targetLanguage (in intake.ts): what the third party is interpreted INTO —
 *     the caller's own language. Defaults to the detected caller language.
 *
 * ConversationRelay carries STT (transcription) and TTS languages. We set the
 * INITIAL caller language per-call from the TwiML customizer, and SWITCH mid-call
 * by sending a `language` message down the ConversationRelay WebSocket. TAC has no
 * dedicated "switch language" method, but exposes the raw socket via
 * `voiceChannel.getWebsocket(conversationId)`, so we send the CR control message
 * directly.
 */

import type { VoiceChannel, ConversationId } from 'twilio-agent-connect';

/**
 * Map a spoken language name to the codes and voice ConversationRelay needs.
 * Scoped to the three we have VERIFIED live — English, Spanish, French.
 *
 * All three use the SAME ElevenLabs multilingual voice, so the caller hears one
 * consistent male voice whichever language they use and across a mid-call switch —
 * rather than the jarring provider/timbre change we had when English was
 * ElevenLabs (CR default) but ES/FR were Google Neural2. ElevenLabs' multilingual
 * model speaks a single voice ID natively in each of these languages. A locale
 * still MUST be declared as a `<Language>` child WITH this voice for mid-call TTS
 * switching to it to work (a bare `<Language code>` broke the call entirely
 * against CR's default provider).
 *
 * NOTE on picking the ID: the legacy "Adam" (pNInz6obpgDQGcFmaJgB) is a
 * narration voice — loud and theatrical, wrong for a calm intake line. Use a
 * conversational-tuned voice ID (copied from the ElevenLabs voice's "Copy Voice
 * ID"). Same name can map to very different voices; audition the exact variant.
 *
 * `transcription` = STT locale, `tts` = TTS locale, `ttsProvider`/`voice` pin the
 * exact synthesis voice.
 */
interface LangCodes {
  transcription: string;
  tts: string;
  ttsProvider?: string;
  voice?: string;
}

// One ElevenLabs multilingual male voice for every language, so the voice is
// identical across languages and across a switch. Change this single ID to
// re-voice the whole agent. Exported so the base greeting (defaultTwimlOptions)
// uses the same voice as the conversation that follows.
export const ELEVENLABS_VOICE = 's3TPKV1kjDlVtZbl4Ksh'; // calm/conversational male
export const TTS_PROVIDER = 'ElevenLabs';

const EN: LangCodes = { transcription: 'en-US', tts: 'en-US', ttsProvider: TTS_PROVIDER, voice: ELEVENLABS_VOICE };
const ES: LangCodes = { transcription: 'es-US', tts: 'es-US', ttsProvider: TTS_PROVIDER, voice: ELEVENLABS_VOICE };
const FR: LangCodes = { transcription: 'fr-FR', tts: 'fr-FR', ttsProvider: TTS_PROVIDER, voice: ELEVENLABS_VOICE };

/**
 * Language name → codes. Keyed by the English name AND the endonym/other-language
 * names a caller (or the model) might use, so detection works regardless of which
 * language the name is spoken in. All aliases for one language map to the same
 * LangCodes.
 */
const LANGUAGES: Record<string, LangCodes> = {
  english: EN, anglais: EN, ingles: EN, 'inglés': EN, englisch: EN,
  spanish: ES, espanol: ES, 'español': ES, espagnol: ES, spanisch: ES,
  french: FR, francais: FR, 'français': FR, frances: FR, 'francés': FR,
};

export function resolveLanguage(name: string | undefined): LangCodes | undefined {
  if (!name) return undefined;
  return LANGUAGES[name.trim().toLowerCase()];
}

/**
 * Returning-caller "welcome back" greeting in the caller's own language, spoken
 * by the preset TTS voice before the first agent turn. English text in a French
 * voice was a bug: the greeting must be in the same language as the voice.
 */
const RETURNING_GREETINGS: Record<string, string> = {
  spanish: 'Bienvenido de nuevo. Puedo conectarle con un intérprete otra vez. ¿En qué puedo ayudarle?',
  french: 'Bon retour. Je peux à nouveau vous mettre en relation avec un interprète. Comment puis-je vous aider?',
};

export function returningGreeting(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return RETURNING_GREETINGS[name.trim().toLowerCase()];
}

/**
 * A short spoken acknowledgement in the language just switched TO, so the caller
 * hears the agent confirm the pivot before it continues in that language.
 */
const SWITCH_ACKS: Record<string, string> = {
  'en-US': "Of course — let's continue in English.",
  'es-US': 'Claro, sigamos en español.',
  'fr-FR': 'Bien sûr, continuons en français.',
};

export function switchAck(name: string | undefined): string | undefined {
  const codes = resolveLanguage(name);
  return codes ? SWITCH_ACKS[codes.tts] : undefined;
}

export function isSupported(name: string | undefined): boolean {
  return resolveLanguage(name) !== undefined;
}

/** Canonical English name for a language (any alias in), for prompt/state text. */
const CANONICAL: Record<string, string> = { 'en-US': 'English', 'es-US': 'Spanish', 'fr-FR': 'French' };
export function canonicalLanguage(name: string | undefined): string | undefined {
  const codes = resolveLanguage(name);
  return codes ? CANONICAL[codes.tts] : undefined;
}

/** True if the name resolves to English (any alias). */
export function isEnglish(name: string | undefined): boolean {
  return resolveLanguage(name)?.tts === 'en-US';
}

/**
 * The supported locales as ConversationRelay `<Language>` child declarations for
 * the initial TwiML (`defaultTwimlOptions.languages`, and every onInboundCallTwiml
 * return — the array replaces wholesale, so it must be present in each). All three
 * carry the same ElevenLabs `ttsProvider` + `voice`, so every language (and every
 * switch, including back to English) uses one consistent male voice. The
 * conditional spreads stay in case a locale is ever declared without a pinned
 * voice (CR's schema is strict about undefined values).
 */
export const SUPPORTED_LANGUAGE_DECLARATIONS = Array.from(
  // Dedup by tts code — LANGUAGES has multiple name aliases per locale.
  new Map(
    Object.values(LANGUAGES).map((c) => [
      c.tts,
      {
        code: c.tts,
        ...(c.ttsProvider ? { ttsProvider: c.ttsProvider } : {}),
        ...(c.voice ? { voice: c.voice } : {}),
      },
    ]),
  ).values(),
);

/**
 * The TwiML preset (ttsLanguage/transcriptionLanguage/voice/ttsProvider) for a
 * returning caller whose language we already know, so the first word is spoken in
 * their language. Undefined for English/unknown (the base greeting handles those).
 */
export function twimlPresetFor(name: string | undefined):
  | { ttsLanguage: string; transcriptionLanguage: string; voice?: string; ttsProvider?: string }
  | undefined {
  const codes = resolveLanguage(name);
  if (!codes || codes.tts === 'en-US') return undefined;
  return {
    ttsLanguage: codes.tts,
    transcriptionLanguage: codes.transcription,
    ...(codes.voice ? { voice: codes.voice } : {}),
    ...(codes.ttsProvider ? { ttsProvider: codes.ttsProvider } : {}),
  };
}

/**
 * Switch the live call's STT/TTS language by sending a ConversationRelay
 * `language` control message on the open WebSocket. Returns false if the socket
 * is gone or the language is unknown (caller hung up, or we don't map it).
 *
 * Per ConversationRelay docs the `language` message accepts `ttsLanguage` and
 * `transcriptionLanguage`.
 */
export function switchLanguage(
  voice: VoiceChannel,
  conversationId: ConversationId,
  languageName: string,
): boolean {
  const codes = resolveLanguage(languageName);
  if (!codes) return false;

  const ws = voice.getWebsocket(conversationId);
  if (!ws) return false;

  ws.send(
    JSON.stringify({
      type: 'language',
      ttsLanguage: codes.tts,
      transcriptionLanguage: codes.transcription,
    }),
  );
  return true;
}
