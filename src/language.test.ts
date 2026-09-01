/**
 * The language map is what makes mid-call switching reliable: every supported
 * locale must resolve (from any alias) to codes WITH a real TTS voice, and
 * anything unsupported must resolve to nothing so we never send a broken switch.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveLanguage,
  isEnglish,
  canonicalLanguage,
  switchAck,
  twimlPresetFor,
  SUPPORTED_LANGUAGE_DECLARATIONS,
} from './language.js';

describe('resolveLanguage', () => {
  it('resolves each supported language to its locale codes', () => {
    expect(resolveLanguage('English')?.tts).toBe('en-US');
    expect(resolveLanguage('Spanish')?.tts).toBe('es-US');
    expect(resolveLanguage('French')?.tts).toBe('fr-FR');
  });

  it('resolves endonyms and cross-language aliases', () => {
    expect(resolveLanguage('anglais')?.tts).toBe('en-US');
    expect(resolveLanguage('español')?.tts).toBe('es-US');
    expect(resolveLanguage('français')?.tts).toBe('fr-FR');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(resolveLanguage('  SPANISH ')?.tts).toBe('es-US');
  });

  it('returns undefined for an unsupported language', () => {
    expect(resolveLanguage('German')).toBeUndefined();
    expect(resolveLanguage('Mandarin')).toBeUndefined();
    expect(resolveLanguage(undefined)).toBeUndefined();
  });
});

describe('canonicalLanguage / isEnglish', () => {
  it('canonicalizes any alias to the English name', () => {
    expect(canonicalLanguage('français')).toBe('French');
    expect(canonicalLanguage('espanol')).toBe('Spanish');
  });
  it('detects English across aliases', () => {
    expect(isEnglish('anglais')).toBe(true);
    expect(isEnglish('French')).toBe(false);
  });
});

describe('switchAck', () => {
  it('gives a localized acknowledgement per language', () => {
    expect(switchAck('Spanish')).toMatch(/español/i);
    expect(switchAck('French')).toMatch(/français/i);
    expect(switchAck('English')).toMatch(/English/i);
    expect(switchAck('German')).toBeUndefined();
  });
});

describe('twimlPresetFor', () => {
  it('returns a voice preset for non-English callers', () => {
    expect(twimlPresetFor('Spanish')).toMatchObject({ ttsLanguage: 'es-US', ttsProvider: 'ElevenLabs' });
  });
  it('returns undefined for English (base voice) and unknowns', () => {
    expect(twimlPresetFor('English')).toBeUndefined();
    expect(twimlPresetFor('German')).toBeUndefined();
  });
});

describe('SUPPORTED_LANGUAGE_DECLARATIONS', () => {
  it('declares exactly the three supported locales', () => {
    expect(SUPPORTED_LANGUAGE_DECLARATIONS).toHaveLength(3);
    const codes = SUPPORTED_LANGUAGE_DECLARATIONS.map((d) => d.code).sort();
    expect(codes).toEqual(['en-US', 'es-US', 'fr-FR']);
  });

  it('uses one ElevenLabs voice across all three locales', () => {
    const voices = new Set(SUPPORTED_LANGUAGE_DECLARATIONS.map((d) => d.voice));
    const providers = new Set(SUPPORTED_LANGUAGE_DECLARATIONS.map((d) => d.ttsProvider));
    expect(voices.size).toBe(1); // same voice ID for EN/ES/FR
    expect([...voices][0]).toBeTruthy();
    expect([...providers]).toEqual(['ElevenLabs']);
  });
});
