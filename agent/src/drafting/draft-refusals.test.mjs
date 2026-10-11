import assert from 'node:assert/strict';
import test from 'node:test';

import { createDraftRefusals, createDraftingStore, refusalKey, runDrafting } from './draft-runner.mjs';

// The drafting passes' egress (DECISIONS § An idle poll reads what could have
// changed): the queue is decided on keys, and a candidate the gates refused is
// not read again until something it depends on moves.

const CUTOVER = '2026-09-26T09:27:21Z';

// --- the memory ---------------------------------------------------------------

test('a refusal is remembered until it expires, and an unknown key is never remembered', () => {
  let clock = 0;
  const refusals = createDraftRefusals({ now: () => clock, ttlMs: 1000 });
  refusals.add('k');
  refusals.add(null);
  assert.equal(refusals.has('k'), true);
  assert.equal(refusals.has(null), false);
  assert.equal(refusals.size, 1);
  clock = 999;
  assert.equal(refusals.has('k'), true);
  clock = 1000;
  assert.equal(refusals.has('k'), false);
  assert.equal(refusals.size, 0);
});

test('the key moves with the ticket, the case file and the case version', () => {
  const base = {
    investigation: { id: 'i1', ticket_id: 't1', investigated_at: '2026-10-01T10:00:00Z' },
    ticketUpdatedAt: '2026-10-01T11:00:00Z',
    caseCurrent: { version: 3, as_of_message_id: 'm2' }
  };
  const key = refusalKey(base);
  assert.ok(key);
  assert.notEqual(refusalKey({ ...base, ticketUpdatedAt: '2026-10-01T12:00:00Z' }), key);
  assert.notEqual(refusalKey({ ...base, investigation: { ...base.investigation, investigated_at: '2026-10-02T10:00:00Z' } }), key);
  assert.notEqual(refusalKey({ ...base, caseCurrent: { version: 4, as_of_message_id: 'm2' } }), key);
  // Without the ticket's stamp there is nothing safe to key on: never remembered.
  assert.equal(refusalKey({ ...base, ticketUpdatedAt: null }), null);
});

// --- the runner ---------------------------------------------------------------

const VOICE = {
  approvalStatus: 'approved',
  roleDescription: 'Vous êtes l’agent de rédaction du Service Client Qiriness.',
  toneAndVoice: 'Professionnel et concis.',
  responseFramework: [],
  guidelinesAndGuardrails: [],
  signature: 'Bien cordialement,\nService Client Qiriness',
  generalContext: ''
};

const customer = (id, at) => ({ id, direction: 'inbound', actor: 'customer', received_at: at });
const partner = (id, at) => ({ id, direction: 'inbound', actor: 'partner', received_at: at });

const candidate = (overrides = {}) => ({
  investigation: {
    id: 'i1', ticket_id: 't1', trigger_message_id: 'm2', verdict: 'answerable',
    established: [{ claim: 'La commande est en préparation.' }], unverified: [], missing: [], do_not_claim: [], knowledge: []
  },
  ticket: { id: 't1', status: 'open', needs_categorisation: false, needs_investigation: false, level: 2, language: 'fr', happiness: 1 },
  message: { id: 'm2', subject: 'Ma commande', body_text: 'Où en est ma commande ?' },
  orderContext: null,
  conversation: [customer('m2', '2026-09-27T10:00:00Z')],
  thread: [customer('m2', '2026-09-27T10:00:00Z')],
  caseCurrent: { version: 3, next_actor: 'support', as_of_message_id: 'm2' },
  refusalKey: 'key-t1',
  ...overrides
});

function run(candidates, { openai } = {}) {
  const refusals = createDraftRefusals();
  const claims = [];
  return runDrafting({
    store: { async claimable(args) { claims.push(args); return candidates; } },
    draftRecord: { async save(draft) { return draft; } },
    openai: openai ?? { async completeJson() { return { subject: null, body: `Bonjour,\n\nVotre commande est en préparation.\n\n${VOICE.signature}` }; } },
    brandVoice: VOICE,
    shopId: 's',
    model: 'gpt-4o',
    gates: 'poll',
    cutoverAt: CUTOVER,
    refusals
  }).then((totals) => ({ totals, refusals, claims }));
}

test('a candidate the gates refuse is remembered, and the memory reaches the claim', async () => {
  // A partner's message is not the customer's to be answered: not_customer_trigger.
  const refused = candidate({
    conversation: [partner('m2', '2026-09-27T10:00:00Z')],
    thread: [partner('m2', '2026-09-27T10:00:00Z')]
  });
  const { totals, refusals, claims } = await run([refused]);
  assert.equal(totals.skippedBy.not_customer_trigger, 1);
  assert.equal(refusals.has('key-t1'), true);
  assert.equal(claims[0].refusals, refusals);
});

test('a model failure is not a refusal: it is tried again next poll', async () => {
  const { totals, refusals } = await run([candidate()], {
    openai: { async completeJson() { throw new Error('rate limited'); } }
  });
  assert.equal(totals.failed, 1);
  assert.equal(refusals.has('key-t1'), false);
});

