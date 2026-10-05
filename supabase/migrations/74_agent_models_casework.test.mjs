import assert from 'node:assert/strict';
import test from 'node:test';

import { EDITABLE_AGENTS } from '../../scripts/lib/agent-models.mjs';
import { checkClause, codeOnly, literalsIn, read } from './_shared.test.mjs';

const SQL = read('74_agent_models_casework');
const SUPPORT = read('04_support');
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

test('the baseline accepts the same agents', () => {
  assert.equal(squash(checkClause(SQL, 'agent_models_agent_check')), squash(checkClause(SUPPORT, 'agent_models_agent_check')));
});

test('the agents the database accepts are the ones Settings can set', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, 'agent_models_agent_check')).sort(), [...EDITABLE_AGENTS].sort());
});

test('nothing is written when it is applied', () => {
  for (const line of codeOnly(SQL).split('\n')) {
    assert.doesNotMatch(line, /^\s*(insert|update|delete)\s+/i, line);
  }
});
