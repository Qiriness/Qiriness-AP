import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLlmAgent } from './llm-agent.mjs';
import { buildCatalogue, mapProduct } from './product-repository.mjs';
import { buildRoutineView, whyTags } from './routine-view.mjs';
import { routineReward } from './shopping-evaluator.mjs';
import { buildAdvisorKnowledge } from '../advisory/advisor-knowledge.mjs';
import { knowledgeIndex } from '../advisory/product-knowledge.mjs';
import { createAdvisor } from '../advisory/recommend.mjs';
import { contentPatch } from '../../dev-store/copy-production-content.mjs';

// THE ROUTINE CARDS (owner, 2026-10-18), on Qiriness's real sheet: both moments always, the
// content of each product, the saving from its minimum on; the code applied, never shown.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const built = buildAdvisorKnowledge({ sheet: read('data/advisor/qiriness-knowledge.json'), settings: read('data/advisor/qiriness-routine-settings.json') });
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CATALOGUE = buildCatalogue(
  built.products.map((k, i) => ({
    id: uuid(i + 1), shopify_product_id: `gid://shopify/Product/${i + 1}`, handle: k.handle, title: k.title ?? k.handle,
    product_type: 'Soin', tags: [], short_description: `La description courte de ${k.handle}.`,
    active_ingredients: 'Acide hyaluronique : il repulpe.', usage_instructions: 'Matin et soir.',
    mf_benefits_0: '<ul><li>95% peau plus lisse</li></ul>', mf_claims_0: ['Lissant'], mf_rating_0: '{"value":"4.8","scale_max":"5.0"}', mf_rating_count_0: '115', mf_volume_0: '100ml',
    variants: [{ id: `gid://shopify/ProductVariant/${i + 1}`, title: '50 ml', price: String(Number(k.price) || 30), inventory_quantity: 5 }], available_stock: 5,
  })),
  [],
);
const advisor = createAdvisor(read('data/advisor/qiriness.json'), CATALOGUE, { knowledge: knowledgeIndex(built.products), routines: built.routines });
const byId = (id) => CATALOGUE.products.find((p) => p.id === id) ?? null;
const money = (n) => `${n.toFixed(2)} €`;
const cartVariant = (p) => p.variants[0]?.id ?? null;
const q = (value) => ({ value, source: 'quick_choice', confidence: 'high', turn: 1 });
const ALL = ['primary_concern', 'skin_type', 'age_band', 'routine_time'];
const profile = { primary_concern: q('wrinkles'), skin_type: q('dry'), age_band: q('35_44'), routine_time: q('day') };

test('the catalogue reads the cards\' content: benefits as text, claims, the rating out of 5, the size', () => {
  const p = CATALOGUE.products[0];
  assert.equal(p.benefits, '95% peau plus lisse');
  assert.deepEqual(p.claims, ['Lissant']);
  assert.equal(p.rating, 4.8);
  assert.equal(p.ratingCount, 115);
  assert.equal(p.volume, '100ml');
  // A product without them: nothing invented.
  const bare = mapProduct({ id: 'x', handle: 'x', title: 'X', variants: [] });
  assert.deepEqual([bare.benefits, bare.claims, bare.rating, bare.ratingCount, bare.volume], [null, [], null, null, null]);
  assert.equal(mapProduct({ id: 'y', handle: 'y', title: 'Y', mf_rating_0: '{"value":"8","scale_max":"10"}' }).rating, 4);
});

test('a day routine: the morning included, the evening greyed with what they already have', () => {
  const advice = advisor.advise({ profile, mode: 'routine_builder', asked: ALL });
  const view = buildRoutineView({ advice, profile, byId, money, cartVariant, labels: built.routines.labels, locale: 'fr', currency: 'EUR', ref: 'r1', discount: { code: 'MAROUTINE20', min_products: 3 }, reward: { percentage: 20, min_quantity: 3 } });
  assert.equal(view.chosen, 'day');
  assert.deepEqual(view.moments.map((m) => [m.part, m.chosen]), [['day', true], ['night', false]]);
  const [day, night] = view.moments;
  assert.deepEqual(day.steps.map((s) => s.handle), advice.steps.map((s) => s.handle));
  assert.ok(night.steps.some((s) => s.owned) && night.steps.some((s) => !s.owned));
  const step = day.steps[0];
  assert.equal(step.stage, 'prepare');
  assert.equal(step.price, money(step.price_value));
  assert.equal(step.volume, '100ml');
  assert.equal(step.rating, 4.8);
  assert.equal(step.ingredients, 'Acide hyaluronique : il repulpe.');
  assert.equal(step.usage, 'Matin et soir.');
  assert.match(step.why.text, /^La description courte/);
  // The saving: its percentage and the higher of the two minimums; the code for the widget only.
  assert.deepEqual(view.discount, { code: 'MAROUTINE20', min_products: 3, percentage: 20 });
  assert.equal(view.ref, 'r1');
});

