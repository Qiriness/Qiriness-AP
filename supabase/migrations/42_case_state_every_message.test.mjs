import assert from 'node:assert/strict';
import test from 'node:test';

import { ACTORS } from '../../agent/src/casework/actors.mjs';
import { INBOUND_EFFECTS, OUTBOUND_EFFECTS } from '../../agent/src/casework/effects.mjs';

import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('42_case_state_every_message');
const SUPPORT = read('04_support');
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

test('every constraint 42 adds is stated identically in the baseline', () => {
  for (const name of [
    'ticket_case_state_relationship_check',
    'ticket_case_state_actor_check',
    'ticket_case_state_effect_check',
    'ticket_case_state_asked_array_check',
    'ticket_case_state_obligations_opened_array_check',
    'ticket_case_state_obligations_cleared_array_check'
  ]) {
    const here = checkClause(SQL, name);
    assert.ok(here, `${name} is missing from 42`);
    assert.equal(squash(here), squash(checkClause(SUPPORT, name)), name);
  }
});

test('the effect and actor vocabularies are the ones the code owns', () => {
  const effects = [...new Set([...Object.keys(INBOUND_EFFECTS), ...Object.keys(OUTBOUND_EFFECTS)])].sort();
  assert.deepEqual(literalsIn(checkClause(SQL, 'ticket_case_state_effect_check')), effects);
  assert.deepEqual(literalsIn(checkClause(SQL, 'ticket_case_state_actor_check')), [...ACTORS].sort());
});

test('the baseline has the five columns and a nullable relationship', () => {
  const columns = columnsIn(SUPPORT, 'ticket_case_state');
  for (const column of ['actor', 'effect', 'asked', 'obligations_opened', 'obligations_cleared']) {
    assert.ok(columns.includes(column), column);
  }
  assert.doesNotMatch(codeOnly(SUPPORT), /case_relationship text not null/);
});

test('it is idempotent and writes no data', () => {
  const code = codeOnly(SQL);
  assert.match(code, /alter column case_relationship drop not null/);
  assert.match(code, /add column if not exists obligations_opened/);
  for (const line of code.split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
