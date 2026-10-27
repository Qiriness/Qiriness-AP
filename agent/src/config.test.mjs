import assert from 'node:assert/strict';
import test from 'node:test';

import { loadAgentConfig } from './config.mjs';

const BASE = { SUPABASE_URL: 'https://db.test', SUPABASE_SECRET_KEY: 'k', SHOPIFY_STORE_DOMAIN: 'desk-shop.myshopify.com' };

test('the worker knows every dashboard shop, the desk shop first unless listed', () => {
  const alone = loadAgentConfig(BASE);
  assert.deepEqual(alone.dashboardShops, [{ slug: 'desk-shop', domain: 'desk-shop.myshopify.com', desk: true }]);
  const both = loadAgentConfig({ ...BASE, DASHBOARD_SHOPS: 'other-shop.myshopify.com' });
  assert.deepEqual(both.dashboardShops.map((shop) => shop.slug), ['desk-shop', 'other-shop']);
});
