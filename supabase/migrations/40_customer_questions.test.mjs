import assert from 'node:assert/strict';
import test from 'node:test';

import { MISSING_FIELDS } from '../../agent/src/investigation/case-file.mjs';

import { checkClause, codeOnly, literalsIn, read } from './_shared.test.mjs';

const SQL = read('40_customer_questions');
const EXEMPLARS = read('05_exemplars');
const CONSTRAINT = 'support_answers_ask_check';

test('40 is the baseline check, copied not retyped', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, CONSTRAINT)), literalsIn(checkClause(EXEMPLARS, CONSTRAINT)));
});

test('it allows exactly the questions the agent can word', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, CONSTRAINT)), Object.keys(MISSING_FIELDS).sort());
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
