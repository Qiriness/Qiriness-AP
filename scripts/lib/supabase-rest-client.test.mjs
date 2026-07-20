import assert from 'node:assert/strict';
import test from 'node:test';

import { supabaseInsert, supabaseUpsert } from './supabase-rest-client.mjs';

test('supabaseUpsert normalizes bulk rows with missing optional keys', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    requests.push(options);
    return {
      ok: true,
      json: async () => []
    };
  };

  try {
    await supabaseUpsert(
      { baseUrl: 'https://example.supabase.co/rest/v1', key: 'test-key' },
      'customers',
      [
        { shop_id: 'shop-1', shopify_customer_id: 'customer-1', email: 'a@example.com' },
        { shop_id: 'shop-1', shopify_customer_id: 'customer-2' }
      ],
      'shop_id,shopify_customer_id'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const rows = JSON.parse(requests[0].body);
  assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(rows[1]).sort());
  assert.equal(rows[1].email, null);
});

test('supabaseInsert normalizes bulk rows with missing optional keys', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    requests.push(options);
    return {
      ok: true,
      json: async () => []
    };
  };

  try {
    await supabaseInsert(
      { baseUrl: 'https://example.supabase.co/rest/v1', key: 'test-key' },
      'events',
      [
        { id: 'event-1', payload: {} },
        { id: 'event-2' }
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const rows = JSON.parse(requests[0].body);
  assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(rows[1]).sort());
  assert.equal(rows[1].payload, null);
});
