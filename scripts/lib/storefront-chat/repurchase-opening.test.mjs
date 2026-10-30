import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLlmAgent } from './llm-agent.mjs';
import { purchaseItems } from './purchase-turn.mjs';
import { openingPromotion, promotionLabel, repurchaseFavourite, repurchaseText } from './repurchase-opening.mjs';
import { parseOpeningRequest } from './request-schema.mjs';
import { buildAdvisorKnowledge } from '../advisory/advisor-knowledge.mjs';
import { knowledgeIndex } from '../advisory/product-knowledge.mjs';

// OWNER, 2026-10-29: a signed-in customer opening the chat hears about their favourite product in its
// repurchase window (« something like 20 %, or 2 weeks »): creams, serums, lotions… first, sheet masks
// last; then bought most often, most recent, most expensive. On Qiriness's real sheet and settings.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const built = buildAdvisorKnowledge({ sheet: read('data/advisor/qiriness-knowledge.json'), settings: read('data/advisor/qiriness-routine-settings.json') });
const KNOWLEDGE = knowledgeIndex(built.products);
const PRICE = new Map(read('data/advisor/qiriness-knowledge.json').products.map((r) => [r.handle, Number(r.price) || 10]));
const SETTINGS = built.routines.repurchase_opening;
const CATALOGUE = {
  products: built.products.map((k, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, shopifyId: `gid://shopify/Product/${1000 + i}`, handle: k.handle, name: k.title ?? k.handle, inStock: true, priceFrom: PRICE.get(k.handle) ?? 10, variants: [{ price: PRICE.get(k.handle) ?? 10 }], collections: [], tags: [] })),
  collections: [],
};
const NOW = new Date('2026-10-29T12:00:00Z');
const product = (handle) => CATALOGUE.products.find((p) => p.handle === handle);
const weeks = (handle) => KNOWLEDGE.get(handle).usage_weeks;
const daysAgo = (days) => new Date(NOW.getTime() - days * 86400000).toISOString().slice(0, 10);
const line = (handle, days, over = {}) => ({ product_id: product(handle).shopifyId, title: product(handle).name, first_purchased_on: daysAgo(days + 200), last_purchased_on: daysAgo(days), times_purchased: 1, returned: false, free_gift: false, ...over });
const pick = (lines, catalogue = CATALOGUE) => repurchaseFavourite(purchaseItems({ products: lines }, catalogue), { catalogue, knowledge: KNOWLEDGE, settings: SETTINGS, now: NOW });

const CREAM = 'creme-anti-age-caresse-active-energie-lift'; // 16 weeks
const OTHER_CREAM = 'creme-de-jour-nuit-caresse-active-energie'; // 16 weeks
const SHEET_MASK = 'masque-anti-age-wrap-dor'; // 11 weeks
const SERUM = built.products.find((k) => k.functional_type === 'serum' && k.usage_weeks && k.status !== 'do_not_advise').handle;

test('the settings reach the routines: 20 % or 2 weeks, sheet masks last', () => {
  assert.equal(SETTINGS.window_share, 0.2);
  assert.equal(SETTINGS.window_days, 14);
  assert.equal(SETTINGS.window_after_share, 0.5);
  assert.equal(SETTINGS.type_order.at(-1), 'sheet_mask');
  assert.equal(weeks(CREAM), 16);
});

test('the window: from the interval less the larger of 20 % and 2 weeks, to 50 % of it after', () => {
  const days = weeks(CREAM) * 7; // 112 days: 20 % is 22.4 days, more than 14
  assert.equal(pick([line(CREAM, days)])?.handle, CREAM);
  assert.equal(pick([line(CREAM, days - 22)])?.handle, CREAM, 'three weeks early: about to run out');
  assert.equal(pick([line(CREAM, days - 30)]), null, 'too early');
  assert.equal(pick([line(CREAM, days + 30)])?.handle, CREAM, 'late');
  assert.equal(pick([line(CREAM, days * 1.5)])?.handle, CREAM, 'half an interval late');
  assert.equal(pick([line(CREAM, days * 1.5 + 1)]), null, 'too late');
  assert.equal(pick([line(CREAM, 730)]), null, 'two years later');
  assert.equal(pick([line(CREAM, 0)]), null, 'just bought');
  // A short interval: the two weeks are the wider margin.
  const mask = weeks(SHEET_MASK) * 7;
  assert.equal(pick([line(SHEET_MASK, mask - 14)])?.handle, SHEET_MASK);
  assert.equal(pick([line(SHEET_MASK, mask - 16)]), null);
});

