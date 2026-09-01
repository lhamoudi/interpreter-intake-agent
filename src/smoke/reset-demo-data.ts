/**
 * One-off: clear returning-caller memory before a demo, so the demo number
 * isn't recognised as a repeat caller from earlier test calls. Pass
 * --requests to also clear the requests table (durable intake records) for
 * a fully blank slate.
 *
 * Run with: npx tsx src/smoke/reset-demo-data.ts [--requests]
 */

import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const clearRequestsToo = process.argv.includes('--requests');

console.log('Target DB:', process.env.TURSO_DATABASE_URL);

const callers = await client.execute('DELETE FROM callers');
console.log(`Cleared callers (memory): ${callers.rowsAffected} row(s)`);

if (clearRequestsToo) {
  const requests = await client.execute('DELETE FROM requests');
  console.log(`Cleared requests: ${requests.rowsAffected} row(s)`);
} else {
  console.log('requests table left untouched (pass --requests to clear it too)');
}
