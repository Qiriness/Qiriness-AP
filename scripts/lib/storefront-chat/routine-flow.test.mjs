import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { anchorFor, beforeAdvice, cleanFlow, emptyFlow, followUpFor, followUpNote, offerAnswer } from './routine-flow.mjs';
import { cartVariant, createLlmAgent, toCards } from './llm-agent.mjs';
import { advisorStateFromHistory } from './advisor-state.mjs';
import { createAdvisor } from '../advisory/recommend.mjs';
import { knowledgeIndex, parseKnowledgeRows } from '../advisory/product-knowledge.mjs';

// The routine builder flow (owner, 2026-10-13): the offer after products, the
// builder, the anchor, the treat. Unit rules first, then through the agent on
// the INVENTED sample set (data/advisor/sample/) under the real playbooks.

const ID = (n) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
const base = { lang: 'fr', builder: false, answer: null, advice: null, showsProducts: true, anchor: null, purchaseAsk: null, runningLow: null, treat: null, purchaseChoices: () => [] };

test('a typed yes or no answers the offer only while it is pending, in French and English', () => {
  const pending = { ...emptyFlow(), offer: 'offered' };
  for (const yes of ['Oui', 'oui volontiers', 'Avec plaisir !', "D'accord", 'Yes please', 'sure']) assert.equal(offerAnswer(pending, { message: yes }), 'yes', yes);
  for (const no of ['Non merci', 'non', 'pas maintenant', 'No thanks', 'not now']) assert.equal(offerAnswer(pending, { message: no }), 'no', no);
  assert.equal(offerAnswer(pending, { message: "Oui mais pas aujourd'hui" }), null);
  assert.equal(offerAnswer(pending, { message: 'Quel sérum pour les rides ?' }), null);
  assert.equal(offerAnswer(emptyFlow(), { message: 'Oui' }), null);
  assert.equal(offerAnswer(emptyFlow(), { choice: 'flow:routine:yes' }), 'yes');
  assert.deepEqual(beforeAdvice(pending, { message: 'Oui' }), { flow: { ...pending, offer: 'accepted' }, answer: 'yes', startBuilder: true });
});

test('the offer follows products, once, never in the builder; its anchor is the page, then the named product, then our top pick', () => {
  const advice = { status: 'recommended', steps: [{ product_id: ID(4) }] };
  assert.deepEqual(anchorFor({ pageProductId: ID(1), resolvedIds: [ID(2)], advice }), { id: ID(1), source: 'page' });
  assert.deepEqual(anchorFor({ resolvedIds: [ID(2)], advice }), { id: ID(2), source: 'request' });
  assert.deepEqual(anchorFor({ advice }), { id: ID(4), source: 'suggested' });

  const offered = followUpFor({ ...base, flow: emptyFlow(), anchor: { id: ID(4), source: 'suggested' } });
  assert.equal(offered.followUp.kind, 'offer');
  assert.deepEqual(offered.followUp.choices, [{ label: 'Oui, avec plaisir', value: 'flow:routine:yes' }, { label: 'Non merci', value: 'flow:routine:no' }]);
  assert.deepEqual(offered.flow, { offer: 'offered', anchor: { id: ID(4), source: 'suggested' }, treat_offered: false });
  assert.equal(followUpFor({ ...base, flow: offered.flow }).followUp, null);
  assert.equal(followUpFor({ ...base, flow: emptyFlow(), builder: true }).followUp, null);
  assert.equal(followUpFor({ ...base, flow: emptyFlow(), showsProducts: false }).followUp, null);
  assert.equal(followUpFor({ ...base, flow: emptyFlow(), lang: 'en' }).followUp.text, 'Would you like me to build you a personalised routine?');
});

test('the treat: after a « Non », or after the routine in the builder; once', () => {
  const treat = { product_id: ID(11) };
  const afterNo = followUpFor({ ...base, flow: { ...emptyFlow(), offer: 'declined' }, answer: 'no', treat });
  assert.equal(afterNo.followUp.kind, 'treat');
  assert.deepEqual(afterNo.followUp.productIds, [ID(11)]);
  assert.equal(afterNo.flow.treat_offered, true);
  const afterRoutine = followUpFor({ ...base, flow: emptyFlow(), builder: true, advice: { status: 'recommended' }, treat });
  assert.match(afterRoutine.followUp.text, /petit plaisir/);
  assert.equal(followUpFor({ ...base, flow: afterRoutine.flow, builder: true, advice: { status: 'recommended' }, treat }).followUp, null);
});

