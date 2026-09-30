import assert from 'node:assert/strict';
import test from 'node:test';

import { NEED_KEYS } from '../../agent/src/investigation/evidence-rules.mjs';
import { checkClause, codeOnly, literalsIn, read } from './_shared.test.mjs';

const SQL = read('56_policy_search_retired');
const EXEMPLARS = read('05_exemplars');
const KNOWLEDGE = read('03_knowledge');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const NEEDS = 'support_exemplars_requirement_needs_check';
const SLOTS = 'knowledge_documents_core_topic_check';

test('56 carries the baseline checks, not retyped ones', () => {
  for (const [name, baseline] of [[NEEDS, EXEMPLARS], [SLOTS, KNOWLEDGE]]) {
    assert.ok(checkClause(SQL, name), name);
    assert.equal(squash(checkClause(SQL, name)), squash(checkClause(baseline, name)), name);
  }
});

test('the head of the needs check is the code vocabulary, and policy_answer is gone from both', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, NEEDS)), [...NEED_KEYS].sort());
  assert.ok(!NEED_KEYS.includes('policy_answer'));
});

test('the one slot left is the brand voice', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, SLOTS)), ['brand']);
});

test('the situations that declared policy_answer lose it before the check narrows', () => {
  const code = codeOnly(SQL);
  const update = code.search(/update public\.support_exemplars\s+set requirement_needs = array_remove\(requirement_needs, 'policy_answer'\)/);
  const narrow = code.search(new RegExp(`add constraint ${NEEDS}`));
  assert.ok(update >= 0 && narrow > update);
  // The only data statement.
  const writes = code.split('\n').filter((line) => /^\s*(insert|update|delete)\s+/i.test(line));
  assert.equal(writes.length, 1);
});
