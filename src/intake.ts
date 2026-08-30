/**
 * The intake record and its completeness rules.
 *
 * Design decision that the panel will probe ("how does the agent decide it has
 * enough info?"): the LLM proposes slot values via the `record_intake` tool, but
 * it does NOT get to decide the intake is done. Completeness is a deterministic,
 * server-side check against REQUIRED_SLOTS. The agent may only hand off once this
 * function says the record is complete.
 */

export type GenderPreference = 'male' | 'female' | 'no_preference';
export type Industry = 'medical' | 'legal' | 'community';
export type Urgency = 'now' | 'scheduled';

/**
 * How the caller chose to be served, offered once the required intake is complete:
 *  - 'ai'    — AI interprets the call itself now (cheapest; roadmap, offered but
 *              actual live AI interpretation is not built — falls back to human).
 *  - 'human' — a human interpreter calls them back (premium).
 *  - 'video' — deflect to a Twilio Video Room (WebRTC) via an SMS'd join link
 *              (good for screensharing / documents; removes PSTN per-minute cost).
 */
export type ServiceTier = 'ai' | 'human' | 'video';

/** A single interpreter request, built up slot-by-slot over the call. */
export interface IntakeRecord {
  /** Language the caller speaks (BCP-47 or plain name as heard). */
  sourceLanguage?: string;
  /** Language they need interpreted to (usually English for US OPI). */
  targetLanguage?: string;
  genderPreference?: GenderPreference;
  /** Optional — many calls have no industry preference. */
  industry?: Industry;
  urgency?: Urgency;
  callbackNumber?: string;
  /**
   * When a scheduled caller wants the callback, exactly as they said it
   * ("in 5 minutes", "tomorrow at 3pm"). Kept verbatim so a human never has to
   * trust the parse alone.
   */
  scheduledTimeText?: string;
  /**
   * The above resolved to an ISO-8601 timestamp (Claude computes it from the
   * current time given in the prompt). May be absent if the caller was vague.
   */
  scheduledTimeISO?: string;
  /** Free text: "what matters most" — context for the interpreter. */
  notes?: string;
  /** Which service tier the caller chose (set at deflection, after core intake). */
  serviceTier?: ServiceTier;
  /**
   * Email for the video-session join link. Collected ONLY on the video tier
   * (SMS is blocked by A2P 10DLC on this account). In the production vision this
   * comes from the member's registered profile — see WRITEUP.
   */
  email?: string;
}

/**
 * Slots that MUST be present before we will secure an interpreter, regardless of
 * how the caller wants to be served. `industry` and `notes` are optional;
 * `callbackNumber` is conditionally required (see checkComplete) — a "now" caller
 * is connected live, so no callback number is needed; only a "scheduled" caller
 * needs one.
 */
export const REQUIRED_SLOTS = [
  'sourceLanguage',
  'targetLanguage',
  'genderPreference',
  'urgency',
] as const satisfies readonly (keyof IntakeRecord)[];

export interface Completeness {
  complete: boolean;
  missing: (keyof IntakeRecord)[];
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** Deterministic completeness check. This — not the model — gates handoff. */
export function checkComplete(record: IntakeRecord): Completeness {
  const required: (keyof IntakeRecord)[] = [...REQUIRED_SLOTS];
  // A scheduled (call-back-later) request needs a callback number AND a requested
  // time; an urgent "now" request is connected live, so it needs neither.
  if (record.urgency === 'scheduled') required.push('callbackNumber', 'scheduledTimeText');

  const missing = required.filter((slot) => {
    const v = record[slot];
    return isBlank(v);
  });
  return { complete: missing.length === 0, missing };
}

/** Merge a partial update from the model into the running record. */
export function mergeIntake(base: IntakeRecord, patch: Partial<IntakeRecord>): IntakeRecord {
  const next: IntakeRecord = { ...base };
  for (const [k, v] of Object.entries(patch) as [keyof IntakeRecord, unknown][]) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    (next as Record<string, unknown>)[k] = v;
  }
  return next;
}

/** Short human-readable summary used in confirmations and the handoff payload. */
export function summarize(record: IntakeRecord): string {
  const parts = [
    record.sourceLanguage && `${record.sourceLanguage} to ${record.targetLanguage ?? 'English'}`,
    record.genderPreference && record.genderPreference !== 'no_preference'
      ? `${record.genderPreference} interpreter`
      : undefined,
    record.industry,
    record.urgency === 'now'
      ? 'needed now'
      : record.urgency === 'scheduled'
        ? `scheduled${record.scheduledTimeText ? ` for ${record.scheduledTimeText}` : ''}`
        : undefined,
    record.callbackNumber && `callback ${record.callbackNumber}`,
  ].filter(Boolean);
  return parts.join(', ');
}
