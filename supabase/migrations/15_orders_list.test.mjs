import assert from 'node:assert/strict';
import test from 'node:test';

import { RPC } from '../../scripts/lib/tables.mjs';

import { INCREMENTAL_FILES, codeOnly, read } from './_shared.test.mjs';

const SQL = read('15_orders_list');
const ANALYTICS = read('06_analytics');
const FUNCTIONS = ['orders_list', 'orders_list_facets'];

/** Incremental migrations after 15, which may replace a function it first carried. */
const LATER = INCREMENTAL_FILES.filter((file) => Number(file.slice(0, 2)) > 15).map(read);

const supersededLater = (name) =>
  LATER.some((sql) => sql.includes(`create or replace function public.${name}(`));

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

test('15 carries the two Orders page functions and nothing else', () => {
  const created = [...codeOnly(SQL).matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, FUNCTIONS);
  assert.equal(RPC.ORDERS_LIST, 'orders_list');
  assert.equal(RPC.ORDERS_LIST_FACETS, 'orders_list_facets');
});

test('15 copies both functions from 06 rather than retyping them', () => {
  // A function a later migration replaces is exempt: 15 stays the historical
  // step it was, already applied, and the newer file is the one that must match
  // 06 (its own test asserts that).
  for (const name of FUNCTIONS) {
    assert.ok(statementOf(SQL, name), `${name} is missing`);
    if (supersededLater(name)) continue;
    assert.equal(statementOf(SQL, name), statementOf(ANALYTICS, name), `${name} drifted from 06`);
  }
});

test('a function 15 no longer matches is superseded on purpose, not adrift', () => {
  for (const name of FUNCTIONS) {
    if (statementOf(SQL, name) === statementOf(ANALYTICS, name)) continue;
    assert.ok(supersededLater(name), `${name} differs between 06 and 15 and no later migration carries it`);
  }
});

test('it creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /\b(insert|update|delete)\b/i);
});

test('every function is revoked from the anon roles, granted to the service role, and commented', () => {
  for (const name of FUNCTIONS) {
    assert.match(SQL, new RegExp(`revoke all on function public\\.${name} from public, anon, authenticated`));
    assert.match(SQL, new RegExp(`grant execute on function public\\.${name} to service_role`));
    assert.match(SQL, new RegExp(`comment on function public\\.${name} is`));
  }
});

test('every function pins its search_path and stays stable', () => {
  for (const name of FUNCTIONS) {
    const statement = statementOf(SQL, name);
    assert.match(statement, /set search_path = public/);
    assert.match(statement, /\nstable\n/);
  }
});

test('VIP comes from vip_customers(), never compared here', () => {
  const statement = codeOnly(statementOf(SQL, 'orders_list'));
  assert.match(statement, /public\.vip_customers\(p_shop, p_min_spend, p_min_orders, p_window_months, p_vip_not_channels\)/);
  assert.doesNotMatch(statement, /p_min_(spend|orders)\s*[<>]/);
});

test('the page order is total and the count is taken before the page is cut', () => {
  // Without the id tiebreak, two orders processed in the same instant could
  // swap between pages and one would be shown twice while another is never shown.
  const statement = codeOnly(statementOf(SQL, 'orders_list'));
  assert.match(statement, /order by o\.processed_at desc nulls last, o\.id desc\n\s+limit/);
  assert.match(statement, /count\(\*\) over \(\) as matched/);
});

test('a facet selects exactly the orders it counts', () => {
  const list = codeOnly(statementOf(SQL, 'orders_list'));
  const facets = codeOnly(statementOf(SQL, 'orders_list_facets'));
  for (const expression of [
    "coalesce(o.fulfillment_status, 'UNKNOWN')",
    "coalesce(o.shipping_destination ->> 'country_code', '??')"
  ]) {
    assert.ok(list.includes(expression), `orders_list does not filter on ${expression}`);
    assert.ok(facets.includes(expression), `orders_list_facets does not group on ${expression}`);
  }
  for (const statement of [list, facets]) assert.match(statement, /o\.deleted_at is null/);
});

test('the carrier is normalised as the fulfilment views normalise it', () => {
  const list = codeOnly(statementOf(SQL, 'orders_list'));
  const timing = codeOnly(ANALYTICS);
  assert.match(list, /public\.normalise_carrier\(min\(t\.value ->> 'company'\)\)/);
  assert.ok(timing.includes("min(t.value ->> 'company') as carrier_raw"), 'order_fulfilment_timing changed its carrier rule');
});
