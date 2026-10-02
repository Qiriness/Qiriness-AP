import assert from 'node:assert/strict';
import test from 'node:test';

import { caseReplyTarget, caseTimeline } from './case-reply-target.mjs';

const msg = (id, ticket, direction, at, actor) => ({
  id,
  ticket_id: ticket,
  direction,
  actor: actor ?? (direction === 'outbound' ? 'support' : 'customer'),
  received_at: at
});

test('the customer wrote again on a new thread: reply there, to the newest message', () => {
  const target = caseReplyTarget([
    msg('a1', 'A', 'inbound', '2026-09-01T09:00:00Z'),
    msg('a2', 'A', 'outbound', '2026-09-02T09:00:00Z'),
    msg('b1', 'B', 'inbound', '2026-09-10T09:00:00Z')
  ]);
  assert.deepEqual(target, { messageId: 'b1', threadId: 'B', at: '2026-09-10T09:00:00.000Z' });
});

test('an answer on ANOTHER thread of the case answers the customer', () => {
  assert.equal(
    caseReplyTarget([
      msg('b1', 'B', 'inbound', '2026-09-10T09:00:00Z'),
      msg('a3', 'A', 'outbound', '2026-09-11T09:00:00Z')
    ]),
    null
  );
});

test('the newest customer message wins over an older one on the newer thread', () => {
  const target = caseReplyTarget([
    msg('b1', 'B', 'inbound', '2026-09-10T09:00:00Z'),
    msg('a4', 'A', 'inbound', '2026-09-12T09:00:00Z')
  ]);
  assert.equal(target.messageId, 'a4');
  assert.equal(target.threadId, 'A');
});

test('stored order does not matter, only the email time', () => {
  const rows = [
    msg('late', 'A', 'inbound', '2026-09-12T09:00:00Z'),
    msg('early', 'B', 'inbound', '2026-09-01T09:00:00Z')
  ];
  assert.equal(caseReplyTarget(rows).messageId, 'late');
  assert.equal(caseReplyTarget([...rows].reverse()).messageId, 'late');
});

test('a colleague or partner is never the target', () => {
  assert.equal(
    caseReplyTarget([msg('c1', 'A', 'inbound', '2026-09-12T09:00:00Z', 'colleague')]),
    null
  );
  const target = caseReplyTarget([
    msg('k1', 'A', 'inbound', '2026-09-10T09:00:00Z'),
    msg('p1', 'A', 'inbound', '2026-09-12T09:00:00Z', 'partner')
  ]);
  assert.equal(target.messageId, 'k1');
});

test('a row from before the actor column falls back to direction', () => {
  const target = caseReplyTarget([{ id: 'x', ticket_id: 'A', direction: 'inbound', received_at: '2026-09-10T09:00:00Z' }]);
  assert.equal(target.messageId, 'x');
});

test('an undated message is neither target nor answer', () => {
  assert.equal(caseReplyTarget([{ id: 'u', ticket_id: 'A', direction: 'inbound', actor: 'customer' }]), null);
  const target = caseReplyTarget([
    msg('k1', 'A', 'inbound', '2026-09-10T09:00:00Z'),
    { id: 'o', ticket_id: 'A', direction: 'outbound', actor: 'support' }
  ]);
  assert.equal(target.messageId, 'k1');
});

test('the timeline orders by email time across threads, undated last', () => {
  const ordered = caseTimeline([
    msg('b1', 'B', 'inbound', '2026-09-10T09:00:00Z'),
    { id: 'u', ticket_id: 'A', direction: 'inbound' },
    msg('a1', 'A', 'inbound', '2026-09-01T09:00:00Z')
  ]).map((m) => m.id);
  assert.deepEqual(ordered, ['a1', 'b1', 'u']);
});
