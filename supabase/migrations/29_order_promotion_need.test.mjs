import assert from 'node:assert/strict';
import test from 'node:test';

import { checkClause, codeOnly, literalsIn, read } from './_shared.test.mjs';

const SQL = read('29_order_promotion_need');
const EXEMPLARS = read('05_exemplars');

const CONSTRAINT = 'support_exemplars_requirement_needs_check';

// 29 WAS EQUAL TO THE BASELINE AND IS NO LONGER, WHICH IS CORRECT. It was the
// head of this constraint when it was written, so it asserted equality with
// 05_exemplars.sql. 33_delivery_delay_need.sql is the head now and carries that
// assertion; an applied migration is a historical step and must not be edited
// to keep up, so what survives here is the claim that still holds: 29 copied the
// baseline of its day rather than retyping one, and every value it names is
// still a value the baseline allows.
test('29 copied the baseline of its day: it names nothing the baseline lost', () => {
  const clause = checkClause(SQL, CONSTRAINT);
  assert.ok(clause, 'the check is missing from 29');
  const baseline = literalsIn(checkClause(EXEMPLARS, CONSTRAINT));
  for (const need of literalsIn(clause)) {
    assert.ok(baseline.includes(need), `${need} is in 29 but no longer in the baseline`);
  }
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
