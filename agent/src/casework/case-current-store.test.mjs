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

test('a fact drift recorded after the last fold counts as movement', () => {
  const ids = staleTickets({
    tickets: [
      { id: 'drifted', last_message_at: '2026-09-20T10:00:00Z', fact_drift_at: '2026-09-22T10:00:00Z' },
      { id: 'old', last_message_at: '2026-09-20T10:00:00Z', fact_drift_at: '2026-09-20T12:00:00Z' }
    ],
    current: [
      { ticket_id: 'drifted', folded_at: '2026-09-21T10:00:00Z' },
      { ticket_id: 'old', folded_at: '2026-09-21T10:00:00Z' }
    ]
  });
  assert.deepEqual(ids, ['drifted']);
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

function statusStore(ticketRow, { moves = true } = {}) {
  const store = fakeStore({ t1: { messages: thread('support'), caseFiles: [], readings: [], previous: null } });
  store.moved = [];
  store.ticket = async () => ticketRow;
  store.setStatus = async (ticket, status, caseStatus) => {
    store.moved.push({ from: ticket.status, status, caseStatus });
    return moves ? { id: ticket.id } : null;
  };
  return store;
}

test('the fold moves the ticket to the status its next actor asks for (stage 5c)', async () => {
  const store = statusStore({ id: 't1', status: 'open', metadata: {} });
  const totals = await runFold({
    store,
    shopId: 's',
    actorFor: () => 'customer',
    statusMap: { nobody: ['resolved'] },
    now: () => new Date('2026-09-27T10:00:00Z')
  });
  assert.equal(totals.statusesMoved, 1);
  assert.deepEqual(store.moved[0].caseStatus, {
    status: 'resolved', from: 'open', next_actor: 'nobody', version: 1, at: '2026-09-27T10:00:00.000Z', resolved_at: '2026-09-27T10:00:00.000Z'
  });
});

test('with no status map the fold writes case_current only', async () => {
  const store = statusStore({ id: 't1', status: 'open', metadata: {} });
  const totals = await runFold({ store, shopId: 's', actorFor: () => 'customer' });
  assert.equal(totals.statusesMoved, 0);
  assert.equal(store.moved.length, 0);
});

test('a ticket a person changed meanwhile is not counted as moved', async () => {
  const store = statusStore({ id: 't1', status: 'open', metadata: {} }, { moves: false });
  const totals = await runFold({ store, shopId: 's', actorFor: () => 'customer', statusMap: { nobody: ['resolved'] } });
  assert.equal(store.moved.length, 1);
  assert.equal(totals.statusesMoved, 0);
});

function draftStore(previous, messages) {
  const store = fakeStore({ t1: { messages, caseFiles: [], readings: [], previous } });
  store.staled = [];
  store.staleDrafts = async (ticketId, options) => {
    store.staled.push({ ticketId, ...options });
    return 1;
  };
  return store;
}

test('our own new reply supersedes the open drafts written before it (stage 6)', async () => {
  const first = fakeStore({ t1: { messages: thread('customer'), caseFiles: [], readings: [], previous: null } });
  await runFold({ store: first, shopId: 's', actorFor: () => 'customer' });
  const before = first.saved[0];

  // Our reply typed in Outlook arrives: the last message is now ours.
  const messages = [...thread('customer'), { id: 'c', direction: 'outbound', actor: 'support', received_at: '2026-09-03T10:00:00Z' }];
  const store = draftStore({ version: before.version, material_hash: before.material_hash, as_of_message_id: 'b' }, messages);
  const totals = await runFold({ store, shopId: 's', actorFor: () => 'customer' });
  assert.equal(store.staled.length, 1);
  assert.equal(store.staled[0].outboundAt, '2026-09-03T10:00:00Z');
  assert.equal(store.staled[0].reason, 'superseded_by_outbound');
  assert.equal(totals.draftsStaled, 1);
});

test('a raised version stales the older drafts as case_changed', async () => {
  const first = fakeStore({ t1: { messages: thread('support'), caseFiles: [], readings: [], previous: null } });
  await runFold({ store: first, shopId: 's', actorFor: () => 'customer' });
  const before = first.saved[0];

  // The customer writes again: the case moves, nothing of ours is new.
  const store = draftStore({ version: before.version, material_hash: before.material_hash, as_of_message_id: 'b' }, thread('customer'));
  await runFold({ store, shopId: 's', actorFor: () => 'customer' });
  assert.deepEqual(store.staled[0], { ticketId: 't1', outboundAt: null, version: before.version + 1, reason: 'case_changed' });
});

test('an unchanged case and a first fold stale nothing', async () => {
  const first = draftStore(null, thread('customer'));
  await runFold({ store: first, shopId: 's', actorFor: () => 'customer' });
  assert.equal(first.staled.length, 0);

  const row = first.saved[0];
  const same = draftStore({ version: row.version, material_hash: row.material_hash, as_of_message_id: row.as_of_message_id }, thread('customer'));
  await runFold({ store: same, shopId: 's', actorFor: () => 'customer' });
  assert.equal(same.staled.length, 0);
});

function snoozeStore(previous, messages, { open = null, snoozedOn = false } = {}) {
  const store = fakeStore({ t1: { messages, caseFiles: [], readings: [], previous } });
  store.written = [];
  store.woken = [];
  store.ticket = async () => ({ id: 't1', status: 'awaiting_customer', level: 2, metadata: {}, overrides: {} });
  store.parameters = async () => new Map([['customer_reply_wait_days', '5']]);
  store.snoozes = {
    open: async () => open,
    autoSnoozedOn: async () => snoozedOn,
    snooze: async (row) => {
      store.written.push(row);
      return { created: true, snooze: { id: 's1', ...row } };
    },
    wake: async (ticketId, reason) => {
      store.woken.push({ ticketId, reason });
      return { id: 's1' };
    },
    retarget: async (snoozeId, change) => {
      store.retargeted.push({ snoozeId, ...change });
      return { id: snoozeId, waiting_for: change.waitingFor, wake_at: change.wakeAt.toISOString() };
    }
  };
  store.retargeted = [];
  return store;
}

// The customer wrote (b); our reply (c) has just come back through Sent Items.
const answered = [...thread('customer'), { id: 'c', direction: 'outbound', actor: 'support', received_at: '2026-09-30T09:00:00Z' }];

test('with AGENT_AUTO_SNOOZE, our sent reply snoozes the ticket until the customer delay', async () => {
  const store = snoozeStore({ version: 1, as_of_message_id: 'b', next_actor: 'support' }, answered);
  // A reply that answered everything folds to nobody; one that asked, to the customer.
  store.inputs = async () => ({
    messages: answered,
    caseFiles: [{ trigger_message_id: 'b', verdict: 'needs_customer_input', missing: [{ field: 'order_number' }] }],
    readings: [],
    previous: { version: 1, as_of_message_id: 'b', next_actor: 'support' }
  });
  const totals = await runFold({ store, shopId: 's', actorFor: () => 'customer', autoSnooze: true, now: () => new Date('2026-09-30T10:00:00Z') });
  assert.equal(totals.snoozed, 1);
  assert.equal(store.written[0].waiting_for, 'customer');
  assert.equal(store.written[0].trigger_message_id, 'c');
  assert.equal(store.written[0].source, 'auto');
  assert.equal(store.written[0].wake_at, '2026-10-07T09:00:00.000Z');
});

test('without the switch the fold never snoozes', async () => {
  const store = snoozeStore({ version: 1, as_of_message_id: 'b', next_actor: 'support' }, answered);
  const totals = await runFold({ store, shopId: 's', actorFor: () => 'customer' });
  assert.equal(totals.snoozed, 0);
  assert.equal(store.written.length, 0);
});

test('a snoozed case the fold hands back to us is woken', async () => {
  // The customer writes on a snoozed ticket: the case is ours again.
  const store = snoozeStore({ version: 1, as_of_message_id: 'x', next_actor: 'customer' }, thread('customer'), { open: { id: 's1' } });
  const totals = await runFold({ store, shopId: 's', actorFor: () => 'customer', autoSnooze: true });
  assert.equal(totals.woken, 1);
  assert.deepEqual(store.woken, [{ ticketId: 't1', reason: 'case_changed' }]);
});

test('a snoozed case the fold now reads as waiting on someone else has its snooze retargeted, not woken', async () => {
  // Snoozed on the customer; the fold now says the customer still owes us, but
  // the open snooze names a partner.
  const store = snoozeStore({ version: 1, as_of_message_id: 'b', next_actor: 'support' }, answered, {
    open: { id: 's1', source: 'auto', waiting_for: 'partner', trigger_message_id: 'x' }
  });
  store.inputs = async () => ({
    messages: answered,
    caseFiles: [{ trigger_message_id: 'b', verdict: 'needs_customer_input', missing: [{ field: 'order_number' }] }],
    readings: [],
    previous: { version: 1, as_of_message_id: 'b', next_actor: 'partner' }
  });
  const totals = await runFold({ store, shopId: 's', actorFor: () => 'customer', autoSnooze: true, now: () => new Date('2026-09-30T10:00:00Z') });
  assert.equal(totals.retargeted, 1);
  assert.equal(totals.woken, 0);
  assert.equal(store.retargeted[0].snoozeId, 's1');
  assert.equal(store.retargeted[0].waitingFor, 'customer');
  assert.equal(store.retargeted[0].wakeAt.toISOString(), '2026-10-07T09:00:00.000Z');
});
