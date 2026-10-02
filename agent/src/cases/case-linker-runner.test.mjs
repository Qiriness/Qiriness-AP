import assert from 'node:assert/strict';
import test from 'node:test';

import { decideLink } from './case-link-rules.mjs';
import { MAX_CANDIDATES, createCaseLinkStore, plausibleCandidates, runCaseLinking, situationOf } from './case-linker-runner.mjs';

const FAMILIES = { subjects: { delivery: 'DELIVERY' }, situations: {}, transitions: [['DELIVERY', 'REFUND_RETURN']] };

function fakes({ context, tickets = [{ id: 't-new', case_id: 'k-new', subject: 'Toujours rien', status: 'open', investigated_at: null }] } = {}) {
  const applied = [];
  const refreshed = [];
  const store = {
    pending: async () => tickets,
    contextFor: async () => context,
    wakeCase: async () => {},
    setCaseKey: async () => {}
  };
  const cases = {
    families: async () => FAMILIES,
    applyDecision: async (decision) => (applied.push(decision), { decision: decision.toCaseId !== decision.fromCaseId ? 'link' : 'new_case' }),
    refreshTarget: async (caseId) => refreshed.push(caseId)
  };
  return { store, cases, applied, refreshed };
}

const thread = (extra = {}) => ({ excluded: false, hasPriorCases: true, orderNumber: '#5832', trackingNumbers: [], family: 'DELIVERY', ...extra });

test('a deterministic match links without the model, and the target case is recomputed', async () => {
  const { store, cases, applied, refreshed } = fakes({
    context: { thread: thread(), candidates: [{ caseId: 'k-old', orderNumbers: ['#5832'], family: 'DELIVERY', reasons: ['same_order'] }] }
  });
  const linkCase = async () => assert.fail('the model must not be asked');
  const result = await runCaseLinking({ store, cases, linkCase });
  assert.equal(result.linked, 1);
  assert.equal(applied[0].toCaseId, 'k-old');
  assert.equal(applied[0].method, 'order_family');
  assert.deepEqual(refreshed, ['k-old']);
});

test('ambiguous with the model off: a new case, candidates recorded', async () => {
  const { store, cases, applied } = fakes({
    context: { thread: thread({ orderNumber: null }), candidates: [{ caseId: 'k1', family: 'DELIVERY', reasons: ['compatible_family'] }] }
  });
  const result = await runCaseLinking({ store, cases, linkCase: null });
  assert.equal(result.ambiguous, 1);
  assert.equal(applied[0].method, 'model_off');
  assert.equal(applied[0].toCaseId, 'k-new');
  assert.deepEqual(applied[0].candidates, [{ case_id: 'k1', reasons: ['compatible_family'] }]);
});

test('ambiguous with the model on: its LINK is applied, and recorded as the model', async () => {
  const { store, cases, applied } = fakes({
    context: { thread: thread({ orderNumber: null }), candidates: [{ caseId: 'k1', reasons: ['similar_message'] }, { caseId: 'k2', reasons: ['compatible_family'] }] }
  });
  const result = await runCaseLinking({
    store,
    cases,
    linkCase: async () => ({ decision: 'link', caseId: 'k2', answer: 'LINK:k2', model: 'gpt-4o-mini' })
  });
  assert.equal(result.modelCalls, 1);
  assert.equal(applied[0].toCaseId, 'k2');
  assert.equal(applied[0].method, 'model');
  assert.equal(applied[0].modelAnswer, 'LINK:k2');
});

test('a failed model call is a new case, never a guess', async () => {
  const { store, cases, applied } = fakes({ context: { thread: thread({ orderNumber: null }), candidates: [{ caseId: 'k1', reasons: ['compatible_family'] }] } });
  await runCaseLinking({ store, cases, linkCase: async () => { throw new Error('timeout'); } });
  assert.equal(applied[0].toCaseId, 'k-new');
});

test('a thread investigated before it joined a case is sent back through the investigation', async () => {
  const { store, cases, applied } = fakes({
    tickets: [{ id: 't', case_id: 'k-new', status: 'awaiting_human', investigated_at: '2026-09-01T00:00:00Z' }],
    context: { thread: thread(), candidates: [{ caseId: 'k-old', orderNumbers: ['#5832'], family: 'DELIVERY', reasons: ['same_order'] }] }
  });
  await runCaseLinking({ store, cases });
  assert.deepEqual(applied[0].ticketColumns, { needs_investigation: true, status: 'open' });
});

