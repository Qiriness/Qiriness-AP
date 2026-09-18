import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('30_customer_mix_plan');
const ANALYTICS = read('06_analytics');
const RANGES = read('11_insights_ranges');
const FUNCTION = 'insights_customer_mix';

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

/** Everything before `as $$`: name, arguments, return columns, language. */
const signatureOf = (statement) => statement.slice(0, statement.indexOf('as $$'));

test('30 carries the customer-mix function and nothing else', () => {
  const created = [...codeOnly(SQL).matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, [FUNCTION]);
});

test('30 copies the function from 06 rather than retyping it', () => {
  assert.ok(statementOf(SQL, FUNCTION));
  assert.equal(statementOf(SQL, FUNCTION), statementOf(ANALYTICS, FUNCTION));
});

test('the signature is the one 11 shipped, so no caller changes', () => {
  // Same arguments, same columns, same language: a replaced body behind an
  // unchanged contract. A new signature would need a drop, and the panel's
  // mapper would read columns that no longer exist.
  assert.equal(signatureOf(statementOf(SQL, FUNCTION)), signatureOf(statementOf(RANGES, FUNCTION)));
});

test('it never joins the range back to itself, the shape that planned as a nested loop', () => {
  // The first version fed `ranged` into `firsts` through `in (select ...)` and
  // then joined the two: without the argument values, Postgres planned that as
  // every range row against every customer — 10.1 million comparisons on a year.
  const body = codeOnly(statementOf(SQL, FUNCTION));
  assert.doesNotMatch(body, /in \(select/i);
  assert.doesNotMatch(body, /\bjoin\b/i);
  assert.match(body, /group by 1/);
});

test('it drops nothing, creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /drop function/i);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /\b(insert|update|delete)\b/i);
});

test('it is granted like every other analytics function', () => {
  assert.match(SQL, new RegExp(`revoke all on function public\\.${FUNCTION} from public, anon, authenticated`));
  assert.match(SQL, new RegExp(`grant execute on function public\\.${FUNCTION} to service_role`));
  assert.match(SQL, new RegExp(`comment on function public\\.${FUNCTION} is`));
  const statement = statementOf(SQL, FUNCTION);
  assert.match(statement, /set search_path = public/);
  assert.match(statement, /\nstable\n/);
});
