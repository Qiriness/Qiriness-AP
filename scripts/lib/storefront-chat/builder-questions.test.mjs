import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLlmAgent } from './llm-agent.mjs';
import { buildCatalogue } from './product-repository.mjs';
import { buildAdvisorKnowledge } from '../advisory/advisor-knowledge.mjs';
import { knowledgeIndex } from '../advisory/product-knowledge.mjs';
import { createAdvisor } from '../advisory/recommend.mjs';
import { isBuiltRoutine, routineRecord } from '../advisory/routine-record.mjs';

// THE BUILDER'S QUESTIONS WITHOUT THE MODEL, AND THE ROUTINE KEPT (owner,
// 2026-10-17), through the storefront agent on Qiriness's real sheet: a button
// answer gets the next question from the code; the finished routine comes back
// as an anonymous record for advisor_routines.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const built = buildAdvisorKnowledge({ sheet: read('data/advisor/qiriness-knowledge.json'), settings: read('data/advisor/qiriness-routine-settings.json') });
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CATALOGUE = buildCatalogue(
  built.products.map((k, i) => ({
    id: uuid(i + 1), shopify_product_id: `gid://shopify/Product/${i + 1}`, handle: k.handle, title: k.title ?? k.handle,
    product_type: 'Soin', tags: [], short_description: null,
    variants: [{ id: `gid://shopify/ProductVariant/${i + 1}`, title: '50 ml', price: String(Number(k.price) || 30), inventory_quantity: 5 }], available_stock: 5,
  })),
  [],
);
const advisor = createAdvisor(read('data/advisor/qiriness.json'), CATALOGUE, { knowledge: knowledgeIndex(built.products), routines: built.routines });

const answer = (reply) => ({ content: JSON.stringify({ reply, reply_language: 'fr', products: [] }), toolCalls: [], usage: { prompt_tokens: 800, completion_tokens: 40 } });
function scripted(...responses) {
  const calls = [];
  return { calls, async completeWithTools(args) { calls.push(args); const next = responses.shift(); if (!next) throw new Error('no more scripted responses'); return next; } };
}
const agentWith = (client) => createLlmAgent({ client, company: { name: 'Qiriness' }, catalogue: CATALOGUE, advisor });
const handleOf = (id) => CATALOGUE.products.find((p) => p.id === id)?.handle;

test('the eye routine by buttons: four questions from the code, no model call until the routine', async () => {
  const client = scripted(answer('Voici votre routine yeux, jour et nuit.'));
  const agent = agentWith(client);
  const turn = (message, choice, advisorState, extra = {}) => agent.respond({ message, choice, advisorState, context: { locale: 'fr' }, conversationRef: 's', ...extra });

  const q1 = await turn('Construire ma routine', null, null, { action: 'build_routine' });
  assert.equal(q1.text, 'Quelle est votre préoccupation principale ?');
  assert.deepEqual(q1.choices.map((c) => c.label), ['Déshydratation', 'Imperfections', 'Taches et teint terne', 'Rides', 'Premières rides', 'Cernes et poches']);
  assert.equal(q1.trace.model_skipped, 'builder_question');

  const q2 = await turn('Cernes et poches', 'profile:primary_concern:dark_circles', q1.advisor);
  assert.equal(q2.text, 'Avez-vous une autre préoccupation autour des yeux ?');
  assert.deepEqual(q2.choices.map((c) => [c.label, c.value]), [
    ['Rides ou ridules', 'profile:eye_concern:eye_wrinkles'], ['Déshydratation', 'profile:eye_concern:dehydration'],
    ['Taches', 'profile:eye_concern:dark_spots'],
  ]);
  const q3 = await turn('Rides ou ridules', 'profile:eye_concern:eye_wrinkles', q2.advisor);
  assert.equal(q3.text, "Quelle est votre tranche d'âge ?");
  const q4 = await turn('45 ans et plus', 'profile:age_band:45_plus', q3.advisor);
  assert.equal(q4.text, 'Souhaitez-vous une routine pour le jour, pour la nuit, ou les deux ?');
  assert.equal(client.calls.length, 0);

  const done = await turn('Jour et nuit', 'profile:routine_time:both', q4.advisor);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(done.routine && {
    main_concern: done.routine.main_concern, primary_concern: done.routine.primary_concern, skin_type: done.routine.skin_type,
    eye_concern: done.routine.eye_concern, age_band: done.routine.age_band, routine_time: done.routine.routine_time,
  }, { main_concern: 'Y', primary_concern: 'dark_circles', skin_type: null, eye_concern: 'eye_wrinkles', age_band: '45_plus', routine_time: 'both' });
  // The day, then the night's eye make-up remover: the rest is already in the day routine.
  assert.deepEqual(done.routine.product_handles, ['lotion-tonique-hydratante-eclat-parfait', 'patchs-yeux-clat-anti-age-regard-or-60-patchs', 'serum-anti-age-elixir-regard-eclat', 'regard-dexception', 'demaquillant-yeux-biphase-express']);
  assert.deepEqual(done.routine.answer_sources, { primary_concern: 'quick_choice', eye_concern: 'quick_choice', age_band: 'quick_choice', routine_time: 'quick_choice' });
  // The conversation carries the ref, and the routine button names it.
  assert.equal(done.advisor.flow.routine_ref, done.routine.ref);
  assert.equal(done.routineCart?.routine_ref, done.routine.ref);
});

