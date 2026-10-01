import assert from 'node:assert/strict';
import test from 'node:test';

import { MECHANICS, promotionMechanic, rewardIsFree } from './promotion-mechanic.mjs';

// Shapes taken from the live rows, 2026-10-01.
const row = (discount_type, extra = {}) => ({ discount_type, discount_classes: [], rule_snapshot: {}, ...extra });

test('free shipping, code or automatic', () => {
  assert.equal(promotionMechanic(row('DiscountAutomaticFreeShipping', { discount_classes: ['SHIPPING'] })), 'free_shipping');
  assert.equal(promotionMechanic(row('DiscountCodeFreeShipping')), 'free_shipping');
});

test('a buy-X-get-Y on a spend threshold is a gift; on a quantity it is a multi-buy', () => {
  const gift = row('DiscountAutomaticBxgy', { rule_snapshot: { customer_buys: { amount: '65.0' } } });
  const multi = row('DiscountAutomaticBxgy', { rule_snapshot: { customer_buys: { quantity: '3' } } });
  assert.equal(promotionMechanic(gift), 'gift');
  assert.equal(promotionMechanic(multi), 'multi_buy');
  assert.equal(promotionMechanic(row('DiscountAutomaticBxgy')), 'unknown');
});

test('a basic discount is order- or product-level by its Shopify class', () => {
  assert.equal(promotionMechanic(row('DiscountCodeBasic', { discount_classes: ['ORDER'] })), 'order_discount');
  assert.equal(promotionMechanic(row('DiscountCodeBasic', { discount_classes: ['PRODUCT'] })), 'product_discount');
  assert.equal(promotionMechanic(row('DiscountAutomaticBasic')), 'unknown');
});

test('app discounts are labelled as such, and anything unrecognised is unknown', () => {
  assert.equal(promotionMechanic(row('DiscountAutomaticApp')), 'app');
  assert.equal(promotionMechanic(row('DiscountSomethingNew')), 'unknown');
  assert.equal(promotionMechanic(null), 'unknown');
});

test('the title never decides', () => {
  const titled = row('DiscountCodeBasic', { title: 'Livraison offerte', discount_classes: ['ORDER'] });
  assert.equal(promotionMechanic(titled), 'order_discount');
});

test('every label is in the closed vocabulary', () => {
  for (const type of ['DiscountAutomaticFreeShipping', 'DiscountAutomaticBxgy', 'DiscountCodeBasic', 'DiscountCodeApp', 'X']) {
    assert.ok(MECHANICS.includes(promotionMechanic(row(type))));
  }
});

test('a reward is free at 100 %, partial below, and unknown when never synced', () => {
  const gets = (customer_gets) => row('DiscountAutomaticBxgy', { rule_snapshot: { customer_gets } });
  assert.equal(rewardIsFree(gets({ percentage: 1, quantity: 1 })), true);
  assert.equal(rewardIsFree(gets({ percentage: 0.5, quantity: 1 })), false);
  assert.equal(rewardIsFree(gets({ amount: '5.0' })), false);
  assert.equal(rewardIsFree(gets({ items: { scope: 'products' } })), null);
});
