import assert from 'node:assert/strict';
import test from 'node:test';

import { NEED_KEYS } from '../../agent/src/investigation/evidence-rules.mjs';

import { checkClause, codeOnly, literalsIn, read } from './_shared.test.mjs';

const SQL = read('33_delivery_delay_need');
const EXEMPLARS = read('05_exemplars');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const CONSTRAINT = 'support_exemplars_requirement_needs_check';

// 33 WAS THE HEAD OF THIS CONSTRAINT UNTIL 56 removed `policy_answer`
// (2026-10-01). An applied migration is a historical step and is not edited to
// keep up, so what survives is what still holds: 33 is the baseline of its day,
// which is today's baseline plus the one need 56 retired.
const RETIRED_BY_56 = ['policy_answer'];
const ADDED_BY_56 = ['policy_attached'];
// And 58 added `promotion_outcome` after it (2026-10-01).
const ADDED_BY_58 = ['promotion_outcome'];
// And 66 added `promotion_reward_stock` (2026-10-04).
const ADDED_BY_66 = ['promotion_reward_stock'];
const ADDED_BY_67 = ['sample_stock'];
const ADDED_BY_68 = ['order_gift_stock'];
const minus = (list, gone) => list.filter((item) => !gone.includes(item));

test('33 carries the baseline check of its day, not a retyped one', () => {
  const clause = checkClause(SQL, CONSTRAINT);
  assert.ok(clause, 'the check is missing from 33');
  assert.deepEqual(literalsIn(clause), [...minus(literalsIn(checkClause(EXEMPLARS, CONSTRAINT)), [...ADDED_BY_56, ...ADDED_BY_58, ...ADDED_BY_66, ...ADDED_BY_67, ...ADDED_BY_68]), ...RETIRED_BY_56].sort());
});
void squash;

test('the baseline allows the new need, beside the ones it already had', () => {
  const clause = checkClause(EXEMPLARS, CONSTRAINT);
  assert.match(clause, /'delivery_delay_state'/);
  // A widening only: the values a situation could already declare are still there.
  for (const need of ['order_identity', 'order_promotion', 'delivery_state', 'dispatch_state', 'other_fact']) {
    assert.match(clause, new RegExp(`'${need}'`), need);
  }
});

test('what 33 allowed is the code vocabulary plus what 56 retired', () => {
  // 56_policy_search_retired.test.mjs pins the head to the code vocabulary now.
  assert.deepEqual(literalsIn(checkClause(SQL, CONSTRAINT)), [...minus(NEED_KEYS, [...ADDED_BY_56, ...ADDED_BY_58, ...ADDED_BY_66, ...ADDED_BY_67, ...ADDED_BY_68]), ...RETIRED_BY_56].sort());
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
