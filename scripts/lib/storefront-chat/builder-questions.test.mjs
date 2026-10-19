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
import { buildStorefrontSystemPrompt } from './system-prompt.mjs';
import { createAdvisorTurn } from './advisor-tools.mjs';
import { cartDoneText, followUpFor } from './routine-flow.mjs';
import { hideCodes } from './shopping-tools.mjs';

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

test('the eye routine by buttons: four questions and the routine from the code, no model call', async () => {
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
  // The cards say it all (owner, 2026-10-18): one short sentence, no model call.
  assert.equal(client.calls.length, 0);
  assert.equal(done.trace.model_skipped, 'routine_cards');
  assert.equal(done.text, 'Voici votre routine personnalisée, matin et soir.');
  assert.deepEqual(done.routine && {
    main_concern: done.routine.main_concern, primary_concern: done.routine.primary_concern, skin_type: done.routine.skin_type,
    eye_concern: done.routine.eye_concern, age_band: done.routine.age_band, routine_time: done.routine.routine_time,
  }, { main_concern: 'Y', primary_concern: 'dark_circles', skin_type: null, eye_concern: 'eye_wrinkles', age_band: '45_plus', routine_time: 'both' });
  // The day, then the night's eye make-up remover: the rest is already in the day routine.
  assert.deepEqual(done.routine.product_handles, ['lotion-tonique-hydratante-eclat-parfait', 'patchs-yeux-clat-anti-age-regard-or-60-patchs', 'serum-anti-age-elixir-regard-eclat', 'regard-dexception', 'demaquillant-yeux-biphase-express']);
  assert.deepEqual(done.routine.answer_sources, { primary_concern: 'quick_choice', eye_concern: 'quick_choice', age_band: 'quick_choice', routine_time: 'quick_choice' });
  // The conversation carries the ref, and the routine cards name it.
  assert.equal(done.advisor.flow.routine_ref, done.routine.ref);
  assert.equal(done.routineView?.ref, done.routine.ref);
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

// THE OWNER'S NOTES ON THE FIRST ROUTINES (2026-10-17): no prices, reasons by skin and concern only,
// steps by stage; the routine discount applied with the routine and never named.

test('the routine as the model sees it: no price, no age or line reason, each step with its stage', () => {
  const profile = { primary_concern: { value: 'wrinkles', source: 'quick_choice' }, skin_type: { value: 'dry', source: 'quick_choice' }, age_band: { value: '35_44', source: 'quick_choice' }, routine_time: { value: 'day', source: 'quick_choice' } };
  const money = (n) => `${n} €`;
  const turn = createAdvisorTurn({ advisor, state: { profile, mode: 'routine_builder', asked: ['primary_concern', 'skin_type', 'age_band', 'routine_time'] }, message: 'Routine du jour', choice: 'profile:routine_time:day', locale: 'fr', catalogue: CATALOGUE, money });
  turn.opening();
  const seen = turn.describe();
  assert.equal(seen.status, 'recommended');
  assert.equal(seen.total_price, undefined);
  assert.ok(seen.steps.every((s) => s.product.price_from === undefined));
  assert.ok(seen.steps.every((s) => s.reason_codes.every((c) => !/^(age_range|preferred_family|made_for_time|step_product|step_fallback)/.test(c))));
  assert.equal(seen.steps[0].stage, 'prepare');
  // The moment buttons carry no price either.
  const { routine_time: _time, ...earlier } = profile;
  const before = createAdvisorTurn({ advisor, state: { profile: earlier, mode: 'routine_builder', asked: ['primary_concern', 'skin_type', 'age_band'] }, message: '35 à 44 ans', choice: 'profile:age_band:35_44', locale: 'fr', catalogue: CATALOGUE, money });
  before.opening();
  assert.deepEqual(before.choices().map((c) => c.label), ['Routine du jour', 'Routine de nuit', 'Jour et nuit']);
});

test('the routine discount: the cart question says it, the code goes to the widget only, never to the model', async () => {
  assert.equal(advisor.routineDiscount, 'MAROUTINE20');
  const items = [{ product_id: uuid(1), variant_id: 'gid://shopify/ProductVariant/1', name: 'A' }, { product_id: uuid(2), variant_id: 'gid://shopify/ProductVariant/2', name: 'B' }];
  const routineAsk = followUpFor({ flow: {}, lang: 'fr', builder: true, answer: null, advice: { status: 'recommended', steps: [{}, {}] }, showsProducts: false, anchor: null, purchaseAsk: null, runningLow: null, treat: null, purchaseChoices: () => [], cartable: items, cart: null, discount: true }).followUp;
  assert.deepEqual(routineAsk.choices.map((c) => c.label), ['Oui, ajouter avec la remise', 'Je cherche encore']);
  assert.ok(!routineAsk.text.includes('MAROUTINE20'));
  assert.match(cartDoneText('fr', ['A', 'B'], [], { discount: true }), /Votre remise routine est appliquée à votre panier\.$/);

  // The finished routine: the widget's button carries the code; the model's prompt never does.
  const client = scripted(answer('Très bien.'));
  const agent = agentWith(client);
  let state = null;
  let last = null;
  for (const [message, choice] of [['Construire ma routine', null], ['Rides', 'profile:primary_concern:wrinkles'], ['Sèche', 'profile:skin_type:dry'], ['35 à 44 ans', 'profile:age_band:35_44'], ['Routine du jour', 'profile:routine_time:day']]) {
    last = await agent.respond({ message, choice, advisorState: state, context: { locale: 'fr' }, ...(choice ? {} : { action: 'build_routine' }) });
    state = last.advisor;
  }
  // The routine cards carry it; the cart question still follows them (owner, 2026-10-18), no model call.
  assert.equal(last.routineView.discount.code, 'MAROUTINE20');
  assert.deepEqual(last.followUp.choices.map((c) => c.value), ['flow:cart:yes', 'flow:cart:no']);
  assert.equal(client.calls.length, 0);
  // « Oui »: the widget adds what the cards include (by the routine's ref), with the code.
  const yes = await agent.respond({ message: 'Oui, ajouter avec la remise', choice: 'flow:cart:yes', advisorState: state, context: { locale: 'fr' } });
  assert.equal(yes.cart.routine_ref, last.routine.ref);
  assert.equal(yes.cart.discount_code, 'MAROUTINE20');
  assert.equal(yes.text, "C'est noté, j'ajoute à votre panier les soins inclus dans votre routine.");
  assert.ok(!yes.text.includes('MAROUTINE20'));
  // « Je cherche encore »: nothing added.
  // The fixture's prices put every mask over the treat cap: a treat is given here.
  const treat = CATALOGUE.products.find((p) => /masque/i.test(p.name));
  const realTreat = advisor.treat;
  advisor.treat = () => ({ product_id: treat.id });
  let no;
  try {
    no = await agent.respond({ message: 'Je cherche encore', choice: 'flow:cart:no', advisorState: state, context: { locale: 'fr' } });
  } finally {
    advisor.treat = realTreat;
  }
  assert.equal(no.cart, undefined);
  // …and no model call, no products again: a short sentence, then the petit plaisir (owner, 2026-10-18).
  assert.equal(client.calls.length, 0);
  assert.equal(no.trace.model_skipped, 'cart_no');
  assert.equal(no.text, 'Très bien, prenez votre temps.');
  assert.deepEqual(no.products, []);
  assert.match(no.followUp.text, /petit plaisir/);
  assert.deepEqual(no.followUp.products.map((c) => c.id), [treat.id]);
  assert.equal(no.advisor.flow.treat_offered, true);
  // Typed, in English, the same.
  const typed = await agent.respond({ message: "I'm still looking", advisorState: state, context: { locale: 'en' } });
  assert.equal(client.calls.length, 0);
  assert.equal(typed.text, 'Of course, take your time.');
});

test('no discount for a routine the builder did not finish, nor in a shop without one', () => {
  const plain = followUpFor({ flow: {}, lang: 'en', builder: true, answer: null, advice: { status: 'recommended', steps: [{}, {}] }, showsProducts: false, anchor: null, purchaseAsk: null, runningLow: null, treat: null, purchaseChoices: () => [], cartable: [{ product_id: uuid(1), variant_id: null, name: 'A' }, { product_id: uuid(2), variant_id: null, name: 'B' }], cart: null }).followUp;
  assert.equal(plain.choices[0].label, 'Yes, add it');
  assert.ok(!buildStorefrontSystemPrompt({ hasTools: true, hasAdvisor: true }).includes('ROUTINE DISCOUNT'));
});

test('shopping data never names the hidden code: « remise routine » in its place', () => {
  const hidden = new Set(['MAROUTINE20']);
  const result = hideCodes({ status: 'ok', applied_codes: ['MAROUTINE20', 'BIENVENUE20'], promotions: [{ promotion_id: 'p1', name: 'MAROUTINE20', code: 'MAROUTINE20', status: 'applied' }, { promotion_id: 'p2', name: 'Livraison offerte', code: null }] }, hidden);
  assert.deepEqual(result.applied_codes, ['BIENVENUE20']);
  assert.deepEqual(result.promotions[0], { promotion_id: 'p1', name: 'remise routine', code: null, status: 'applied' });
  assert.equal(result.promotions[1].name, 'Livraison offerte');
  assert.ok(!JSON.stringify(result).includes('MAROUTINE20'));
});

test('the routine code typed by the customer is theirs: named back; not typed, never named', async () => {
  const { createShoppingTurn } = await import('./shopping-tools.mjs');
  const source = { status: 'ok', promotions: [], cartCodeRows: [] };
  const turn = (message, history = []) => createShoppingTurn({ readShopping: async () => source, shopDomain: 'x.myshopify.com', cart: null, message, history, hiddenCodes: ['MAROUTINE20'] });
  const reply = 'Le code MAROUTINE20 est appliqué à votre panier.';
  assert.ok(!turn('Où est mon code de routine ?').sanitizeReply(reply).includes('MAROUTINE20'));
  assert.ok(turn('Le code MAROUTINE20 marche ?').sanitizeReply(reply).includes('MAROUTINE20'));
  // Typed earlier: like any other code, the shopping data names it back (applied in their cart), not a guess.
  const earlier = turn('Et il est appliqué ?', [{ role: 'user', content: "j'ai le code maroutine20" }]);
  const result = await earlier.run('get_cart_context');
  assert.ok(!JSON.stringify(result).includes('remise routine'));
});

test('the builder asked for again after a routine starts from its first question (FR and EN)', async () => {
  const client = scripted();
  const agent = agentWith(client);
  let state = null;
  let last = null;
  for (const [message, choice] of [['Construire ma routine', null], ['Rides', 'profile:primary_concern:wrinkles'], ['Sèche', 'profile:skin_type:dry'], ['35 à 44 ans', 'profile:age_band:35_44'], ['Routine du jour', 'profile:routine_time:day']]) {
    last = await agent.respond({ message, choice, advisorState: state, context: { locale: 'fr' }, ...(choice ? {} : { action: 'build_routine' }) });
    state = last.advisor;
  }
  assert.ok(last.routineView);
  for (const [message, locale, question] of [['Je voudrais refaire ma routine', 'fr', 'Quelle est votre préoccupation principale ?'], ['Construire ma routine', 'fr', 'Quelle est votre préoccupation principale ?'], ['Can I redo my routine?', 'en', null]]) {
    const again = await agent.respond({ message, advisorState: state, context: { locale }, ...(message === 'Construire ma routine' ? { action: 'build_routine' } : {}) });
    assert.equal(again.routineView, undefined, message);
    assert.equal(again.advisor.mode, 'routine_builder', message);
    assert.equal(again.advisor.profile.skin_type, undefined, message);
    assert.equal(again.advisor.flow.treat_offered, false, message);
    assert.ok(again.choices.some((c) => c.value.startsWith('profile:primary_concern:')), message);
    if (question) assert.equal(again.text, question);
  }
  assert.equal(client.calls.length, 0);
});

test('a « sérum » said before « refaire ma routine » never turns the new routine into a choice of products', async () => {
  const agent = agentWith(scripted());
  const said = { value: 'serum', source: 'natural_language', confidence: 'medium', turn: 3 };
  let state = { profile: { primary_concern: { value: 'wrinkles', source: 'quick_choice', confidence: 'high', turn: 1 }, skin_type: { value: 'oily', source: 'quick_choice', confidence: 'high', turn: 1 }, age_band: { value: '35_44', source: 'quick_choice', confidence: 'high', turn: 1 }, desired_care_type: said }, mode: 'conversation', asked: ['primary_concern', 'skin_type', 'age_band', 'routine_time'], last_question: null, last_advice: null, purchases: { asked: [], around: [] }, flow: {} };
  let last = await agent.respond({ message: 'refaire ma routine', advisorState: state, context: { locale: 'fr' } });
  assert.equal(last.text, 'Quelle est votre préoccupation principale ?');
  assert.equal(last.advisor.profile.desired_care_type, undefined);
  state = last.advisor;
  for (const [message, choice] of [['Rides', 'profile:primary_concern:wrinkles'], ['Grasse', 'profile:skin_type:oily'], ['35 à 44 ans', 'profile:age_band:35_44'], ['Jour et nuit', 'profile:routine_time:both']]) {
    last = await agent.respond({ message, choice, advisorState: state, context: { locale: 'fr' } });
    state = last.advisor;
  }
  assert.ok(last.routineView, 'the routine cards, not « quel type de soin souhaitez-vous privilégier ? »');
  assert.ok(last.routineView.moments.every((m) => m.steps.length > 1));
});

test('a comparison: the eye creams named by their range, and no routine offer while « laquelle ? » is asked (owner, 2026-10-19)', async () => {
  const ranges = new Map(built.products.filter((k) => k.range).map((k) => [k.handle, k.range]));
  const agent = createLlmAgent({ client: scripted(answer('Voici leurs différences.'), answer('Laquelle souhaitez-vous comparer ?')), company: { name: 'Qiriness' }, catalogue: CATALOGUE, advisor, productKnowledge: knowledgeIndex(built.products) });
  assert.ok(ranges.size > 0);
  // (The sheet has no title for Regard d'Exception: the fixture names it by its handle; the live catalogue resolves both.)
  const both = await agent.respond({ message: 'la creme contour des yeux temps sublime et le contour des yeux caresse regard energie', context: { locale: 'fr' } });
  assert.deepEqual(both.resolution.ids.map(handleOf).sort(), ['contour-des-yeux-caresse-regard-energie', 'creme-contour-yeux-anti-age-levres-acide-hyaluronique']);
  // One named, one to choose: the question alone, no « Souhaitez-vous que je vous construise une routine ? ».
  const partial = await agent.respond({ message: 'la creme temps sublime et la creme contour des yeux temps sublime', context: { locale: 'fr' } });
  assert.equal(partial.resolution.status, 'partial');
  assert.notEqual(partial.followUp?.choices?.[0]?.value, 'flow:routine:yes');
});

test('no routine offer under a « laquelle ? » the model asked through its own resolve_products (owner, 2026-10-19)', async () => {
  const resolveCall = { toolCalls: [{ id: 'r1', name: 'resolve_products', args: { mentions: ['crème Temps Sublime'] }, argsError: null }], message: { role: 'assistant', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'resolve_products', arguments: JSON.stringify({ mentions: ['crème Temps Sublime'] }) } }] }, content: null, usage: { prompt_tokens: 800, completion_tokens: 20 } };
  const agent = createLlmAgent({ client: scripted(resolveCall, answer('Quelle crème Temps Sublime souhaitez-vous comparer ?')), company: { name: 'Qiriness' }, catalogue: CATALOGUE, advisor, productKnowledge: knowledgeIndex(built.products) });
  const reply = await agent.respond({ message: 'comparer la creme contour des yeux temps sublime', context: { locale: 'fr' } });
  assert.equal(reply.resolution.status, 'ambiguous');
  assert.ok(reply.choices.length > 0, 'the options are the chips');
  assert.notEqual(reply.followUp?.choices?.[0]?.value, 'flow:routine:yes');
});

