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

// 56 WAS THE HEAD OF THE NEEDS CHECK UNTIL 58 added `promotion_outcome`
// (2026-10-01). An applied migration is not edited to keep up: 56 is the
// baseline of its day, which is today's baseline minus what 58 added.
const ADDED_BY_58 = ['promotion_outcome'];
const minus = (list, gone) => list.filter((item) => !gone.includes(item));

test('56 carries the baseline checks of its day, not retyped ones', () => {
  assert.equal(squash(checkClause(SQL, SLOTS)), squash(checkClause(KNOWLEDGE, SLOTS)));
  assert.deepEqual(literalsIn(checkClause(SQL, NEEDS)), minus(literalsIn(checkClause(EXEMPLARS, NEEDS)), ADDED_BY_58));
});

test('the head of the needs check is the code vocabulary, and policy_answer is gone from both', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, NEEDS)), minus([...NEED_KEYS], ADDED_BY_58).sort());
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
