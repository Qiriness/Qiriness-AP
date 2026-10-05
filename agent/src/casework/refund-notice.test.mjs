import assert from 'node:assert/strict';
import test from 'node:test';

import { noticeDue, noticeRecord } from './change-router.mjs';
import { runChangeRouter } from './change-router-runner.mjs';

// Shaped on 75419781 (#6886): our last reply 2026-09-07, a partial refund
// recorded 2026-09-25, the customer never told.
const REFUND = { id: 'gid://shopify/Refund/1', created_at: '2026-09-25T12:47:28Z' };
const CASE = {
  inScope: true,
  refunds: [REFUND],
  firstMessageAt: '2026-09-04T12:40:17Z',
  lastMessageAt: '2026-09-07T14:55:10Z',
  lastOutboundAt: '2026-09-07T14:55:10Z',
  windowDays: 60
};

test('a refund recorded after our last reply is due', () => {
  assert.deepEqual(noticeDue(CASE), { refund_ids: [REFUND.id] });
});

test('a refund we have written since is not due: the customer was told', () => {
  assert.equal(noticeDue({ ...CASE, lastOutboundAt: '2026-09-26T09:00:00Z' }), null);
});

test('a refund from before the ticket is not news to this case', () => {
  assert.equal(noticeDue({ ...CASE, firstMessageAt: '2026-09-30T00:00:00Z', lastOutboundAt: null }), null);
});

test('outside the window, out of scope, or no window set: nothing', () => {
  assert.equal(noticeDue({ ...CASE, windowDays: 10 }), null);
  assert.equal(noticeDue({ ...CASE, inScope: false }), null);
  assert.equal(noticeDue({ ...CASE, windowDays: null }), null);
});

test('the same refunds are noticed once; a later one is noticed again', () => {
  const recorded = { refund_ids: [REFUND.id] };
  assert.equal(noticeDue({ ...CASE, recorded }), null);
  const later = { id: 'gid://shopify/Refund/2', created_at: '2026-10-01T10:00:00Z' };
  assert.deepEqual(noticeDue({ ...CASE, refunds: [REFUND, later], recorded }), { refund_ids: [REFUND.id, later.id] });
});

test('a ticket we never answered still gets told of a refund made after it opened', () => {
  assert.deepEqual(noticeDue({ ...CASE, lastOutboundAt: null }), { refund_ids: [REFUND.id] });
});

// --- The pass -------------------------------------------------------------

const TEMPLATE = { answer_set: 'returns', answer_key: 'remboursement_deja_parti' };
const TICKET = {
  id: 't6886',
  status: 'closed',
  category: 'return_exchange',
  secondary_category: null,
  shopify_order_number: '#6886',
  fact_drift: null,
  metadata: { closed_reason: 'inactivity' },
  first_message_at: CASE.firstMessageAt,
  last_message_at: CASE.lastMessageAt,
  case_id: 'k1'
};

function fakeStore({ tickets = [TICKET], parameters = new Map([['refund_notice_window_days', '60']]), templates = new Map([['returns', TEMPLATE]]) } = {}) {
  const writes = [];
  return {
    writes,
    async parameters() { return parameters; },
    async noticeTemplates() { return templates; },
    async noticeCandidates() { return tickets; },
    async refundsByOrder() { return new Map([['#6886', [REFUND]]]); },
    async lastOutboundByCase() { return new Map([['k1', CASE.lastOutboundAt]]); },
    async candidates() { return []; },
    async write(id, columns) { writes.push({ id, columns }); }
  };
}

const NOW = new Date('2026-10-05T09:00:00Z');

test('a closed returns ticket with an untold refund is reopened for a person, with the notice recorded', async () => {
  const store = fakeStore();
  const totals = await runChangeRouter({ store, shopId: 's', now: NOW });
  assert.equal(totals.notices.due, 1);
  assert.equal(totals.notices.reopened, 1);
  const [{ columns }] = store.writes;
  assert.equal(columns.status, 'awaiting_human');
  assert.equal(columns.closed_at, null);
  assert.deepEqual(columns.fact_drift.notice, noticeRecord({ refundIds: [REFUND.id], template: TEMPLATE, at: NOW.toISOString() }));
  assert.equal(columns.fact_drift.checked_at, NOW.toISOString());
  assert.equal(columns.metadata.closed_reason, 'inactivity', 'other metadata is kept');
  assert.equal(columns.metadata.change_router.reopened_from, 'closed');
});

test('an open ticket is not reopened, only noticed; a notice already recorded is not written again', async () => {
  const open = fakeStore({ tickets: [{ ...TICKET, status: 'awaiting_customer' }] });
  await runChangeRouter({ store: open, shopId: 's', now: NOW });
  assert.equal(open.writes[0].columns.status, undefined);

  const recorded = fakeStore({ tickets: [{ ...TICKET, fact_drift: { notice: { refund_ids: [REFUND.id] } } }] });
  const totals = await runChangeRouter({ store: recorded, shopId: 's', now: NOW });
  assert.equal(totals.notices.due, 0);
  assert.equal(recorded.writes.length, 0);
});

test('no window set, or no rule marked: the notice is off', async () => {
  const unset = fakeStore({ parameters: new Map() });
  assert.equal((await runChangeRouter({ store: unset, shopId: 's', now: NOW })).notices.skipped, 'window_unset');
  const unmarked = fakeStore({ templates: new Map() });
  assert.equal((await runChangeRouter({ store: unmarked, shopId: 's', now: NOW })).notices.skipped, 'no_template');
  assert.equal(unset.writes.length + unmarked.writes.length, 0);
});

test('a ticket outside the template’s answer set is never considered', async () => {
  const store = fakeStore({ tickets: [{ ...TICKET, category: 'product_question' }] });
  const totals = await runChangeRouter({ store, shopId: 's', now: NOW });
  assert.equal(totals.notices.considered, 0);
});

test('one notice per case: the thread written on last', async () => {
  const older = { ...TICKET, id: 'old', last_message_at: '2026-09-05T00:00:00Z' };
  const store = fakeStore({ tickets: [older, TICKET] });
  await runChangeRouter({ store, shopId: 's', now: NOW });
  assert.deepEqual(store.writes.map((w) => w.id), ['t6886']);
});

test('a dry run records nothing', async () => {
  const store = fakeStore();
  const totals = await runChangeRouter({ store, shopId: 's', now: NOW, dryRun: true });
  assert.equal(totals.notices.due, 1);
  assert.equal(store.writes.length, 0);
});