test('a drafted candidate is not remembered as refused', async () => {
  const { totals, refusals } = await run([candidate()]);
  assert.equal(totals.drafted, 1);
  assert.equal(refusals.size, 0);
});

// --- the store, through the real PostgREST client ----------------------------

const TABLES = {
  case_current: [
    { ticket_id: 't1', shop_id: 's', version: 3, next_actor: 'support', as_of_message_id: 'm2', as_of_at: '2026-09-27T10:00:00Z', obligations: [], pending_customer_inputs: [] }
  ],
  ticket_investigations: [
    { id: 'i-old', ticket_id: 't1', shop_id: 's', trigger_message_id: 'm1', verdict: 'answerable', investigated_at: '2026-09-27T09:00:00Z', established: ['old'], handoff: null },
    { id: 'i-new', ticket_id: 't1', shop_id: 's', trigger_message_id: 'm2', verdict: 'answerable', investigated_at: '2026-09-27T11:00:00Z', established: ['new'], handoff: 'rembourser' }
  ],
  ticket_drafts: [],
  tickets: [{ id: 't1', shop_id: 's', updated_at: '2026-09-27T11:05:00Z', status: 'open', case_id: null }],
  ticket_messages: [{ id: 'm2', ticket_id: 't1', direction: 'inbound', actor: 'customer', body_text: 'Où en est ma commande ?', received_at: '2026-09-27T10:00:00Z' }]
};

function matches(row, params) {
  for (const [column, condition] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(column)) continue;
    if (condition.startsWith('in.(')) {
      const values = condition.slice(4, -1).split(',').map((v) => v.replace(/^"|"$/g, ''));
      if (!values.includes(String(row[column]))) return false;
    } else if (condition.startsWith('eq.')) {
      if (String(row[column]) !== condition.slice(3)) return false;
    }
  }
  return true;
}

function fakeSupabase() {
  const queries = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const table = parsed.pathname.split('/').pop();
    const select = parsed.searchParams.get('select');
    queries.push({ table, select, params: Object.fromEntries(parsed.searchParams) });
    const from = Number(String(init?.headers?.Range || '0-999').split('-')[0]);
    if (from > 0) return { ok: true, json: async () => [] };
    const rows = (TABLES[table] ?? []).filter((row) => matches(row, parsed.searchParams));
    const columns = select.split(',');
    return { ok: true, json: async () => rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null]))) };
  };
  return {
    queries,
    client: { baseUrl: 'https://example.test/rest/v1', key: 'test-key' },
    restore: () => { globalThis.fetch = originalFetch; }
  };
}

test('the queue is decided on keys; the case file is read in full for the claimed only', async () => {
  const db = fakeSupabase();
  try {
    const store = createDraftingStore(db.client);
    const [claimed] = await store.claimable({ shopId: 's', gates: 'poll', cutoverAt: CUTOVER, refusals: createDraftRefusals() });

    const reads = db.queries.filter((q) => q.table === 'ticket_investigations');
    assert.equal(reads.length, 2);
    assert.equal(reads[0].select, 'id,ticket_id,trigger_message_id,investigated_at');
    // The heavy read names the one claimed case file, the newest.
    assert.match(reads[1].select, /established/);
    assert.equal(reads[1].params.id, 'in.(i-new)');

    assert.equal(claimed.investigation.id, 'i-new');
    assert.deepEqual(claimed.investigation.established, ['new']);
    assert.equal(claimed.investigation.handoff, true);
    assert.equal(claimed.refusalKey, refusalKey({
      investigation: TABLES.ticket_investigations[1],
      ticketUpdatedAt: '2026-09-27T11:05:00Z',
      caseCurrent: TABLES.case_current[0]
    }));
  } finally {
    db.restore();
  }
});

test('a remembered refusal is not claimed: no case file and no thread is read for it', async () => {
  const db = fakeSupabase();
  try {
    const store = createDraftingStore(db.client);
    const refusals = createDraftRefusals();
    const [first] = await store.claimable({ shopId: 's', gates: 'poll', cutoverAt: CUTOVER, refusals });
    refusals.add(first.refusalKey);
    db.queries.length = 0;

    assert.deepEqual(await store.claimable({ shopId: 's', gates: 'poll', cutoverAt: CUTOVER, refusals }), []);
    assert.equal(db.queries.some((q) => q.table === 'ticket_messages'), false);
    assert.equal(db.queries.some((q) => q.table === 'ticket_investigations' && /established/.test(q.select)), false);
  } finally {
    db.restore();
  }
});

test('without a memory the claim reads no ticket stamp, as before', async () => {
  const db = fakeSupabase();
  try {
    const store = createDraftingStore(db.client);
    const [claimed] = await store.claimable({ shopId: 's', gates: 'poll', cutoverAt: CUTOVER });
    assert.equal(claimed.refusalKey, null);
    assert.equal(db.queries.some((q) => q.table === 'tickets' && q.select === 'id,updated_at'), false);
  } finally {
    db.restore();
  }
});