test('« Pourquoi pour vous ? »: their skin type and the concern the product treats, in their language', () => {
  const labels = built.routines.labels;
  assert.deepEqual(whyTags({ reason_codes: ['skin_type_match', 'primary_concern'] }, profile, labels, 'E', 'fr'), ['Peau sèche / très sèche', 'Rides']);
  assert.deepEqual(whyTags({ reason_codes: ['skin_type_match', 'primary_concern'] }, profile, labels, 'E', 'en'), ['Dry', 'Wrinkles']);
  // A concern not on the Rules tab: the main concern's name.
  assert.deepEqual(whyTags({ reason_codes: ['primary_concern'] }, { primary_concern: q('global_signs_of_ageing') }, labels, 'E', 'fr'), ['Anti-âge']);
  // Neither code: no tag, never a guess.
  assert.deepEqual(whyTags({ reason_codes: ['age_range'] }, profile, labels, 'E', 'fr'), []);
});

test('no view outside a finished builder routine; no discount without a code', () => {
  const asked = advisor.advise({ profile: { primary_concern: q('wrinkles') }, mode: 'conversation' });
  assert.equal(buildRoutineView({ advice: asked, profile, byId, money, cartVariant }), null);
  const advice = advisor.advise({ profile, mode: 'routine_builder', asked: ALL });
  assert.equal(buildRoutineView({ advice, profile, byId, money, cartVariant }).discount, null);
  // A code whose value is unknown: the minimum still, no saving shown.
  assert.deepEqual(buildRoutineView({ advice, profile, byId, money, cartVariant, discount: { code: 'MAROUTINE20', min_products: 3 } }).discount, { code: 'MAROUTINE20', min_products: 3 });
});

test('the routine discount\'s value from its synced Shopify rule; not running or not a percentage, none', () => {
  const row = (extra = {}) => ({ codes: [{ code: 'MAROUTINE20' }], status: 'ACTIVE', rule_snapshot: { customer_gets: { percentage: 0.2 }, minimum_requirement: { type: 'quantity', quantity: 3 } }, ...extra });
  assert.deepEqual(routineReward({ status: 'ok', cartCodeRows: [row()] }, 'maroutine20'), { percentage: 20, min_quantity: 3 });
  assert.equal(routineReward({ status: 'ok', cartCodeRows: [row({ status: 'EXPIRED' })] }, 'MAROUTINE20'), null);
  assert.equal(routineReward({ status: 'ok', cartCodeRows: [row({ rule_snapshot: { customer_gets: { amount: 10 } } })] }, 'MAROUTINE20'), null);
  assert.equal(routineReward({ status: 'unavailable' }, 'MAROUTINE20'), null);
});

test('the agent: the finished routine carries its cards and the routine layout, with no model call', async () => {
  const calls = [];
  const client = { async completeWithTools(args) { calls.push(args); return { content: JSON.stringify({ reply: 'Voici votre routine.', reply_language: 'fr', products: [] }), toolCalls: [], usage: {} }; } };
  const agent = createLlmAgent({ client, company: { name: 'Qiriness' }, catalogue: CATALOGUE, advisor });
  let state = null;
  let last = null;
  for (const [message, choice] of [['Construire ma routine', null], ['Rides', 'profile:primary_concern:wrinkles'], ['Sèche', 'profile:skin_type:dry'], ['35 à 44 ans', 'profile:age_band:35_44'], ['Routine du jour', 'profile:routine_time:day']]) {
    last = await agent.respond({ message, choice, advisorState: state, context: { locale: 'fr' }, ...(choice ? {} : { action: 'build_routine' }) });
    state = last.advisor;
    assert.equal(last.layout, 'routine');
  }
  assert.equal(last.routineView.chosen, 'day');
  assert.equal(last.routineView.ref, last.routine.ref);
  assert.equal(last.routineView.discount.code, 'MAROUTINE20');
  // « No need for the text reply » (owner, 2026-10-18): the cards say it.
  assert.equal(calls.length, 0);
  assert.equal(last.text, 'Voici votre routine personnalisée, matin et soir.');
  // All four show, the serum and the cream ticked (owner, 2026-10-19); « Oui, ajouter » adds only those.
  const [day] = last.routineView.moments;
  assert.equal(day.steps.length, 4);
  assert.deepEqual(day.steps.map((s) => s.preselected !== false), [false, true, false, true]);
  const ticked = day.steps.filter((s) => s.preselected !== false).map((s) => s.product_id).sort();
  assert.deepEqual(last.advisor.flow.cart.pending.map((x) => x.id).sort(), ticked);
  assert.deepEqual(last.routineCart?.add.map((x) => x.product_id).sort() ?? ticked, ticked);
});

