/**
 * Persistence + returning-caller memory (Turso / libSQL).
 *
 * Two responsibilities:
 *  1. Durable record of every intake (complete or abandoned) — retrievable by a
 *     coordinator via GET /requests.
 *  2. Memory across calls: keyed by a SALTED HASH of the caller's number, never
 *     the raw PSTN identity. A returning caller's known preferences are injected
 *     into the system prompt so the agent can skip questions it already knows.
 */

import { createHash } from 'node:crypto';
import { createClient, type Client } from '@libsql/client';
import type { IntakeRecord } from './intake.js';

let client: Client | null = null;

function db(): Client {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error('TURSO_DATABASE_URL is not set');
  client = createClient({ url, authToken });
  return client;
}

/** Salted hash of an E.164 number — the only caller identifier we store. */
export function hashCaller(address: string | undefined): string | null {
  if (!address) return null;
  const salt = process.env.CALLER_HASH_SALT ?? 'dev-salt';
  return createHash('sha256').update(salt).update(address).digest('hex').slice(0, 32);
}

export interface CallerMemory {
  sourceLanguage?: string;
  targetLanguage?: string;
  genderPreference?: string;
  industry?: string;
  callbackNumber?: string;
  callCount: number;
}

/** Look up what we know about a returning caller. Null on first contact. */
export async function getCallerMemory(callerHash: string | null): Promise<CallerMemory | null> {
  if (!callerHash) return null;
  const res = await db().execute({
    sql: 'SELECT source_language, target_language, gender_preference, industry, callback_number, call_count FROM callers WHERE caller_hash = ?',
    args: [callerHash],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    sourceLanguage: (row.source_language as string) ?? undefined,
    targetLanguage: (row.target_language as string) ?? undefined,
    genderPreference: (row.gender_preference as string) ?? undefined,
    industry: (row.industry as string) ?? undefined,
    callbackNumber: (row.callback_number as string) ?? undefined,
    callCount: Number(row.call_count ?? 0),
  };
}

/** Upsert the caller's latest known preferences and bump their call count. */
export async function rememberCaller(callerHash: string | null, r: IntakeRecord): Promise<void> {
  if (!callerHash) return;
  await db().execute({
    sql: `INSERT INTO callers (caller_hash, source_language, target_language, gender_preference, industry, callback_number, call_count, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))
          ON CONFLICT(caller_hash) DO UPDATE SET
            source_language = COALESCE(excluded.source_language, source_language),
            target_language = COALESCE(excluded.target_language, target_language),
            gender_preference = COALESCE(excluded.gender_preference, gender_preference),
            industry = COALESCE(excluded.industry, industry),
            callback_number = COALESCE(excluded.callback_number, callback_number),
            call_count = call_count + 1,
            last_seen_at = datetime('now')`,
    args: [
      callerHash,
      r.sourceLanguage ?? null,
      r.targetLanguage ?? null,
      r.genderPreference ?? null,
      r.industry ?? null,
      r.callbackNumber ?? null,
    ],
  });
}

/** Write the durable request record. `status` is 'complete' or 'abandoned'. */
export async function saveRequest(params: {
  id: string;
  conversationId: string;
  callerHash: string | null;
  status: 'complete' | 'abandoned';
  record: IntakeRecord;
}): Promise<void> {
  const { id, conversationId, callerHash, status, record: r } = params;
  await db().execute({
    sql: `INSERT INTO requests (id, conversation_id, caller_hash, status, source_language, target_language,
             gender_preference, industry, urgency, callback_number, notes, raw_intake, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'complete' THEN datetime('now') ELSE NULL END)`,
    args: [
      id,
      conversationId,
      callerHash,
      status,
      r.sourceLanguage ?? null,
      r.targetLanguage ?? null,
      r.genderPreference ?? null,
      r.industry ?? null,
      r.urgency ?? null,
      r.callbackNumber ?? null,
      r.notes ?? null,
      JSON.stringify(r),
      status,
    ],
  });
}

/** Read-back for the coordinator dashboard (GET /requests). */
export async function listRequests(limit = 50): Promise<Record<string, unknown>[]> {
  const res = await db().execute({
    sql: 'SELECT id, conversation_id, status, source_language, target_language, gender_preference, industry, urgency, callback_number, notes, created_at, completed_at FROM requests ORDER BY created_at DESC LIMIT ?',
    args: [limit],
  });
  return res.rows as unknown as Record<string, unknown>[];
}
