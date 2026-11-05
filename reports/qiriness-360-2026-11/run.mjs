// Read-only runner for the Qiriness 360° analysis.
//
//   node reports/qiriness-360-2026-11/run.mjs            # every sql/*.sql
//   node reports/qiriness-360-2026-11/run.mjs 04 07      # files starting with 04, 07
//
// SCOPE GUARD: Qiriness only. Every statement must contain the Qiriness shop id
// (written as :shop and substituted here), and no statement may contain a
// writing keyword. The session is `begin read only` and always rolls back.
// Barbara Gould's shop is never named, read or joined.
//
// A file holds one or more statements, each introduced by `-- name: <csv>`.
// Each result is written to data/<csv>.csv (aggregates only, no personal data).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from '../../node_modules/pg/lib/index.js';

pg.types.setTypeParser(1082, (v) => v); // dates stay 'YYYY-MM-DD' (no local-time shift)

export const QIRINESS_SHOP_ID = '1f0e5eb2-e375-4363-9d34-c3c352231a37';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }),
);

const FORBIDDEN = /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|copy|vacuum|comment\s+on|call|do)\b/i;

export function checkStatement(name, sql) {
  const body = sql.replace(/--.*$/gm, '');
  if (!body.includes(':shop')) throw new Error(`${name}: no :shop filter, refused`);
  if (FORBIDDEN.test(body)) throw new Error(`${name}: writing keyword, refused`);
  if (/d92c8096/i.test(body)) throw new Error(`${name}: names another shop, refused`);
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

function parseFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const parts = text.split(/^-- name:\s*/m).slice(1);
  return parts.map((p) => {
    const nl = p.indexOf('\n');
    return { name: p.slice(0, nl).trim(), sql: p.slice(nl + 1).trim().replace(/;\s*$/, '') };
  });
}

async function main() {
  const prefixes = process.argv.slice(2);
  const sqlDir = path.join(here, 'sql');
  const outDir = path.join(here, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs.readdirSync(sqlDir).filter((f) => f.endsWith('.sql'))
    .filter((f) => !prefixes.length || prefixes.some((p) => f.startsWith(p))).sort();

  const base = fs.readFileSync(path.join(sqlDir, '_base.sqlinc'), 'utf8').replace(/^--.*$/gm, '').trim();
  const statements = files.flatMap((f) => parseFile(path.join(sqlDir, f)).map((s) => ({
    ...s, file: f, sql: s.sql.replace('/*BASE*/', base),
  })));
  for (const s of statements) checkStatement(`${s.file}/${s.name}`, s.sql);

  const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('begin read only');
    await client.query("set local statement_timeout = '120s'");
    await client.query("set local timezone = 'Europe/Paris'");
    for (const s of statements) {
      const sql = s.sql.replaceAll(':shop', `'${QIRINESS_SHOP_ID}'::uuid`);
      await client.query('savepoint s');
      const t = Date.now();
      try {
        const r = await client.query(sql);
        fs.writeFileSync(path.join(outDir, `${s.name}.csv`), toCsv(r.rows));
        console.log(`ok   ${s.name} (${r.rows.length} rows, ${Date.now() - t} ms)`);
        if (process.env.SHOW && r.rows.length) console.log(toCsv(r.rows.slice(0, Number(process.env.SHOW))));
      } catch (e) {
        console.log(`FAIL ${s.name}: ${e.message}`);
        await client.query('rollback to savepoint s');
      }
    }
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
