import assert from 'node:assert/strict';
import test from 'node:test';

import { needingDraft, pollGate, runDrafting } from './draft-runner.mjs';

// Stage 6 of codex_plans/Case_State_Plan.md: drafting in the poll, one draft
// per case version, and the dry run that comes before switching it on.

const CUTOVER = '2026-09-26T09:27:21Z';
const customer = (id, at) => ({ id, direction: 'inbound', actor: 'customer', received_at: at });
const ours = (id, at) => ({ id, direction: 'outbound', actor: 'support', received_at: at });

const GATE = {
  caseCurrent: { version: 3, next_actor: 'support', as_of_message_id: 'm2' },
  ticket: { id: 't1', status: 'open', needs_categorisation: false, needs_investigation: false },
  investigation: { trigger_message_id: 'm2' },
  conversation: [customer('m1', '2026-09-20T10:00:00Z'), customer('m2', '2026-09-27T10:00:00Z')],
  cutoverAt: CUTOVER
};

test('a new customer message on our turn, after the cutover, passes every gate', () => {
  assert.deepEqual(pollGate(GATE), { ok: true, reason: null });
  assert.equal(pollGate({ ...GATE, ticket: { ...GATE.ticket, status: 'awaiting_human' } }).ok, true);
});

test('each gate names itself when it fails', () => {
  const cases = [
    [{ caseCurrent: null }, 'not_folded'],
    [{ caseCurrent: { ...GATE.caseCurrent, next_actor: 'partner' } }, 'not_our_turn'],
    [{ caseCurrent: { ...GATE.caseCurrent, next_actor: 'customer' } }, 'not_our_turn'],
    [{ ticket: { ...GATE.ticket, needs_investigation: true } }, 'pass_pending'],
    [{ ticket: { ...GATE.ticket, needs_categorisation: true } }, 'pass_pending'],
    [{ ticket: { ...GATE.ticket, status: 'resolved' } }, 'not_open'],
    [{ ticket: { ...GATE.ticket, status: 'awaiting_customer' } }, 'not_open'],
    // The case file answers m1 while the customer has written m2 since.
    [{ investigation: { trigger_message_id: 'm1' } }, 'stale_case_file'],
    // The imported history is never drafted to (Q3).
    [
      {
        investigation: { trigger_message_id: 'm1' },
        conversation: [customer('m1', '2026-09-20T10:00:00Z')]
      },
      'before_cutover'
    ],
    [{ cutoverAt: null }, 'before_cutover'],
    // Deret's message is not the customer's to be answered.
    [
      {
        investigation: { trigger_message_id: 'p1' },
        conversation: [{ id: 'p1', direction: 'inbound', actor: 'partner', received_at: '2026-09-27T10:00:00Z' }]
      },
      'not_customer_trigger'
    ]
  ];
  for (const [change, reason] of cases) {
    assert.equal(pollGate({ ...GATE, ...change }).reason, reason, reason);
  }
});

// --- one draft per case version ----------------------------------------------

const READING = { ticket_id: 't1', trigger_message_id: 'm1', investigated_at: '2026-09-27T12:00:00Z' };
const at = (version) => new Map([['t1', version]]);

test('a version with no draft needs one, even when an older version had one', () => {
  const drafts = [{ ticket_id: 't1', trigger_message_id: 'm1', case_version: 2, status: 'stale', drafted_at: '2026-09-27T12:05:00Z' }];
  assert.deepEqual(needingDraft([READING], drafts, at(3)), [READING]);
});

test('this version’s draft stands, unless it is pending and older than the case file', () => {
  const current = { ticket_id: 't1', trigger_message_id: 'm1', case_version: 3, status: 'pending', drafted_at: '2026-09-27T12:05:00Z' };
  assert.deepEqual(needingDraft([READING], [current], at(3)), []);
  assert.deepEqual(needingDraft([READING], [{ ...current, drafted_at: '2026-09-27T11:00:00Z' }], at(3)), [READING]);
  assert.deepEqual(needingDraft([READING], [{ ...current, status: 'approved', drafted_at: '2026-09-27T11:00:00Z' }], at(3)), []);
});

