import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  processComplianceWebhook,
  verifyShopifyWebhookHmac
} from './shopify-compliance-webhooks.mjs';

test('verifyShopifyWebhookHmac accepts valid raw body signatures', () => {
  const rawBody = Buffer.from(JSON.stringify({ ok: true }));
  const secret = 'webhook-secret';
  const hmac = createHmac('sha256', secret).update(rawBody).digest('base64');

  assert.equal(
    verifyShopifyWebhookHmac(rawBody, { 'X-Shopify-Hmac-SHA256': hmac }, secret),
    true
  );
  assert.equal(
    verifyShopifyWebhookHmac(rawBody, { 'X-Shopify-Hmac-SHA256': 'wrong' }, secret),
    false
  );
});

test('processComplianceWebhook hard deletes matching customer rows idempotently', async () => {
  const rawBody = Buffer.from(JSON.stringify({
    shop_id: 123,
    shop_domain: 'qiriness-dev.myshopify.com',
    customer: {
      id: 191167,
      email: 'jane@example.com',
      phone: '+33123456789'
    },
    orders_to_redact: [1, 2]
  }));
  const hmac = createHmac('sha256', 'webhook-secret').update(rawBody).digest('base64');
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });

    if (options.method === 'GET' && String(url).includes('/shops?')) {
      return jsonResponse([{ id: 'shop-id', shop_domain: 'qiriness-dev.myshopify.com', shopify_shop_id: '123' }]);
    }
    if (options.method === 'GET' && String(url).includes('/integration_events?')) {
      return jsonResponse([]);
    }
    if (options.method === 'POST' && String(url).includes('/integration_events?')) {
      return jsonResponse([{ id: 'event-id', event_key: 'shopify-webhook:webhook-1', status: 'processing' }]);
    }
    if (options.method === 'POST' && String(url).includes('/privacy_requests?')) {
      return jsonResponse([{ id: 'privacy-id', request_key: 'shopify-webhook:webhook-1' }]);
    }
    if (options.method === 'GET' && String(url).includes('/customers?')) {
      return jsonResponse([
        { id: 'customer-row-id', legacy_resource_id: '191167', email: 'jane@example.com', phone: '+33123456789' }
      ]);
    }
    if (options.method === 'DELETE' && String(url).includes('/customers?')) {
      return jsonResponse([{ id: 'customer-row-id' }]);
    }
    if (options.method === 'PATCH') {
      return jsonResponse([{ id: 'updated-row-id' }]);
    }

    throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
  };

  try {
    const result = await processComplianceWebhook({
      rawBody,
      headers: {
        'x-shopify-topic': 'customers/redact',
        'x-shopify-shop-domain': 'qiriness-dev.myshopify.com',
        'x-shopify-webhook-id': 'webhook-1',
        'x-shopify-hmac-sha256': hmac
      },
      config: { shopifyWebhookSecret: 'webhook-secret' },
      supabase: { baseUrl: 'https://example.supabase.co/rest/v1', key: 'test-key' }
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.deleted_customer_count, 1);
    assert.equal(
      requests.some((request) => request.options.method === 'DELETE' && request.url.includes('/customers?')),
      true
    );
    assert.equal(
      requests.every((request) => !JSON.stringify(request).includes('jane@example.com')),
      true
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('processComplianceWebhook skips completed duplicate deliveries', async () => {
  const rawBody = Buffer.from(JSON.stringify({
    shop_id: 123,
    shop_domain: 'qiriness-dev.myshopify.com',
    customer: { id: 191167 }
  }));
  const hmac = createHmac('sha256', 'webhook-secret').update(rawBody).digest('base64');
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });

    if (options.method === 'GET' && String(url).includes('/shops?')) {
      return jsonResponse([{ id: 'shop-id', shop_domain: 'qiriness-dev.myshopify.com', shopify_shop_id: '123' }]);
    }
    if (options.method === 'GET' && String(url).includes('/integration_events?')) {
      return jsonResponse([{ id: 'event-id', event_key: 'shopify-webhook:webhook-duplicate', status: 'completed' }]);
    }

    throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
  };

  try {
    const result = await processComplianceWebhook({
      rawBody,
      headers: {
        'x-shopify-topic': 'customers/redact',
        'x-shopify-shop-domain': 'qiriness-dev.myshopify.com',
        'x-shopify-webhook-id': 'webhook-duplicate',
        'x-shopify-hmac-sha256': hmac
      },
      config: { shopifyWebhookSecret: 'webhook-secret' },
      supabase: { baseUrl: 'https://example.supabase.co/rest/v1', key: 'test-key' }
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, 'duplicate');
    assert.equal(
      requests.some((request) => request.options.method === 'DELETE'),
      false
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(payload) {
  return {
    ok: true,
    json: async () => payload
  };
}
