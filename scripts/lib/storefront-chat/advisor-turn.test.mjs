import assert from 'node:assert/strict';
import test from 'node:test';

import { createLlmAgent } from './llm-agent.mjs';
import { buildCatalogue } from './product-repository.mjs';
import { advisorStateFromHistory, emptyAdvisorState } from './advisor-state.mjs';
import { PROFILE_CHOICE } from './advisor-tools.mjs';
import { parseChatRequest } from './request-schema.mjs';
import { createAdvisor } from '../advisory/recommend.mjs';

// The consultation through the storefront agent: profile before the model,
// advice in the prompt, chips from the engine, cards from the steps, state and
// events back to the service. An invented brand, scripted model replies.

const row = (n, title, tags, stock = 3) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, shopify_product_id: `gid://shopify/Product/${n}`, handle: title.toLowerCase().replace(/[^a-z]+/g, '-'), title, product_type: 'Soin Visage', tags, short_description: `${title}, court.`, variants: [{ title: '50 ml', price: '30.00' }], available_stock: stock });
const CATALOGUE = buildCatalogue(
  [
    row(1, 'Sérum Hydra - Élixir Aqua', ['visage', 'tous les types de peaux', 'hydratation']),
    row(2, 'Crème Hydra - Caresse Aqua Riche', ['visage', 'peaux sèches', 'hydratation']),
    row(3, 'Crème Hydra - Caresse Aqua Light', ['visage', 'peaux grasses', 'hydratation']),
    row(4, 'Sérum Lift - Élixir Tensor', ['visage', 'tous les types de peaux', 'rides', 'fermete']),
    row(5, 'Sérum Global - Élixir Temps', ['visage', 'tous les types de peaux', 'rides', 'global'])
  ],
  [
    { handle: 'aqua', title: 'Aqua', axis: 'range', product_ids: ['gid://shopify/Product/1', 'gid://shopify/Product/2', 'gid://shopify/Product/3'] },
    { handle: 'serums', title: 'Sérums', axis: 'category', product_ids: ['gid://shopify/Product/1', 'gid://shopify/Product/4', 'gid://shopify/Product/5'] },
    { handle: 'cremes', title: 'Crèmes', axis: 'category', product_ids: ['gid://shopify/Product/2', 'gid://shopify/Product/3'] }
  ]
);
const CONFIG = {
  selection_priority: ['body_area', 'primary_concern', 'skin_type_and_behaviour', 'sensitivity', 'current_routine', 'requested_product_or_routine_scope', 'secondary_concerns', 'sex_target', 'age'],
  playbooks: [
    { key: 'hydra', area: 'face', primary_concerns: ['dehydration'], preferred_family: 'Aqua', targeted: { priority_slots: ['serum', 'moisturiser'] }, essential: { slots: ['serum', 'moisturiser'] }, texture: { moisturiser: [['dry', 'richer_texture'], ['oily', 'lighter_texture']] } },
    { key: 'lift', area: 'face', primary_concerns: ['wrinkles', 'loss_of_firmness'], essential: { slots: ['serum'] } },
    { key: 'global', area: 'face', primary_concerns: ['wrinkles', 'global_signs_of_ageing'], essential: { slots: ['serum'] } }
  ],
  families: { Aqua: { collections: ['aqua'] } },
  slots: { serum: { kind: 'serum', collections: ['serums'], care_types: ['serum'] }, moisturiser: { kind: 'moisturiser', texture_slot: 'moisturiser', collections: ['cremes'], care_types: ['creme'] } },
  areas: { face: { tags: ['visage'] } },
  skin_types: { dry: { tags: ['peaux sèches'] }, oily: { tags: ['peaux grasses'] }, _all: { tags: ['tous les types de peaux'] } },
  skin_type_groups: { dry: { skin_types: ['dry', 'very_dry'] }, oily: { skin_types: ['oily'] } },
  textures: { richer_texture: { name_words: ['riche'], opposite: 'lighter_texture' }, lighter_texture: { name_words: ['light'], opposite: 'richer_texture' } },
  concerns: { dehydration: { tags: ['hydratation'] }, wrinkles: { tags: ['rides'] }, loss_of_firmness: { tags: ['fermete'] }, global_signs_of_ageing: { tags: ['global'] } },
  labels: { fr: { concern: { loss_of_firmness: 'Perte de fermeté', global_signs_of_ageing: "Signes de l'âge" }, skin_type: { dry: 'Sèche', unknown: 'Je ne sais pas' } } },
  merchandising: { tiers: {}, tie_window: 0.15, entries: [] }
};

