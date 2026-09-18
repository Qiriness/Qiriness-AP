import assert from 'node:assert/strict';
import test from 'node:test';

import { checkClause, codeOnly, read } from './_shared.test.mjs';

const SQL = read('29_order_promotion_need');
const EXEMPLARS = read('05_exemplars');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const CONSTRAINT = 'support_exemplars_requirement_needs_check';

test('29 carries the baseline check, not a retyped one', () => {
  const clause = checkClause(SQL, CONSTRAINT);
  assert.ok(clause, 'the check is missing from 29');
  assert.equal(squash(clause), squash(checkClause(EXEMPLARS, CONSTRAINT)));
});

test('the baseline allows the new need, beside the ones it already had', () => {
  const clause = checkClause(EXEMPLARS, CONSTRAINT);
  assert.match(clause, /'order_promotion'/);
  // A widening only: the values a situation could already declare are still there.
  for (const need of ['order_identity', 'order_state', 'delivery_state', 'other_fact']) {
    assert.match(clause, new RegExp(`'${need}'`), need);
  }
});

test('it only widens: no table, no data, nothing dropped but the constraint', () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /drop (column|table)/i);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
  assert.match(code, new RegExp(`drop constraint if exists ${CONSTRAINT}`));
});
