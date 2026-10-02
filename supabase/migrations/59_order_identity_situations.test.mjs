import assert from 'node:assert/strict';
import test from 'node:test';

import { ORDER_IDENTITY_SITUATIONS } from '../../agent/src/resolution/order-identity.mjs';
import { codeOnly, read } from './_shared.test.mjs';

const SQL = codeOnly(read('59_order_identity_situations'));
const SPLIT = ORDER_IDENTITY_SITUATIONS.filter((value) => value !== 'resolved');

test('59 adds exactly the values `none` was split into, from the code vocabulary', () => {
  for (const value of SPLIT) {
    // Once in the values added, once in the idempotence guard.
    assert.equal(SQL.split(`'${value}'`).length - 1, 2, value);
  }
  assert.doesNotMatch(SQL, /'resolved'/, 'a confirmed order is not one of them');
});

test('it keeps `none`, so a rule is never left unconditional by either code version', () => {
  assert.doesNotMatch(SQL, /array_remove|-\s*'none'/);
  assert.match(SQL, /\?\s*'none'/);
});

test('it only rewrites rule conditions: no schema, no other table', () => {
  assert.doesNotMatch(SQL, /create |alter |drop /i);
  assert.match(SQL, /^update public\.support_answers/m);
  assert.equal((SQL.match(/^\s*update\s+/gim) || []).length, 1);
});