test('the favourite: the type first (a cream before a sheet mask bought more), then bought most, then most recent, then dearer', () => {
  const at = (h) => weeks(h) * 7;
  assert.equal(pick([line(SHEET_MASK, at(SHEET_MASK), { times_purchased: 6 }), line(CREAM, at(CREAM))]).handle, CREAM);
  assert.equal(pick([line(SERUM, at(SERUM), { times_purchased: 5 }), line(CREAM, at(CREAM))]).handle, CREAM);
  assert.equal(pick([line(CREAM, at(CREAM)), line(OTHER_CREAM, at(OTHER_CREAM), { times_purchased: 3 })]).handle, OTHER_CREAM);
  assert.equal(pick([line(CREAM, at(CREAM) + 5), line(OTHER_CREAM, at(OTHER_CREAM) - 5)]).handle, OTHER_CREAM, 'the more recent');
  const same = [line(CREAM, at(CREAM)), line(OTHER_CREAM, at(OTHER_CREAM))];
  assert.equal(pick(same).handle, product(CREAM).priceFrom > product(OTHER_CREAM).priceFrom ? CREAM : OTHER_CREAM, 'the dearer');
});

test('never a free line, a return, a product out of stock, an accessory or a kit', () => {
  const days = weeks(CREAM) * 7;
  assert.equal(pick([line(CREAM, days, { free_gift: true })]), null);
  assert.equal(pick([line(CREAM, days, { returned: true })]), null);
  const soldOut = { ...CATALOGUE, products: CATALOGUE.products.map((p) => (p.handle === CREAM ? { ...p, inStock: false } : p)) };
  assert.equal(pick([line(CREAM, days)], soldOut), null);
  const accessory = built.products.find((k) => k.functional_type === 'tool' && k.usage_weeks);
  if (accessory) assert.equal(pick([line(accessory.handle, accessory.usage_weeks * 7)]), null, accessory.handle);
  const kit = built.products.find((k) => ['kit', 'coffret'].includes(k.functional_type) && k.usage_weeks);
  if (kit) assert.equal(pick([line(kit.handle, kit.usage_weeks * 7)]), null, kit.handle);
});

test('the owner\'s sentence, FR and EN: the days in bold, the offer by its reward only when there is one', () => {
  assert.equal(repurchaseText('Crème X', 'fr', { days: 112 }), 'Nous avons remarqué que vous aviez déjà apprécié « Crème X ». Cela fait maintenant **112 jours** que vous ne l’avez pas commandé. Souhaitez-vous en reprendre ?');
  assert.match(repurchaseText('Crème X', 'fr', { days: 112, promo: '20 %' }), /Souhaitez-vous en reprendre \? On a même une promo de 20 % sur ce produit en ce moment\.$/);
  assert.match(repurchaseText('Crème X', 'en-GB', { days: 112 }), /enjoyed Crème X before\. It has now been \*\*112 days\*\* since you last ordered it\. Would you like to get it again\?$/);
  assert.match(repurchaseText('Crème X', 'en', { days: 3, promo: '20%' }), /We even have 20% off this product right now\.$/);
});

test('the offer mentioned: automatic, a percentage or an amount off, no minimum and no « buy X »', () => {
  const off = (over) => ({ type: 'automatic', reward: { percentage: 20, amount: null }, minimum: null, requires: null, ...over });
  assert.ok(openingPromotion([off()]));
  assert.equal(openingPromotion([off({ type: 'code' })]), null, 'a code would have to be named');
  assert.equal(openingPromotion([off({ minimum: { type: 'subtotal', amount: 65 } })]), null);
  assert.equal(openingPromotion([off({ requires: { quantity: 2 } })]), null);
  assert.equal(openingPromotion([off({ reward: { percentage: null, amount: null } })]), null, 'a gift is not « X off »');
  assert.equal(promotionLabel(off(), null, 'fr'), '20 %');
  assert.equal(promotionLabel(off({ reward: { percentage: null, amount: 5 } }), (n) => `${n},00 €`, 'fr'), '5,00 €');
});

