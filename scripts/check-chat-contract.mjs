// Checks the management chat's views as the chat role: every view runs, and the
// schema text the model is shown matches supabase/chat-contract.snapshot.txt.
//   npm run db:check:chat              check (exit 1 on a failure or a change)
//   npm run db:check:chat -- --update  accept the current text as the snapshot
// Read-only: each view runs inside a rolled-back read-only transaction and
// returns a count, never row data. Connects with CHAT_DB_URL (the chat role).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

import { checkChatContract } from './lib/chat-contract.mjs';
import { loadEnv } from './lib/sync-config.mjs';

export const SNAPSHOT = fileURLToPath(new URL('../supabase/chat-contract.snapshot.txt', import.meta.url));

export async function runChatContractCheck({ update = false, log = console.log } = {}) {
  const env = loadEnv();
  if (!env.CHAT_DB_URL) {
    log('chat contract: skipped (CHAT_DB_URL is not set)');
    return { skipped: true, ok: true };
  }
  const client = new pg.Client({ connectionString: env.CHAT_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const snapshot = existsSync(SNAPSHOT) ? readFileSync(SNAPSHOT, 'utf8') : null;
    const result = await checkChatContract(client, snapshot);
    for (const f of result.failed) log(`chat contract: chat.${f.view} FAILS as the chat role: ${f.error}`);
    if (update) {
      writeFileSync(SNAPSHOT, result.text.endsWith('\n') ? result.text : `${result.text}\n`);
      log(`chat contract: snapshot written (${result.views} views)${result.failed.length ? ' — but some views FAIL, see above' : ''}`);
      return { ...result, ok: result.failed.length === 0 };
    }
    if (snapshot === null) log('chat contract: no snapshot yet; run with --update to create it');
    if (result.changed.length) {
      log(`chat contract: what the model is shown CHANGED (${result.changed.length} lines). Review, then --update if intended:`);
      for (const line of result.changed) log(`  ${line.length > 220 ? `${line.slice(0, 220)}…` : line}`);
    }
    if (result.ok) log(`chat contract: ok (${result.views} views run as the chat role, schema text unchanged)`);
    return result;
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runChatContractCheck({ update: process.argv.includes('--update') })
    .then((result) => { if (!result.ok) process.exitCode = 1; })
    .catch((error) => { console.error(`chat contract: ${error.message}`); process.exitCode = 1; });
}
