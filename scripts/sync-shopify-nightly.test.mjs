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

test('runNightlySync runs customers, orders, products, then knowledge', async () => {
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
      knowledge: async () => {
        order.push('knowledge');
        return { documents: 4, chunks: 8, unresolvedSources: 0 };
      }
    }
  });

  assert.deepEqual(order, ['customers', 'orders', 'products', 'knowledge']);
  assert.deepEqual(result, {
    customers: 10,
    deleted_customers: 1,
    orders: 12,
    deleted_expired_orders: 2,
    products: 20,
    linked_metaobjects: 2,
    target_metaobjects: 3,
    knowledge_documents: 4,
    knowledge_chunks: 8,
    unresolved_knowledge_sources: 0
  });
});
