import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSenderDirectory } from '../ingestion/sender-directory.mjs';
import {
  backendPosition,
  buildReconstructionPrompt,
  contradictions,
  normaliseReconstruction,
  reconstructCase,
  renderThread
} from './reconstruct.mjs';

const SITUATIONS = [
  { exemplar_key: 'D-36', canonical_question: 'Je pense que mon colis est perdu.' },
  { exemplar_key: 'O-09', canonical_question: 'Où en est ma commande ?' }
];

const CONVERSATION = [
  { id: 'm1', direction: 'inbound', body_text: 'colis non reçu', received_at: '2026-08-01T09:00:00Z' },
  { id: 'm2', direction: 'outbound', body_text: 'avez-vous vu vos voisins ?', received_at: '2026-08-02T09:00:00Z' },
  { id: 'm3', direction: 'inbound', body_text: 'oui, rien chez eux', received_at: '2026-08-03T09:00:00Z' }
];

const ANSWER = {
  situation_key: 'D-36',
  customer_objective: 'recevoir sa commande',
  established_facts: ['Le colis est annoncé livré', ''],
  asked_by_qiriness: [{ what: 'vérifier chez les voisins', answered: true }, { what: '  ', answered: false }],
  commitments: [{ what: 'ouvrir une enquête', status: 'pending' }],
  pending_customer_inputs: [],
  pending_internal_actions: ['ouvrir l’enquête transporteur'],
  open_issue: 'colis toujours introuvable',
  case_summary: 'Colis annoncé livré, jamais reçu.',
  refund_claimed: 'not_mentioned',
  replacement_claimed: 'not_mentioned'
};

function openaiReturning(answer) {
  const calls = [];
  return {
    calls,
    async completeJson(request) {
      calls.push(request);
      if (answer instanceof Error) throw answer;
      return answer;
    }
  };
}

// --- the thread as the reader sees it ----------------------------------------

test('both directions are rendered, labelled and dated', () => {
  assert.equal(
    renderThread(CONVERSATION),
    '[client — 2026-08-01]\ncolis non reçu\n\n' +
      '[Qiriness — 2026-08-02]\navez-vous vu vos voisins ?\n\n' +
      '[client — 2026-08-03]\noui, rien chez eux'
  );
});

test('each message says WHO sent it, not merely which direction', () => {
  // A thread carries internal staff and 3PL mail too — four of five inbound
  // messages on `c5ec7404` are exactly that, and rendering them all as the
  // customer is what let a draft ask the customer for a screenshot.
  const directory = buildSenderDirectory([
    { pattern_type: 'domain', pattern: 'lap-groupe.com', label: 'internal', note: null },
    { pattern_type: 'domain', pattern: 'deret.fr', label: 'logistics', note: null }
  ]);
  const rendered = renderThread(
    [
      { direction: 'inbound', from_email: 'cliente@gmail.com', body_text: 'colis non reçu', received_at: '2026-08-01T09:00:00Z' },
      { direction: 'inbound', from_email: 'tlamzouki@lap-groupe.com', body_text: 'je regarde', received_at: '2026-08-02T09:00:00Z' },
      { direction: 'inbound', from_email: 'agent@deret.fr', body_text: 'colis en retour', received_at: '2026-08-03T09:00:00Z' }
    ],
    directory
  );

  assert.ok(rendered.includes('[client — 2026-08-01]'));
  assert.ok(rendered.includes('[collègue (LAP Groupe) — 2026-08-02]'));
  assert.ok(rendered.includes('[prestataire logistique — 2026-08-03]'));
  // The address resolves the role and is never rendered.
  assert.ok(!rendered.includes('lap-groupe.com'));
  assert.ok(!rendered.includes('deret.fr'));
});

test('a quoted chain is stripped and an empty message drops out', () => {
  const rendered = renderThread([
    { direction: 'outbound', body_text: 'merci\n\nLe 1 août 2026, x a écrit :\n> ancien message', received_at: '2026-08-02T09:00:00Z' },
    { direction: 'inbound', body_text: '   ', received_at: '2026-08-03T09:00:00Z' }
  ]);
  assert.ok(rendered.includes('merci'));
  assert.ok(!rendered.includes('ancien message'));
  assert.equal(rendered.split('[').length - 1, 1);
});

// --- the prompt ---------------------------------------------------------------

test('the library travels and the backend does not', () => {
  const prompt = buildReconstructionPrompt({
    ticket: { subject: 'Commande', category: 'delivery', request_kind: 'problem', resolved_context: { order: { name: '#6686' } } },
    conversation: CONVERSATION,
    situations: SITUATIONS
  });

  assert.ok(prompt.includes('D-36 : Je pense que mon colis est perdu.'));
  // The order bundle stays out: the model reads the conversation, and code owns
  // what the backend shows. Mixing them is the conflation the report exists to
  // keep apart.
  assert.ok(!prompt.includes('#6686'));
});

// --- what the codebase will stand behind --------------------------------------

