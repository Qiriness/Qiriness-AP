import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from './lib/sync-config.mjs';
import { runNightlySync } from './sync-shopify-nightly.mjs';

const BASE_ENV = {
  SHOPIFY_STORE_DOMAIN: 'qiriness-dev.myshopify.com',
  SHOPIFY_CLIENT_ID: 'client-id',
  SHOPIFY_CLIENT_SECRET: 'client-secret',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'supabase-secret'
};

test('loadConfig defaults nightly schedule to 02:00 Europe/London', () => {
  const config = loadConfig(BASE_ENV);

  assert.equal(config.syncCron, '0 2 * * *');
  assert.equal(config.syncTimezone, 'Europe/London');
});

test('loadConfig allows nightly schedule overrides', () => {
  const config = loadConfig({
    ...BASE_ENV,
    SYNC_CRON: '30 1 * * *',
    SYNC_TIMEZONE: 'Europe/Paris'
  });

  assert.equal(config.syncCron, '30 1 * * *');
  assert.equal(config.syncTimezone, 'Europe/Paris');
});

test('runNightlySync runs customers, orders, products, promotions, content catalog, collections, storefront months, then Klaviyo', async () => {
  const order = [];
  const result = await runNightlySync({
    args: { dryRun: false },
    config: {},
    shopify: {},
    supabase: {},
    shopRow: { id: 'shop-id', shop_domain: 'qiriness-dev.myshopify.com' },
    syncedAt: '2026-07-20T02:00:00Z',
    integrationEventId: 'event-id',
    runners: {
      customers: async () => {
        order.push('customers');
        return { customers: 10, deletedCustomers: 1 };
      },
      orders: async () => {
        order.push('orders');
        return { orders: 12, deletedExpiredOrders: 2 };
      },
      products: async () => {
        order.push('products');
        return { products: 20, linkedMetaobjects: 2, targetMetaobjects: 3 };
      },
      promotions: async () => {
        order.push('promotions');
        return { discounts: 6, promotions: 8, deletedPromotions: 1 };
      },
      contentCatalog: async () => {
        order.push('contentCatalog');
        return { sources: 16, deletedSources: 1 };
      },
      collections: async () => {
        order.push('collections');
        return { total: 175, refreshed: 6, products: 60 };
      },
      storefrontMonths: async () => {
        order.push('storefrontMonths');
        return { months: 36, restated: 0 };
      },
      klaviyo: async () => {
        order.push('klaviyo');
        return { flow_days: 40, campaigns: 3, backfill: false };
      }
    }
  });

  // Collections last, and after products: a collection's membership is checked
  // against a catalogue the product pass has just refreshed.
  assert.deepEqual(order, [
    'customers',
    'orders',
    'products',
    'promotions',
    'contentCatalog',
    'collections',
    'storefrontMonths',
    'klaviyo'
  ]);
  assert.deepEqual(result, {
    customers: 10,
    deleted_customers: 1,
    orders: 12,
    deleted_expired_orders: 2,
    products: 20,
    linked_metaobjects: 2,
    target_metaobjects: 3,
    discounts: 6,
    promotions: 8,
    deleted_promotions: 1,
    shopify_content_sources: 16,
    deleted_shopify_content_sources: 1,
    collections: 175,
    active_collections_refreshed: 6,
    collection_memberships: 60,
    storefront_session_months: 36,
    storefront_months_restated: 0,
    storefront_months_error: null,
    klaviyo_flow_days: 40,
    klaviyo_campaigns: 3,
    klaviyo_skipped: null,
    klaviyo_error: null
  });
});

test('a failed storefront-months step is recorded, and does not fail the night', async () => {
  const ok = async () => ({});
  const result = await runNightlySync({
    args: { dryRun: false },
    config: {},
    shopify: {},
    supabase: {},
    shopRow: { id: 'shop-id' },
    syncedAt: '2026-07-20T02:00:00Z',
    runners: {
      customers: ok,
      orders: ok,
      products: ok,
      promotions: ok,
      contentCatalog: ok,
      collections: ok,
      storefrontMonths: async () => {
        throw new Error('ShopifyQL did not answer within 300s');
      },
      klaviyo: async () => {
        throw new Error('Klaviyo GET /metrics/ failed: HTTP 401');
      }
    }
  });
  assert.equal(result.storefront_months_error, 'ShopifyQL did not answer within 300s');
  assert.equal(result.storefront_session_months, null);
  assert.equal(result.klaviyo_error, 'Klaviyo GET /metrics/ failed: HTTP 401');
});