const answer = (reply, products = []) => ({ content: JSON.stringify({ reply, reply_language: 'fr', products }), toolCalls: [], usage: { prompt_tokens: 800, completion_tokens: 40 } });
const toolCall = (name, args, id = 'call_1') => ({
  content: null,
  message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
  toolCalls: [{ id, name, args, argsError: null }],
  usage: { prompt_tokens: 900, completion_tokens: 20 }
});
function scripted(...responses) {
  const calls = [];
  return { calls, async completeWithTools(args) { calls.push(structuredClone(args)); const next = responses.shift(); if (!next) throw new Error('no more scripted responses'); return next; } };
}
const agentWith = (client) => createLlmAgent({ client, company: { name: 'Lumen' }, catalogue: CATALOGUE, advisor: createAdvisor(CONFIG, CATALOGUE) });

test('a skin statement is advised before the model: one call, the routine in the prompt, cards from the steps', async () => {
  const client = scripted(answer('Pour une peau sèche et déshydratée, je vous conseille l’Élixir Aqua.'));
  const reply = await agentWith(client).respond({ message: "J'ai la peau sèche et déshydratée", context: { locale: 'fr' }, conversationRef: 'session-1' });
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].system, /ADVICE FOR THIS CUSTOMER/);
  assert.match(client.calls[0].system, /"playbook":\{"key":"hydra"/);
  assert.ok(client.calls[0].tools.some((t) => t.function.name === 'advise'));
  // The model listed no card; the routine's product is shown anyway.
  assert.deepEqual(reply.products.map((p) => p.title), ['Sérum Hydra - Élixir Aqua']);
  assert.equal(reply.advisor.profile.skin_type.value, 'dry');
  assert.equal(reply.advisor.profile.skin_type.source, 'natural_language');
  assert.equal(reply.advisor.last_advice.playbook, 'hydra');
  assert.deepEqual(reply.events.map((e) => e.event_type), ['conversation_started', 'advisory_started', 'profile_field_collected', 'profile_field_collected', 'products_considered', 'products_recommended']);
  assert.ok(reply.events.every((e) => e.channel === 'storefront_chat' && e.conversation_ref === 'session-1'));
});

test('an ambiguous concern becomes ONE question with chips from the engine; the chip answers it', async () => {
  const first = scripted(answer('Qu’est-ce qui vous préoccupe le plus ?'));
  const r1 = await agentWith(first).respond({ message: "J'ai des rides", context: { locale: 'fr' } });
  assert.deepEqual(r1.choices, [{ label: 'Perte de fermeté', value: 'profile:primary_concern:loss_of_firmness' }, { label: "Signes de l'âge", value: 'profile:primary_concern:global_signs_of_ageing' }]);
  assert.equal(r1.advisor.last_question, 'primary_concern');
  assert.deepEqual(r1.products, []);

  const history = [{ role: 'user', content: "J'ai des rides" }, { role: 'assistant', content: 'Qu’est-ce qui vous préoccupe le plus ?', context: { advisor: r1.advisor } }];
  const second = scripted(answer('Je vous conseille l’Élixir Temps.'));
  const r2 = await agentWith(second).respond({ message: "Signes de l'âge", choice: 'profile:primary_concern:global_signs_of_ageing', history, advisorState: advisorStateFromHistory(history), context: { locale: 'fr' } });
  assert.equal(r2.advisor.profile.primary_concern.value, 'global_signs_of_ageing');
  assert.equal(r2.advisor.profile.primary_concern.source, 'quick_choice');
  assert.deepEqual(r2.advisor.profile.secondary_concerns.value, ['wrinkles']);
  assert.deepEqual(r2.products.map((p) => p.title), ['Sérum Global - Élixir Temps']);
});

