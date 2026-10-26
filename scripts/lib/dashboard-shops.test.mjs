import assert from 'node:assert/strict';
import test from 'node:test';

import { dashboardShops, defaultShop, shopForDomain, shopForSlug } from './dashboard-shops.mjs';

const desk = { SHOPIFY_STORE_DOMAIN: 'qiriness.myshopify.com' };

test('unset, the dashboard serves the desk shop alone, as before', () => {
  assert.deepEqual(dashboardShops(desk), [{ slug: 'qiriness', domain: 'qiriness.myshopify.com', desk: true }]);
});

test('the listed shops, in order; the desk shop is marked and added first if left out', () => {
  assert.deepEqual(dashboardShops({ ...desk, DASHBOARD_SHOPS: 'qiriness.myshopify.com, barbara-gould.myshopify.com' }).map((s) => [s.slug, s.desk]), [
    ['qiriness', true],
    ['barbara-gould', false]
  ]);
  assert.deepEqual(dashboardShops({ ...desk, DASHBOARD_SHOPS: 'barbara-gould.myshopify.com' }).map((s) => s.slug), ['qiriness', 'barbara-gould']);
  assert.deepEqual(dashboardShops({ ...desk, DASHBOARD_SHOPS: 'barbara-gould.myshopify.com,qiriness.myshopify.com' }).map((s) => s.slug), ['barbara-gould', 'qiriness']);
});

test('malformed and duplicate entries are dropped; case and a scheme are tolerated', () => {
  const shops = dashboardShops({ ...desk, DASHBOARD_SHOPS: 'HTTPS://Barbara-Gould.myshopify.com/,evil.com,barbara-gould.myshopify.com,,qiriness.myshopify.com' });
  assert.deepEqual(shops.map((s) => s.domain), ['barbara-gould.myshopify.com', 'qiriness.myshopify.com']);
});

test('a slug or a domain resolves only to a shop the dashboard serves', () => {
  const env = { ...desk, DASHBOARD_SHOPS: 'qiriness.myshopify.com,barbara-gould.myshopify.com' };
  assert.equal(shopForSlug('barbara-gould', env).domain, 'barbara-gould.myshopify.com');
  assert.equal(shopForSlug('BARBARA-GOULD', env).slug, 'barbara-gould');
  assert.equal(shopForSlug('other', env), null);
  assert.equal(shopForSlug('', env), null);
  assert.equal(shopForDomain('Barbara-Gould.myshopify.com', env).slug, 'barbara-gould');
  assert.equal(shopForDomain('other.myshopify.com', env), null);
});

test('Insights opens on the shop last looked at, if it is still served', () => {
  const env = { ...desk, DASHBOARD_SHOPS: 'qiriness.myshopify.com,barbara-gould.myshopify.com' };
  assert.equal(defaultShop('barbara-gould', env).slug, 'barbara-gould');
  assert.equal(defaultShop('gone', env).slug, 'qiriness');
  assert.equal(defaultShop(undefined, env).slug, 'qiriness');
});
