import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISCOUNT_TOPICS,
  discountNodeIdFromPayload,
  processDiscountWebhook,
  readCompleteDiscount
} from './shopify-discount-webhooks.mjs';

const NODE_ID = 'gid://shopify/DiscountCodeNode/1234';

// --- payload reading ----------------------------------------------------------

test('the discount node gid is read from admin_graphql_api_id', () => {
  assert.equal(discountNodeIdFromPayload({ admin_graphql_api_id: NODE_ID }), NODE_ID);
  assert.equal(
    discountNodeIdFromPayload({ admin_graphql_api_id: 'gid://shopify/DiscountAutomaticNode/9' }),
    'gid://shopify/DiscountAutomaticNode/9'
  );
});

test('a payload without a discount gid is refused rather than guessed at', () => {
  // A bare numeric id cannot say whether it is a code or an automatic node.
  assert.equal(discountNodeIdFromPayload({ id: 1234 }), null);
  assert.equal(discountNodeIdFromPayload({ admin_graphql_api_id: 'gid://shopify/Order/1' }), null);
  assert.equal(discountNodeIdFromPayload(null), null);
});

test('only create, update and delete are subscribed — never the per-code topics', () => {
  assert.deepEqual([...DISCOUNT_TOPICS].sort(), ['discounts/create', 'discounts/delete', 'discounts/update']);
});

// --- the handler --------------------------------------------------------------

test('an unsigned request is refused and writes nothing', async () => {
  const { requests, restore } = stubWorld();
  try {
    const result = await processDiscountWebhook({ ...baseArgs(), verifyHmac: () => false });
    assert.equal(result.statusCode, 401);
  } finally {
    restore();
  }
  assert.equal(requests.length, 0);
});

test('an unknown topic is refused before any row is created', async () => {
  const { requests, restore } = stubWorld();
  try {
    const result = await processDiscountWebhook({
      ...baseArgs({ headers: headers({ 'x-shopify-topic': 'discounts/redeemcode_added' }) }),
      verifyHmac: () => true
    });
    assert.equal(result.statusCode, 400);
  } finally {
    restore();
  }
  assert.equal(requests.length, 0);
});

test('a signed update re-reads the discount and upserts the mapped row', async () => {
  const { requests, restore } = stubWorld();
  const reads = [];
  let result;
  try {
    result = await processDiscountWebhook({
      ...baseArgs({ headers: new Headers(headers()) }),
      verifyHmac: () => true,
      readDiscount: async (_shopify, id) => { reads.push(id); return discountNode(); }
    });
  } finally {
    restore();
  }

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, 'ok');
  assert.deepEqual(reads, [NODE_ID], 'the discount must be re-read, not taken from the payload');

  const upsert = requests.find((r) => r.url.includes('/promotions?') && r.options.method === 'POST');
  assert.ok(upsert, 'the promotion must be written');
  const [row] = JSON.parse(upsert.options.body);
  assert.equal(row.promotion_key, NODE_ID);
  assert.equal(row.method, 'code');
  assert.deepEqual(row.codes.map((c) => c.code), ['WELCOME10']);
  // The operator's switches are local and must survive the write.
  assert.equal('offerable_in_replies' in row, false);
  assert.equal('describable_in_replies' in row, false);
});

test('a delete removes the row without asking Shopify for it', async () => {
  const { requests, restore } = stubWorld();
  let read = false;
  let result;
  try {
    result = await processDiscountWebhook({
      ...baseArgs({ headers: headers({ 'x-shopify-topic': 'discounts/delete' }) }),
      verifyHmac: () => true,
      readDiscount: async () => { read = true; return null; }
    });
  } finally {
    restore();
  }

  assert.equal(result.body.status, 'deleted');
  assert.equal(read, false);
  const del = requests.find((r) => r.url.includes('/promotions?') && r.options.method === 'DELETE');
  assert.ok(del, 'the promotion must be deleted');
  assert.match(decodeURIComponent(del.url), /promotion_key=eq\.gid:\/\/shopify\/DiscountCodeNode\/1234/);
  assert.match(del.url, /shop_id=eq\.shop-1/);
});

test('an update for a discount Shopify no longer has is treated as a delete', async () => {
  const { requests, restore } = stubWorld();
  try {
    const result = await processDiscountWebhook({
      ...baseArgs(), verifyHmac: () => true, readDiscount: async () => null
    });
    assert.equal(result.body.status, 'deleted');
  } finally {
    restore();
  }
  assert.ok(requests.some((r) => r.url.includes('/promotions?') && r.options.method === 'DELETE'));
});

