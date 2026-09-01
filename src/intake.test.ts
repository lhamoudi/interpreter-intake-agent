/**
 * Tests for the completeness check that decides when the intake is done:
 * Claude fills slots via record_intake, but checkComplete against
 * REQUIRED_SLOTS is what actually decides.
 */

import { describe, expect, it } from 'vitest';
import { checkComplete, mergeIntake, summarize, type IntakeRecord } from './intake.js';

describe('checkComplete', () => {
  it('reports an empty record as incomplete', () => {
    expect(checkComplete({}).complete).toBe(false);
  });

  it('lists every missing required slot', () => {
    const { missing } = checkComplete({ sourceLanguage: 'Spanish' });
    expect(missing).toEqual(['targetLanguage', 'genderPreference']);
  });

  it('is complete once language pair and gender are set', () => {
    const result = checkComplete({
      sourceLanguage: 'Spanish',
      targetLanguage: 'English',
      genderPreference: 'no_preference',
    });
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('treats an empty-string required value as missing', () => {
    const { complete } = checkComplete({
      sourceLanguage: 'Spanish',
      targetLanguage: 'English',
      genderPreference: '   ' as never,
    });
    expect(complete).toBe(false);
  });
});

describe('mergeIntake', () => {
  it('applies a field onto an empty base', () => {
    const next = mergeIntake({}, { sourceLanguage: 'Spanish' });
    expect(next.sourceLanguage).toBe('Spanish');
  });

  it('keeps the prior value when the patch sends undefined', () => {
    const base: IntakeRecord = { sourceLanguage: 'Spanish' };
    const next = mergeIntake(base, { sourceLanguage: undefined, targetLanguage: 'English' });
    expect(next.sourceLanguage).toBe('Spanish');
    expect(next.targetLanguage).toBe('English');
  });

  it('ignores a blank-string patch value rather than clobbering the prior one', () => {
    const base: IntakeRecord = { sourceLanguage: 'Spanish' };
    const next = mergeIntake(base, { sourceLanguage: '' });
    expect(next.sourceLanguage).toBe('Spanish');
  });

  it('does not mutate the base record', () => {
    const base: IntakeRecord = { sourceLanguage: 'Spanish' };
    mergeIntake(base, { targetLanguage: 'English' });
    expect(base).toEqual({ sourceLanguage: 'Spanish' });
  });
});

describe('summarize', () => {
  it('formats the language pair, gender, and industry', () => {
    const summary = summarize({
      sourceLanguage: 'Spanish',
      targetLanguage: 'English',
      genderPreference: 'female',
      industry: 'medical',
    });
    expect(summary).toBe('Spanish to English, female interpreter, medical');
  });

  it('omits a no_preference gender rather than naming it', () => {
    const summary = summarize({ genderPreference: 'no_preference' });
    expect(summary).not.toContain('no_preference');
  });
});
