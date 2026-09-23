import assert from 'node:assert/strict';
import test from 'node:test';

import { RPC } from '../../scripts/lib/tables.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('36_collection_sales');
const FUNCTION = 'insights_collection_sales';

/**
 * 36 is SUPERSEDED BY 37, which adds `p_handles`, so this file is no longer
 * compared against 06 — it is the record of what was applied to the live
 * database on 2026-09-23, and 37's test carries the checks that must hold now.
 * What is still asserted here is what any applied migration must be: one
 * function, granted like the rest, writing nothing.
 */

function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

test('36 carries the collection function and nothing else', () => {
  const created = [...codeOnly(SQL).matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, [FUNCTION]);
});

test('36 is the seven-argument shape 37 replaced', () => {
  const statement = statementOf(SQL, FUNCTION);
  assert.ok(statement);
  assert.match(statement, /p_limit integer default 10\n\)/);
  assert.doesNotMatch(statement, /p_handles/);
});

test('the web reaches it through tables.mjs', () => {
  assert.equal(RPC.INSIGHTS_COLLECTION_SALES, FUNCTION);
});

test('it drops nothing, creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /drop function/i);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /\b(insert|update|delete)\b/i);
});

test('it was granted like every other analytics function', () => {
  assert.match(SQL, new RegExp(`revoke all on function public\\.${FUNCTION} from public, anon, authenticated`));
  assert.match(SQL, new RegExp(`grant execute on function public\\.${FUNCTION} to service_role`));
  assert.match(SQL, new RegExp(`comment on function public\\.${FUNCTION} is`));
  const statement = statementOf(SQL, FUNCTION);
  assert.match(statement, /set search_path = public/);
  assert.match(statement, /\nstable\n/);
  assert.match(statement, /p_from timestamp,\n\s+p_to timestamp,\n\s+p_tz text/);
});
