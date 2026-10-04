import assert from 'node:assert/strict';
import test from 'node:test';

import { NEED_KEYS } from '../../agent/src/investigation/evidence-rules.mjs';
import { checkClause, codeOnly, literalsIn, read } from './_shared.test.mjs';

const SQL = read('66_promotion_reward_stock_need');
const EXEMPLARS = read('05_exemplars');

const NEEDS = 'support_exemplars_requirement_needs_check';

// 66 WAS THE HEAD OF THE NEEDS CHECK UNTIL 67 added `sample_stock`
// (2026-10-04). An applied migration is not edited to keep up: 66 is the
// baseline of its day, which is today's baseline minus what 67 added.
const ADDED_BY_67 = ['sample_stock'];
const ADDED_BY_68 = ['order_gift_stock'];
const minus = (list, gone) => list.filter((item) => !gone.includes(item));

test('66 carries the baseline check of its day, not a retyped one', () => {
  assert.ok(checkClause(SQL, NEEDS));
  assert.deepEqual(literalsIn(checkClause(SQL, NEEDS)), minus(literalsIn(checkClause(EXEMPLARS, NEEDS)), [...ADDED_BY_67, ...ADDED_BY_68]));
});

test('what 66 allowed is the code vocabulary minus what 67 added, promotion_reward_stock included', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, NEEDS)), minus([...NEED_KEYS], [...ADDED_BY_67, ...ADDED_BY_68]).sort());
  assert.ok(NEED_KEYS.includes('promotion_reward_stock'));
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
