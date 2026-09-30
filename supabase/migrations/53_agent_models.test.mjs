import assert from 'node:assert/strict';
import test from 'node:test';

import { EDITABLE_AGENTS } from '../../scripts/lib/agent-models.mjs';
import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('53_agent_models');
const SUPPORT = read('04_support');
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

test('53 creates the same table the baseline does, column for column', () => {
  assert.deepEqual(columnsIn(SQL, 'agent_models'), columnsIn(SUPPORT, 'agent_models'));
  for (const name of ['agent_models_agent_check', 'agent_models_model_check']) {
    assert.equal(squash(checkClause(SQL, name)), squash(checkClause(SUPPORT, name)), name);
  }
});

test('the agents the database accepts are the ones Settings can set', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, 'agent_models_agent_check')).sort(), [...EDITABLE_AGENTS].sort());
});

test('no data is written', () => {
  const writes = codeOnly(SQL).split('\n').filter((line) => /^\s*(insert|update|delete)\s+/i.test(line));
  assert.equal(writes.length, 0);
});
