import assert from 'node:assert/strict';
import test from 'node:test';

import { advisorClientId, devStoreTarget } from './dev-store-config.mjs';

const ENV = {
  SHOPIFY_STORE_DOMAIN: 'prod-shop.myshopify.com',
  SHOPIFY_CLIENT_ID: 'prod-id',
  SHOPIFY_ADMIN_API_ACCESS_TOKEN: 'prod-token',
  STOREFRONT_CHAT_ALLOWED_SHOPS: 'dev-shop.myshopify.com',
  STOREFRONT_APP_CLIENT_ID: 'dev-id',
  STOREFRONT_APP_CLIENT_SECRET: 'dev-secret',
  APP_ENV: 'production'
};

test('the child runs against the dev store, with the advisor app, as development, without production\'s token', () => {
  const { domain, childEnv } = devStoreTarget(ENV);
  assert.equal(domain, 'dev-shop.myshopify.com');
  assert.equal(childEnv.SHOPIFY_STORE_DOMAIN, 'dev-shop.myshopify.com');
  assert.equal(childEnv.SHOPIFY_CLIENT_ID, 'dev-id');
  assert.equal(childEnv.SHOPIFY_CLIENT_SECRET, 'dev-secret');
  assert.equal(childEnv.SHOPIFY_ADMIN_API_ACCESS_TOKEN, '');
  assert.equal(childEnv.APP_ENV, 'development');
});

test('every guard refuses', () => {
  assert.throws(() => devStoreTarget({ ...ENV, STOREFRONT_CHAT_ALLOWED_SHOPS: '' }), /No dev store/);
  assert.throws(() => devStoreTarget({ ...ENV, STOREFRONT_DEV_STORE_DOMAIN: 'other.myshopify.com' }), /not in STOREFRONT_CHAT_ALLOWED_SHOPS/);
  assert.throws(() => devStoreTarget({ ...ENV, STOREFRONT_CHAT_ALLOWED_SHOPS: 'prod-shop.myshopify.com' }), /production store/);
  assert.throws(() => devStoreTarget({ ...ENV, STOREFRONT_APP_CLIENT_SECRET: '' }), /required/);
  assert.throws(() => devStoreTarget({ ...ENV, STOREFRONT_APP_CLIENT_ID: 'prod-id' }), /equal the production app/);
});

test('the advisor client id falls back to the advisor app toml', () => {
  assert.equal(advisorClientId({ STOREFRONT_APP_CLIENT_ID: 'from-env' }), 'from-env');
  assert.match(advisorClientId({}), /^[0-9a-f]{32}$/);
});
