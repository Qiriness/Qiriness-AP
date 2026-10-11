// Read-only: compares tmp-egress-snap0.json with pg_stat_statements now.
// Usage: node scripts/.tmp-egress-diff.mjs [top=60]
import pg from 'pg';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadEnv } from './lib/sync-config.mjs';
const snap0 = JSON.parse(readFileSync('tmp-egress-snap0.json', 'utf8'));
const env = loadEnv();
const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rows } = await c.query(`select now() at_, s.queryid::text id, r.rolname role, calls::bigint calls, total_exec_time ms, query
  from pg_stat_statements s join pg_roles r on r.oid=s.userid
  where r.rolname in ('authenticator','authenticated','anon','service_role')`);
const info = (await c.query(`select dealloc, stats_reset from pg_stat_statements_info`)).rows[0];
await c.end();
const before = new Map(snap0.rows.map((r) => [r.id + r.role, r]));
const hours = (Date.parse(rows[0].at_) - Date.parse(snap0.at)) / 3600000;
const diff = rows.map((r) => ({ calls: Number(r.calls) - Number(before.get(r.id + r.role)?.calls ?? 0), perDay: 0, role: r.role, query: r.query.replace(/\s+/g, ' ').slice(0, 300) }))
  .filter((r) => r.calls > 0).map((r) => ({ ...r, perDay: Math.round(r.calls * 24 / hours) })).sort((a, b) => b.calls - a.calls);
writeFileSync('tmp-egress-diff.json', JSON.stringify({ hours, infoBefore: snap0.info, infoNow: info, diff }, null, 1));
console.log(`window ${hours.toFixed(2)} h; dealloc ${snap0.info.dealloc} -> ${info.dealloc} (eviction makes new entries look like fresh calls)`);
for (const r of diff.slice(0, Number(process.argv[2] ?? 60))) console.log(String(r.perDay).padStart(7), '/day ', r.query);
