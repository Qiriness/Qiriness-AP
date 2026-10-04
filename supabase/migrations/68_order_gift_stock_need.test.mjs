import assert from 'node:assert/strict';
import test from 'node:test';

import { NEED_KEYS } from '../../agent/src/investigation/evidence-rules.mjs';
import { checkClause, codeOnly, literalsIn, read } from './_shared.test.mjs';

const SQL = read('68_order_gift_stock_need');
const EXEMPLARS = read('05_exemplars');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const NEEDS = 'support_exemplars_requirement_needs_check';

test('68 carries the baseline check, not a retyped one', () => {
  assert.ok(checkClause(SQL, NEEDS));
  assert.equal(squash(checkClause(SQL, NEEDS)), squash(checkClause(EXEMPLARS, NEEDS)));
});

test('the head of the needs check is the code vocabulary, order_gift_stock included', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, NEEDS)), [...NEED_KEYS].sort());
  assert.ok(NEED_KEYS.includes('order_gift_stock'));
});

test('it only widens: no table, no data, nothing dropped but the constraint', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /drop (column|table)/i);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
  assert.match(code, new RegExp(`drop constraint if exists ${NEEDS}`));
});
