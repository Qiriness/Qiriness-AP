import assert from 'node:assert/strict';
import test from 'node:test';

import { checkClause, codeOnly, literalsIn, read } from './_shared.test.mjs';

const SQL = read('77_collection_range_axis');
const BEFORE = read('27_advice_collections');

test('the axis accepts range, and keeps the two axes 27 created', () => {
  const after = literalsIn(checkClause(SQL, 'advice_collections_axis_check'));
  const before = literalsIn(checkClause(BEFORE, 'advice_collections_axis_check'));
  assert.deepEqual(after, ['category', 'concern', 'range']);
  for (const axis of before) assert.ok(after.includes(axis), `27's ${axis} is kept`);
});

test('the check is replaced under its own name, in one transaction', () => {
  const code = codeOnly(SQL);
  assert.match(code, /^begin;/m);
  assert.match(code, /drop constraint if exists advice_collections_axis_check;/);
  assert.match(code, /add constraint advice_collections_axis_check check/);
  assert.match(code, /^commit;/m);
});

test('nothing is written when it is applied', () => {
  for (const line of codeOnly(SQL).split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
