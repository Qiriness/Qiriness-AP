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

test('the advise tool merges what the lexicon missed, and its products may be shown', async () => {
  const client = scripted(
    toolCall('advise', { profile_updates: [{ field: 'primary_concern', value: 'dehydration' }, { field: 'skin_type', value: 'oily' }], scope: 'essential' }),
    answer('Voici votre routine.', [{ handle: CATALOGUE.products.find((p) => p.name.endsWith('Aqua Light')).handle, rationale: 'Texture légère' }])
  );
  const reply = await agentWith(client).respond({ message: 'Ma peau manque d’eau et brille un peu', context: { locale: 'fr' } });
  assert.equal(client.calls.length, 2);
  const toolResult = JSON.parse(client.calls[1].messages.find((m) => m.role === 'tool').content);
  assert.equal(toolResult.status, 'recommended');
  assert.deepEqual(toolResult.steps.map((s) => s.product.name), ['Sérum Hydra - Élixir Aqua', 'Crème Hydra - Caresse Aqua Light']);
  assert.deepEqual(reply.products.map((p) => p.title), ['Crème Hydra - Caresse Aqua Light']);
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
