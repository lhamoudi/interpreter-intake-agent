/**
 * Language handling — the accessibility feature that makes this an interpreter
 * product rather than a generic form-filler. A caller who does not speak English
 * should be met in their own language.
 *
 * ConversationRelay carries STT (transcription) and TTS languages. We can set the
 * INITIAL language per-call from the TwiML customizer, and we can SWITCH language
 * mid-call by sending a `language` message down the ConversationRelay WebSocket.
 *
 * TAC does not expose a dedicated "switch language" method, but it does expose the
 * raw socket via `voiceChannel.getWebsocket(conversationId)`, so we send the
 * ConversationRelay control message directly.
 */

import type { VoiceChannel, ConversationId } from 'twilio-agent-connect';

/**
 * Map a spoken language name (as the model reports it) to the codes and voice
 * ConversationRelay needs. Scoped to the languages we have VERIFIED live —
 * English (the parent default) plus French and Spanish — each with an explicit
 * Google TTS voice, because mid-call TTS switching only works for a locale that
 * is declared as a `<Language>` child WITH a real voice (bare `<Language code>`
 * children broke the call entirely against CR's ElevenLabs default). Adding more
 * languages means declaring each here with a validated Google voice and testing
 * it on a real call — don't add unverified ones.
 *
 * `transcription` = STT locale, `tts` = TTS locale, `ttsProvider`/`voice` pin the
 * exact synthesis voice.
 */
interface LangCodes {
  transcription: string;
  tts: string;
  ttsProvider: string;
  voice: string;
}

const EN: LangCodes = { transcription: 'en-US', tts: 'en-US', ttsProvider: 'Google', voice: 'en-US-Neural2-C' };
const ES: LangCodes = { transcription: 'es-US', tts: 'es-US', ttsProvider: 'Google', voice: 'es-US-Neural2-A' };
const FR: LangCodes = { transcription: 'fr-FR', tts: 'fr-FR', ttsProvider: 'Google', voice: 'fr-FR-Neural2-F' };

/**
 * Language name → codes. Keyed by the English name AND the endonym/other-language
 * names a caller might use, so "switch to English" works when the caller says it
 * in their own language ("anglais", "inglés"). All aliases for one language map
 * to the same LangCodes.
 */
const LANGUAGES: Record<string, LangCodes> = {
  english: EN, anglais: EN, ingles: EN, 'inglés': EN, englisch: EN,
  spanish: ES, espanol: ES, 'español': ES, espagnol: ES,
  french: FR, francais: FR, 'français': FR, frances: FR, 'francés': FR,
};

export function resolveLanguage(name: string | undefined): LangCodes | undefined {
  if (!name) return undefined;
  return LANGUAGES[name.trim().toLowerCase()];
}

/**
 * Returning-caller "welcome back" greeting in the caller's own language, spoken
 * by the preset TTS voice before the first agent turn. English text in a French
 * voice was the bug: the greeting must be in the same language as the voice.
 */
const RETURNING_GREETINGS: Record<string, string> = {
  spanish: 'Bienvenido de nuevo. Puedo conectarle con un intérprete de español otra vez. ¿Continuamos?',
  french: 'Bon retour. Je peux à nouveau vous mettre en relation avec un interprète français. On continue?',
};

export function returningGreeting(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return RETURNING_GREETINGS[name.trim().toLowerCase()];
}

export function isSupported(name: string | undefined): boolean {
  return resolveLanguage(name) !== undefined;
}

/** Canonical English name for a language (any alias in), for prompt text. */
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
 * The non-English locales we support, as ConversationRelay `<Language>` child
 * declarations for the initial TwiML (`defaultTwimlOptions.languages`). Each
 * carries an explicit `ttsProvider` + `voice` — a bare `<Language code=...>`
 * with no voice broke the call entirely against CR's ElevenLabs default (CR
 * rejected the TwiML, no WebSocket opened, caller got an error tone). English is
 * the parent default and is NOT re-declared here. A mid-call switch to one of
 * these locales then has a real voice to use.
 */
export const SUPPORTED_LANGUAGE_DECLARATIONS = Array.from(
  // Dedup by tts code — LANGUAGES has multiple name aliases per locale.
  new Map(
    Object.values(LANGUAGES)
      .filter((c) => c.tts !== 'en-US')
      .map((c) => [c.tts, { code: c.tts, ttsProvider: c.ttsProvider, voice: c.voice }]),
  ).values(),
);

/**
 * Switch the live call's STT/TTS language by sending a ConversationRelay
 * `language` control message on the open WebSocket. Returns false if the socket
 * is gone or the language is unknown (caller has hung up, or we don't map it).
 *
 * See ConversationRelay docs: the `language` message accepts `ttsLanguage` and
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