test('a discount older than the stored copy is skipped, not written over it', async () => {
  const { requests, restore } = stubWorld({ storedUpdatedAt: '2026-11-02T12:00:00Z' });
  try {
    const result = await processDiscountWebhook({
      ...baseArgs(), verifyHmac: () => true, readDiscount: async () => discountNode()
    });
    assert.equal(result.body.status, 'stale');
  } finally {
    restore();
  }
  assert.equal(requests.filter((r) => r.url.includes('/promotions?') && r.options.method === 'POST').length, 0);
});

test('a redelivered webhook is acknowledged without doing the work twice', async () => {
  const { requests, restore } = stubWorld({ existingEvent: { id: 'event-1', status: 'completed' } });
  try {
    const result = await processDiscountWebhook({
      ...baseArgs(), verifyHmac: () => true, readDiscount: async () => discountNode()
    });
    assert.equal(result.body.status, 'duplicate');
  } finally {
    restore();
  }
  assert.equal(requests.filter((r) => r.url.includes('/promotions?')).length, 0);
});

test('a failure Shopify can retry answers 500 and records itself as failed', async () => {
  const { requests, restore } = stubWorld();
  try {
    const result = await processDiscountWebhook({
      ...baseArgs(), verifyHmac: () => true, readDiscount: async () => { throw new Error('Throttled'); }
    });
    assert.equal(result.statusCode, 500);
  } finally {
    restore();
  }
  const patches = requests.filter((r) => r.url.includes('/integration_events?') && r.options.method === 'PATCH');
  assert.equal(JSON.parse(patches.at(-1).options.body).status, 'failed');
});

test('readCompleteDiscount asks for the one node and completes its code pages', async () => {
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (body.query.includes('query DiscountNode(')) {
      const node = discountNode();
      node.discount.codes.pageInfo = { hasNextPage: true, endCursor: 'c1' };
      return json({ data: { discountNode: node } });
    }
    return json({ data: { discountNode: { id: NODE_ID, discount: { codes: {
      nodes: [{ id: 'code-2', code: 'WELCOME11', asyncUsageCount: 0 }],
      pageInfo: { hasNextPage: false, endCursor: null }
    } } } } });
  };
  let node;
  try {
    node = await readCompleteDiscount(shopifyClient(), NODE_ID);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(bodies[0].variables.id, NODE_ID);
  assert.deepEqual(node.discount.codes.nodes.map((c) => c.code), ['WELCOME10', 'WELCOME11']);
});

// --- harness ------------------------------------------------------------------

function headers(overrides = {}) {
  return {
    'x-shopify-topic': 'discounts/update',
    'x-shopify-shop-domain': 'qiriness.myshopify.com',
    'x-shopify-webhook-id': 'webhook-d1',
    'x-shopify-hmac-sha256': 'signature',
    ...overrides
  };
}

function shopifyClient() {
  return { endpoint: 'https://qiriness.myshopify.com/admin/api/2026-07/graphql.json', token: 't', accessToken: 't' };
}

function baseArgs(overrides = {}) {
  return {
    rawBody: Buffer.from(JSON.stringify({ admin_graphql_api_id: NODE_ID, title: 'Welcome', status: 'ACTIVE' })),
    headers: headers(),
    config: { shopifyWebhookSecret: 'secret' },
    supabase: { baseUrl: 'https://example.supabase.co/rest/v1', key: 'test-key' },
    shopify: shopifyClient(),
    now: new Date('2026-11-02T10:00:00Z'),
    ...overrides
  };
}

function discountNode() {
  return {
    id: NODE_ID,
    discount: {
      __typename: 'DiscountCodeBasic',
      title: 'Welcome 10',
      status: 'ACTIVE',
      startsAt: '2026-11-01T00:00:00Z',
      endsAt: null,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-02T09:59:00Z',
      discountClasses: ['ORDER'],
      combinesWith: { orderDiscounts: false, productDiscounts: true, shippingDiscounts: true },
      codes: { nodes: [{ id: 'code-1', code: 'WELCOME10', asyncUsageCount: 3 }], pageInfo: { hasNextPage: false, endCursor: null } },
      customerGets: { value: { percentage: 0.1 }, items: { allItems: true } }
    }
  };
}

function stubWorld({ existingEvent = null, storedUpdatedAt = null } = {}) {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    requests.push({ url: href, options });
    const method = options.method || 'GET';
    if (href.includes('/shops?')) return json([{ id: 'shop-1', shop_domain: 'qiriness.myshopify.com' }]);
    if (href.includes('/integration_events?')) {
      if (method === 'GET') return json(existingEvent ? [existingEvent] : []);
      if (method === 'POST') return json([{ id: 'event-1', status: 'processing' }]);
      return json([{ id: 'event-1' }]);
    }
    if (href.includes('/promotions?') && method === 'GET') {
      return json(storedUpdatedAt ? [{ shopify_updated_at: storedUpdatedAt }] : []);
    }
    return json([]);
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

function json(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}