test('a situation outside the library is dropped and reported', () => {
  const reading = normaliseReconstruction(
    { ...ANSWER, situation_key: 'D-99' },
    { situationKeys: SITUATIONS.map((s) => s.exemplar_key) }
  );
  assert.equal(reading.situationKey, null);
  assert.equal(reading.rejectedSituationKey, 'D-99');
});

test('a known situation survives, and blanks are dropped from every list', () => {
  const reading = normaliseReconstruction(ANSWER, { situationKeys: ['D-36', 'O-09'] });
  assert.equal(reading.situationKey, 'D-36');
  assert.equal(reading.rejectedSituationKey, null);
  assert.deepEqual(reading.establishedFacts, ['Le colis est annoncé livré']);
  assert.equal(reading.askedByQiriness.length, 1);
  assert.deepEqual(reading.askedByQiriness[0], { what: 'vérifier chez les voisins', answered: true });
});

test('an unknown commitment status reads as unknown, never as done', () => {
  const reading = normaliseReconstruction(
    { ...ANSWER, commitments: [{ what: 'rembourser', status: 'peut-être' }] },
    { situationKeys: ['D-36'] }
  );
  assert.equal(reading.commitments[0].status, 'unknown');
});

test('a garbage answer normalises rather than throwing', () => {
  const reading = normaliseReconstruction({}, { situationKeys: [] });
  assert.equal(reading.situationKey, null);
  assert.deepEqual(reading.establishedFacts, []);
  assert.equal(reading.claims.refund, 'not_mentioned');
});

// --- the backend, in code -----------------------------------------------------

test('the refund position is read from the stored bundle, in every shape', () => {
  assert.equal(backendPosition(null).refund, 'no_order_resolved');
  assert.equal(backendPosition({ signals: {} }).refund, 'no_order_resolved');
  assert.equal(backendPosition({ order: { refunds: { count: 0 } }, signals: {} }).refund, 'none');
  assert.equal(backendPosition({ order: { refunds: { count: 1 } }, signals: {} }).refund, 'partial');
  assert.equal(backendPosition({ order: { refunds: { count: 2, isFull: true } }, signals: {} }).refund, 'full');
  assert.equal(backendPosition({ order: { refunds: {} }, signals: { isFullyRefunded: true } }).refund, 'full');
});

test('a replacement is never claimed to be verified, because nothing records one', () => {
  assert.equal(backendPosition({ order: { refunds: {} }, signals: {} }).replacement, 'not_representable');
});

test('being told a refund happened, with none on the order, is the contradiction worth reporting', () => {
  assert.equal(
    contradictions({ claims: { refund: 'stated_done' }, backend: { refund: 'none' } }).length,
    1
  );
  assert.equal(
    contradictions({ claims: { refund: 'stated_done' }, backend: { refund: 'no_order_resolved' } }).length,
    1
  );
  // A promise is not a claim that it is done, and agreement is not a finding.
  assert.deepEqual(contradictions({ claims: { refund: 'promised' }, backend: { refund: 'none' } }), []);
  assert.deepEqual(contradictions({ claims: { refund: 'stated_done' }, backend: { refund: 'full' } }), []);
});

// --- one thread, one call -----------------------------------------------------

test('a reconstruction carries the thread shape beside the reading', async () => {
  const openai = openaiReturning(ANSWER);
  const row = await reconstructCase({
    openai,
    model: 'gpt-4o',
    ticket: { id: 'tk1', subject: 'Commande', status: 'closed', resolved_context: { order: { refunds: { count: 0 } }, signals: {} } },
    conversation: CONVERSATION,
    situations: SITUATIONS
  });

  assert.equal(row.ticketId, 'tk1');
  assert.deepEqual([row.messages, row.inbound, row.outbound], [3, 2, 1]);
  assert.equal(row.situationKey, 'D-36');
  assert.equal(row.backend.refund, 'none');
  assert.equal(openai.calls[0].pass, 'reconstruct');
});

test('a failed thread becomes a row, so one bad ticket cannot end the report', async () => {
  const row = await reconstructCase({
    openai: openaiReturning(new Error('429 rate limited')),
    model: 'gpt-4o',
    ticket: { id: 'tk2' },
    conversation: CONVERSATION,
    situations: SITUATIONS
  });

  assert.equal(row.error, '429 rate limited');
  assert.equal(row.ticketId, 'tk2');
  assert.equal(row.messages, 3);
});

test('the reading is written in French whatever language the thread is in', async () => {
  // MEASURED on the first corpus run: 36 threads, and several came back
  // summarised in English — « The customer has not received their package » —
  // because nothing said otherwise. These lines are labels a person compares
  // side by side, and a corpus half in each language does not compare.
  const openai = openaiReturning(ANSWER);
  await reconstructCase({
    openai,
    model: 'gpt-4o',
    ticket: { id: 'tk1' },
    conversation: CONVERSATION,
    situations: SITUATIONS
  });
  assert.match(openai.calls[0].system, /TOUJOURS EN FRANÇAIS/);
});
