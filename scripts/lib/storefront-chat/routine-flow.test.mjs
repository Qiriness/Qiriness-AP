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
  assert.deepEqual(beforeAdvice(pending, { message: 'Oui' }), { flow: { ...pending, offer: 'accepted' }, answer: 'yes', cart: null, startBuilder: true });
});

test('the offer follows products, once, never in the builder; its anchor is the page, then the named product, then our top pick', () => {
  const advice = { status: 'recommended', steps: [{ product_id: ID(4) }] };
  assert.deepEqual(anchorFor({ pageProductId: ID(1), resolvedIds: [ID(2)], advice }), { id: ID(1), source: 'page' });
  assert.deepEqual(anchorFor({ resolvedIds: [ID(2)], advice }), { id: ID(2), source: 'request' });
  assert.deepEqual(anchorFor({ advice }), { id: ID(4), source: 'suggested' });

  const offered = followUpFor({ ...base, flow: emptyFlow(), anchor: { id: ID(4), source: 'suggested' } });
  assert.equal(offered.followUp.kind, 'offer');
  assert.deepEqual(offered.followUp.choices, [{ label: 'Oui, avec plaisir', value: 'flow:routine:yes' }, { label: 'Non merci', value: 'flow:routine:no' }]);
  assert.deepEqual(offered.flow, { offer: 'offered', anchor: { id: ID(4), source: 'suggested' }, treat_offered: false, cart: { pending: [], asked: [] }, routine_ref: null });
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
  assert.deepEqual(cleanFlow({ offer: 'declined', anchor: { id: ID(1), source: 'page' } }), { offer: 'declined', anchor: { id: ID(1), source: 'page' }, treat_offered: false, cart: { pending: [], asked: [] }, routine_ref: null });
  // The routine's ref survives the log; anything else is dropped.
  assert.equal(cleanFlow({ routine_ref: ID(7) }).routine_ref, ID(7));
  assert.equal(cleanFlow({ routine_ref: 'DROP TABLE' }).routine_ref, null);
  // A pending cart keeps only real ids and variant gids.
  assert.deepEqual(cleanFlow({ cart: { pending: [{ id: ID(1), variant_id: 'gid://shopify/ProductVariant/5' }, { id: 'x', variant_id: null }, { id: ID(2), variant_id: 'evil' }], asked: [ID(1), 'x'] } }).cart, { pending: [{ id: ID(1), variant_id: 'gid://shopify/ProductVariant/5' }], asked: [ID(1)] });
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
  // The routine is done: « shall I add it to your cart? » first, the treat after the answer.
  assert.equal(r3.trace.follow_up, 'cart');
  assert.deepEqual(r3.followUp.choices.map((c) => c.label), ['Oui, ajouter', 'Je cherche encore']);
  history = next(history, 'Déshydratation', r3);
  const r4 = await agent.respond({ message: 'Je cherche encore', context, history, advisorState: advisorStateFromHistory(history) });
  assert.equal(r4.trace.follow_up, 'treat');
  assert.ok(!r3.trace.advice.steps.some((s) => s.id === r4.followUp.products[0].id));
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
  // No second routine offer (a single product may now get the cart question).
  assert.notEqual(r3.followUp?.text, 'Souhaitez-vous que je vous construise une routine personnalisée ?');
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

// BUDGET through the agent, on the foundation engine (the routines bench).
const BENCH = read('data/advisor/sample-routines/catalogue.json');
const BENCH_SHEET = read('data/advisor/sample-routines/knowledge.json');
const BENCH_KNOWLEDGE = knowledgeIndex(parseKnowledgeRows(BENCH_SHEET.rows, { concerns: BENCH_SHEET.concerns }).products);
const benchAgent = (client) => createLlmAgent({ client, company: { name: 'Lumen' }, catalogue: BENCH, advisor: createAdvisor(CONFIG, BENCH, { knowledge: BENCH_KNOWLEDGE, routines: read('data/advisor/sample-routines/routines.json') }), productKnowledge: BENCH_KNOWLEDGE });

test('« trop cher »: a « petit plaisir » with its price, and neither the routine offer nor a second treat after it', async () => {
  const client = scripted(answer('Je vous propose un petit plaisir plus doux pour votre budget.'));
  const reply = await benchAgent(client).respond({ message: "C'est trop cher pour moi, j'ai le visage déshydraté", context: { locale: 'fr' } });
  assert.equal(reply.trace.advice.playbook, 'treat');
  assert.equal(reply.followUp, undefined);
  assert.match(client.calls.at(-1).system, /"total_price":"\d+[,.]\d{2}/);
  assert.match(client.calls.at(-1).system, /playbook treat is a small affordable treat/);
});

test('a need shows our top choices as cards; « trop cher » just after a product gives a cheaper one of its type', async () => {
  const client = scripted(answer('Voici nos meilleurs choix.'), answer('Une crème moins chère.'));
  const agent = benchAgent(client);
  const r1 = await agent.respond({ message: 'Je cherche une crème pour mon visage déshydraté', context: { locale: 'fr' } });
  assert.ok(r1.products.length >= 1);
  const history = [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'x', context: { advisor: r1.advisor } }];
  const r2 = await agent.respond({ message: "C'est trop cher", context: { locale: 'fr' }, history, advisorState: advisorStateFromHistory(history) });
  const before = BENCH.products.find((p) => p.id === r1.trace.advice.steps[0].id);
  const after = BENCH.products.find((p) => p.id === r2.trace.advice.steps[0].id);
  assert.ok(['cheaper', 'treat'].includes(r2.trace.advice.playbook));
  if (r2.trace.advice.playbook === 'cheaper') assert.ok(after.priceFrom < before.priceFrom && after.type === before.type);
  const top = await benchAgent(scripted(answer('Voici.'))).respond({ message: 'Que me conseillez-vous pour mon visage déshydraté ?', context: { locale: 'fr' } });
  assert.equal(top.products.length, 3);
});


test('« Oui, ajouter » after a routine: the code writes the turn and tells the widget what to add; no model call', async () => {
  const client = scripted();
  const agent = benchAgent(client);
  const routine = await agent.respond({ message: 'Pouvez-vous me construire une routine pour mon visage déshydraté ?', action: 'build_routine', context: { locale: 'fr' } });
  const state = advisorStateFromHistory([{ role: 'assistant', content: '…', context: { advisor: routine.advisor } }]);
  state.asked = [...new Set([...state.asked, 'skin_type', 'sensitivity', 'current_routine', 'routine_scope', 'age_band'])];
  const built = await agent.respond({ message: 'Visage', choice: 'profile:body_area:face', context: { locale: 'fr' }, advisorState: state });
  assert.equal(built.trace.follow_up, 'cart');
  assert.ok(built.routineCart.add.length >= 2);
  const history = [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'x', context: { advisor: built.advisor } }];
  const calls = client.calls.length;
  const yes = await agent.respond({ message: 'Oui, ajouter', choice: 'flow:cart:yes', context: { locale: 'fr' }, history, advisorState: advisorStateFromHistory(history) });
  assert.equal(client.calls.length, calls);
  assert.deepEqual(yes.cart.add.map((x) => x.product_id), built.trace.advice.steps.map((s) => s.id).filter((id) => built.routineCart.add.some((x) => x.product_id === id)));
  assert.match(yes.text, /^C'est noté, j'ajoute à votre panier : /);
  assert.equal(yes.trace.follow_up, 'treat');
});

test('a typed « oui » or « je cherche encore » answers the cart question only while it is pending', () => {
  const pending = { ...emptyFlow(), offer: 'declined', cart: { pending: [{ id: ID(1), variant_id: 'gid://shopify/ProductVariant/9' }], asked: [ID(1)] } };
  assert.equal(beforeAdvice(pending, { message: 'Oui' }).cart, 'yes');
  assert.equal(beforeAdvice(pending, { message: 'Je cherche encore' }).cart, 'no');
  assert.equal(beforeAdvice(pending, { message: "I'm still looking" }).cart, 'no');
  assert.equal(beforeAdvice(pending, { message: 'Oui' }).answer, null);
  assert.equal(beforeAdvice({ ...pending, cart: { pending: [], asked: [] } }, { message: 'Oui' }).cart, null);
});

test('a cart question passed over is no longer pending: a later « oui » answers something else', () => {
  // Dev store, 2026-10-16: asked about the retinol cream, then « trop cher », « sans rétinol ? »,
  // the model's own yes/no question, and « oui » added the retinol cream.
  const asked = { ...emptyFlow(), offer: 'accepted', cart: { pending: [{ id: ID(1), variant_id: 'gid://shopify/ProductVariant/9' }], asked: [ID(1)] } };
  const passedOver = followUpFor({ ...base, flow: beforeAdvice(asked, { message: "c'est un peu trop cher pour moi" }).flow, showsProducts: false });
  assert.deepEqual(passedOver.flow.cart, { pending: [], asked: [ID(1)] });
  assert.equal(beforeAdvice(passedOver.flow, { message: 'oui' }).cart, null);
});

test('a routine the AI builds through advise during its turn still gets the cart question after it', async () => {
  const toolCall = (name, args) => ({ content: null, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, toolCalls: [{ id: 'c1', name, args, argsError: null }], usage: {} });
  const calls = [];
  const client = { calls, async completeWithTools(args) {
    calls.push(structuredClone(args));
    if (!args.tools) return { content: JSON.stringify({ updates: [] }), toolCalls: [], usage: {} };
    return calls.filter((c) => c.tools).length === 1 ? toolCall('advise', { profile_updates: [{ field: 'current_routine', value: 'none' }], scope: 'essential' }) : answer('Voici votre routine.');
  } };
  const reply = await benchAgent(client).respond({ message: 'Aidez-moi à construire une routine, mon visage manque d\'éclat', context: { locale: 'fr' } });
  assert.equal(reply.trace.advice.status, 'recommended');
  assert.equal(reply.trace.follow_up, 'cart');
  assert.ok(reply.routineCart.add.length >= 2);
});

test('the treat after a routine names their concern, FR and EN (owner, 2026-10-19)', () => {
  const treat = { product_id: ID(11) };
  const say = (lang, concern) => followUpFor({ ...base, lang, flow: emptyFlow(), builder: true, advice: { status: 'recommended' }, treat, concern }).followUp.text;
  assert.equal(say('fr', 'Imperfections'), 'Et pour un moment de douceur, parfait pour atténuer vos imperfections, ce petit plaisir pourrait vous plaire :');
  assert.equal(say('fr', 'Déshydratation'), 'Et pour un moment de douceur, parfait pour atténuer votre déshydratation, ce petit plaisir pourrait vous plaire :');
  assert.equal(say('en', 'Dark spots'), 'And for a little moment of pampering, perfect for easing your dark spots, you might like this treat:');
  // No concern known: the plain sentence.
  assert.equal(say('fr', null), 'Et pour un moment de douceur, ce petit plaisir pourrait vous plaire :');
});
