import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSenderDirectory } from '../ingestion/sender-directory.mjs';

import { buildCaseReadingPrompt, normaliseCaseReading, readCase } from './case-manager.mjs';

const TICKET = { id: 'tk1', subject: 'Commande #6686', category: 'delivery', request_kind: 'problem' };
const TRIGGER = { id: 'm3', direction: 'inbound', from_email: 'cliente@gmail.com', body_text: 'oui, rien chez les voisins' };
const CONVERSATION = [
  { id: 'm1', direction: 'inbound', from_email: 'cliente@gmail.com', body_text: 'colis non reçu', received_at: '2026-08-01T09:00:00Z' },
  { id: 'm2', direction: 'outbound', from_email: 'contact@qiriness.com', body_text: 'avez-vous vu vos voisins ?', received_at: '2026-08-02T09:00:00Z' },
  TRIGGER
];

const ANSWER = {
  case_relationship: 'continuation',
  answered: ['shopify_order_number'],
  new_facts: ['Les voisins n’ont rien reçu'],
  commitments: [{ what: 'ouvrir une enquête transporteur', status: 'pending' }],
  contradictions: [],
  case_summary: 'Colis annoncé livré, jamais reçu ; les vérifications sont faites.'
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

// --- the prompt ---------------------------------------------------------------

test('only the questions WE asked are offered, with their own wording', () => {
  const prompt = buildCaseReadingPrompt({
    ticket: TICKET,
    message: TRIGGER,
    conversation: CONVERSATION,
    pendingInputs: ['shopify_order_number', 'not_a_field']
  });

  assert.match(prompt, /shopify_order_number : le numéro de commande/);
  assert.ok(!prompt.includes('not_a_field'));
});

test('the thread is rendered with each sender named, and the trigger only once', () => {
  const directory = buildSenderDirectory([
    { pattern_type: 'domain', pattern: 'lap-groupe.com', label: 'internal', note: null }
  ]);
  const prompt = buildCaseReadingPrompt({
    ticket: TICKET,
    message: TRIGGER,
    conversation: [
      ...CONVERSATION,
      { id: 'm4', direction: 'inbound', from_email: 'x@lap-groupe.com', body_text: 'je regarde', received_at: '2026-08-04T09:00:00Z' }
    ],
    senderDirectory: directory
  });

  assert.match(prompt, /\[client — 2026-08-01\]/);
  assert.match(prompt, /\[Qiriness — 2026-08-02\]/);
  // A colleague's note read as the customer answering would strike a question
  // off the list, and it would never be asked again.
  assert.match(prompt, /\[collègue \(LAP Groupe\) — 2026-08-04\]/);
  assert.equal(prompt.split('oui, rien chez les voisins').length - 1, 1);
});

test('the situation library is never shown, because this layer may not name one', () => {
  const prompt = buildCaseReadingPrompt({ ticket: TICKET, message: TRIGGER, conversation: CONVERSATION });
  assert.ok(!/situation/i.test(prompt));
});

// --- what the codebase will act on --------------------------------------------

test('a reading is reduced to the closed vocabulary', () => {
  const reading = normaliseCaseReading(ANSWER, { pendingInputs: ['shopify_order_number'] });
  assert.equal(reading.caseRelationship, 'continuation');
  assert.deepEqual(reading.resolvedInputs, ['shopify_order_number']);
  assert.equal(reading.commitments[0].status, 'pending');
});

test('a question we never asked cannot be struck off', () => {
  // The whole value of the table is that a question is recorded when it is
  // ASKED. Letting the reader mint one would put guesses back in.
  const reading = normaliseCaseReading(
    { ...ANSWER, answered: ['photo', 'shopify_order_number'] },
    { pendingInputs: ['shopify_order_number'] }
  );
  assert.deepEqual(reading.resolvedInputs, ['shopify_order_number']);
});

test('an unrecognised relationship reads as unclear, which changes nothing', () => {
  const reading = normaliseCaseReading({ ...ANSWER, case_relationship: 'invented' }, {});
  assert.equal(reading.caseRelationship, 'unclear');
});

test('a commitment status that is not `done` is pending, never assumed done', () => {
  const reading = normaliseCaseReading(
    { ...ANSWER, commitments: [{ what: 'rembourser', status: 'peut-être' }] },
    {}
  );
  assert.equal(reading.commitments[0].status, 'pending');
});

// --- one message, one call ----------------------------------------------------

test('the call is booked against the casework pass', async () => {
  const openai = openaiReturning(ANSWER);
  const reading = await readCase({
    openai,
    model: 'gpt-4o-mini',
    ticket: TICKET,
    message: TRIGGER,
    conversation: CONVERSATION,
    pendingInputs: ['shopify_order_number']
  });

  assert.equal(reading.failed, false);
  assert.equal(openai.calls[0].pass, 'casework');
  assert.equal(openai.calls[0].ticketId, 'tk1');
});

test('a failure reads as unclear, so every pass runs as it did before', async () => {
  // The dangerous direction is a rate limit silently suppressing a
  // re-categorisation or striking a question off a list. `unclear` takes
  // neither decision.
  const reading = await readCase({
    openai: openaiReturning(new Error('429 rate limited')),
    model: 'gpt-4o-mini',
    ticket: TICKET,
    message: TRIGGER,
    conversation: CONVERSATION
  });

  assert.equal(reading.failed, true);
  assert.equal(reading.caseRelationship, 'unclear');
  assert.deepEqual(reading.resolvedInputs, []);
});
