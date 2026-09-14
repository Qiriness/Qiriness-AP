import assert from 'node:assert/strict';
import test from 'node:test';

import { ALL_MARKETPLACE_HANDLES } from '../../scripts/lib/insights-range.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const CODE = codeOnly(read('21_chat_vip'));

function functionBody() {
  const start = CODE.indexOf('create or replace function chat.vip_customer_rows()');
  return CODE.slice(start, CODE.indexOf('$$;', start));
}

test('the wrapper takes no arguments, runs as its owner, and fixes its search_path', () => {
  const body = functionBody();
  assert.ok(body.length > 0);
  assert.match(body, /chat\.vip_customer_rows\(\)\s*\nreturns table/);
  assert.match(body, /\nsecurity definer\n/);
  assert.match(body, /\nset search_path = public, pg_temp\n/);
});

test('it applies the rule through vip_customers(), never a copy of it', () => {
  const body = functionBody();
  assert.match(body, /public\.vip_customers\(\s*s\.id,\s*s\.vip_min_spend,\s*s\.vip_min_orders,\s*s\.vip_window_months,/);
  // A copied rule would name the tables the rule reads.
  assert.doesNotMatch(body, /public\.orders|public\.customers/);
});

test('it excludes exactly the marketplaces vip-rule.mjs excludes', () => {
  const literal = functionBody().match(/array\[([^\]]*)\]/);
  assert.ok(literal, 'no marketplace array');
  const handles = [...literal[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(handles.sort(), [...ALL_MARKETPLACE_HANDLES].sort());
});

test('only the chat role may call it or read the view', () => {
  assert.match(CODE, /revoke all on function chat\.vip_customer_rows\(\) from public, anon, authenticated;/);
  assert.match(CODE, /revoke all on chat\.vip_customers from public, anon, authenticated;/);
  const grants = [...CODE.matchAll(/grant ([^;]+) to (\w+);/g)].map((m) => `${m[1]} -> ${m[2]}`);
  assert.deepEqual(grants.sort(), [
    'execute on function chat.vip_customer_rows() -> mgmt_chat_ro',
    'select on chat.vip_customers -> mgmt_chat_ro'
  ]);
});

test('the view returns ids and numbers only, and is documented for the model', () => {
  const start = CODE.indexOf('create or replace view chat.vip_customers as');
  const view = CODE.slice(start, CODE.indexOf(';', start));
  assert.deepEqual(
    [...view.matchAll(/\bas (\w+)/g)].map((m) => m[1]),
    ['customer_id', 'orders_in_window', 'net_spend_in_window']
  );
  assert.match(CODE, /comment on view chat\.vip_customers is/);
});

test('it writes no data', () => {
  assert.doesNotMatch(CODE, /^\s*(insert|update|delete)\s/im);
});
