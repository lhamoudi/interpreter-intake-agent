-- Interpreter intake persistence (Turso / libSQL — SQLite dialect).
-- Two tables: durable record of each request, and per-caller memory.

CREATE TABLE IF NOT EXISTS requests (
  id                   TEXT PRIMARY KEY,          -- uuid
  conversation_id      TEXT NOT NULL,
  caller_hash          TEXT,                       -- hashed E.164, links to callers
  status               TEXT NOT NULL,              -- 'complete' | 'abandoned' | 'declined'
  source_language      TEXT,                       -- language the caller speaks
  target_language      TEXT,                       -- language they need interpreted to
  gender_preference    TEXT,                       -- 'male' | 'female' | 'no_preference'
  industry             TEXT,                       -- 'medical' | 'legal' | 'community' | null
  service_tier         TEXT,                       -- 'ai' | 'human' | 'video' | null
  notes                TEXT,                       -- free-text "what matters most"
  raw_intake           TEXT,                       -- full JSON snapshot
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_requests_caller ON requests (caller_hash);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests (created_at);

-- Returning-caller memory. Keyed by a salted hash of the caller number so we
-- never store the raw PSTN identity. Holds the last-known preferences so a
-- repeat caller can skip questions.
CREATE TABLE IF NOT EXISTS callers (
  caller_hash          TEXT PRIMARY KEY,
  source_language      TEXT,
  target_language      TEXT,
  gender_preference    TEXT,
  industry             TEXT,
  call_count           INTEGER NOT NULL DEFAULT 0,
  last_seen_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
