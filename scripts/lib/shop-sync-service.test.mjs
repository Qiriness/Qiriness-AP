import assert from 'node:assert/strict';
import test from 'node:test';

import { syncShop } from './shop-sync-service.mjs';
import { readRetentionPolicy } from './order-retention.mjs';

const CONFIG = { shopDomain: 'qiriness.myshopify.com', appEnv: 'production' };
const SHOP = {
  id: 'gid://shopify/Shop/1',
  name: 'Qiriness',
  myshopifyDomain: 'qiriness.myshopify.com',
  primaryDomain: { url: 'https://qiriness.com' }
};

/**
 * The stored row carries columns `mapShop` never sends — the ones that are ours
 * rather than Shopify's.
 */
const STORED = {
  id: 'shop-uuid-1',
  shop_domain: 'qiriness.myshopify.com',
  order_retention_mode: 'indefinite',
  order_retention_months: null,
  order_retention_reason: 'set by migration 10'
};

function fakeSupabase(stored = STORED) {
  const calls = { upserts: 0, selects: 0 };
  return {
    calls,
    client: {
      baseUrl: 'https://example.supabase.co/rest/v1',
      // Same shape `createSupabaseClient` returns. The test stubs global fetch
      // rather than the REST module, so the client's own header and error
      // handling still runs against these.
      key: 'sb_secret_test',
      stored
    }
  };
}

/** Stub `fetch` so the REST client's own request/response handling still runs. */
function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => { globalThis.fetch = original; });
}

/**
 * A PostgREST-shaped 200.
 *
 * RANGE-AWARE ON PURPOSE. `supabaseSelectAll` pages until a request returns an
 * EMPTY array -- a stub that answers every page with the same row loops for
 * ever, which is exactly what the first version of this file did. A real
 * PostgREST honours the Range header and runs out; this does the same.
 */
const ok = (body) => async (_url, init) => {
  const range = init?.headers?.Range;
  const firstPage = !range || range.startsWith('0-');
  return new Response(JSON.stringify(firstPage ? body : []), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

test('a real run returns the STORED row, not the payload it just sent', async () => {
  // THE BUG THIS PINS. `mapShop` omits order_retention_mode, so returning the
  // mapped payload handed callers a shop with no retention setting. The orders
  // sync read that as "unset", resolved to the 6-month fallback, and would have
  // purged order history the shop is configured to keep indefinitely.
  await withFetch(
    ok([STORED]),
    async () => {
      const { client } = fakeSupabase();
      const row = await syncShop({ args: { dryRun: false }, config: CONFIG, supabase: client, shop: SHOP });

      assert.equal(row.id, 'shop-uuid-1');
      assert.equal(row.order_retention_mode, 'indefinite');
      assert.equal(readRetentionPolicy(row).mode, 'indefinite');
    }
  );
});

test('mapped values still win over the stored ones', async () => {
  // The stored row is the base so local columns survive; what this run just
  // wrote sits on top, or a sync would report the previous values back.
  await withFetch(
    ok([{ ...STORED, shop_name: 'Old Name' }]),
    async () => {
      const { client } = fakeSupabase();
      const row = await syncShop({ args: { dryRun: false }, config: CONFIG, supabase: client, shop: SHOP });

      assert.equal(row.shop_name, 'Qiriness');
      assert.equal(row.order_retention_mode, 'indefinite', 'the local column must survive');
    }
  );
});

test('an upsert that returns no id still throws', async () => {
  await withFetch(
    ok([]),
    async () => {
      const { client } = fakeSupabase();
      await assert.rejects(
        syncShop({ args: { dryRun: false }, config: CONFIG, supabase: client, shop: SHOP }),
        /did not return a shop id/
      );
    }
  );
});

// --- the dry run has to tell the truth ---------------------------------------

test('a dry run reads the stored settings rather than reporting defaults', async () => {
  // A dry run exists to report what a real run WOULD do, and the settings that
  // decide that live on the row. Reporting the fallback while the shop is set to
  // something else makes it actively misleading -- which is how the bug above
  // was found: the dry run said "kept for 6 months" on a shop set to indefinite.
  await withFetch(
    ok([STORED]),
    async () => {
      const { client } = fakeSupabase();
      const row = await syncShop({ args: { dryRun: true }, config: CONFIG, supabase: client, shop: SHOP });

      assert.equal(readRetentionPolicy(row).mode, 'indefinite');
    }
  );
});

test('a dry run against a shop that does not exist yet still works', async () => {
  // A normal state on a first run, and it must not throw.
  await withFetch(
    ok([]),
    async () => {
      const { client } = fakeSupabase();
      const row = await syncShop({ args: { dryRun: true }, config: CONFIG, supabase: client, shop: SHOP });

      assert.equal(row.shop_domain, 'qiriness.myshopify.com');
    }
  );
});

test('a dry run survives an unreadable shops table', async () => {
  // 403 rather than 500 on purpose: `supabaseFetch` retries 5xx and 429 with
  // exponential backoff, so a 500 here would make the suite sit through the real
  // retry schedule to assert something about the fallback, not about retrying.
  await withFetch(
    async () => new Response('nope', { status: 403 }),
    async () => {
      const { client } = fakeSupabase();
      const row = await syncShop({ args: { dryRun: true }, config: CONFIG, supabase: client, shop: SHOP });

      // Falls back to the mapped payload, which reads as the safe default.
      assert.equal(readRetentionPolicy(row).mode, 'months');
    }
  );
});
