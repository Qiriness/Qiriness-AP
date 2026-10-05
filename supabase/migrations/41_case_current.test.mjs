import assert from 'node:assert/strict';
import test from 'node:test';

import { ACTORS, NEXT_ACTORS } from '../../agent/src/casework/actors.mjs';

import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('41_case_current');
const SUPPORT = read('04_support');
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

test('41 creates the same case_current the baseline does, column for column', () => {
  assert.deepEqual(columnsIn(SQL, 'case_current'), columnsIn(SUPPORT, 'case_current'));
});

// `ticket_messages_actor_check` is superseded by 73, which adds `automated`;
// the baseline is compared against 73 in 73_automated_actor.test.mjs. 41's own
// clause is still checked against ACTORS below.
test('every constraint is stated identically in both files', () => {
  for (const name of [
    'case_current_last_actor_check',
    'case_current_next_actor_check',
    'case_current_pending_inputs_array_check',
    'case_current_commitments_array_check',
    'case_current_contradictions_array_check',
    'case_current_obligations_array_check'
  ]) {
    const here = checkClause(SQL, name);
    assert.ok(here, `${name} is missing from 41`);
    assert.equal(squash(here), squash(checkClause(SUPPORT, name)), name);
  }
});

test('the actor vocabulary is the one the code owns', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, 'ticket_messages_actor_check')), [...ACTORS].sort());
  assert.deepEqual(literalsIn(checkClause(SQL, 'case_current_next_actor_check')), [...NEXT_ACTORS].sort());
});

test('the baseline declares the actor column, so a fresh install needs no delta', () => {
  assert.ok(columnsIn(SUPPORT, 'ticket_messages').includes('actor'));
});

test('it is idempotent and writes no data', () => {
  const code = codeOnly(SQL);
  assert.match(code, /add column if not exists actor text/);
  assert.match(code, /create table if not exists public\.case_current/);
  assert.match(code, /create index if not exists case_current_shop_next_actor_idx/);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
