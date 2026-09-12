import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORDER_TOPICS,
  isStale,
  orderIdFromPayload,
  processOrderWebhook
} from './shopify-order-webhooks.mjs';

// --- payload reading ----------------------------------------------------------

test('a refund payload gives up the order id, not the refund id', () => {
  // The trap this exists for: `id` on a refunds/create body is the REFUND. Read
  // it as an order and the fetch finds nothing, and the handler reports a clean
  // skip — a failure that looks exactly like success.
  assert.equal(orderIdFromPayload('refunds/create', { id: 555, order_id: 6997 }), '6997');
  assert.equal(orderIdFromPayload('orders/updated', { id: 6997 }), '6997');
});

test('a payload with no usable id is refused rather than guessed at', () => {
  assert.equal(orderIdFromPayload('orders/updated', {}), null);
  assert.equal(orderIdFromPayload('refunds/create', { id: 555 }), null);
  assert.equal(orderIdFromPayload('orders/updated', { id: '' }), null);
});

// --- the ordering guard -------------------------------------------------------

test('an order older than what is stored is stale', () => {
  assert.equal(isStale('2026-09-12T10:00:00Z', '2026-09-12T11:00:00Z'), true);
  assert.equal(isStale('2026-09-12T11:00:00Z', '2026-09-12T10:00:00Z'), false);
});

test('an order equal to what is stored is not stale, so a retry still writes', () => {
  // Equal timestamps are the ordinary case for a Shopify retry. Treating them as
  // stale would make the idempotency guard the only thing that can ever finish a
  // redelivery, and a row that failed halfway would never be repaired.
  assert.equal(isStale('2026-09-12T10:00:00Z', '2026-09-12T10:00:00Z'), false);
});

test('nothing stored means nothing to be stale against', () => {
  assert.equal(isStale('2026-09-12T10:00:00Z', null), false);
  assert.equal(isStale('2026-09-12T10:00:00Z', undefined), false);
  assert.equal(isStale('not a date', '2026-09-12T10:00:00Z'), false);
});

// --- the handler --------------------------------------------------------------

test('an unsigned request is refused and writes nothing at all', async () => {
  const { requests, restore } = stubWorld();
  try {
    const result = await processOrderWebhook({
      ...baseArgs(),
      verifyHmac: () => false
    });
    assert.equal(result.statusCode, 401);
  } finally {
    restore();
  }

  // The point is the second assertion: an audit table anyone can fill is not an
  // audit table.
  assert.equal(requests.length, 0, 'a forged request must not create rows');
});

test('an unknown topic is refused before any row is created', async () => {
  const { requests, restore } = stubWorld();
  try {
    const result = await processOrderWebhook({
      ...baseArgs({ headers: { ...headers(), 'x-shopify-topic': 'products/update' } }),
      verifyHmac: () => true
    });
    assert.equal(result.statusCode, 400);
    assert.match(result.body.error, /Unsupported order topic/);
  } finally {
    restore();
  }
  assert.equal(requests.length, 0);
});

test('a shop we do not have answers 200, because retrying cannot fix it', async () => {
  const { restore } = stubWorld({ shop: null });
  try {
    const result = await processOrderWebhook({ ...baseArgs(), verifyHmac: () => true });
    // A non-2xx would buy 48 hours of retries for a delivery that can never land.
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, 'unknown_shop');
  } finally {
    restore();
  }
});

test('a redelivered webhook is acknowledged without doing the work twice', async () => {
  const { requests, restore } = stubWorld({
    existingEvent: { id: 'event-1', status: 'completed' }
  });
  try {
    const result = await processOrderWebhook({ ...baseArgs(), verifyHmac: () => true });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, 'duplicate');
  } finally {
    restore();
  }

  assert.equal(
    requests.filter((r) => r.url.includes('/orders?') && r.options.method === 'POST').length,
    0,
    'the order must not be written a second time'
  );
});

test('a signed webhook re-reads the order and upserts it', async () => {
  const { requests, restore } = stubWorld();
  let result;
  try {
    result = await processOrderWebhook({ ...baseArgs(), verifyHmac: () => true });
  } finally {
    restore();
  }

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, 'ok');

  // It asked Shopify for the order rather than trusting the body it was handed.
  const graphql = requests.find((r) => r.url.includes('/graphql.json'));
  assert.ok(graphql, 'the order must be re-read from Shopify');
  assert.match(JSON.parse(graphql.options.body).variables.query, /id:6997/);

  const upsert = requests.find((r) => r.url.includes('/orders?') && r.options.method === 'POST');
  assert.ok(upsert, 'the order must be written');
  const [row] = JSON.parse(upsert.options.body);
  assert.equal(row.shopify_order_id, 'gid://shopify/Order/6997');
  assert.equal(row.name, '#6997');
});

