import assert from 'node:assert/strict';
import test from 'node:test';

import { noticeCaseFile, noticeDecision, noticeGate, runDrafting } from './draft-runner.mjs';
import { noticeSection } from './compose-draft.mjs';

const SIGNATURE = 'Bien cordialement,\nService Client Qiriness';
const VOICE = {
  approvalStatus: 'approved',
  roleDescription: 'Vous êtes l’agent de rédaction du Service Client Qiriness.',
  toneAndVoice: 'Professionnel et concis.',
  responseFramework: [],
  guidelinesAndGuardrails: [],
  signature: SIGNATURE,
  generalContext: ''
};

const TEMPLATE = {
  answer_set: 'returns',
  answer_key: 'remboursement_deja_parti',
  answer_skeleton: 'Le client demande sous quel délai il sera remboursé, et un remboursement est DÉJÀ parti.',
  tones: []
};
const RECORD = { event: 'refund_recorded', refund_ids: ['gid://shopify/Refund/1'], answer_set: 'returns', answer_key: 'remboursement_deja_parti', recorded_at: '2026-10-05T09:00:00Z' };

// Our reply of 09-07 sits between the customer's message and the notice.
const CONVERSATION = [
  { id: 'c1', direction: 'inbound', actor: 'customer', received_at: '2026-09-04T12:40:17Z' },
  { id: 's1', direction: 'outbound', actor: 'support', received_at: '2026-09-07T14:55:10Z' }
];

const CANDIDATE = {
  investigation: {
    id: 'investigation-1',
    ticket_id: 'ticket-1',
    trigger_message_id: 'c1',
    verdict: 'needs_human',
    investigated_at: '2026-09-04T13:00:00Z',
    tool_calls: [{ id: 't1', tool: 'getOrderContext' }, { id: 't2', tool: 'searchKnowledge' }],
    established: [
      { claim: 'Aucun remboursement n’est encore parti.', evidence_ids: ['t1'] },
      { claim: 'Les retours sont acceptés sous 14 jours.', evidence_ids: ['t2'] }
    ],
    unverified: [],
    missing: [{ field: 'shopify_order_number' }],
    do_not_claim: [],
    knowledge: [],
    exemplar_match: { policy: { answer_skeleton: 'Accuser réception du retour.', offer_code: 'BIENVENUE' } }
  },
  ticket: { id: 'ticket-1', status: 'awaiting_human', level: 2, language: 'fr', happiness: 1, requester_name: 'Laurence', category: 'return_exchange' },
  message: { id: 'c1', subject: 'Retour', body_text: 'Je vous ai renvoyé le colis.' },
  orderContext: null,
  conversation: CONVERSATION,
  thread: CONVERSATION,
  caseCurrent: { ticket_id: 'ticket-1', version: 4, next_actor: 'support', obligations: [], pending_customer_inputs: [] },
  notice: { record: RECORD, template: TEMPLATE }
};

const BODY = `Bonjour Laurence,\n\nVotre remboursement a été effectué et vous parviendra prochainement.\n\n${SIGNATURE}`;

function harness(candidates = [CANDIDATE]) {
  const saved = [];
  const calls = [];
  return {
    saved,
    calls,
    args: {
      store: { async claimable(options) { calls.push({ claim: options }); return candidates; } },
      draftRecord: { async save(draft) { saved.push(draft); return draft; } },
      openai: { async completeJson(request) { calls.push(request); return { subject: null, body: BODY }; } },
      brandVoice: VOICE,
      shopId: 'shop-1',
      model: 'gpt-4o',
      gates: 'notice'
    }
  };
}

