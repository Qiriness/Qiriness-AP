/**
 * Sets (or rotates) the password of `qiriness_worker`, the direct-connection
 * login role (migration direct_worker_connection), and writes WORKER_DB_URL to .env.local.
 *
 *   node scripts/set-worker-db-password.mjs
 *
 * Connects as SUPABASE_DB_URL (`postgres`). The password is random and never
 * printed; Postgres receives only its SCRAM-SHA-256 verifier, because
 * `log_statement = ddl` writes every ALTER ROLE to the database log and a
 * plain password would land there. Copy WORKER_DB_URL from .env.local to the
 * Render worker and the GitHub Actions secret of the same name, then set
 * SUPABASE_DB_TRANSPORT=pg beside it. Rotating: run again, then update both;
 * the old password stops working at once.
 *
 * Ends by connecting as the new role the way the transport does and checking
 * it logs in acting as `service_role` (role settings from the migration).
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

import { WORKER_ROLE } from './lib/schema-catalog.mjs';
import { connectionConfig } from './lib/supabase-pg-transport.mjs';
import { loadEnv } from './lib/sync-config.mjs';

const ENV_FILE = '.env.local';

/** The verifier Postgres stores for a SCRAM-SHA-256 password (RFC 5802 / 7677). */
export function scramVerifier(password, { salt = randomBytes(16), iterations = 4096 } = {}) {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** The pooler's user name is `<role>.<project ref>`; a direct host's is the bare role. */
export function workerUrl(adminUrl, password) {
  const url = new URL(adminUrl);
  const [, ref] = decodeURIComponent(url.username).split('.');
  url.username = ref ? `${WORKER_ROLE}.${ref}` : WORKER_ROLE;
  url.password = password;
  url.search = '';
  return url.toString();
}

function writeEnvValue(key, value) {
  const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  writeFileSync(ENV_FILE, pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n?$/, '\n')}${line}\n`);
}

if (process.argv[1]?.endsWith('set-worker-db-password.mjs')) {
  const env = loadEnv();
  if (!env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL is required (the postgres connection).');

  // base64url: no character that needs escaping in a URL or a shell.
  const password = randomBytes(32).toString('base64url');
  const admin = new pg.Client({ ...connectionConfig(env.SUPABASE_DB_URL, 'set-worker-db-password') });
  await admin.connect();
  try {
    const exists = (await admin.query('select 1 from pg_roles where rolname = $1', [WORKER_ROLE])).rowCount === 1;
    if (!exists) throw new Error(`Role ${WORKER_ROLE} does not exist: apply the direct_worker_connection migration first.`);
    // ALTER ROLE takes no parameters; the verifier is base64 and '$', so quoting it is safe.
    await admin.query(`alter role ${WORKER_ROLE} password '${scramVerifier(password)}'`);
  } finally {
    await admin.end();
  }

  const url = workerUrl(env.SUPABASE_DB_URL, password);
  writeEnvValue('WORKER_DB_URL', url);

  const check = new pg.Client(connectionConfig(url, 'set-worker-db-password-check'));
  await check.connect();
  try {
    const { rows: [who] } = await check.query('select session_user, current_user, current_setting($1) as statement_timeout', ['statement_timeout']);
    console.log(`password set; WORKER_DB_URL written to ${ENV_FILE}`);
    console.log(`connected as ${who.session_user}, acting as ${who.current_user}, statement_timeout ${who.statement_timeout}`);
    if (who.current_user !== 'service_role') throw new Error('The worker role does not act as service_role: check its role settings.');
  } finally {
    await check.end();
  }
}
