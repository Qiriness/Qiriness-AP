import assert from 'node:assert/strict';
import test from 'node:test';

import { EDITABLE_AGENTS } from '../../scripts/lib/agent-models.mjs';
import { checkClause, codeOnly, columnsIn, literalsIn, read } from './_shared.test.mjs';

const SQL = read('53_agent_models');
const SUPPORT = read('04_support');
const LATEST = read('74_agent_models_casework');
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

test('53 creates the same table the baseline does, column for column', () => {
  assert.deepEqual(columnsIn(SQL, 'agent_models'), columnsIn(SUPPORT, 'agent_models'));
  assert.equal(squash(checkClause(SQL, 'agent_models_model_check')), squash(checkClause(SUPPORT, 'agent_models_model_check')));
  // The agent list was widened by 61 (case_link), then 74 (casework, closure);
  // 74 is the step that must match the baseline now, and 53 stays the
  // historical step it was.
  assert.equal(squash(checkClause(LATEST, 'agent_models_agent_check')), squash(checkClause(SUPPORT, 'agent_models_agent_check')));
  assert.ok(literalsIn(checkClause(SQL, 'agent_models_agent_check')).every((agent) => EDITABLE_AGENTS.includes(agent)));
});

test('the agents the database accepts are the ones Settings can set', () => {
  assert.deepEqual(literalsIn(checkClause(LATEST, 'agent_models_agent_check')).sort(), [...EDITABLE_AGENTS].sort());
});

test('no data is written', () => {
  const writes = codeOnly(SQL).split('\n').filter((line) => /^\s*(insert|update|delete)\s+/i.test(line));
  assert.equal(writes.length, 0);
});
