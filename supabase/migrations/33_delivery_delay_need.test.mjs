import assert from 'node:assert/strict';
import test from 'node:test';

import { NEED_KEYS } from '../../agent/src/investigation/evidence-rules.mjs';

import { checkClause, codeOnly, literalsIn, read } from './_shared.test.mjs';

const SQL = read('33_delivery_delay_need');
const EXEMPLARS = read('05_exemplars');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const CONSTRAINT = 'support_exemplars_requirement_needs_check';

test('33 carries the baseline check, not a retyped one', () => {
  const clause = checkClause(SQL, CONSTRAINT);
  assert.ok(clause, 'the check is missing from 33');
  assert.equal(squash(clause), squash(checkClause(EXEMPLARS, CONSTRAINT)));
});

test('the baseline allows the new need, beside the ones it already had', () => {
  const clause = checkClause(EXEMPLARS, CONSTRAINT);
  assert.match(clause, /'delivery_delay_state'/);
  // A widening only: the values a situation could already declare are still there.
  for (const need of ['order_identity', 'order_promotion', 'delivery_state', 'dispatch_state', 'other_fact']) {
    assert.match(clause, new RegExp(`'${need}'`), need);
  }
});

test('the head migration is the one pinned to the code vocabulary', () => {
  // The same claim 05_exemplars.test.mjs makes about the baseline, made here
  // too: this file is what an existing database applies, so a need code can
  // only ever be declarable if BOTH say so.
  assert.deepEqual(literalsIn(checkClause(SQL, CONSTRAINT)), [...NEED_KEYS].sort());
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