test('the model opens the builder only when a routine is asked for, and then from the first question (owner, 2026-10-19)', async () => {
  const useSkill = { toolCalls: [{ id: 's1', name: 'use_skill', args: { name: 'routine_builder' }, argsError: null }], message: { role: 'assistant', tool_calls: [{ id: 's1', type: 'function', function: { name: 'use_skill', arguments: JSON.stringify({ name: 'routine_builder' }) } }] }, content: null, usage: { prompt_tokens: 800, completion_tokens: 20 } };
  // A finished routine, by buttons (no model call).
  const builder = agentWith(scripted());
  const turn = (message, choice, advisorState, extra = {}) => builder.respond({ message, choice, advisorState, context: { locale: 'en' }, conversationRef: 's', ...extra });
  let state = (await turn('Build my routine', null, null, { action: 'build_routine' })).advisor;
  for (const [m, c] of [['Wrinkles', 'profile:primary_concern:wrinkles'], ['Dry', 'profile:skin_type:dry'], ['25 to 34', 'profile:age_band:25_34'], ['Day', 'profile:routine_time:day']]) state = (await turn(m, c, state)).advisor;
  assert.equal(state.mode, 'conversation');

  // "What spa treatments would you recommend": no routine word, the model may not open it.
  const spa = await agentWith(scripted(useSkill, answer('Our spa treatments are listed on the Spas page.'))).respond({ message: 'what spa treatments would you recommend', advisorState: state, context: { locale: 'en' }, conversationRef: 's' });
  assert.equal(spa.trace.skill_refused, 'routine_builder');
  assert.equal(spa.routineView ?? null, null);
  assert.notEqual(spa.text, 'Here is your personalised routine, morning and evening.');
  assert.equal(spa.advisor.mode, 'conversation');

  // "Can you make me a new skincare regimen": it opens, and starts again from the first question.
  const again = await agentWith(scripted(useSkill, answer('Of course.'))).respond({ message: 'can you put together a new skincare regimen for me', advisorState: state, context: { locale: 'en' }, conversationRef: 's' });
  assert.equal(again.advisor.mode, 'routine_builder');
  assert.equal(again.trace.advice.question, 'primary_concern');
});
