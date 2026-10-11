// Read-only: writes a pg_stat_statements snapshot (PostgREST roles) to a file.
import pg from 'pg';
import { writeFileSync } from 'node:fs';
import { loadEnv } from './lib/sync-config.mjs';
const env = loadEnv();
const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rows } = await c.query(`select now() at_, s.queryid::text id, r.rolname role, calls::bigint calls, total_exec_time ms, query
  from pg_stat_statements s join pg_roles r on r.oid=s.userid
  where r.rolname in ('authenticator','authenticated','anon','service_role')`);
const info = (await c.query(`select dealloc, stats_reset from pg_stat_statements_info`)).rows[0];
writeFileSync(process.argv[2], JSON.stringify({ at: rows[0]?.at_, info, rows }));
console.log('saved', rows.length, 'statements at', rows[0]?.at_, info);
await c.end();
