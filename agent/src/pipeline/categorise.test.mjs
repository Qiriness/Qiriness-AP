import assert from 'node:assert/strict';
import test from 'node:test';

import { createCategoriser, normaliseCategorisation } from './categorise.mjs';
import {
  TICKET_SUBJECTS,
  REQUEST_KINDS,
  REPLY_LANGUAGES,
  HAPPINESS_SCORES
} from '../../../scripts/lib/support-taxonomy.mjs';

function fakeOpenAI(result, captured = {}) {
  return {
    async completeJson(args) {
      Object.assign(captured, args);
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

const answer = (overrides = {}) => ({
  category: 'order',
  request_kind: 'question',
  secondary_category: null,
  secondary_request_kind: null,
  level: 1,
  language: 'fr',
  happiness: 2,
  reason: 'demande de statut de commande',
  ...overrides
});

const input = (body = 'Où est ma commande ?') => ({
  subject: 'Ma commande',
  messages: [{ subject: 'Ma commande', body_text: body, received_at: '2026-07-01T10:00:00Z' }]
});

test('the schema enums are built from the taxonomy, so the model cannot answer off-list', async () => {
  const captured = {};
  await createCategoriser(fakeOpenAI(answer(), captured), { model: 'm' }).categorise(input());
  assert.deepEqual(captured.schema.properties.category.enum, TICKET_SUBJECTS);
  assert.deepEqual(captured.schema.properties.request_kind.enum, REQUEST_KINDS);
  // Nullable enums, because strict Structured Outputs requires every property.
  assert.ok(captured.schema.properties.secondary_category.enum.includes(null));
  assert.deepEqual(captured.schema.required.sort(), [
    'category',
    'happiness',
    'language',
    'level',
    'reason',
    'request_kind',
    'secondary_category',
    'secondary_request_kind'
  ]);
});

test('the signal enums are built from the taxonomy too', async () => {
  const captured = {};
  await createCategoriser(fakeOpenAI(answer(), captured), { model: 'm' }).categorise(input());
  assert.deepEqual(captured.schema.properties.language.enum, REPLY_LANGUAGES);
  assert.deepEqual(captured.schema.properties.happiness.enum, HAPPINESS_SCORES);
});

test('the signals are carried through when the model answers well', async () => {
  const { categorise } = createCategoriser(
    fakeOpenAI(answer({ language: 'en', happiness: 4 })),
    { model: 'm' }
  );
  const result = await categorise(input());
  assert.equal(result.language, 'en');
  assert.equal(result.happiness, 4);
});

test('the model is never asked how confident it is', async () => {
  // It was, once, and answered `high` on 171 of 171 real tickets and 40 of 40
  // review cases: Structured Outputs emits fields in order, so it rated an answer
  // it had already committed to. A constant field carries no information, and a
  // constant field called "confidence" invites exactly the wrong decision
  // downstream. tickets.categorisation_confidence is now written only by the
  // runner's failure paths.
  const captured = {};
  await createCategoriser(fakeOpenAI(answer(), captured), { model: 'm' }).categorise(input());
  assert.equal(Object.hasOwn(captured.schema.properties, 'confidence'), false);
  assert.equal(captured.schema.required.includes('confidence'), false);
  assert.doesNotMatch(captured.system, /confiance|confidence/i);
  // ... and a stray value from the model is not carried through either.
  assert.equal(
    Object.hasOwn(normaliseCategorisation(answer({ confidence: 'high' })), 'confidence'),
    false
  );
});

test('an unusable language or happiness is null, not a fabricated default', () => {
  // "We do not know" is a real state the drafting agent has to handle. Defaulting
  // to fr (the majority language) or to a neutral 2 would hide it behind a value
  // that looks like a measurement.
  const result = normaliseCategorisation(answer({ language: 'français', happiness: 7 }));
  assert.equal(result.language, null);
  assert.equal(result.happiness, null);
});

test('happiness does not touch the level', () => {
  // An angry customer with a routine tracking question stays level 2: the anger
  // belongs in happiness. Deriving level from mood is the mistake the level-4
  // rule was rewritten to fix.
  const furious = normaliseCategorisation(
    answer({ category: 'order', request_kind: 'problem', level: 2, happiness: 4 })
  );
  assert.equal(furious.level, 2);
  assert.equal(furious.happiness, 4);
  // ... and a cheerful refund request stays level 3.
  const cheerful = normaliseCategorisation(
    answer({ category: 'return_exchange', request_kind: 'problem', level: 3, happiness: 1 })
  );
  assert.equal(cheerful.level, 3);
  assert.equal(cheerful.happiness, 1);
});

test('the prompt defines the happiness scale and pins its independence from level', async () => {
  const captured = {};
  await createCategoriser(fakeOpenAI(answer(), captured), { model: 'm' }).categorise(input());
  // The two ends of the scale the user actually cares about.
  assert.match(captured.system, /inacceptable|ne plus commander/);
  assert.match(captured.system, /plusieurs fois sans réponse/);
  // ... and the instruction that keeps anger out of the level.
  assert.match(captured.system, /happiness et level sont indépendants/);
});

test('the prompt asks for the reply language, restricted to what the desk writes', async () => {
  const captured = {};
  await createCategoriser(fakeOpenAI(answer(), captured), { model: 'm' }).categorise(input());
  assert.match(captured.system, /Langue de réponse/);
  // The list itself, not each code on its own: two-letter codes match inside
  // ordinary French words ("de", "it", "es"), so a substring check per code would
  // pass on a prompt that never listed them.
  const offered = REPLY_LANGUAGES.filter((code) => code !== 'other').join(', ');
  assert.ok(captured.system.includes(offered), `the prompt should offer ${offered}`);
  assert.match(captured.system, /ou other/);
});

test('level is clamped up to the derived floor when the model under-rates it', async () => {
  const { categorise } = createCategoriser(
    fakeOpenAI(answer({ category: 'return_exchange', request_kind: 'problem', level: 1 })),
    { model: 'm' }
  );
  const result = await categorise(input());
  assert.equal(result.level, 3);
});

test('the model may escalate above the floor', async () => {
  const { categorise } = createCategoriser(
    fakeOpenAI(answer({ category: 'order', request_kind: 'question', level: 4 })),
    { model: 'm' }
  );
  assert.equal((await categorise(input())).level, 4);
});

test('a reported reaction is level 2, not an automatic escalation', async () => {
  // The products are natural formulations: a reaction is a mild allergy or
  // irritation. Only the email's own severity reaches 4.
  const { categorise } = createCategoriser(
    fakeOpenAI(answer({ category: 'cosmetovigilance', request_kind: 'problem', level: 1 })),
    { model: 'm' }
  );
  assert.equal((await categorise(input())).level, 2);
});

test('the model can escalate to 4 on severity, from any subject', async () => {
  // The only route to 4: a threat of legal action, hospitalisation, or grave
  // injury, read from the email rather than implied by the topic.
  const { categorise } = createCategoriser(
    fakeOpenAI(answer({ category: 'product', request_kind: 'complaint', level: 4 })),
    { model: 'm' }
  );
  assert.equal((await categorise(input())).level, 4);
});

test('a secondary subject raises the level floor too', async () => {
  // An order question that also asks for a return must not sit at level 2: the
  // secondary pair is what needs the action.
  const result = normaliseCategorisation(
    answer({ secondary_category: 'return_exchange', secondary_request_kind: 'problem', level: 2 })
  );
  assert.equal(result.level, 3);
});

test('an off-list category falls back to other', () => {
  assert.equal(normaliseCategorisation(answer({ category: 'order_problem' })).category, 'other');
});

test('an off-list request kind falls back to problem, never to question', () => {
  // The fallback must raise the level floor (a human sees it), not lower it.
  // Uses a non-lookup subject, where question (1) and problem (3) still differ —
  // on a lookup subject both floor at 2 and the test could not tell them apart.
  const result = normaliseCategorisation(answer({ category: 'product', request_kind: 'enquiry' }));
  assert.equal(result.request_kind, 'problem');
  assert.equal(result.level, 3);
});

test('contact is coerced to question on a subject it cannot describe', () => {
  const result = normaliseCategorisation(answer({ category: 'order', request_kind: 'contact' }));
  assert.equal(result.request_kind, 'question');
  // ... but stands on a relationship subject.
  assert.equal(
    normaliseCategorisation(answer({ category: 'b2b', request_kind: 'contact' })).request_kind,
    'contact'
  );
});

test('a secondary repeating the primary is dropped', () => {
  const result = normaliseCategorisation(
    answer({ secondary_category: 'order', secondary_request_kind: 'problem' })
  );
  assert.equal(result.secondary_category, null);
  assert.equal(result.secondary_request_kind, null);
});

test('a secondary kind is never written without its subject (tickets_secondary_pair_check)', () => {
  const result = normaliseCategorisation(
    answer({ secondary_category: null, secondary_request_kind: 'question' })
  );
  assert.equal(result.secondary_category, null);
  assert.equal(result.secondary_request_kind, null);
});

test('a secondary subject with an unusable kind defaults to question', () => {
  const result = normaliseCategorisation(
    answer({ secondary_category: 'product_stock', secondary_request_kind: 'nonsense' })
  );
  assert.equal(result.secondary_category, 'product_stock');
  assert.equal(result.secondary_request_kind, 'question');
});

test('the responsible team is derived from the primary subject', () => {
  assert.equal(normaliseCategorisation(answer({ category: 'payment' })).responsible_team, 'finance');
  assert.equal(normaliseCategorisation(answer({ category: 'delivery' })).responsible_team, 'logistics');
});

test('the prompt pins the three level-4 triggers and rules topic out', async () => {
  // Level 4 is now defined only in the prompt (no subject derives it), so the
  // definition is pinned here: escalation must be severity, named in the reason.
  const captured = {};
  await createCategoriser(fakeOpenAI(answer(), captured), { model: 'm' }).categorise(input());
  assert.match(captured.system, /justice|plainte|avocat/);
  assert.match(captured.system, /hospitalisation/);
  assert.match(captured.system, /blessure grave|danger grave/);
  assert.match(captured.system, /GRAVITÉ/);
  // ... and explicitly excludes the cases that used to derive a 4.
  assert.match(captured.system, /réaction cutanée[^.]*ne sont PAS|ne sont PAS des niveaux 4/);
});

test('the prompt carries subject and body but no sender identity', async () => {
  const captured = {};
  await createCategoriser(fakeOpenAI(answer(), captured), { model: 'm' }).categorise({
    subject: 'Ma commande',
    messages: [{ body_text: 'Où est ma commande ?' }]
  });
  assert.match(captured.user, /Ma commande/);
  assert.match(captured.user, /Où est ma commande/);
  assert.doesNotMatch(captured.user, /@/);
});

test('only the first and latest messages are sent when a thread has grown', async () => {
  const captured = {};
  await createCategoriser(fakeOpenAI(answer(), captured), { model: 'm' }).categorise({
    subject: 'Fil',
    messages: [{ body_text: 'premier' }, { body_text: 'milieu' }, { body_text: 'dernier' }]
  });
  assert.match(captured.user, /premier/);
  assert.match(captured.user, /dernier/);
  assert.doesNotMatch(captured.user, /milieu/);
});

test('the body is truncated to the configured budget', async () => {
  const captured = {};
  await createCategoriser(fakeOpenAI(answer(), captured), { model: 'm', maxBodyChars: 10 }).categorise({
    subject: 's',
    messages: [{ body_text: 'x'.repeat(500) }]
  });
  assert.ok(!captured.user.includes('x'.repeat(11)));
});

test('errors propagate — the categoriser never invents a default label', async () => {
  const { categorise } = createCategoriser(fakeOpenAI(new Error('boom')), { model: 'm' });
  await assert.rejects(() => categorise(input()), /boom/);
});

test('the model used is carried through for the audit trail', async () => {
  const { categorise } = createCategoriser(fakeOpenAI(answer()), { model: 'gpt-4o-mini' });
  const result = await categorise(input());
  assert.equal(result.model, 'gpt-4o-mini');
  assert.equal(result.reason, 'demande de statut de commande');
});