test('the advise tool merges what the lexicon missed; outside the builder it gives one product', async () => {
  const client = scripted(
    toolCall('advise', { profile_updates: [{ field: 'primary_concern', value: 'dehydration' }, { field: 'skin_type', value: 'oily' }], scope: 'essential' }),
    answer('Voici votre routine.', [{ handle: CATALOGUE.products.find((p) => p.name.endsWith('Aqua Light')).handle, rationale: 'Texture légère' }])
  );
  const reply = await agentWith(client).respond({ message: 'Ma peau manque d’eau et brille un peu', context: { locale: 'fr' } });
  assert.equal(client.calls.length, 2);
  const toolResult = JSON.parse(client.calls[1].messages.find((m) => m.role === 'tool').content);
  assert.equal(toolResult.status, 'recommended');
  // Outside the routine builder skill a routine size is not the model's to set: one product.
  assert.equal(toolResult.steps.length, 1);
  assert.equal(reply.advisor.profile.routine_scope, undefined);
  assert.equal(reply.advisor.profile.skin_type.source, 'model_inferred');
});

test('a question about a named product is answered from its facts, not with a routine', async () => {
  const client = scripted(answer('Oui, la Caresse Aqua Riche convient aux peaux sèches.'));
  const reply = await agentWith(client).respond({ message: 'La Caresse Aqua Riche convient aux peaux sèches ?', context: { locale: 'fr' } });
  assert.doesNotMatch(client.calls[0].system, /ADVICE FOR THIS CUSTOMER/);
  assert.equal(reply.advisor.profile.skin_type.value, 'dry', 'the profile still learns');
});

test('« Construire ma routine » starts the builder and asks the concern first', async () => {
  const client = scripted(answer('Avec plaisir, quelques questions pour une routine adaptée.'));
  const reply = await agentWith(client).respond({ message: 'Construire ma routine', action: 'build_routine', context: { locale: 'fr' }, conversationRef: 's' });
  assert.equal(reply.advisor.mode, 'routine_builder');
  assert.equal(reply.advisor.last_question, 'primary_concern');
  assert.ok(reply.choices.length >= 2);
  assert.ok(reply.events.some((e) => e.event_type === 'routine_builder_started'));
  assert.ok(reply.events.some((e) => e.event_type === 'clarification_asked'));
});

test('the saved state is re-checked when read back', () => {
  assert.deepEqual(advisorStateFromHistory([]), emptyAdvisorState());
  const state = advisorStateFromHistory([
    { role: 'assistant', context: { advisor: { profile: { skin_type: { value: 'dry' } }, mode: 'routine_builder', asked: ['skin_type'], last_question: 'sensitivity' } } },
    { role: 'user', content: 'x' },
    { role: 'assistant', context: { advisor: { profile: { 'bad key!': {}, skin_type: { value: 'oily' } }, mode: 'hack', asked: ['ok', 7], last_question: 'DROP TABLE' } } }
  ]);
  assert.deepEqual(state.profile, { skin_type: { value: 'oily' } });
  assert.equal(state.mode, 'conversation');
  assert.deepEqual(state.asked, ['ok']);
  assert.equal(state.last_question, null);
});

test('the widget may send a profile chip value', () => {
  assert.equal(parseChatRequest({ message: 'Sèche', choice: 'profile:skin_type:dry' }).choice, 'profile:skin_type:dry');
  assert.equal(parseChatRequest({ message: 'x', choice: 'profile:current_routine:cleanser+moisturiser' }).choice, 'profile:current_routine:cleanser+moisturiser');
  assert.ok(PROFILE_CHOICE.test('profile:current_routine:cleanser+moisturiser'));
  assert.ok(!PROFILE_CHOICE.test('profile:Skin:Dry'));
});