test('the agent: one sentence and its card from code, no model call; nothing without purchases or in the window', async () => {
  const calls = [];
  const client = { async completeWithTools(args) { calls.push(args); throw new Error('no model call expected'); } };
  const agent = createLlmAgent({ client, company: { name: 'Qiriness' }, catalogue: CATALOGUE, productKnowledge: KNOWLEDGE, repurchaseOpening: SETTINGS });
  const days = Math.round((NOW.getTime() - Date.now()) / 86400000) + weeks(CREAM) * 7; // the agent uses today
  for (const [locale, words] of [['fr', /\*\*112 jours\*\*.*Souhaitez-vous en reprendre \?$/], ['en', /\*\*112 days\*\*.*get it again\?$/]]) {
    const r = await agent.opening({ purchases: async () => ({ products: [line(CREAM, days)] }), locale });
    assert.match(r.text, words, 'the days; no offer read: no promotion sentence');
    assert.deepEqual(r.products.map((c) => c.id), [product(CREAM).id]);
    // The cart question's buttons, and its state: « Oui » or a typed « oui » adds the cream.
    assert.deepEqual(r.choices.map((c) => c.value), ['flow:cart:yes', 'flow:cart:no']);
    assert.deepEqual(r.advisor.flow.cart.pending.map((x) => x.id), [product(CREAM).id]);
  }
  assert.equal(await agent.opening({ purchases: async () => null, locale: 'fr' }), null);
  assert.equal(await agent.opening({ purchases: async () => ({ products: [line(CREAM, days - 60)] }), locale: 'fr' }), null);
  assert.equal(await agent.opening({ purchases: null, locale: 'fr' }), null, 'anonymous');
  assert.equal(await agent.opening({ purchases: async () => { throw new Error('read failed'); }, locale: 'fr' }), null);
  assert.equal(calls.length, 0);
});

test('the agent: an automatic offer on the product is said by its reward, never its name; a code is not said', async () => {
  const client = { async completeWithTools() { throw new Error('no model call expected'); } };
  const offer = { id: 'p1', title: 'Secret name', method: 'automatic', status: 'ACTIVE', describable_in_replies: true, offerable_in_replies: false, discount_type: 'DiscountAutomaticBasic', discount_classes: ['PRODUCT'], codes: [], rule_snapshot: { customer_gets: { percentage: 0.2, items: { scope: 'all' } } } };
  const make = (promotion) => createLlmAgent({ client, company: { name: 'Qiriness' }, catalogue: CATALOGUE, productKnowledge: KNOWLEDGE, repurchaseOpening: SETTINGS, readShopping: async () => ({ status: 'ok', promotions: [promotion], members: new Map() }) });
  const days = Math.round((NOW.getTime() - Date.now()) / 86400000) + weeks(CREAM) * 7;
  const visit = { purchases: async () => ({ products: [line(CREAM, days)] }), locale: 'fr', shopDomain: 'dev.myshopify.com' };
  const r = await make(offer).opening(visit);
  assert.match(r.text, /On a même une promo de 20 % sur ce produit en ce moment\.$/);
  assert.doesNotMatch(r.text, /Secret name/);
  assert.equal(r.trace.promotion_id, 'p1');
  const coded = await make({ ...offer, method: 'code', discount_type: 'DiscountCodeBasic', offerable_in_replies: true, codes: [{ code: 'X20' }] }).opening(visit);
  assert.doesNotMatch(coded.text, /promo/);
});

test('the opening request: a session token and the context, nothing else', () => {
  const r = parseOpeningRequest({ sessionId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', context: { locale: 'fr', loggedIn: true, email: 'x@y.z' } });
  assert.equal(r.sessionToken, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(r.context.locale, 'fr');
  assert.equal('email' in r.context, false);
  assert.equal(parseOpeningRequest({}).sessionToken, null);
  assert.throws(() => parseOpeningRequest([]));
});
