import assert from 'node:assert/strict';
import test from 'node:test';

import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('43_case_actions');
const SUPPORT = read('04_support');

test('43 creates the same table the baseline does, column for column', () => {
  assert.deepEqual(columnsIn(SQL, 'ticket_case_actions'), columnsIn(SUPPORT, 'ticket_case_actions'));
});

test('an action is a check done or cancelled, nothing else', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, 'ticket_case_actions_action_check')), ['cancelled', 'fulfilled']);
  assert.equal(checkClause(SQL, 'ticket_case_actions_action_check').replace(/\s+/g, ' '), checkClause(SUPPORT, 'ticket_case_actions_action_check').replace(/\s+/g, ' '));
});

test('it is idempotent and writes no data', () => {
  const code = codeOnly(SQL);
  assert.match(code, /create table if not exists public\.ticket_case_actions/);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
