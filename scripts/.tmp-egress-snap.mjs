// Read-only: writes a pg_stat_statements snapshot (API roles + Auth) to a file.
// Usage: node scripts/.tmp-egress-snap.mjs <out.json>
import pg from 'pg';
import { writeFileSync } from 'node:fs';
import { loadEnv } from './lib/sync-config.mjs';
export const SNAP_SQL = `select now() at_, s.queryid::text id, r.rolname role, calls::bigint calls, rows::bigint rows_,
    (shared_blks_hit + shared_blks_read)::bigint blks, total_exec_time ms, query
  from pg_stat_statements s join pg_roles r on r.oid=s.userid
  where r.rolname in ('authenticator','authenticated','anon','service_role','supabase_auth_admin')`;
if (process.argv[1]?.includes('.tmp-egress-snap')) {
  const env = loadEnv();
  const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const { rows } = await c.query(SNAP_SQL);
  const info = (await c.query(`select dealloc, stats_reset from pg_stat_statements_info`)).rows[0];
  writeFileSync(process.argv[2], JSON.stringify({ at: rows[0]?.at_, info, rows }));
  console.log('saved', rows.length, 'statements at', rows[0]?.at_, info);
  await c.end();
}