test('a routine product in several textures: the one their skin type calls for, never a refill', async () => {
  const { cartVariant, preferredVariant, variantPreference } = await import('./llm-agent.mjs');
  const choice = advisor.variantChoice;
  assert.equal(choice.skin_texture.normal, 'standard');
  const textures = [{ id: 'n', title: 'Normale 50 ml' }, { id: 'r', title: 'Riche 50 ml' }, { id: 'l', title: 'Légère 50 ml' }];
  const pick = (skin, variants = textures) => preferredVariant(variants, variantPreference(choice, skin ? { skin_type: q(skin) } : {}))?.id ?? null;
  assert.equal(pick('normal'), 'n');
  assert.equal(pick('dry'), 'r');
  assert.equal(pick('oily'), 'l');
  // Skin type unknown: the default texture; no light one: the default too.
  assert.equal(pick(null), 'n');
  assert.equal(pick('oily', textures.slice(0, 2)), 'n');
  // A refill is never chosen while the jar exists.
  assert.equal(pick('normal', [{ id: 'c', title: 'CRÈME 50 ML' }, { id: 'x', title: 'RECHARGE 50 ML' }]), 'c');
  // Two sizes nothing tells apart: none, the customer chooses on the page.
  assert.equal(pick('normal', [{ id: 'a', title: '30 ml' }, { id: 'b', title: '50 ml' }]), null);
  // Without a preference (a single product's card), still none.
  const product = { inStock: true, variants: textures.map((v) => ({ ...v, price: 51.9, inStock: true })) };
  assert.equal(cartVariant(product), null);
  assert.equal(cartVariant(product, variantPreference(choice, { skin_type: q('normal') })), 'n');
});

test('the dev store takes production\'s content where it has none, never over its own', () => {
  const prod = { short_description: 'Prod', active_ingredients: 'Actifs', usage_instructions: 'Usage', usage_advice: null, structured_facts: { metafields: { 'accentuate.results': { value: 'R' }, 'reviews.rating': { value: '{}' }, 'judgeme.widget': { value: '<div>' } } } };
  const patch = contentPatch({ short_description: 'Dev', active_ingredients: 'null', usage_instructions: null, structured_facts: { metafields: { 'global.title_tag': { value: 't' } } } }, prod);
  assert.equal(patch.short_description, undefined);
  assert.equal(patch.active_ingredients, 'Actifs');
  assert.equal(patch.usage_instructions, 'Usage');
  assert.deepEqual(Object.keys(patch.structured_facts.metafields).sort(), ['accentuate.results', 'global.title_tag', 'reviews.rating']);
  assert.deepEqual(contentPatch({ ...prod }, prod), {});
});

test('the routine code\'s rule is read on its own: its shop, its code, its rule only', async () => {
  const { createRoutineCodeReader, ROUTINE_CODE_COLUMNS } = await import('./shopping-repository.mjs');
  const calls = [];
  const read = createRoutineCodeReader({ async selectAll(table, filters, columns) {
    calls.push({ table, filters, columns });
    return table === 'shops' ? [{ id: 'shop-1' }] : [{ codes: [{ code: 'MAROUTINE20' }], status: 'ACTIVE', rule_snapshot: { customer_gets: { percentage: 0.2 } } }];
  } });
  const source = await read('x.myshopify.com', 'MAROUTINE20');
  assert.deepEqual(routineReward(source, 'MAROUTINE20'), { percentage: 20 });
  const promo = calls.find((c) => c.table === 'promotions');
  assert.equal(promo.filters.shop_id, 'shop-1');
  assert.deepEqual(promo.filters.codes, { operator: 'cs', value: '[{"code":"MAROUTINE20"}]' });
  assert.equal(promo.columns, ROUTINE_CODE_COLUMNS);
  // A code that is not one: nothing read.
  assert.equal((await read('x.myshopify.com', 'A,B')).status, 'unavailable');
  assert.equal(calls.length, 2);
});
