import assert from 'node:assert/strict';
import test from 'node:test';

import { codeOnly, read } from './_shared.test.mjs';

const SQL = read('77_updated_at_indexes');
const BASELINE = read('02_shopify') + read('04_support');

const INDEXES = [
  ['customers_shop_updated_at_idx', 'customers'],
  ['orders_shop_updated_at_idx', 'orders'],
  ['tickets_shop_updated_at_idx', 'tickets']
];

test('each index is created here and in the baseline, on (shop_id, updated_at)', () => {
  for (const [name, table] of INDEXES) {
    const shape = `${name} on public.${table} (shop_id, updated_at);`;
    assert.ok(SQL.includes(`create index if not exists ${shape}`), `77 creates ${name}`);
    assert.ok(BASELINE.includes(`create index ${shape}`), `the baseline creates ${name}`);
  }
});

test('nothing is written when it is applied', () => {
  for (const line of codeOnly(SQL).split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete|drop|alter)\s+/i, line);
  }
});
