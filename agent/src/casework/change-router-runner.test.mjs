import assert from 'node:assert/strict';
import test from 'node:test';

import { answerFromRow } from '../investigation/answer-selection.mjs';
import { runChangeRouter } from './change-router-runner.mjs';

const ORDERS = [
  { answer_key: 'non_expediee', when_conditions: { order_state: ['not_dispatched'] } },
  { answer_key: 'expediee_sans_scan', when_conditions: { order_state: ['dispatched'] } }
].map(answerFromRow);

// A bundle the context pass rebuilt: fulfilled, dispatched, no carrier scan.
const SHIPPED_BUNDLE = {
  order: {
    name: '#7093',
    placedAt: '2026-09-28T10:00:00Z',
    status: { payment: 'PAID', fulfillment: 'FULFILLED' },
    delivery: { state: 'dispatched', dispatchedAt: '2026-09-29T14:32:44Z', tracking: [{ number: 'TEST' }] },
    refunds: [],
    returns: []
  },
  signals: { isPaid: true }
};

const CASE_FILE = {
  ticket_id: 't1',
  investigated_at: '2026-09-28T15:17:59Z',
  context_ref: { orderName: '#7093' },
  tool_calls: [{ id: 't1', tool: 'getOrderContext' }],
  established: [{ claim: 'La commande n’est pas encore expédiée.', evidence_ids: ['t1'] }],
  findings_trace: [{ findings: { order_state: 'not_dispatched', delivery_state: 'not_dispatched' } }],
  exemplar_match: {
    policy: { answer_set: 'orders', situation_key: null, answer_key: 'non_expediee', verdict: 'selected', findings: { order_state: 'not_dispatched' } }
  }
};

const TICKET = {
  id: 't1',
  status: 'open',
  needs_investigation: false,
  needs_categorisation: false,
  shopify_order_number: '#7093',
  resolved_context: SHIPPED_BUNDLE,
  fact_drift: null,
  metadata: { investigation: { attempts: 0 } },
  investigated_at: '2026-09-28T15:17:59Z'
};

function fakeStore({ tickets = [TICKET], nextActor = 'support', caseFile = CASE_FILE, parameters = new Map() } = {}) {
  const writes = [];
  return {
    writes,
    async candidates() { return tickets; },
    async nextActors(ids) { return new Map(ids.map((id) => [id, nextActor])); },
    async latestInvestigations() { return new Map(caseFile ? [[caseFile.ticket_id, caseFile]] : []); },
    async answers(set) { return set === 'orders' ? ORDERS : []; },
    async parameters() {
      if (parameters instanceof Error) throw parameters;
      return parameters;
    },
    async write(id, columns) { writes.push({ id, columns }); }
  };
}

const NOW = new Date('2026-10-04T10:00:00Z');

test('a shipped order under a « not yet shipped » case file is queued for re-investigation', async () => {
  const store = fakeStore();
  const totals = await runChangeRouter({ store, shopId: 's', now: NOW });
  assert.equal(totals.reinvestigate, 1);
  const [{ columns }] = store.writes;
  assert.equal(columns.needs_investigation, true);
  assert.deepEqual(columns.fact_drift.changed.order_state, { from: 'not_dispatched', to: 'dispatched' });
  assert.equal(columns.fact_drift.case_file_at, CASE_FILE.investigated_at);
  // The trail is added beside the other passes' trails, never over them.
  assert.equal(columns.metadata.change_router.at, NOW.toISOString());
  assert.deepEqual(columns.metadata.investigation, { attempts: 0 });
});

test('a case waiting on someone else writes nothing', async () => {
  const store = fakeStore({ nextActor: 'customer' });
  const totals = await runChangeRouter({ store, shopId: 's', now: NOW });
  assert.equal(totals.none, 1);
  assert.equal(store.writes.length, 0);
});

test('the same drift found again is not written again', async () => {
  const first = fakeStore();
  await runChangeRouter({ store: first, shopId: 's', now: NOW });
  const recorded = first.writes[0].columns.fact_drift;
  const again = fakeStore({ tickets: [{ ...TICKET, fact_drift: recorded }] });
  const totals = await runChangeRouter({ store: again, shopId: 's', now: new Date('2026-10-04T10:05:00Z') });
  assert.equal(totals.already_recorded, 1);
  assert.equal(again.writes.length, 0);
});

test('a dry run decides and writes nothing', async () => {
  const store = fakeStore();
  const totals = await runChangeRouter({ store, shopId: 's', now: NOW, dryRun: true });
  assert.equal(totals.reinvestigate, 1);
  assert.equal(totals.written, 0);
  assert.equal(store.writes.length, 0);
});

test('parameters that fail to load skip the pass rather than read every window as unknown', async () => {
  const store = fakeStore({ parameters: new Error('timeout') });
  const totals = await runChangeRouter({ store, shopId: 's', now: NOW });
  assert.equal(totals.skipped, 'parameters_unavailable');
  assert.equal(store.writes.length, 0);
});

test('one ticket failing does not stop the others', async () => {
  const store = fakeStore({ tickets: [{ ...TICKET, id: 'bad', resolved_context: { order: {} } }, TICKET] });
  store.latestInvestigations = async () => new Map([['bad', { get exemplar_match() { throw new Error('boom'); } }], ['t1', CASE_FILE]]);
  const totals = await runChangeRouter({ store, shopId: 's', now: NOW });
  assert.equal(totals.failed, 1);
  assert.equal(totals.reinvestigate, 1);
});

test('a ticket held for a person gets a drift, but no new investigation and no status change', async () => {
  const store = fakeStore({ tickets: [{ ...TICKET, status: 'awaiting_human' }] });
  const totals = await runChangeRouter({ store, shopId: 's', now: NOW });
  assert.equal(totals.redraft, 1);
  const [{ columns }] = store.writes;
  assert.ok(columns.fact_drift);
  assert.equal(columns.needs_investigation, undefined);
  assert.equal(columns.status, undefined);
  assert.equal(columns.metadata, undefined);
});