test('a dry run decides and writes nothing', async () => {
  const { store, cases, applied } = fakes({ context: { thread: thread({ hasPriorCases: false }), candidates: [] } });
  const result = await runCaseLinking({ store, cases, dryRun: true });
  assert.equal(result.decisions[0].method, 'first_contact');
  assert.equal(applied.length, 0);
});

test('the same sender is a candidate within 14 days, never beyond, and never links on its own', () => {
  const old = { caseId: 'k-old', family: 'DELIVERY', orderNumbers: [], trackingNumbers: [], lastMessageAt: '2026-09-01T10:00:00Z' };
  const recent = { caseId: 'k-recent', family: 'DELIVERY', orderNumbers: [], trackingNumbers: [], lastMessageAt: '2026-09-20T10:00:00Z' };
  const candidates = plausibleCandidates({
    thread: thread({ orderNumber: null, family: 'PRODUCT', at: '2026-09-25T14:28:00Z' }),
    cases: [old, recent],
    transitions: FAMILIES.transitions
  });
  assert.deepEqual(candidates.map((c) => [c.caseId, c.reasons]), [['k-recent', ['recent_same_customer']]]);
  // A candidate, not a link: no order and no parcel, so the rules call it ambiguous.
  const outcome = decideLink({ thread: thread({ orderNumber: null, family: 'PRODUCT' }), candidates, transitions: FAMILIES.transitions });
  assert.equal(outcome.decision, 'ambiguous');
});

test('candidates are ranked by the strength of their reason and capped', () => {
  const cases = Array.from({ length: 8 }, (_, i) => ({ caseId: `k${i}`, family: 'DELIVERY', orderNumbers: [], trackingNumbers: [], lastMessageAt: `2026-09-0${i + 1}` }));
  cases[6].orderNumbers = ['#5832'];
  const ranked = plausibleCandidates({ thread: thread(), cases, transitions: FAMILIES.transitions });
  assert.equal(ranked.length, MAX_CANDIDATES);
  assert.equal(ranked[0].caseId, 'k6');
  assert.deepEqual(ranked[0].reasons, ['same_order', 'compatible_family']);
});

test('the situation an investigation recorded is read from either shape', () => {
  assert.equal(situationOf({ exemplar_match: { policy: { situation_key: 'D-01' } } }), 'D-01');
  assert.equal(situationOf({ exemplar_match: { exemplar_key: 'O-09' } }), 'O-09');
  assert.equal(situationOf({}), null);
});

test('a thread already linked elsewhere counts as part of its target case (the replay is cumulative)', async () => {
  // Two earlier threads on parcel P1, stored as two cases; the replay linked the second into the first.
  const rows = {
    ticket_first_inbound: [
      { ticket_id: 't3', body_text: 'Toujours rien', from_email: 'a@example.com' },
      { ticket_id: 't1', body_text: 'Mon colis\n  n’est pas arrivé', received_at: '2026-01-01' },
      { ticket_id: 't2', body_text: 'Je relance', received_at: '2026-01-03' }
    ],
    tickets: [
      { id: 't1', case_id: 'k1', subject: 'Colis', status: 'closed', category: 'delivery', shopify_order_number: '#100', last_message_at: '2026-01-02' },
      { id: 't2', case_id: 'k2', subject: 'Re: Colis', status: 'closed', category: 'delivery', shopify_order_number: '#100', last_message_at: '2026-01-03' }
    ],
    orders: [{ name: '#100', tracking_numbers: ['P1'] }],
    ticket_investigations: [],
    ticket_messages: []
  };
  const select = async (_supabase, table) => rows[table] ?? [];
  const ticket = { id: 't3', case_id: 'k3', requester_email_hash: 'h', shopify_order_number: '#100', category: 'delivery' };
  const families = { ...FAMILIES, transitions: [] };
  const storeWith = (caseOf) => createCaseLinkStore(null, { shopId: 's', select, now: () => new Date('2026-01-10'), caseOf });

  const stored = await storeWith(null).contextFor(ticket, { families });
  assert.deepEqual(stored.candidates.map((c) => c.caseId).sort(), ['k1', 'k2']);

  const replayed = await storeWith((id) => (id === 't2' ? 'k1' : undefined)).contextFor(ticket, { families });
  assert.deepEqual(replayed.candidates.map((c) => c.caseId), ['k1']);
  assert.deepEqual(replayed.candidates[0].ticketIds.sort(), ['t1', 't2']);
  // The Case Linker reads what the case's customer first wrote, flattened.
  assert.equal(replayed.candidates[0].opening, 'Mon colis n’est pas arrivé');
});