test('a draft from before versions still covers its message, so the switch redrafts no history', () => {
  const legacy = { ticket_id: 't1', trigger_message_id: 'm1', case_version: null, status: 'approved', drafted_at: '2026-09-27T12:05:00Z' };
  assert.deepEqual(needingDraft([READING], [legacy], at(3)), []);
  // …unless it went stale: then the case moved and this version needs its own.
  assert.deepEqual(needingDraft([READING], [{ ...legacy, status: 'stale' }], at(3)), [READING]);
});

test('without a fold the old rule applies, and a stale draft counts as none', () => {
  const draft = { trigger_message_id: 'm1', status: 'stale', drafted_at: '2026-09-27T12:05:00Z' };
  assert.deepEqual(needingDraft([READING], [draft]), [READING]);
});

// --- the runner in poll mode -------------------------------------------------

const VOICE = {
  approvalStatus: 'approved',
  roleDescription: 'Vous êtes l’agent de rédaction du Service Client Qiriness.',
  toneAndVoice: 'Professionnel et concis.',
  responseFramework: [],
  guidelinesAndGuardrails: [],
  signature: 'Bien cordialement,\nService Client Qiriness',
  generalContext: ''
};

const CANDIDATE = {
  investigation: {
    id: 'i1', ticket_id: 't1', trigger_message_id: 'm2', verdict: 'answerable',
    established: [{ claim: 'La commande est en préparation.' }], unverified: [], missing: [], do_not_claim: [], knowledge: []
  },
  ticket: { ...GATE.ticket, level: 2, language: 'fr', happiness: 1, requester_name: 'Laurence' },
  message: { id: 'm2', subject: 'Ma commande', body_text: 'Où en est ma commande ?' },
  orderContext: null,
  conversation: GATE.conversation,
  thread: GATE.conversation,
  caseCurrent: GATE.caseCurrent
};

function run(options = {}, candidates = [CANDIDATE]) {
  const saved = [];
  const calls = [];
  const claims = [];
  return runDrafting({
    store: { async claimable(args) { claims.push(args); return candidates; } },
    draftRecord: { async save(draft) { saved.push(draft); return draft; } },
    openai: { async completeJson(request) { calls.push(request); return { subject: null, body: `Bonjour Laurence,\n\nVotre commande est en préparation.\n\n${VOICE.signature}` }; } },
    brandVoice: VOICE,
    shopId: 's',
    model: 'gpt-4o',
    gates: 'poll',
    cutoverAt: CUTOVER,
    ...options
  }).then((totals) => ({ totals, saved, calls, claims }));
}

test('in the poll a draft is written against the case version, and the claim carries the gates', async () => {
  const { totals, saved, claims } = await run();
  assert.equal(totals.drafted, 1);
  assert.equal(saved[0].caseVersion, 3);
  assert.equal(saved[0].triggerEventId, 'm2');
  assert.equal(claims[0].gates, 'poll');
  assert.equal(claims[0].cutoverAt, CUTOVER);
});

test('a failed gate is counted and costs no model call', async () => {
  const { totals, calls, saved } = await run({}, [{ ...CANDIDATE, caseCurrent: { ...GATE.caseCurrent, next_actor: 'customer' } }]);
  assert.deepEqual(totals.skippedBy, { not_our_turn: 1 });
  assert.equal(calls.length, 0);
  assert.equal(saved.length, 0);
});

test('the estimate runs every gate and calls no model', async () => {
  const seen = [];
  const { totals, calls, saved } = await run({ estimateOnly: true, onDraft: (d) => seen.push(d) }, [
    CANDIDATE,
    { ...CANDIDATE, ticket: { ...CANDIDATE.ticket, id: 't2', level: 4 } }
  ]);
  assert.equal(totals.drafted, 1);
  assert.deepEqual(totals.skippedBy, { level_4: 1 });
  assert.equal(calls.length, 0);
  assert.equal(saved.length, 0);
  assert.equal(seen[0].estimate, true);
});

test('the manual path ignores the poll gates, as before', async () => {
  const { totals } = await run({ gates: 'manual' }, [{ ...CANDIDATE, caseCurrent: null }]);
  assert.equal(totals.drafted, 1);
});
