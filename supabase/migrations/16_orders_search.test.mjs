import assert from 'node:assert/strict';
import test from 'node:test';

import { INCREMENTAL_FILES, codeOnly, read } from './_shared.test.mjs';

const SQL = read('16_orders_search');
const ANALYTICS = read('06_analytics');
const VIP = read('12_vip_rule');

/** Incremental migrations after 16, which may replace the function it carries. */
const LATER = INCREMENTAL_FILES.filter((file) => Number(file.slice(0, 2)) > 16).map(read);
const supersededLater = LATER.some((sql) => sql.includes('create or replace function public.orders_list('));

/** One function's `create ... $$;` statement, verbatim. */
function statementOf(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return undefined;
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
}

test('16 carries orders_list and nothing else', () => {
  const created = [...codeOnly(SQL).matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, ['orders_list']);
});

test('16 copies orders_list from 06 rather than retyping it', () => {
  assert.ok(statementOf(SQL, 'orders_list'));
  // 31 filters on order_fulfilment_display(); from then on 16's copy is history.
  if (supersededLater) return;
  assert.equal(statementOf(SQL, 'orders_list'), statementOf(ANALYTICS, 'orders_list'));
});

test('an orders_list 16 no longer matches is superseded on purpose, not adrift', () => {
  if (statementOf(SQL, 'orders_list') === statementOf(ANALYTICS, 'orders_list')) return;
  assert.ok(supersededLater, 'orders_list differs between 06 and 16 and no later migration carries it');
});

test('the old signature is dropped before the new one is created', () => {
  // Without the drop, adding p_search leaves two overloads and PostgREST
  // refuses to pick one — the page would fail on its first read.
  const code = codeOnly(SQL);
  const drop = code.indexOf(
    'drop function if exists public.orders_list(uuid, numeric, integer, integer, text[], text, text, boolean, uuid[], integer, integer);'
  );
  assert.ok(drop >= 0, 'the eleven-argument orders_list is not dropped');
  assert.ok(drop < code.indexOf('create or replace function public.orders_list('));
});

test('it creates no table and writes no data', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /\b(insert|update|delete)\b/i);
});

test('the grants are re-issued, since a dropped function loses them', () => {
  assert.match(SQL, /revoke all on function public\.orders_list from public, anon, authenticated/);
  assert.match(SQL, /grant execute on function public\.orders_list to service_role/);
  assert.match(SQL, /comment on function public\.orders_list is/);
  const statement = statementOf(SQL, 'orders_list');
  assert.match(statement, /set search_path = public/);
  assert.match(statement, /\nstable\n/);
});

test('an order is awaiting fulfilment by exactly the rule open_orders uses', () => {
  // The Delay column and the waiting-orders list on Fulfilment must count the
  // same orders; "not closed" is the condition that keeps refunded orders out.
  const list = codeOnly(statementOf(SQL, 'orders_list'));
  const open = codeOnly(statementOf(VIP, 'open_orders'));
  for (const condition of [
    'o.cancelled_at is null',
    'o.closed_at is null',
    'o.fulfillment_status is not null',
    "o.fulfillment_status not in ('FULFILLED', 'RESTOCKED')"
  ]) {
    assert.ok(list.includes(condition), `orders_list is missing: ${condition}`);
    assert.ok(open.includes(condition), `open_orders is missing: ${condition}`);
  }
  assert.match(list, /\) as awaiting,/);
  assert.match(list, /awaiting_fulfilment boolean/);
});

test('the search reaches the order, the buyer and the parcel', () => {
  const list = codeOnly(statementOf(SQL, 'orders_list'));
  assert.match(list, /p_search text default null/);
  assert.match(list, /p_search is null/);
  assert.match(list, /o\.name ilike \('%' \|\| p_search \|\| '%'\)/);
  assert.match(list, /c\.email ilike \('%' \|\| p_search \|\| '%'\)/);
  assert.match(list, /concat_ws\(' ', c\.first_name, c\.last_name\)\) ilike/);
  // Tracking numbers are stored normalised (no spaces, dots or hyphens, upper
  // case), so the typed number is normalised the same way before comparing.
  assert.match(list, /upper\(regexp_replace\(p_search, '\[\[:space:\]\.-\]', '', 'g'\)\) = any\(o\.tracking_numbers\)/);
});