test('the handler works when headers arrive as a Headers object, not a plain one', async () => {
  // THE SHAPE PRODUCTION ACTUALLY SENDS. A Route Handler passes `request.headers`,
  // a `Headers` instance with no own enumerable properties. Every test above uses
  // a plain object, and that gap is exactly how a route that 401s every real
  // delivery passed a green suite on 2026-09-12.
  const { requests, restore } = stubWorld();
  let result;
  try {
    result = await processOrderWebhook({
      ...baseArgs({ headers: new Headers(headers()) }),
      verifyHmac: () => true
    });
  } finally {
    restore();
  }

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, 'ok', 'the topic and shop domain must be readable from a Headers');
  assert.ok(requests.some((r) => r.url.includes('/orders?') && r.options.method === 'POST'));
});

test('an order we already hold a newer copy of is skipped, not overwritten', async () => {
  const { requests, restore } = stubWorld({ storedUpdatedAt: '2026-09-12T18:00:00Z' });
  let result;
  try {
    result = await processOrderWebhook({ ...baseArgs(), verifyHmac: () => true });
  } finally {
    restore();
  }

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, 'stale');
  assert.equal(
    requests.filter((r) => r.url.includes('/orders?') && r.options.method === 'POST').length,
    0,
    'fresher data must not be replaced by older data'
  );
});

test('an order Shopify will not return is skipped with 200, not retried forever', async () => {
  const { restore } = stubWorld({ order: null });
  try {
    const result = await processOrderWebhook({ ...baseArgs(), verifyHmac: () => true });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, 'not_found');
  } finally {
    restore();
  }
});

test('a failure Shopify can retry answers 500 and records itself', async () => {
  const { requests, restore } = stubWorld({ failUpsert: true });
  let result;
  try {
    result = await processOrderWebhook({ ...baseArgs(), verifyHmac: () => true });
  } finally {
    restore();
  }

  assert.equal(result.statusCode, 500);
  const patches = requests.filter(
    (r) => r.url.includes('/integration_events?') && r.options.method === 'PATCH'
  );
  const last = JSON.parse(patches[patches.length - 1].options.body);
  assert.equal(last.status, 'failed', 'a failed webhook must not be left on processing');
});

test('every declared topic is one the id reader understands', () => {
  for (const topic of ORDER_TOPICS) {
    const payload = topic === 'refunds/create' ? { id: 1, order_id: 6997 } : { id: 6997 };
    assert.equal(orderIdFromPayload(topic, payload), '6997', `${topic} must yield an order id`);
  }
});

// --- harness ------------------------------------------------------------------

function headers() {
  return {
    'x-shopify-topic': 'orders/updated',
    'x-shopify-shop-domain': 'qiriness.myshopify.com',
    'x-shopify-webhook-id': 'webhook-1',
    'x-shopify-hmac-sha256': 'signature'
  };
}

function baseArgs(overrides = {}) {
  return {
    rawBody: Buffer.from(JSON.stringify({ id: 6997 })),
    headers: headers(),
    config: { shopifyWebhookSecret: 'secret' },
    supabase: { baseUrl: 'https://example.supabase.co/rest/v1', key: 'test-key' },
    shopify: { endpoint: 'https://qiriness.myshopify.com/admin/api/2026-07/graphql.json', token: 't' },
    now: new Date('2026-09-12T12:00:00Z'),
    ...overrides
  };
}

function stubWorld({
  shop = { id: 'shop-1', shop_domain: 'qiriness.myshopify.com' },
  existingEvent = null,
  order = {
    id: 'gid://shopify/Order/6997',
    legacyResourceId: '6997',
    name: '#6997',
    number: 6997,
    updatedAt: '2026-09-12T11:48:36Z',
    createdAt: '2026-09-12T11:48:36Z',
    currencyCode: 'EUR',
    customer: null,
    lineItems: { nodes: [] },
    fulfillments: [],
    refunds: [],
    returns: { nodes: [] }
  },
  storedUpdatedAt = null,
  failUpsert = false
} = {}) {
  const requests = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    requests.push({ url: href, options });
    const method = options.method || 'GET';

    if (href.includes('/graphql.json')) {
      return json({ data: { orders: { nodes: order ? [order] : [], pageInfo: {} } } });
    }
    if (href.includes('/shops?')) {
      return json(shop ? [shop] : []);
    }
    if (href.includes('/integration_events?')) {
      if (method === 'GET') return json(existingEvent ? [existingEvent] : []);
      if (method === 'POST') return json([{ id: 'event-1', status: 'processing' }]);
      return json([{ id: 'event-1' }]);
    }
    if (href.includes('/customers?')) {
      return json([]);
    }
    if (href.includes('/orders?')) {
      if (method === 'GET') {
        return json(storedUpdatedAt ? [{ shopify_updated_at: storedUpdatedAt }] : []);
      }
      if (failUpsert) {
        return { ok: false, status: 500, json: async () => ({ message: 'upstream exploded' }) };
      }
      return json([{ id: 'order-row' }]);
    }
    if (href.includes('/data_access_events?')) {
      return json([{ id: 'access-1' }]);
    }
    return json([]);
  };

  return { requests, restore: () => { globalThis.fetch = original; } };
}

function json(payload) {
  return { ok: true, status: 200, json: async () => payload };
}
