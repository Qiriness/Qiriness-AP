import test from 'node:test';
import assert from 'node:assert/strict';

import cartContract from '../../../extensions/storefront-advisor/assets/advisor-cart.js';
import { applyAdds, cartFromFixture, customerView, describeCart, emptyCart, judgePrompt, parseIds, planRuns, sheetRow } from './stress-plan.mjs';

const t = (id, extra = {}) => ({ row: id - 99, id, priority: 'P0', category: 'c', objective: 'o', mode: '', scenario: '', turn: '', message: `m${id}`, criterion: `crit ${id}`, setup: 'Nouveau chat', truth: '', source: '', ...extra });
const CATALOGUE = {
  products: [
    { id: 'db-1', shopifyId: 'gid://shopify/Product/1', handle: 'wrap', name: 'Wrap Hyal-Aqua', variants: [{ id: 'gid://shopify/ProductVariant/11', title: null, price: 5.9 }] },
    { id: 'db-2', shopifyId: 'gid://shopify/Product/2', handle: 'creme', name: 'Crème Lift', variants: [{ id: 'gid://shopify/ProductVariant/21', title: '50 ml', price: 71.9 }] }
  ]
};

test('planRuns: a standalone test is its own run, a scenario runs up to the wanted turn in order', () => {
  const tests = [t(101), t(102), t(272, { scenario: 'A', turn: 2 }), t(271, { scenario: 'A', turn: 1 }), t(273, { scenario: 'A', turn: 3 })];
  assert.deepEqual(planRuns(tests, new Set([102, 272])).map((r) => [r.key, r.tests.map((x) => x.id)]), [['102', [102]], ['A', [271, 272]]]);
  assert.deepEqual(planRuns(tests, null).map((r) => r.tests.length), [1, 1, 3]);
  assert.deepEqual(planRuns(tests, new Set([999])), []);
});

test('parseIds: lists and ranges; anything else is refused', () => {
  assert.deepEqual([...parseIds('101, 108-110')], [101, 108, 109, 110]);
  assert.throws(() => parseIds('101,abc'));
});

test('the baskets the runner sends are ones the widget contract accepts', () => {
  assert.ok(cartContract.normalizeSnapshot(emptyCart()));
  const cart = cartFromFixture([{ handle: 'wrap', quantity: 2 }, { handle: 'creme' }], CATALOGUE);
  assert.ok(cartContract.normalizeSnapshot(cart), 'fixture basket rejected by normalizeSnapshot');
  assert.equal(cart.subtotal, 590 * 2 + 7190);
  assert.throws(() => cartFromFixture([{ handle: 'missing' }], CATALOGUE), /not in the live catalogue/);
  assert.equal(describeCart(emptyCart()), 'vide');
});

test('applyAdds: the widget adds one unit per line, merges a variant already there, skips the unknown', () => {
  const start = cartFromFixture([{ handle: 'wrap' }], CATALOGUE);
  const next = applyAdds(start, [
    { product_id: 'gid://shopify/Product/1', variant_id: 'gid://shopify/ProductVariant/11' },
    { product_id: 'gid://shopify/Product/2', variant_id: 'gid://shopify/ProductVariant/21' },
    { product_id: 'gid://shopify/Product/9', variant_id: 'gid://shopify/ProductVariant/99' }
  ], CATALOGUE);
  assert.deepEqual(next.lines.map((l) => [l.productName, l.quantity]), [['Wrap Hyal-Aqua', 2], ['Crème Lift', 1]]);
  assert.ok(cartContract.normalizeSnapshot(next));
  assert.equal(start.lines[0].quantity, 1, 'the earlier basket is not changed');
  assert.equal(applyAdds(start, undefined, CATALOGUE), start);
});

test('customerView shows what the customer sees: text, cards, buttons, follow-up, contact, cart add', () => {
  const view = customerView({
    text: 'Voici.', products: [{ title: 'Crème Lift', url: '/products/creme', price: '71,90 €', variantId: 'v' }],
    choices: [{ label: 'Oui', value: 'yes' }], followUp: { text: 'Une routine ?', products: [], choices: [] },
    contact: { url: '/pages/contact' }, cart: { add: [{ product_id: 'gid://shopify/Product/2', variant_id: 'x' }], needs_size: [] }
  }, (id) => CATALOGUE.products.find((p) => p.shopifyId === id)?.name);
  for (const part of ['Voici.', '[carte] Crème Lift — 71,90 € — /products/creme', '« Oui »', '[message suivant] Une routine ?', '/pages/contact', 'widget] Crème Lift']) assert.ok(view.includes(part), part);
  assert.equal(customerView(null), '(aucune réponse)');
});

test('judgePrompt: the turn judged is last, the earlier turns are context, the facts are included', () => {
  const prompt = judgePrompt({ test: t(272), transcript: [{ message: 'un', view: 'r1' }, { message: 'deux', view: 'r2' }], setup: 'réel', facts: 'CATALOGUE' });
  assert.ok(prompt.indexOf('Cliente (1) : un') < prompt.indexOf('MESSAGE DE LA CLIENTE : deux'));
  assert.ok(prompt.includes('CRITÈRE DE RÉUSSITE : crit 272') && prompt.includes('CATALOGUE') && prompt.includes('ÉTAT RÉEL DU TEST : réel'));
});

test('sheetRow: a turn not sent is Bloqué, not a failure; a failure always has a type', () => {
  const blocked = sheetRow({ test: t(101), view: null, seconds: null, verdict: null, error: 'HTTP 429 daily_limit', sessionId: null, date: '2026-11-02' });
  assert.equal(blocked.result, 'Bloqué');
  assert.match(blocked.notes, /daily_limit/);
  const failed = sheetRow({ test: t(101), view: 'x', seconds: 2.1, verdict: { verdict: 'Échec', failure_type: '', reason: 'r', human_check: '' }, error: null, sessionId: 's', date: 'd' });
  assert.deepEqual([failed.result, failed.failure_type, failed.ttft, failed.total], ['Échec', 'Autre', 2.1, 2.1]);
  const passed = sheetRow({ test: t(101), view: 'x', seconds: 1, verdict: { verdict: 'Réussi', failure_type: 'Prix/Promo', reason: 'ok', human_check: 'voir panier' }, error: null, sessionId: 's', date: 'd' });
  assert.equal(passed.failure_type, '');
  assert.match(passed.notes, /À vérifier à la main\] voir panier/);
});
