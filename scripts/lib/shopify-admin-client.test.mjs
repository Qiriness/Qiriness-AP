import assert from 'node:assert/strict';
import test from 'node:test';

import { PRODUCT_MAX_PAGE_SIZE, fetchProductPage } from './shopify-admin-client.mjs';

// --- product page size --------------------------------------------------------
//
// Shopify prices a query before running it and refuses anything over 1000 points.
// The product query is the expensive one — 25 variants, 100 metafields and 10
// references per node — so the shared `--page-size` cannot be passed through to
// it the way it is to customers and orders. Measured on 2026-09-12: 30 passed,
// 40 and 50 came back `Query cost is 1003`, a hard rejection that no retry fixes.

test('fetchProductPage never asks for more products than the cost limit allows', async () => {
  const { sent, restore } = stubFetch();
  try {
    await fetchProductPage(client(), { pageSize: 50 }, null);
  } finally {
    restore();
  }

  assert.equal(sent[0].variables.first, PRODUCT_MAX_PAGE_SIZE);
});

test('fetchProductPage leaves a page size below the cap alone', async () => {
  // The cap is a ceiling, not a default: a dry run asking for 5 still gets 5.
  const { sent, restore } = stubFetch();
  try {
    await fetchProductPage(client(), { pageSize: 5 }, null);
  } finally {
    restore();
  }

  assert.equal(sent[0].variables.first, 5);
});

test('the product cap leaves room under the 1000-point ceiling', () => {
  // 30 was the largest page the live shop accepted. The cap sits below it because
  // the cost is set by the nested `first` values, not by the data: raising
  // PRODUCT_METAFIELD_PAGE_SIZE would make 30 the next rejection.
  assert.ok(PRODUCT_MAX_PAGE_SIZE < 30, 'must stay under the measured failure point');
});

function client() {
  return { endpoint: 'https://example.myshopify.com/admin/api/2026-07/graphql.json', token: 'test-token' };
}

function stubFetch() {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ data: { products: { nodes: [], pageInfo: {} } } }) };
  };
  return { sent, restore: () => { globalThis.fetch = original; } };
}
