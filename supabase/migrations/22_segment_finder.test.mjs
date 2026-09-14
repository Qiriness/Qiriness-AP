import assert from 'node:assert/strict';
import test from 'node:test';

import { RPC } from '../../scripts/lib/tables.mjs';

import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('22_segment_finder');
const ANALYTICS = read('06_analytics');
const FUNCTION = 'customer_segment_find';

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

const body = () => codeOnly(statementOf(SQL, FUNCTION));

test('22 carries the segment finder and the contract names it', () => {
  const created = [...codeOnly(SQL).matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, [FUNCTION]);
  assert.equal(RPC.CUSTOMER_SEGMENT_FIND, FUNCTION);
});

test('22 copies the function from 06 rather than retyping it', () => {
  assert.ok(statementOf(SQL, FUNCTION));
  assert.equal(statementOf(SQL, FUNCTION), statementOf(ANALYTICS, FUNCTION));
});

test('it creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /\b(insert|update|delete)\b/i);
});

test('revoked from the anon roles, granted to the service role, commented, stable and pinned', () => {
  assert.match(SQL, new RegExp(`revoke all on function public\\.${FUNCTION} from public, anon, authenticated`));
  assert.match(SQL, new RegExp(`grant execute on function public\\.${FUNCTION} to service_role`));
  assert.match(SQL, new RegExp(`comment on function public\\.${FUNCTION} is`));
  const statement = statementOf(SQL, FUNCTION);
  assert.match(statement, /set search_path = public/);
  assert.match(statement, /\nstable\n/);
});

test('orders and spend are windowed; lifetime spend is not', () => {
  const statement = body();
  assert.equal(statement.split('make_interval(months => p_window_months)').length - 1, 2, 'orders and spend each windowed once');
  assert.match(statement, /coalesce\(sum\(o\.total_price - coalesce\(o\.total_refunded, 0\)\), 0\) as lifetime_spend/);
  assert.match(statement, /o\.cancelled_at is null/);
});

test('the three metrics and two operators are the only ones understood, and strictly', () => {
  const statement = body();
  for (const metric of ['orders', 'spend', 'lifetime_spend']) {
    assert.match(statement, new RegExp(`when '${metric}' then b\\.${metric}`), metric);
  }
  assert.match(statement, /when 'gt' then m\.actual > \(cond\.rule ->> 'value'\)::numeric/);
  assert.match(statement, /when 'lt' then m\.actual < \(cond\.rule ->> 'value'\)::numeric/);
  // Only the operator block: the window filter itself is rightly `>=`.
  const operators = statement.slice(statement.indexOf("case cond.rule ->> 'op'"), statement.indexOf('false', statement.indexOf("case cond.rule ->> 'op'")));
  assert.ok(operators.length > 0, 'operator block not found');
  assert.doesNotMatch(operators, />=|<=/, 'the screen says more than / less than');
});

test('an unknown metric or operator fails closed', () => {
  // `not coalesce(<null>, false)` is true, so the condition counts as FAILED and
  // its group cannot match. Without the coalesce, `not null` would skip it.
  assert.match(body(), /where not coalesce\(\s*case cond\.rule ->> 'op'[\s\S]*?end,\s*false\s*\)/);
});

test('matching is OR across groups and AND within one', () => {
  const statement = body();
  assert.match(statement, /where exists \(\s*select 1\s*from jsonb_array_elements\(/);
  assert.match(statement, /and not exists \(\s*select 1\s*from jsonb_array_elements\(grp\.conditions\) as cond\(rule\)/);
  assert.match(statement, /jsonb_array_length\(grp\.conditions\) > 0/, 'an empty group must not match everybody');
});

test('marketplace-synthetic customers are left out entirely', () => {
  const statement = body();
  assert.match(statement, /marketplace_keys as \(/);
  assert.match(statement, /o\.sales_channel_handle = any\(p_not_channels\)/);
  assert.match(statement, /and not exists \(\s*select 1 from marketplace_keys mk where mk\.customer_key = c\.shopify_customer_id\s*\)/);
});

test('every customer on file is in the base, so zero-order conditions can match', () => {
  const statement = body();
  assert.match(statement, /from public\.customers c\s+left join order_facts f on f\.customer_key = c\.shopify_customer_id/);
  assert.match(statement, /coalesce\(f\.orders, 0\) as orders/);
});

test('the totals always arrive, and only the member list is capped', () => {
  const statement = body();
  assert.match(statement, /from totals t\s+left join shown s on true/);
  assert.match(statement, /limit greatest\(coalesce\(p_limit, 25\), 0\)/);
  const totals = statement.slice(statement.indexOf('totals as ('), statement.indexOf('shown as ('));
  assert.doesNotMatch(totals, /limit/, 'the totals must count every match');
});