test('in the builder the purchase question wins over the treat; « il m\'en reste peu » brings its card first', () => {
  const purchaseAsk = { product_id: ID(7), name: 'Crème' };
  const asked = followUpFor({ ...base, flow: emptyFlow(), builder: true, advice: { status: 'recommended' }, purchaseAsk, treat: { product_id: ID(11) }, purchaseChoices: () => [{ label: 'x', value: 'purchase:around:' + ID(7) }] });
  assert.equal(asked.followUp.kind, 'purchase');
  assert.equal(asked.flow.treat_offered, false);
  const low = followUpFor({ ...base, flow: emptyFlow(), builder: true, runningLow: { product_id: ID(7), name: 'Crème' } });
  assert.deepEqual([low.followUp.kind, low.followUp.productIds], ['running_low', [ID(7)]]);
});

test('flow state from the log is re-checked', () => {
  assert.deepEqual(cleanFlow({ offer: 'maybe', anchor: { id: 'x', source: 'page' }, treat_offered: 'yes' }), emptyFlow());
  assert.deepEqual(cleanFlow({ offer: 'declined', anchor: { id: ID(1), source: 'page' } }), { offer: 'declined', anchor: { id: ID(1), source: 'page' }, treat_offered: false });
});

// THROUGH THE AGENT.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const CONFIG = read('data/advisor/qiriness.json');
const CATALOGUE = read('data/advisor/sample/catalogue.json');
const SHEET = read('data/advisor/sample/knowledge.json');
const KNOWLEDGE = knowledgeIndex(parseKnowledgeRows(SHEET.rows, { concerns: SHEET.concerns }).products);
const product = (handle) => CATALOGUE.products.find((p) => p.handle === handle);
const answer = (reply, products = []) => ({ content: JSON.stringify({ reply, reply_language: 'fr', products }), toolCalls: [], usage: { prompt_tokens: 800, completion_tokens: 40 } });
function scripted(...responses) {
  const calls = [];
  return { calls, async completeWithTools(args) { calls.push(structuredClone(args)); return responses.shift() ?? answer('…'); } };
}
const agentWith = (client) => createLlmAgent({ client, company: { name: 'Lumen' }, catalogue: CATALOGUE, advisor: createAdvisor(CONFIG, CATALOGUE, { knowledge: KNOWLEDGE }), productKnowledge: KNOWLEDGE });
const next = (history, message, reply) => [...history, { role: 'user', content: message }, { role: 'assistant', content: reply.text, context: { advisor: reply.advisor } }];

test('on a product page: the answer, the offer; « oui » typed starts the builder around that product', async () => {
  const page = product('test-creme-hydratante-light');
  const client = scripted(answer('Cette crème légère convient aux peaux mixtes.', [{ handle: page.handle, rationale: 'légère' }]), answer('Quelle est votre préoccupation ?'), answer('Voici votre routine, autour de votre crème.'));
  const agent = agentWith(client);
  const context = { locale: 'fr', productHandle: page.handle };
  const r1 = await agent.respond({ message: 'Cette crème est-elle pour moi ?', context });
  assert.equal(r1.followUp.choices[0].value, 'flow:routine:yes');
  assert.deepEqual(r1.advisor.flow.anchor, { id: page.id, source: 'page' });
  let history = next([], 'Cette crème est-elle pour moi ?', r1);

  const r2 = await agent.respond({ message: 'Oui', context, history, advisorState: advisorStateFromHistory(history) });
  assert.equal(r2.advisor.mode, 'routine_builder');
  assert.equal(r2.advisor.flow.offer, 'accepted');
  assert.ok(r2.choices.some((c) => c.value.startsWith('profile:primary_concern:')));
  history = next(history, 'Oui', r2);

  const state = advisorStateFromHistory(history);
  state.asked = [...new Set([...state.asked, 'skin_type', 'sensitivity', 'current_routine', 'routine_scope', 'age_band'])];
  state.profile.body_area = { value: 'face', source: 'quick_choice', confidence: 'high', turn: 2 };
  state.profile.skin_type = { value: 'combination', source: 'quick_choice', confidence: 'high', turn: 2 };
  const r3 = await agent.respond({ message: 'Déshydratation', choice: 'profile:primary_concern:dehydration', context, history, advisorState: state });
  const cream = r3.trace.advice.steps.find((s) => s.slot === 'moisturiser');
  assert.equal(cream.id, page.id);
  assert.match(client.calls.at(-1).system, /"customer_interest":true/);
  // The routine is done: the treat follows, never a routine product.
  assert.equal(r3.trace.follow_up, 'treat');
  assert.ok(!r3.trace.advice.steps.some((s) => s.id === r3.followUp.products[0].id));
});

