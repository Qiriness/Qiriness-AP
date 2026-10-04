import assert from 'node:assert/strict';
import test from 'node:test';

import { RPC } from '../../scripts/lib/tables.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('65_inventory_stock_floor');
const ANALYTICS = read('06_analytics');
const FUNCTION = 'insights_inventory_exceptions';

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

/** The `comment on function` literal, verbatim. */
const commentOf = (sql) => sql.match(/comment on function public\.insights_inventory_exceptions is\s*'((?:[^']|'')*)';/)?.[1];

test('65 carries the stock function and nothing else', () => {
  const created = [...codeOnly(SQL).matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, [FUNCTION]);
});

test('65 copies the function and its comment from 06 rather than retyping them', () => {
  assert.ok(statementOf(SQL, FUNCTION));
  assert.equal(statementOf(SQL, FUNCTION), statementOf(ANALYTICS, FUNCTION));
  assert.ok(commentOf(ANALYTICS));
  assert.equal(commentOf(SQL), commentOf(ANALYTICS));
});

test('the web reaches it through tables.mjs', () => {
  assert.equal(RPC.INSIGHTS_INVENTORY_EXCEPTIONS, FUNCTION);
});

test('it drops only the version it replaces, creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  // 35's five-argument version, by its exact signature: a bare `drop function`
  // by name would be ambiguous once two overloads exist.
  assert.match(code, /drop function if exists public\.insights_inventory_exceptions\(uuid, timestamp, timestamp, text, numeric\);/);
  assert.equal(code.match(/drop function/gi).length, 1);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /\b(insert|update|delete)\b/i);
});

test('it is granted like every other analytics function', () => {
  assert.match(SQL, new RegExp(`revoke all on function public\.${FUNCTION} from public, anon, authenticated`));
  assert.match(SQL, new RegExp(`grant execute on function public\.${FUNCTION} to service_role`));
  const statement = statementOf(SQL, FUNCTION);
  assert.match(statement, /set search_path = public/);
  assert.match(statement, /\nstable\n/);
  assert.match(statement, /p_from timestamp,\n\s+p_to timestamp,\n\s+p_tz text/);
});

test('active products only; both cut-offs are the caller\'s, and either one lists a product', () => {
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  assert.match(statement, /p\.status = 'active'/);
  assert.match(statement, /p_max_cover_days numeric,\n\s+p_max_stock_units integer\n\)/);
  assert.match(statement, /m\.available_stock <= 0\n\s+or \(m\.cover is not null and m\.cover <= p_max_cover_days\)\n\s+or m\.available_stock < p_max_stock_units/);
  // "Low" and "critical" are words the service owns, never SQL; nor is 30.
  assert.doesNotMatch(statement, /'(critical|low|watch)'/i);
  assert.doesNotMatch(statement, /\b30\b/);
});

test('stock leaving counts every unit, samples included', () => {
  assert.doesNotMatch(codeOnly(statementOf(SQL, FUNCTION)), /discounted_total/);
});

test('out of stock comes first, then the shortest cover, then the fewest units', () => {
  const statement = codeOnly(statementOf(SQL, FUNCTION));
  assert.match(statement, /order by m\.available_stock > 0, m\.cover nulls last, m\.available_stock, m\.units desc, m\.title;/);
});