test('a notice is drafted from the template rule, as a closing message, never auto-sendable', async () => {
  const h = harness();
  const totals = await runDrafting(h.args);
  assert.equal(totals.drafted, 1);
  const [draft] = h.saved;
  assert.equal(draft.purpose, 'refund_notice');
  assert.equal(draft.sourceVerdict, 'answerable');
  assert.equal(draft.disposition, 'terminal');
  assert.equal(draft.autoSendEligible, false);
  assert.deepEqual(draft.autoSendBlockers, [{ reason: 'refund_notice', detail: null }]);
  assert.equal(draft.triggerMessageId, 'c1', 'threaded under the customer’s latest message');
  assert.equal(draft.caseVersion, 4);

  const prompt = h.calls.find((call) => call.user).user;
  assert.match(prompt, /## Message à notre initiative/);
  assert.match(prompt, /un remboursement est DÉJÀ parti/, 'the template’s skeleton, not the case file’s');
  assert.doesNotMatch(prompt, /Accuser réception du retour/);
  assert.doesNotMatch(prompt, /Aucun remboursement n’est encore parti/, 'the order-only claim is dropped');
  assert.match(prompt, /Les retours sont acceptés sous 14 jours/, 'a claim from another tool is kept');
  assert.doesNotMatch(prompt, /BIENVENUE/, 'no offer rides along');
});

test('with a check still open the notice informs and says what is still to come', async () => {
  const open = { ...CANDIDATE, caseCurrent: { ...CANDIDATE.caseCurrent, obligations: [{ id: 'o1', owner: 'partner', status: 'open' }] } };
  const h = harness([open]);
  await runDrafting(h.args);
  assert.equal(h.saved[0].disposition, 'intermediary');
  assert.match(h.calls.find((call) => call.user).user, /D’autres points restent ouverts/);
});

test('the gate: already told, not our turn, a pass pending, or not open — no notice', () => {
  const base = { caseCurrent: CANDIDATE.caseCurrent, ticket: CANDIDATE.ticket, notice: CANDIDATE.notice, conversation: CONVERSATION };
  assert.deepEqual(noticeGate(base), { ok: true, reason: null });
  const told = [...CONVERSATION, { id: 's2', direction: 'outbound', actor: 'support', received_at: '2026-10-05T10:00:00Z' }];
  assert.equal(noticeGate({ ...base, conversation: told }).reason, 'already_told');
  assert.equal(noticeGate({ ...base, caseCurrent: { ...base.caseCurrent, next_actor: 'customer' } }).reason, 'not_our_turn');
  assert.equal(noticeGate({ ...base, ticket: { ...base.ticket, needs_investigation: true } }).reason, 'pass_pending');
  assert.equal(noticeGate({ ...base, ticket: { ...base.ticket, status: 'closed' } }).reason, 'not_open');
  assert.equal(noticeGate({ ...base, notice: null }).reason, 'no_notice');
});

test('the decision and the case file a notice reads', () => {
  assert.equal(noticeDecision({ obligations: [], pending_customer_inputs: [] }).disposition, 'terminal');
  assert.equal(noticeDecision({ obligations: [], pending_customer_inputs: ['lot_number'] }).disposition, 'intermediary');
  const file = noticeCaseFile({ verdict: 'needs_human', missing: [{ field: 'x' }], offerCode: 'X', link: { url: 'https://x' }, established: [] }, TEMPLATE);
  assert.equal(file.verdict, 'answerable');
  assert.deepEqual(file.missing, []);
  assert.equal(file.offerCode, null);
  assert.equal(file.link, null);
  assert.equal(file.answerSkeleton, TEMPLATE.answer_skeleton);
  assert.match(noticeSection({ closing: true }), /message de clôture/);
});

test('a reply run never carries a notice', async () => {
  const h = harness([{ ...CANDIDATE, investigation: { ...CANDIDATE.investigation, verdict: 'answerable' } }]);
  await runDrafting({ ...h.args, gates: 'manual' });
  assert.equal(h.saved[0]?.purpose ?? 'reply', 'reply');
  assert.doesNotMatch(h.calls.find((call) => call.user)?.user ?? '', /Message à notre initiative/);
});