test('« Non merci » to the offer: a treat, and no second offer', async () => {
  const client = scripted(answer('Pour la déshydratation, le Sérum Hydratant Aqua.'), answer('Très bien.'), answer('Voici.'));
  const agent = agentWith(client);
  const r1 = await agent.respond({ message: "J'ai le visage déshydraté", context: { locale: 'fr' } });
  assert.deepEqual(r1.followUp.choices.map((c) => c.value), ['flow:routine:yes', 'flow:routine:no']);
  let history = next([], "J'ai le visage déshydraté", r1);
  const r2 = await agent.respond({ message: 'Non merci', choice: 'flow:routine:no', context: { locale: 'fr' }, history, advisorState: advisorStateFromHistory(history) });
  assert.equal(r2.advisor.flow.offer, 'declined');
  assert.equal(r2.followUp.products[0].id, product('test-masque-hydratant-wrap').id);
  assert.match(r2.followUp.text, /^Très bien\./);
  history = next(history, 'Non merci', r2);
  const r3 = await agent.respond({ message: 'Et pour les rides ?', context: { locale: 'fr' }, history, advisorState: advisorStateFromHistory(history) });
  assert.equal(r3.followUp, undefined);
});

test('a reply that shows no product is not followed by the offer', async () => {
  const client = scripted(answer('Bonjour, que puis-je pour vous ?'));
  const reply = await agentWith(client).respond({ message: 'Bonjour', context: { locale: 'fr' } });
  assert.equal(reply.followUp, undefined);
  assert.equal(reply.advisor.flow.offer, null);
});

test('« build me a routine » on a product page: straight into the builder, around that product, no offer', async () => {
  const page = product('test-serum-booster-eclat');
  const reply = await agentWith(scripted(answer('Avec plaisir. Quelle est votre préoccupation ?'))).respond({ message: 'Je voudrais construire ma routine', context: { locale: 'fr', productHandle: page.handle } });
  assert.equal(reply.advisor.mode, 'routine_builder');
  assert.deepEqual(reply.advisor.flow.anchor, { id: page.id, source: 'page' });
  assert.notEqual(reply.followUp?.kind, 'offer');
});

test('cards carry the variant to add to the cart only when there is one size to buy', () => {
  const handles = ['test-serum-hydratant-aqua', 'test-serum-anti-age-lift'];
  const cards = toCards(handles.map((handle) => ({ handle, rationale: '' })), new Set(handles), CATALOGUE, (n) => `${n} €`);
  assert.equal(cards[0].variantId, 'gid://shopify/ProductVariant/800004');
  assert.equal(cards[1].variantId, undefined);
  assert.equal(cartVariant({ ...product('test-serum-hydratant-aqua'), inStock: false }), null);
});

test('a product-page answer without a card is still followed by the offer: the page is the product', async () => {
  const page = product('test-creme-hydratante-light');
  const reply = await agentWith(scripted(answer('Elle convient surtout aux peaux mixtes.'))).respond({ message: 'Cette crème est-elle adaptée à ma peau ?', context: { locale: 'fr', productHandle: page.handle } });
  assert.deepEqual(reply.followUp.choices.map((c) => c.value), ['flow:routine:yes', 'flow:routine:no']);
});

test('when the follow-up asks, the model is told to ask nothing itself', () => {
  assert.match(followUpNote({ text: 'Q ?', choices: [{ label: 'a', value: 'b' }] }), /this turn's only question/);
  assert.doesNotMatch(followUpNote({ text: 'Voici.', choices: [] }), /only question/);
});

test('the offer took the turn: after « oui » the engine still asks its concern question, with buttons', async () => {
  const page = product('test-creme-hydratante-light');
  const agent = agentWith(scripted(answer('Pour vous répondre, quelle est votre préoccupation ?'), answer('Avec plaisir.')));
  const context = { locale: 'fr', productHandle: page.handle };
  const r1 = await agent.respond({ message: 'Cette crème est-elle adaptée à ma peau ?', context });
  const history = next([], 'Cette crème est-elle adaptée à ma peau ?', r1);
  const r2 = await agent.respond({ message: 'Oui, avec plaisir', choice: 'flow:routine:yes', context, history, advisorState: advisorStateFromHistory(history) });
  assert.ok(r2.choices.some((c) => c.value.startsWith('profile:')), JSON.stringify(r2.choices));
});

test('« oui » to a routine after a one-product request builds a routine, not one product', async () => {
  const agent = agentWith(scripted(answer('La Crème Hydratante Light.'), answer('Voici.')));
  const r1 = await agent.respond({ message: 'Je cherche une crème pour mon visage déshydraté', context: { locale: 'fr' } });
  const history = next([], 'Je cherche une crème pour mon visage déshydraté', r1);
  const r2 = await agent.respond({ message: 'Oui', context: { locale: 'fr' }, history, advisorState: advisorStateFromHistory(history) });
  assert.equal(r2.advisor.profile.desired_care_type, undefined);
  assert.equal(r2.advisor.mode === 'routine_builder' || (r2.trace.advice.steps ?? []).length > 1, true);
});
