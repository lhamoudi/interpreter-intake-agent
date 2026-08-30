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
 * Map a spoken language name (as the model reports it) to the BCP-47 codes
 * ConversationRelay expects. Kept deliberately small — the common OPI languages.
 * `transcription` is the STT locale; `tts` is the speech-synthesis locale.
 */
interface LangCodes {
  transcription: string;
  tts: string;
}

const LANGUAGES: Record<string, LangCodes> = {
  english: { transcription: 'en-US', tts: 'en-US' },
  spanish: { transcription: 'es-US', tts: 'es-US' },
  french: { transcription: 'fr-FR', tts: 'fr-FR' },
  mandarin: { transcription: 'zh-CN', tts: 'zh-CN' },
  chinese: { transcription: 'zh-CN', tts: 'zh-CN' },
  arabic: { transcription: 'ar-AE', tts: 'ar-XA' },
  russian: { transcription: 'ru-RU', tts: 'ru-RU' },
  portuguese: { transcription: 'pt-BR', tts: 'pt-BR' },
  vietnamese: { transcription: 'vi-VN', tts: 'vi-VN' },
  haitian: { transcription: 'fr-FR', tts: 'fr-FR' }, // Haitian Creole: nearest supported
};

export function resolveLanguage(name: string | undefined): LangCodes | undefined {
  if (!name) return undefined;
  return LANGUAGES[name.trim().toLowerCase()];
}

/**
 * The distinct TTS/transcription locales we support, as ConversationRelay
 * `<Language>` child declarations. These MUST be declared in the initial TwiML
 * (`defaultTwimlOptions.languages`) or a mid-call `set_language` switch to a
 * non-default locale has no configured voice and the TTS silently stays English
 * — the exact bug seen on a live French call. `voice` is omitted so CR uses each
 * locale's default voice; a specific voice can be pinned per language later.
 */
export const SUPPORTED_LANGUAGE_DECLARATIONS: { code: string }[] = Array.from(
  new Set(Object.values(LANGUAGES).map((c) => c.tts)),
).map((code) => ({ code }));

export function isSupported(name: string | undefined): boolean {
  return resolveLanguage(name) !== undefined;
}

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