// ---------------------------------------------------------------- the lexicon's backup
import { readProfile, shouldRead } from './profile-reader.mjs';

const reading = (updates) => ({ content: JSON.stringify({ profile_updates: updates }), toolCalls: [], usage: { prompt_tokens: 300, completion_tokens: 30 } });

test('words the lexicon does not know are read by the model BEFORE the engine decides', async () => {
  const client = scripted(reading([{ field: 'primary_concern', value: 'dehydration' }, { field: 'skin_type', value: 'dry' }]), answer('Voici une routine.'));
  const reply = await agentWith(client).respond({ message: 'My face feels like sandpaper' });
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].pass, 'storefront_profile_read');
  assert.equal(reply.trace.advice.reader.reason, 'unexplained_words');
  assert.equal(reply.trace.advice.reader.status, 'read');
  assert.deepEqual(reply.trace.advice.reader.added.sort(), ['primary_concern', 'skin_type']);
  // The advice the reply model saw was computed from the full reading, not from nothing.
  assert.equal(reply.trace.advice.status, 'recommended');
  assert.equal(reply.trace.advice.playbook, 'hydra');
  assert.match(client.calls[1].system, /Élixir Aqua/);
  assert.equal(reply.usage.inputTokens, 300 + 800);
});

test('a message the lexicon reads whole costs no extra call', async () => {
  const client = scripted(answer('Voici.'));
  const reply = await agentWith(client).respond({ message: "J'ai la peau sèche et déshydratée" });
  assert.equal(client.calls.length, 1);
  assert.equal(reply.trace.advice.reader.reason, 'fully_read');
});

test('the lexicon wins a conflict with the reader; a failed reading leaves the turn as it was', async () => {
  const conflicting = scripted(reading([{ field: 'skin_type', value: 'oily' }]), answer('Voici.'));
  const reply = await agentWith(conflicting).respond({ message: 'Dry skin, dehydrated, it feels like sandpaper' });
  assert.equal(reply.trace.advice.reader.status, 'read');
  assert.ok(!reply.trace.advice.reader.added.includes('skin_type'), 'the lexicon read « dry »; the reader cannot turn it into oily');

  const failing = { calls: [], async completeWithTools(args) { this.calls.push(args); if (args.pass === 'storefront_profile_read') throw new Error('HTTP 500'); return answer('Voici.'); } };
  const after = await agentWith(failing).respond({ message: 'My face feels like sandpaper' });
  assert.equal(after.trace.advice.reader.status, 'failed');
  assert.equal(after.text, 'Voici.');
});

test('the reader gate: consultation turns with unexplained words only', () => {
  const lex = (updates, residue, routineBuilder = false) => ({ updates, residue, routineBuilder });
  assert.equal(shouldRead({ lexicon: lex([], ['sandpaper']), skinWords: true }).reason, 'nothing_read');
  assert.equal(shouldRead({ lexicon: lex([{}], ['bumps']) }).reason, 'unexplained_words');
  assert.equal(shouldRead({ lexicon: lex([{}], []) }).read, false);
  assert.equal(shouldRead({ lexicon: lex([], ['livraison']) }).reason, 'not_a_consultation');
  assert.equal(shouldRead({ lexicon: lex([], ['ouais']), state: { last_question: 'skin_type' } }).read, true, 'an answer in their own words to the question just asked');
  assert.equal(shouldRead({ lexicon: lex([{}], ['bumps']), choice: 'profile:skin_type:dry' }).reason, 'chip');
  assert.equal(shouldRead({ lexicon: lex([{}], ['bumps']), productQuestion: true }).reason, 'product_question');
  assert.equal(shouldRead({ lexicon: lex([{}], ['bumps']), otherTopic: true }).reason, 'other_topic');
});

