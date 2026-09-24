import assert from 'node:assert/strict';
import test from 'node:test';

import { STOREFRONT_T } from '../../scripts/lib/tables.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('38_storefront_months');
const CODE = codeOnly(SQL);

test('38 creates exactly the session month table, named as tables.mjs names it', () => {
  const created = [...CODE.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(created, [STOREFRONT_T.SESSION_MONTHS]);
});

test('every table is closed to anon and authenticated', () => {
  for (const table of Object.values(STOREFRONT_T)) {
    assert.match(CODE, new RegExp(`alter table public\\.${table} enable row level security;`));
    assert.match(CODE, new RegExp(`revoke all on public\\.${table} from anon, authenticated;`));
  }
});

test('only summable session counts are stored: no rate, no unique visitors, and no money', () => {
  // Net sales and AOV are read live at every range length — the owner's rule.
  for (const column of ['conversion_rate', 'bounce_rate', 'average_order_value', 'visitors', 'net_sales', 'gross_sales', 'numeric']) {
    assert.doesNotMatch(CODE, new RegExp(`\\b${column}\\b`), column);
  }
});

test('keyed per shop and month, on the first of the month', () => {
  assert.match(CODE, /primary key \(shop_id, month\)/);
  assert.match(CODE, /check \(extract\(day from month\) = 1\)/);
});

test('it writes no data', () => {
  assert.doesNotMatch(CODE, /\binsert into\b|\bupdate public\.|\bdelete from\b/i);
});
