import assert from 'node:assert/strict';
import test from 'node:test';

import { amountAboveConsumerCeiling, amountsIn, deriveBuyerType } from './trade-signals.mjs';

// The shop's own ceiling at the time of writing: p99 is €248.58 and the largest
// consumer order ever placed is €488.60.
const CEILING = 500;

test('French and ERP decimal marks both parse, because the mailbox carries both', () => {
  // BOTH OF THESE WERE GOT WRONG BEFORE THE RULE WAS PER-AMOUNT. Reading `.` as
  // a thousands separator turned €1,605.71 into €160,571 and invented four trade
  // customers; a stricter pattern then matched nothing at all.
  assert.deepEqual(amountsIn('un montant total de 1 901,93€'), [1901.93]);
  assert.deepEqual(amountsIn('06/08 1605.71€'), [1605.71]);
  assert.deepEqual(amountsIn('49,90 EUR'), [49.9]);
  assert.deepEqual(amountsIn('12 € pour la livraison'), [12]);
});

test('a reference number wearing a currency symbol is not money', () => {
  // « 8829,6201 » is two order references with a comma between them. Read as a
  // sum it produces an €8,829.62 order and a trade customer who does not exist.
  assert.deepEqual(amountsIn('commandes 8829,6201€ en retard'), []);
  assert.deepEqual(amountsIn('9793€'), [9793], 'a bare integer is still a plausible sum');
  assert.deepEqual(amountsIn('99999999999€'), [], 'above a million is a reference');
});

test('several amounts in one message all come back', () => {
  assert.deepEqual(amountsIn('j’ai payé 49,90€ puis 12,00€ de port'), [49.9, 12]);
});

test('no money, no amounts', () => {
  for (const text of ['', null, undefined, 'bonjour, où est ma commande ?', '2026', '30 jours']) {
    assert.deepEqual(amountsIn(text), [], String(text));
  }
});

test('the ceiling reports the largest amount over it, or nothing', () => {
  assert.equal(amountAboveConsumerCeiling('un montant total de 1 901,93€', CEILING), 1901.93);
  assert.equal(amountAboveConsumerCeiling('j’ai payé 49,90€', CEILING), null);
  assert.equal(amountAboveConsumerCeiling('120€ puis 1 545,78€', CEILING), 1545.78);
});

test('a threshold that was never set disables the signal rather than firing it', () => {
  // A parameter starts undecided, and `deriveBuyerType` must not read "no
  // ceiling configured" as "every amount is above it".
  for (const threshold of [null, undefined, 0, NaN]) {
    assert.equal(amountAboveConsumerCeiling('un montant de 1 901,93€', threshold), null, String(threshold));
  }
});

// --- the finding --------------------------------------------------------------

test('an amount far above what this shop sells to consumers means trade', () => {
  // The four real ones: a pharmacy, a company, an invoice reminder, and the
  // €1,901.93 « facture définitive » against an order Shopify never held.
  assert.equal(deriveBuyerType({ namedAmountOverCeiling: 1901.93 }), 'trade');
  assert.equal(deriveBuyerType({ namedAmountOverCeiling: 1545.78, orderFound: false }), 'trade');
});

test('a missing order is NOT a trade signal, and that is the whole guard', () => {
  // The tempting inference and the wrong one. A mistyped reference, a guest
  // checkout, or a customer quoting the confirmation email all produce "not
  // found" — labelling those wholesale would misroute ordinary customers on the
  // strength of a typo. It stays `unknown`, and PA-30 asks for a number.
  assert.equal(deriveBuyerType({ orderFound: false }), 'unknown');
  assert.equal(deriveBuyerType({ orderFound: false, namedAmountOverCeiling: null }), 'unknown');
});

test('a confirmed order is what establishes a consumer', () => {
  assert.equal(deriveBuyerType({ orderFound: true }), 'consumer');
});

test('an amount overrides a confirmed order, because a trade buyer can have both', () => {
  assert.equal(deriveBuyerType({ orderFound: true, namedAmountOverCeiling: 1605.71 }), 'trade');
});

test('nothing established is unknown, never a default of consumer', () => {
  assert.equal(deriveBuyerType({}), 'unknown');
  assert.equal(deriveBuyerType(), 'unknown');
});
