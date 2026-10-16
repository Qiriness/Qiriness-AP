// Read-only: compares a snapshot with pg_stat_statements now (or with a second snapshot).
// Usage: node scripts/.tmp-egress-diff.mjs <before.json> [after.json] [--top=40] [--by=calls|rows|blks]
import pg from 'pg';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadEnv } from './lib/sync-config.mjs';
import { SNAP_SQL } from './.tmp-egress-snap.mjs';
const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const top = Number(opt.top ?? 40), by = opt.by ?? 'calls';
const snap0 = JSON.parse(readFileSync(files[0], 'utf8'));
let now;
if (files[1]) now = JSON.parse(readFileSync(files[1], 'utf8'));
else {
  const c = new pg.Client({ connectionString: loadEnv().SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const { rows } = await c.query(SNAP_SQL);
  now = { at: rows[0].at_, info: (await c.query(`select dealloc, stats_reset from pg_stat_statements_info`)).rows[0], rows };
  await c.end();
}
const before = new Map(snap0.rows.map((r) => [r.id + r.role, r]));
const hours = (Date.parse(now.at) - Date.parse(snap0.at)) / 3600000;
const perDay = (n) => Math.round((n * 24) / hours);
const diff = now.rows.map((r) => {
  const b = before.get(r.id + r.role);
  const d = (k) => Number(r[k] ?? 0) - Number(b?.[k] ?? 0);
  return { role: r.role, calls: d('calls'), rows: d('rows_'), blks: d('blks'), fresh: !b, query: r.query.replace(/\s+/g, ' ').slice(0, 220) };
}).filter((r) => r.calls > 0);
const totals = {};
for (const r of diff) {
  const t = (totals[r.role] ??= { calls: 0, rows: 0, blks: 0 });
  t.calls += r.calls; t.rows += r.rows; t.blks += r.blks;
}
writeFileSync('tmp-egress-diff.json', JSON.stringify({ hours, infoBefore: snap0.info, infoNow: now.info, totals, diff }, null, 1));
console.log(`window ${hours.toFixed(2)} h; dealloc ${snap0.info.dealloc} -> ${now.info.dealloc} (an evicted entry re-appears as fresh)`);
console.log('per day by role:');
for (const [role, t] of Object.entries(totals)) console.log(`  ${role.padEnd(20)} calls ${String(perDay(t.calls)).padStart(8)}  rows ${String(perDay(t.rows)).padStart(9)}  blks ${String(perDay(t.blks)).padStart(10)}`);
console.log(`\ntop ${top} by ${by} (per day: calls / rows / blks):`);
for (const r of diff.sort((a, b) => b[by] - a[by]).slice(0, top))
  console.log(String(perDay(r.calls)).padStart(7), String(perDay(r.rows)).padStart(8), String(perDay(r.blks)).padStart(9), r.role === 'supabase_auth_admin' ? '[auth]' : '', r.fresh ? '*' : '', r.query);
