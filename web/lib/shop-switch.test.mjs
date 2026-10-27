import assert from 'node:assert/strict';
import test from 'node:test';

import { currentShop, isShopPage, navHref, switchHref } from './shop-switch.mjs';

const DESK = { slug: 'desk-shop', desk: true };
const OTHER = { slug: 'other-shop', desk: false };
const SHOPS = [DESK, OTHER];

test('only Insights and Settings are shop pages', () => {
  assert.equal(isShopPage('/insights'), true);
  assert.equal(isShopPage('/insights/sales'), true);
  assert.equal(isShopPage('/settings'), true);
  for (const path of ['/tickets', '/orders', '/orders/1', '/agent-setup', '/conversations', '/home', '/insightsx']) {
    assert.equal(isShopPage(path), false, path);
  }
});

test('a shop page shows the shop it names; every other page shows the desk shop', () => {
  assert.equal(currentShop('/insights/sales', 'other-shop', SHOPS), OTHER);
  assert.equal(currentShop('/settings', 'other-shop', SHOPS), OTHER);
  assert.equal(currentShop('/tickets', 'other-shop', SHOPS), DESK);
  assert.equal(currentShop('/insights/sales', 'not-served', SHOPS), DESK);
  assert.equal(currentShop('/insights/sales', null, []), null);
});

test('switching on Insights keeps the panel and period; a desk-only panel opens Overview', () => {
  assert.equal(switchHref({ pathname: '/insights/sales', search: 'shop=desk-shop&range=7d', target: OTHER }), '/insights/sales?shop=other-shop&range=7d');
  assert.equal(switchHref({ pathname: '/insights/support', search: 'shop=desk-shop', target: OTHER }), '/insights/overview?shop=other-shop');
  assert.equal(switchHref({ pathname: '/insights/support', search: 'shop=other-shop', target: DESK }), '/insights/support?shop=desk-shop');
});

test('switching on Settings keeps the tab, except the desk agents tabs', () => {
  assert.equal(switchHref({ pathname: '/settings', search: 'tab=integrations&shop=desk-shop', target: OTHER }), '/settings?tab=integrations&shop=other-shop');
  assert.equal(switchHref({ pathname: '/settings', search: 'tab=agents&shop=desk-shop', target: OTHER }), '/settings?shop=other-shop');
});

test('from a desk page, another shop opens its Insights and the desk shop stays put', () => {
  assert.equal(switchHref({ pathname: '/tickets', search: '', target: OTHER }), '/insights?shop=other-shop');
  assert.equal(switchHref({ pathname: '/tickets', search: '', target: DESK }), null);
});

test('nav links to the per-shop sections carry the shop on screen, and only with two shops', () => {
  assert.equal(navHref('/insights', OTHER, 2), '/insights?shop=other-shop');
  assert.equal(navHref('/settings', OTHER, 2), '/settings?shop=other-shop');
  assert.equal(navHref('/tickets', OTHER, 2), '/tickets');
  assert.equal(navHref('/insights', DESK, 1), '/insights');
});
