/**
 * The completeness gate is the headline design decision for Q&A ("how does the
 * agent decide it has enough info?") — the model proposes via record_intake, but
 * this deterministic check is what actually gates handoff. Covered directly.
 */

import { describe, expect, it } from 'vitest';
import { checkComplete, mergeIntake, summarize, type IntakeRecord } from './intake.js';

describe('checkComplete', () => {
  it('reports an empty record as incomplete', () => {
    expect(checkComplete({}).complete).toBe(false);
  });

  it('lists every missing required slot', () => {
    const { missing } = checkComplete({ sourceLanguage: 'Spanish' });
    expect(missing).toEqual(['targetLanguage', 'genderPreference', 'urgency', 'callbackNumber']);
  });

  it('is complete once every required slot is set, leaving optional ones out of it', () => {
    const record: IntakeRecord = {
      sourceLanguage: 'Spanish',
      targetLanguage: 'English',
      genderPreference: 'no_preference',
      urgency: 'now',
      callbackNumber: '+15551234567',
    };
    const result = checkComplete(record);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('treats an empty string the same as a missing value', () => {
    const { complete } = checkComplete({
      sourceLanguage: 'Spanish',
      targetLanguage: 'English',
      genderPreference: 'no_preference',
      urgency: 'now',
      callbackNumber: '   ',
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
    const base: IntakeRecord = { callbackNumber: '+15551234567' };
    const next = mergeIntake(base, { callbackNumber: '' });
    expect(next.callbackNumber).toBe('+15551234567');
  });

  it('does not mutate the base record', () => {
    const base: IntakeRecord = { sourceLanguage: 'Spanish' };
    mergeIntake(base, { targetLanguage: 'English' });
    expect(base).toEqual({ sourceLanguage: 'Spanish' });
  });
});

describe('summarize', () => {
  it('formats the language pair, gender, urgency, and callback number', () => {
    const summary = summarize({
      sourceLanguage: 'Spanish',
      targetLanguage: 'English',
      genderPreference: 'female',
      urgency: 'now',
      callbackNumber: '+15551234567',
    });
    expect(summary).toBe('Spanish to English, female interpreter, needed now, callback +15551234567');
  });

  it('omits a no_preference gender rather than naming it', () => {
    const summary = summarize({ genderPreference: 'no_preference' });
    expect(summary).not.toContain('no_preference');
  });
});
