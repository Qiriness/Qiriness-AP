import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromotionLookup } from './promotion-lookup.mjs';

// `listActive` answers "quelles promos avez-vous ?", and it once answered it per
// REDEEM CODE. On the live shop that was 3619 entries and 259,874 characters in
// one tool result — seven times the model's whole per-minute token budget, which
// failed the investigation outright on a 284-character ticket.
//
// The tests below hold the two properties that fixed it: one entry per OFFER,
// and a bulk discount's per-customer codes never leaving the module.

/**
 * Stubs the transport, not the client — `supabaseSelectAll` builds a URL and
 * fetches it. The `Range` header must be honoured: it pages, and stops only on
 * an empty page, so a mock returning the same rows regardless loops forever.
 */
function stubFetch(getRows) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const from = Number(String(init?.headers?.Range || '0-999').split('-')[0]);
    const rows = from === 0 ? getRows() : [];
    return {
      ok: true,
      status: 200,
      async json() {
        return rows;
      },
      async text() {
        return JSON.stringify(rows);
      }
    };
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function bulkCodes(n, prefix = 'GEN') {
  return Array.from({ length: n }, (_, i) => ({ code: `${prefix}${i}`, usage_count: 0 }));
}

const ACTIVE = {
  id: 'p1',
  title: 'QIRINESS20',
  status: 'ACTIVE',
  summary: '20% off',
  codes: [{ code: 'QIRINESS20', usage_count: 3 }]
};

const BULK = {
  id: 'p2',
  title: 'Welcome bulk',
  status: 'ACTIVE',
  summary: '10% off',
  codes: bulkCodes(600)
};

/** A lookup over a fixed set of rows, plus the teardown for its fetch stub. */
function lookupOver(rows) {
  const restore = stubFetch(() => rows);
  const lookup = createPromotionLookup({
    supabase: { baseUrl: 'https://example.test/rest/v1', key: 'k' },
    shopId: 's1',
    logger: null
  });
  return { lookup, restore };
}

test('a bulk discount is one offer, not six hundred', async () => {
  // THE REGRESSION. Flattening per code is correct for `lookupPromotion`, which
  // needs per-code usage to answer "you have already used this one". Reusing it
  // here multiplied a 2-offer shop into 601 lines.
  const { lookup, restore } = lookupOver([ACTIVE, BULK]);
  try {
    const { promotions, total } = await lookup.listActive();
    assert.equal(promotions.length, 2);
    assert.equal(total, 2);
    assert.deepEqual(promotions.map((p) => p.title).sort(), ['QIRINESS20', 'Welcome bulk']);
  } finally { restore(); }
});

test("a bulk discount's codes never leave the module", async () => {
  // They are other customers' property: each is single-use and belongs to one
  // person. One turn from here is a drafted reply.
  const { lookup, restore } = lookupOver([BULK]);
  try {
    const { promotions } = await lookup.listActive();
    assert.equal(promotions[0].code, null, 'no code is named for a bulk discount');
    assert.equal(promotions[0].codeCount, 600, 'but how many exist is still reported');
    assert.ok(!JSON.stringify(promotions).includes('GEN0'), 'no generated code is carried');
  } finally { restore(); }
});

test('a single shared code is named, because that is what advertised looks like', async () => {
  const { lookup, restore } = lookupOver([ACTIVE]);
  try {
    const { promotions } = await lookup.listActive();
    assert.equal(promotions[0].code, 'QIRINESS20');
  } finally { restore(); }
});

test('the listing is bounded even when every offer is distinct', async () => {
  // The dedup is what fixes this shop; the cap is what stops a shop with
  // hundreds of genuinely distinct offers reproducing the failure another way.
  const many = Array.from({ length: 90 }, (_, i) => ({
    id: `p${i}`,
    title: `Offer ${i}`,
    status: 'ACTIVE',
    summary: 's',
    codes: []
  }));
  const { lookup, restore } = lookupOver(many);
  try {
    const { promotions, total, truncated } = await lookup.listActive();
    assert.equal(total, 90, 'the true count is still reported');
    assert.ok(promotions.length < 90, 'but the list is capped');
    assert.equal(truncated, true);
  } finally { restore(); }
});

test('inactive and out-of-window promotions are not listed', async () => {
  const now = new Date('2026-08-14T00:00:00Z');
  const rows = [
    ACTIVE,
    { ...ACTIVE, id: 'p3', title: 'EXPIRED', ends_at: '2026-01-01T00:00:00Z' },
    { ...ACTIVE, id: 'p4', title: 'FUTURE', starts_at: '2027-01-01T00:00:00Z' },
    { ...ACTIVE, id: 'p5', title: 'DISABLED', status: 'EXPIRED' }
  ];
  const { lookup, restore } = lookupOver(rows);
  try {
    const { promotions } = await lookup.listActive({ now });
    assert.deepEqual(promotions.map((p) => p.title), ['QIRINESS20']);
  } finally { restore(); }
});

test('refresh drops the row cache too, not only the flattened one', async () => {
  // Two caches now sit behind this module; clearing one would rebuild the
  // flattened list from stale rows.
  let rows = [ACTIVE];
  const restore = stubFetch(() => rows);
  try {
    const lookup = createPromotionLookup({
      supabase: { baseUrl: 'https://example.test/rest/v1', key: 'k' },
      shopId: 's1',
      logger: null
    });

    await lookup.listActive();
    rows = [ACTIVE, { ...ACTIVE, id: 'p9', title: 'NOUVEAU' }];
    lookup.refresh();

    const { promotions } = await lookup.listActive();
    assert.equal(promotions.length, 2, 'the second read saw the new row');
  } finally { restore(); }
});
