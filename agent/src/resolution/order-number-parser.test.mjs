import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOrderCandidates, shopifyOrderCandidates, toOrderName } from './order-number-parser.mjs';

test('the real phrasings customers use are all caught', () => {
  // Verbatim shapes from the corpus.
  const cases = [
    ['Bonjour j’a passé une commande #4854 mais elle n’est pas complète', 4854],
    ['ma commande n° 3985 du 12 mai', 3985],
    ['commande 5281 toujours pas reçue', 5281],
    ['URGENT - Commande #6216 du 27 juin 2026', 6216],
    ['J’ai reçu ce jour ma commande 6045', 6045]
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(shopifyOrderCandidates(text).map((c) => c.orderNumber), [expected], text);
  }
});

test('a bare number is never a candidate', () => {
  // French support mail is full of four-digit numbers that are not orders.
  for (const text of [
    'je vous ai écrit en 2026',
    'mon code postal est 75011',
    'le prix était de 1250 euros',
    'j’ai commandé 2x50ml'
  ]) {
    assert.deepEqual(shopifyOrderCandidates(text), [], text);
  }
});

test('the internal Q00 reference is classified, not silently dropped', () => {
  // 911 occurrences in the corpus, and never a Shopify order. Failing to match
  // one must not look like "we could not find your order".
  const found = parseOrderCandidates('Pourrais-tu vérifier la commande Q00 26200111 ?');
  const erp = found.find((c) => c.format === 'internal_erp');
  assert.ok(erp, 'Q00 recognised');
  assert.equal(erp.orderNumber, null, 'never offered as a Shopify number');
  assert.deepEqual(shopifyOrderCandidates('la commande Q00 26200111'), []);
});

test('other internal references are recognised too', () => {
  for (const raw of ['CL 59088', 'FA015974', 'DS251105']) {
    const found = parseOrderCandidates(`référence ${raw} en pièce jointe`);
    assert.ok(found.some((c) => c.format === 'internal_other'), raw);
  }
});

test('several distinct numbers all come back, in the order written', () => {
  const found = shopifyOrderCandidates('mes commandes #4854 et #6216 sont incomplètes');
  assert.deepEqual(found.map((c) => c.orderNumber), [4854, 6216]);
});

test('the same number written twice is returned once', () => {
  const found = shopifyOrderCandidates('la commande #4854 — je répète, #4854');
  assert.equal(found.length, 1);
});

test('empty or absent text does not throw', () => {
  for (const value of [null, undefined, '', '   ']) {
    assert.deepEqual(shopifyOrderCandidates(value), []);
  }
});

test('the display form matches orders.name', () => {
  assert.equal(toOrderName(1006), '#1006');
  assert.equal(toOrderName(null), null);
});

test('long order numbers are parsed, because stores keep counting', () => {
  // The bug this covers: a {3,6} cap would silently stop parsing the day the
  // store passed 999,999 orders, and the failure would read as "we cannot find
  // your order" rather than as a bug. Length is not evidence — the database
  // decides what is an order.
  for (const [text, expected] of [
    ['ma commande #1234567 est incomplète', 1234567],
    ['commande n° 98765432 du 3 mai', 98765432],
    ['#4854', 4854]
  ]) {
    assert.deepEqual(shopifyOrderCandidates(text).map((c) => c.orderNumber), [expected], text);
  }
});

test('an implausibly long run of digits is still not swallowed', () => {
  // A sanity ceiling against phone numbers, not a claim about order sizes.
  assert.deepEqual(shopifyOrderCandidates('appelez le #33612345678901234'), []);
});
