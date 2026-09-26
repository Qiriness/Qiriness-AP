import assert from 'node:assert/strict';
import test from 'node:test';

import { compareWithDelta, planIdTranslation } from './immutable-ids.mjs';

const ok = (sourceId) => ({ sourceId, targetId: `imm-${sourceId}`, error: null });

test('each translated row is rewritten; an untranslatable one keeps its id and is counted', () => {
  const plan = planIdTranslation(
    {
      ticket_messages: [{ id: 't1', graph_message_id: 'a' }, { id: 't2', graph_message_id: 'gone' }],
      spam_audit: [{ id: 's1', graph_message_id: 'b' }]
    },
    [ok('a'), ok('b'), { sourceId: 'gone', targetId: null, error: 'Format' }]
  );

  assert.deepEqual(plan.updates, [
    { table: 'ticket_messages', id: 't1', from: 'a', to: 'imm-a' },
    { table: 'spam_audit', id: 's1', from: 'b', to: 'imm-b' }
  ]);
  assert.deepEqual(plan.failed, { Format: 1 });
  assert.deepEqual(plan.failedByTable, { ticket_messages: 1 });
  assert.deepEqual(plan.conflicts, []);
});

test('one id stored in two tables is rewritten in both', () => {
  const plan = planIdTranslation(
    { ticket_messages: [{ id: 't1', graph_message_id: 'a' }], categorisation_review: [{ id: 'c1', graph_message_id: 'a' }] },
    [ok('a')]
  );
  assert.equal(plan.updates.length, 2);
  assert.deepEqual(plan.conflicts, []);
});

test('two rows translating to one id within a table is a conflict, never a write', () => {
  const plan = planIdTranslation(
    { ticket_messages: [{ id: 't1', graph_message_id: 'a' }, { id: 't2', graph_message_id: 'b' }] },
    [{ sourceId: 'a', targetId: 'same', error: null }, { sourceId: 'b', targetId: 'same', error: null }]
  );
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.updates.length, 1);
});

test('a target another row already holds is a conflict', () => {
  const plan = planIdTranslation(
    { ticket_messages: [{ id: 't1', graph_message_id: 'a' }, { id: 't2', graph_message_id: 'imm-a' }] },
    [ok('a'), { sourceId: 'imm-a', targetId: null, error: 'Format' }]
  );
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.updates.length, 0);
});

test('the delta comparison joins on internetMessageId and ignores mail it cannot join', () => {
  const stored = [
    { graph_message_id: 'a', internet_message_id: '<a@x>' },
    { graph_message_id: 'b', internet_message_id: '<b@x>' },
    { graph_message_id: 'c', internet_message_id: null }
  ];
  const translated = new Map([['a', 'imm-a'], ['b', 'imm-b'], ['c', 'imm-c']]);
  const delta = [
    { id: 'imm-a', internetMessageId: '<a@x>' },
    { id: 'other', internetMessageId: '<b@x>' },
    { id: 'imm-z', internetMessageId: '<z@x>' }
  ];
  assert.deepEqual(compareWithDelta(stored, translated, delta), { equal: 1, differ: 1 });
});