test('a typed answer still goes to the model, and answers the eye question', async () => {
  const client = scripted(answer('Quelle est votre tranche d’âge ?'));
  const agent = agentWith(client);
  const q1 = await agent.respond({ message: 'Construire ma routine', action: 'build_routine', context: { locale: 'fr' } });
  const q2 = await agent.respond({ message: 'Cernes et poches', choice: 'profile:primary_concern:dark_circles', advisorState: q1.advisor, context: { locale: 'fr' } });
  const typed = await agent.respond({ message: "J'ai aussi la peau déshydratée", advisorState: q2.advisor, context: { locale: 'fr' } });
  assert.equal(client.calls.length, 1);
  assert.equal(typed.advisor.profile.eye_concern.value, 'dehydration');
  // Still the eye routine: « déshydratée » is no vote for Hydration there.
  assert.equal(typed.advisor.last_question, 'age_band');
});

test('« Taches et teint terne »: dull complexion the main concern, dark spots the other', async () => {
  const client = scripted();
  const agent = agentWith(client);
  const q1 = await agent.respond({ message: 'Construire ma routine', action: 'build_routine', context: { locale: 'fr' } });
  const q2 = await agent.respond({ message: 'Taches et teint terne', choice: 'profile:primary_concern:dark_spots+dullness', advisorState: q1.advisor, context: { locale: 'fr' } });
  assert.equal(q2.advisor.profile.primary_concern.value, 'dullness');
  assert.deepEqual(q2.advisor.profile.secondary_concerns.value, ['dark_spots']);
  assert.equal(q2.text, 'Quel est votre type de peau ?');
  assert.ok(!q2.choices.some((c) => c.value.endsWith(':unknown')));
});

test('English: the questions and buttons in English, still no model call', async () => {
  const client = scripted();
  const agent = agentWith(client);
  const q1 = await agent.respond({ message: 'Build my routine', action: 'build_routine', context: { locale: 'en' } });
  assert.equal(q1.text, 'What is your main skin concern?');
  const q2 = await agent.respond({ message: 'Dark circles and puffiness', choice: 'profile:primary_concern:dark_circles', advisorState: q1.advisor, context: { locale: 'en' } });
  assert.equal(q2.text, 'Do you have any other concern around your eyes?');
  assert.deepEqual(q2.choices.map((c) => c.label), ['Wrinkles or fine lines', 'Dehydration', 'Dark spots']);
  assert.equal(client.calls.length, 0);
});

test('« Oui, ajouter » after a routine marks that routine added, once', async () => {
  const client = scripted();
  const ref = uuid(999);
  const pending = CATALOGUE.products.slice(0, 2).map((p) => ({ id: p.id, variant_id: p.variants[0].id }));
  const reply = await agentWith(client).respond({ message: 'Oui, ajouter', choice: 'flow:cart:yes', advisorState: { profile: {}, mode: 'conversation', asked: [], flow: { offer: 'accepted', cart: { pending, asked: [] }, routine_ref: ref } }, context: { locale: 'fr' } });
  assert.equal(reply.routineAdded, ref);
  assert.equal(reply.advisor.flow.routine_ref, null);
  assert.equal(client.calls.length, 0);
});

test('the record is anonymous: codes only, the age as its range, never a session', () => {
  const profile = { primary_concern: { value: 'wrinkles', source: 'quick_choice' }, skin_type: { value: 'dry', source: 'quick_choice' }, age: { value: '52', source: 'natural_language' }, routine_time: { value: 'day', source: 'quick_choice' } };
  const advice = advisor.advise({ profile, mode: 'routine_builder', asked: ['primary_concern', 'skin_type', 'age_band', 'routine_time'] });
  assert.ok(isBuiltRoutine(advice, 'routine_builder'));
  assert.ok(!isBuiltRoutine(advice, 'conversation'));
  const r = routineRecord({ advice, profile, channel: 'storefront_chat', locale: 'fr', currency: 'EUR' });
  assert.equal(r.age_band, '45_plus');
  assert.equal(r.main_concern, 'E');
  assert.match(r.ref, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(r).sort(), ['age_band', 'answer_sources', 'channel', 'currency', 'eye_concern', 'locale', 'main_concern', 'primary_concern', 'product_handles', 'ref', 'routine_time', 'secondary_concerns', 'skin_type', 'total_price'].sort());
  assert.deepEqual(r.product_handles, advice.steps.map((s) => handleOf(s.product_id)));
});
