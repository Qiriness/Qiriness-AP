import assert from 'node:assert/strict';
import test from 'node:test';

import { runFold, staleTickets } from './case-current-store.mjs';

test('a ticket is folded when it has never been, or has moved since', () => {
  const ids = staleTickets({
    tickets: [
      { id: 'new', last_message_at: '2026-09-20T10:00:00Z' },
      { id: 'fresh', last_message_at: '2026-09-20T10:00:00Z' },
      { id: 'mail', last_message_at: '2026-09-22T10:00:00Z' },
      { id: 'caseFile', last_message_at: '2026-09-20T10:00:00Z', investigated_at: '2026-09-23T10:00:00Z' },
      { id: 'reading', last_message_at: '2026-09-20T10:00:00Z' }
    ],
    current: [
      { ticket_id: 'fresh', folded_at: '2026-09-21T10:00:00Z' },
      { ticket_id: 'mail', folded_at: '2026-09-21T10:00:00Z' },
      { ticket_id: 'caseFile', folded_at: '2026-09-21T10:00:00Z' },
      { ticket_id: 'reading', folded_at: '2026-09-21T10:00:00Z' }
    ],
    readings: [{ ticket_id: 'reading', read_at: '2026-09-24T10:00:00Z' }]
  });
  assert.deepEqual(ids, ['new', 'mail', 'caseFile', 'reading']);
});

function fakeStore(inputs) {
  const saved = [];
  return {
    saved,
    async staleTicketIds() { return Object.keys(inputs); },
    async inputs(id) { if (inputs[id] instanceof Error) throw inputs[id]; return inputs[id]; },
    async save(row) { saved.push(row); }
  };
}

const thread = (lastActor) => [
  { id: 'a', direction: 'inbound', actor: 'customer', received_at: '2026-09-01T10:00:00Z' },
  { id: 'b', direction: lastActor === 'support' ? 'outbound' : 'inbound', actor: lastActor, received_at: '2026-09-02T10:00:00Z' }
];

test('each stale ticket is folded and saved; its version moves only when something material did', async () => {
  const first = fakeStore({ t1: { messages: thread('support'), caseFiles: [], readings: [], previous: null } });
  await runFold({ store: first, shopId: 's', actorFor: () => 'customer', now: () => new Date('2026-09-26T10:00:00Z') });
  const row = first.saved[0];
  assert.equal(row.version, 1);
  assert.equal(row.next_actor, 'nobody');
  assert.equal(row.folded_at, '2026-09-26T10:00:00.000Z');

  const same = fakeStore({ t1: { messages: thread('support'), caseFiles: [], readings: [], previous: { version: 1, material_hash: row.material_hash } } });
  await runFold({ store: same, shopId: 's', actorFor: () => 'customer' });
  assert.equal(same.saved[0].version, 1);

  const moved = fakeStore({ t1: { messages: thread('customer'), caseFiles: [], readings: [], previous: { version: 1, material_hash: row.material_hash } } });
  const totals = await runFold({ store: moved, shopId: 's', actorFor: () => 'customer' });
  assert.equal(moved.saved[0].version, 2);
  assert.equal(totals.versionsRaised, 1);
});

test('a ticket that fails is counted and the others still fold', async () => {
  const warnings = [];
  const store = fakeStore({ bad: new Error('timeout'), good: { messages: thread('customer'), caseFiles: [], readings: [], previous: null } });
  const totals = await runFold({ store, shopId: 's', actorFor: () => 'customer', logger: { warn: (e) => warnings.push(e) } });
  assert.deepEqual([totals.failed, totals.folded], [1, 1]);
  assert.deepEqual(warnings, ['fold.ticket_failed']);
});

test('a message stored before the actor column is given one', async () => {
  const store = fakeStore({
    t1: { messages: [{ id: 'a', direction: 'inbound', actor: null, from_email: 'ops@partner.example', received_at: '2026-09-01' }], caseFiles: [], readings: [], previous: null }
  });
  await runFold({ store, shopId: 's', actorFor: () => 'partner' });
  assert.equal(store.saved[0].last_actor, 'partner');
});
