import { describe, expect, it } from 'vitest';
import { resolveLanguage, isSupported } from './language.js';

describe('resolveLanguage', () => {
  it('resolves a known language to its transcription/tts codes', () => {
    expect(resolveLanguage('Spanish')).toEqual({ transcription: 'es-US', tts: 'es-US' });
  });

  it('is case- and whitespace-insensitive', () => {
    expect(resolveLanguage('  MANDARIN  ')).toEqual({ transcription: 'zh-CN', tts: 'zh-CN' });
  });

  it('returns undefined for an unmapped language', () => {
    expect(resolveLanguage('Klingon')).toBeUndefined();
  });

  it('returns undefined for an empty name', () => {
    expect(resolveLanguage(undefined)).toBeUndefined();
  });
});

describe('isSupported', () => {
  it('is true for a mapped language', () => {
    expect(isSupported('French')).toBe(true);
  });

  it('is false for an unmapped language', () => {
    expect(isSupported('Klingon')).toBe(false);
  });
});
