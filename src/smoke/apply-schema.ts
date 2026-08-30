/**
 * One-off: apply schema.sql to the configured Turso database.
 * Run with: npx tsx src/smoke/apply-schema.ts
 */

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const sql = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
const statements = sql
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

for (const stmt of statements) {
  await client.execute(stmt);
  console.log('OK:', stmt.split('\n')[0].slice(0, 60));
}

const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
console.log('\nTables now present:', tables.rows.map((r) => r.name));