test('readProfile times out instead of holding the turn', async () => {
  const hanging = { completeWithTools: () => new Promise(() => {}) };
  const r = await readProfile({ client: hanging, model: 'm', message: 'x', allowed: { body_area: [], skin_type: [], sensitivity: [], secondary_concerns: [], current_routine: [], desired_care_type: [], routine_scope: [], age_band: [] }, timeoutMs: 20 });
  assert.equal(r.status, 'failed');
});

// PURCHASE HISTORY: the signed-in customer's purchases, read only when the turn
// needs them, asked about in the builder's follow-up only, never taken as a profile.
const RICH = '00000000-0000-4000-8000-000000000002';
const bought = (over = {}) => ({ products: [{ product_id: 'gid://shopify/Product/2', title: 'Crème Hydra - Caresse Aqua Riche', first_purchased_on: '2026-06-01', last_purchased_on: '2026-08-20', times_purchased: 2, returned: false, free_gift: false, ...over }] });
function loader(result = bought()) {
  const fn = async () => { fn.calls += 1; if (result instanceof Error) throw result; return result; };
  fn.calls = 0;
  return fn;
}

test('outside the builder purchases are read but never asked about: the reply is followed by the routine offer', async () => {
  const client = scripted(answer('Pour une peau sèche et déshydratée, l’Élixir Aqua.'));
  const purchases = loader();
  const reply = await agentWith(client).respond({ message: "J'ai la peau sèche et déshydratée", context: { locale: 'fr' }, purchases });
  assert.equal(purchases.calls, 1);
  const system = client.calls[0].system;
  assert.match(system, /PURCHASES \(this signed-in customer/);
  assert.doesNotMatch(system, /gid:\/\/shopify|2026-06-01|"ask_about"/);
  assert.ok(!JSON.stringify(reply).includes('purchase:'));
  assert.equal(reply.followUp.text, 'Souhaitez-vous que je vous construise une routine personnalisée ?');
  assert.deepEqual(reply.followUp.choices.map((c) => c.value), ['flow:routine:yes', 'flow:routine:no']);
  assert.match(system, /FOLLOW-UP\nAfter your reply, the app sends its own message that asks whether they would like a personalised routine/);
  assert.doesNotMatch(system, /Souhaitez-vous que je vous construise/);
  assert.deepEqual(reply.choices, []);
  // A purchase never fills the profile.
  assert.equal(reply.advisor.profile.skin_type.source, 'natural_language');
});

const builderTurn = (client, purchases, locale = 'fr') => agentWith(client).respond({ message: locale === 'fr' ? "J'ai la peau sèche et déshydratée" : 'My skin is dry and dehydrated', action: 'build_routine', context: { locale }, purchases });

test('in the builder, once the concern is known, the purchase question is the whole turn: the code asks it, no model call', async () => {
  const client = scripted(answer('never used'));
  const reply = await builderTurn(client, loader());
  assert.equal(client.calls.length, 0);
  assert.equal(reply.text, 'Je vois que vous avez déjà acheté Crème Hydra - Caresse Aqua Riche. Souhaitez-vous construire votre routine autour, vous en reste-t-il peu, ou préférez-vous vous concentrer sur votre préoccupation ?');
  assert.deepEqual(reply.choices.map((c) => c.value), [`purchase:around:${RICH}`, `purchase:running_low:${RICH}`, `purchase:focus:${RICH}`]);
  assert.equal(reply.followUp, undefined);
  assert.deepEqual(reply.advisor.purchases.asked, [RICH]);
  assert.equal(reply.trace.follow_up, 'purchase');
});

const answeredState = async () => {
  const first = await builderTurn(scripted(answer('…')), loader());
  const state = advisorStateFromHistory([{ role: 'assistant', content: '…', context: { advisor: first.advisor } }]);
  state.profile.routine_scope = { value: 'essential', source: 'quick_choice', confidence: 'high', turn: 1 };
  // The builder's own questions answered: the next turn recommends.
  state.asked = [...new Set([...state.asked, 'skin_type', 'sensitivity', 'current_routine', 'routine_scope', 'age_band'])];
  return state;
};

test('« build around it »: their product fills its step, and they are not asked again', async () => {
  const client = scripted(answer('Parfait, continuez avec votre Caresse Aqua Riche.'));
  const reply = await agentWith(client).respond({ message: 'Construire ma routine autour', choice: `purchase:around:${RICH}`, context: { locale: 'fr' }, advisorState: await answeredState(), purchases: loader() });
  const system = client.calls[0].system;
  assert.match(system, /"just_answered":\{"name":"Crème Hydra - Caresse Aqua Riche","customer_said":"build_around"\}/);
  assert.match(system, /"reason":"already_owned","customer_product":"Crème Hydra - Caresse Aqua Riche"/);
  assert.ok(!reply.trace.advice.steps.some((s) => s.id === RICH));
  assert.deepEqual(reply.advisor.purchases.around, [RICH]);
  assert.ok(!JSON.stringify(reply.followUp ?? {}).includes('purchase:'));
  assert.equal(reply.trace.purchases.answered, 'around');
});

test('« running low »: its card comes in the follow-up, and the routine includes it', async () => {
  const reply = await agentWith(scripted(answer('Très bien.'))).respond({ message: "Il m'en reste peu", choice: `purchase:running_low:${RICH}`, context: { locale: 'fr' }, advisorState: await answeredState(), purchases: loader() });
  assert.equal(reply.followUp.text, "Vous pouvez retrouver Crème Hydra - Caresse Aqua Riche ici, ou l'ajouter directement à votre panier.");
  assert.deepEqual(reply.followUp.products.map((c) => c.id), [RICH]);
  assert.ok(reply.trace.advice.steps.some((s) => s.id === RICH));
});

test('a turn that is not a consultation never reads the purchases', async () => {
  const purchases = loader();
  await agentWith(scripted(answer('Bonjour ! Comment puis-je vous aider ?'))).respond({ message: 'Bonjour', context: { locale: 'fr' }, purchases });
  assert.equal(purchases.calls, 0);
});

test('« what did I buy? » reads them without a consultation, and nothing is asked', async () => {
  const client = scripted(answer('Vous avez acheté la Caresse Aqua Riche.'));
  const purchases = loader(bought({ free_gift: true }));
  const reply = await agentWith(client).respond({ message: 'What did I buy last time?', context: { locale: 'en' }, purchases });
  assert.equal(purchases.calls, 1);
  assert.match(client.calls[0].system, /"free_gift":true/);
  assert.ok(!JSON.stringify(reply).includes('purchase:'));
});

test('English: the purchase question and its buttons in English', async () => {
  const reply = await builderTurn(scripted(answer('Here is your routine.')), loader(), 'en');
  assert.match(reply.text, /^I can see you've bought Crème Hydra - Caresse Aqua Riche before\./);
  assert.deepEqual(reply.choices.map((c) => c.label), ['Build my routine around it', "I'm running low", 'Focus on my concern']);
});

test('anonymous (no loader) or a failed read: no purchases, no purchase question', async () => {
  const anon = scripted(answer('…'));
  const r1 = await builderTurn(anon, null);
  assert.doesNotMatch(anon.calls[0].system, /PURCHASES \(/);
  assert.equal(r1.trace.purchases, undefined);
  const failing = scripted(answer('…'));
  const r2 = await builderTurn(failing, loader(new Error('db down')));
  assert.doesNotMatch(failing.calls[0].system, /PURCHASES \(/);
  assert.equal(r2.trace.purchases.status, 'failed');
  assert.ok(!JSON.stringify(r2).includes('purchase:'));
});

test('the flow and purchase chips are valid request choices', () => {
  for (const choice of [`purchase:around:${RICH}`, 'flow:routine:yes']) {
    const parsed = parseChatRequest({ sessionId: null, message: 'x', action: null, choice, context: { pageType: 'index', productHandle: null, collectionHandle: null, locale: 'fr', path: '/' } });
    assert.equal(parsed.choice, choice);
  }
});
