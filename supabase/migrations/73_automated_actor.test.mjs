import assert from 'node:assert/strict';
import test from 'node:test';

import { ACTORS, MESSAGE_ACTORS } from '../../agent/src/casework/actors.mjs';
import { checkClause, codeOnly, literalsIn, read } from './_shared.test.mjs';

const SQL = read('73_automated_actor');
const SUPPORT = read('04_support');
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

test('the baseline declares the same message actors', () => {
  assert.equal(squash(checkClause(SQL, 'ticket_messages_actor_check')), squash(checkClause(SUPPORT, 'ticket_messages_actor_check')));
});

test('a message may be automated; a case reading and a fold may not', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, 'ticket_messages_actor_check')), [...MESSAGE_ACTORS].sort());
  assert.deepEqual(literalsIn(checkClause(SUPPORT, 'ticket_case_state_actor_check')), [...ACTORS].sort());
  assert.deepEqual(literalsIn(checkClause(SUPPORT, 'case_current_last_actor_check')), [...ACTORS].sort());
});

test('nothing is written when it is applied', () => {
  for (const line of codeOnly(SQL).split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
