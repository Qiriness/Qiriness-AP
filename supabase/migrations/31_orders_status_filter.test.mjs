import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('31_orders_status_filter');
const ANALYTICS = read('06_analytics');
const JS = readFileSync(new URL('../../scripts/lib/order-list-query.mjs', import.meta.url), 'utf8');
const FUNCTIONS = ['order_fulfilment_display', 'orders_list', 'orders_list_facets'];

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

const DISPLAY =
  'public.order_fulfilment_display(o.fulfillment_status, o.line_items, o.cancelled_at, o.financial_status)';

test('31 carries the status function and the two Orders page functions, and nothing else', () => {
  const created = [...codeOnly(SQL).matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, FUNCTIONS);
});

test('31 copies every function from 06 rather than retyping it', () => {
  for (const name of FUNCTIONS) {
    assert.ok(statementOf(SQL, name), `${name} is missing`);
    assert.equal(statementOf(SQL, name), statementOf(ANALYTICS, name), `${name} drifted from 06`);
  }
});

test('the status function exists before anything calls it', () => {
  for (const sql of [SQL, ANALYTICS]) {
    const code = codeOnly(sql);
    assert.ok(
      code.indexOf('create or replace function public.order_fulfilment_display(') <
        code.indexOf('create or replace function public.orders_list(')
    );
  }
});

test('nothing is dropped, created as a table, or written', () => {
  // Same names, arguments and columns as before: create or replace is enough.
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /drop function/i);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /\b(insert|update|delete)\b/i);
});

test('every function is revoked from the anon roles, granted to the service role, and commented', () => {
  for (const name of FUNCTIONS) {
    assert.match(SQL, new RegExp(`revoke all on function public\\.${name} from public, anon, authenticated`));
    assert.match(SQL, new RegExp(`grant execute on function public\\.${name} to service_role`));
    assert.match(SQL, new RegExp(`comment on function public\\.${name} is`));
    assert.match(statementOf(SQL, name), /set search_path = public/);
  }
  assert.match(statementOf(SQL, 'order_fulfilment_display'), /\nimmutable\n/);
  assert.match(statementOf(SQL, 'orders_list'), /\nstable\n/);
  assert.match(statementOf(SQL, 'orders_list_facets'), /\nstable\n/);
});

test('a status option selects exactly the orders it counts, by the derived status', () => {
  const list = codeOnly(statementOf(SQL, 'orders_list'));
  const facets = codeOnly(statementOf(SQL, 'orders_list_facets'));
  assert.ok(list.includes(`${DISPLAY} = p_fulfillment_status`), 'orders_list does not filter on the derived status');
  assert.ok(facets.includes(`select 'fulfillment_status', ${DISPLAY},`), 'the facets do not group on it');
  // The raw column is no longer the filter, or "Unfulfilled" would return refunds again.
  assert.ok(!list.includes("coalesce(o.fulfillment_status, 'UNKNOWN') = p_fulfillment_status"));
  // The country filter is untouched.
  const country = "coalesce(o.shipping_destination ->> 'country_code', '??')";
  assert.ok(list.includes(country) && facets.includes(country));
});

test('the SQL rule is the one fulfillmentDisplay labels the pill with', () => {
  // Two languages, one rule: the pill (JS) and the filter (SQL) must agree on
  // every branch, or a filter option would select rows whose pill says otherwise.
  const fn = codeOnly(statementOf(SQL, 'order_fulfilment_display'));
  assert.match(fn, /in \('FULFILLED', 'RESTOCKED'\)\s+then p_fulfillment_status/);
  assert.match(fn, /\) <> 0\s+then coalesce\(p_fulfillment_status, 'UNKNOWN'\)/);
  assert.match(fn, /when p_cancelled_at is not null then 'CANCELLED'/);
  assert.match(fn, /when p_financial_status = 'REFUNDED' then 'REFUNDED'/);
  assert.ok(fn.indexOf("'CANCELLED'") < fn.indexOf("'REFUNDED'"), 'cancelled must win over refunded');
  // Items are counted as the units column counts them.
  const units = "sum(coalesce((li.value ->> 'current_quantity')::int, (li.value ->> 'quantity')::int, 0))";
  assert.ok(fn.includes(units));
  assert.ok(codeOnly(statementOf(SQL, 'orders_list')).includes(units));

  assert.match(JS, /status === 'FULFILLED' \|\| status === 'RESTOCKED'/);
  assert.match(JS, /if \(cancelled\) return \{ status: 'CANCELLED'/);
  assert.match(JS, /if \(financialStatus === 'REFUNDED'\) return \{ status: 'REFUNDED'/);
});
