import assert from 'node:assert/strict';
import test from 'node:test';

import { readStockByShopifyIds, stockOfAll } from './stock-by-id.mjs';

const A = 'gid://shopify/Product/9001';
const B = 'gid://shopify/Product/9002';

/** Stubs the transport; `Range` must be honoured or `supabaseSelectAll` pages for ever. */
function stubProducts(rows) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const from = Number(String(init?.headers?.Range || '0-999').split('-')[0]);
    const page = from === 0 ? rows : [];
    return { ok: true, status: 200, async json() { return page; }, async text() { return JSON.stringify(page); } };
  };
  return () => { globalThis.fetch = original; };
}

const supabase = { baseUrl: 'https://example.test/rest/v1', key: 'k' };

test('a sample is read like any product: active with units is sendable, -1, archived or deleted is not', async () => {
  const restore = stubProducts([
    { shopify_product_id: A, title: 'BB Crème Medium - échantillon', status: 'active', available_stock: 755, deleted_at: null },
    { shopify_product_id: B, title: 'BB Crème Light - échantillons', status: 'active', available_stock: -1, deleted_at: null }
  ]);
  try {
    const products = await readStockByShopifyIds(supabase, 's1', [A, B, A]);
    assert.deepEqual(products, [
      { id: A, title: 'BB Crème Medium - échantillon', purchasable: true },
      { id: B, title: 'BB Crème Light - échantillons', purchasable: false }
    ]);
  } finally { restore(); }

  const gone = stubProducts([
    { shopify_product_id: A, title: 'x', status: 'archived', available_stock: 50, deleted_at: null },
    { shopify_product_id: B, title: 'y', status: 'active', available_stock: 50, deleted_at: '2026-09-01T00:00:00Z' }
  ]);
  try {
    const products = await readStockByShopifyIds(supabase, 's1', [A, B]);
    assert.deepEqual(products.map((p) => p.purchasable), [false, false]);
  } finally { gone(); }
});

test('no ids reads nothing', async () => {
  assert.deepEqual(await readStockByShopifyIds(supabase, 's1', []), []);
});

test('all, some or none sendable; nothing to send; a missing row is unknown', () => {
  assert.equal(stockOfAll([A, B], [{ id: A, purchasable: true }, { id: B, purchasable: true }]), 'in_stock');
  assert.equal(stockOfAll([A, B], [{ id: A, purchasable: true }, { id: B, purchasable: false }]), 'partial');
  assert.equal(stockOfAll([A], [{ id: A, purchasable: false }]), 'out_of_stock');
  assert.equal(stockOfAll([], []), 'none');
  assert.equal(stockOfAll(null, []), 'unknown');
  assert.equal(stockOfAll([A, B], [{ id: A, purchasable: true }]), 'unknown');
});
