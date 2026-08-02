import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCheckoutQuery,
  createAbandonedCheckoutLookup,
  normaliseCheckout
} from './abandoned-checkout.mjs';

const NODE = {
  id: 'gid://shopify/AbandonedCheckout/1',
  name: '#C1',
  createdAt: '2026-07-30T10:00:00Z',
  updatedAt: '2026-07-30T10:20:00Z',
  abandonedCheckoutUrl: 'https://shop.test/recover',
  discountCodes: ['UKLED20'],
  customer: { id: 'gid://shopify/Customer/9', email: 'Marie@Example.com' },
  subtotalPriceSet: { shopMoney: { amount: '42.50', currencyCode: 'EUR' } },
  totalPriceSet: { shopMoney: { amount: '48.50', currencyCode: 'EUR' } },
  totalDiscountSet: { shopMoney: { amount: '0.00', currencyCode: 'EUR' } },
  lineItems: {
    nodes: [
      {
        title: 'Crème Mains', variantTitle: '50ml', quantity: 2, sku: 'CM-50',
        product: { id: 'gid://shopify/Product/1', title: 'Crème Mains Velours' },
        originalTotalPriceSet: { shopMoney: { amount: '42.50' } },
        discountedTotalPriceWithCodeDiscount: { shopMoney: { amount: '42.50' } }
      }
    ]
  }
};

test('the filter is a date window, because there is no email filter', () => {
  // abandonedCheckouts(query:) supports only default/created_at/email_state/
  // id/recovery_state/status/updated_at. Matching the email client-side is the
  // only deterministic route.
  const q = buildCheckoutQuery({ since: '2026-07-01T00:00:00Z', until: '2026-08-01T00:00:00Z' });
  assert.equal(q, 'created_at:>=2026-07-01 created_at:<=2026-08-01');
  assert.equal(buildCheckoutQuery({}), null);
});

test('a checkout normalises to the shape the promotion checks consume', () => {
  const c = normaliseCheckout(NODE);
  assert.equal(c.subtotal, 42.5, 'a number, not a string');
  assert.equal(c.currency, 'EUR');
  assert.deepEqual(c.discountCodes, ['UKLED20']);
  assert.equal(c.lineItems[0].productTitle, 'Crème Mains Velours');
  assert.equal(c.lineItems[0].quantity, 2);
});

test('addresses are dropped, not merely unused', () => {
  // Fetched live into an AI-adjacent path; the question is what was in the
  // basket, and a street address answers neither part of it.
  const c = JSON.stringify(normaliseCheckout({ ...NODE, billingAddress: { address1: '1 rue X' } }));
  assert.doesNotMatch(c, /address|rue X/i);
});

test('an empty checkout does not throw', () => {
  assert.equal(normaliseCheckout(null), null);
  const bare = normaliseCheckout({ id: 'x' });
  assert.deepEqual(bare.lineItems, []);
  assert.equal(bare.subtotal, null);
});

function buildShopify(pages) {
  let call = 0;
  return {
    calls: () => call,
    async __graphql() {}
  };
}

test('the email is matched case-insensitively across pages', async () => {
  const pages = [
    { nodes: [{ ...NODE, id: 'a', customer: { email: 'other@example.com' } }], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
    { nodes: [NODE], pageInfo: { hasNextPage: false, endCursor: null } }
  ];
  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { abandonedCheckouts: pages[call++] } })
  });

  try {
    const find = createAbandonedCheckoutLookup({ shopify: { shopDomain: 's', accessToken: 't', apiVersion: 'v' } });
    const r = await find({ email: 'marie@EXAMPLE.com', since: '2026-07-01' });
    assert.equal(r.found, true);
    assert.equal(r.checkout.id, NODE.id);
    assert.equal(call, 2, 'walked to the second page');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('no email means no call at all', async () => {
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({ data: {} }) }; };
  try {
    const find = createAbandonedCheckoutLookup({ shopify: {} });
    const r = await find({ email: '   ' });
    assert.equal(r.found, false);
    assert.equal(r.reason, 'no_email');
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('paging is bounded so a support lookup cannot walk the whole history', async () => {
  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    call += 1;
    return {
      ok: true,
      json: async () => ({
        data: { abandonedCheckouts: { nodes: [{ ...NODE, customer: { email: 'nobody@example.com' } }], pageInfo: { hasNextPage: true, endCursor: 'c' } } }
      })
    };
  };
  try {
    const find = createAbandonedCheckoutLookup({ shopify: {} });
    const r = await find({ email: 'marie@example.com', since: '2020-01-01', maxPages: 3 });
    assert.equal(r.found, false);
    assert.equal(r.reason, 'no_match');
    assert.equal(call, 3, 'stopped at maxPages');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the pre-discount subtotal is reconstructed, because Shopify reports it net', () => {
  // Real numbers from a live abandoned checkout: lines totalled 244.30,
  // totalDiscount 24.43, and subtotalPriceSet came back 219.87. Measuring a
  // minimum requirement against 219.87 would tell a qualifying customer they
  // were 20 € short.
  const c = normaliseCheckout(NODE);
  assert.equal(c.subtotal, 42.5);
  assert.equal(c.subtotalBeforeDiscount, 42.5, 'no discount here, so the same');

  const discounted = normaliseCheckout({
    ...NODE,
    subtotalPriceSet: { shopMoney: { amount: '219.87', currencyCode: 'EUR' } },
    totalDiscountSet: { shopMoney: { amount: '24.43', currencyCode: 'EUR' } },
    lineItems: { nodes: [{ ...NODE.lineItems.nodes[0], originalTotalPriceSet: { shopMoney: { amount: '244.30' } } }] }
  });
  assert.equal(discounted.subtotal, 219.87);
  assert.equal(discounted.subtotalBeforeDiscount, 244.3);
});

test('it falls back to subtotal + discount when line items are missing', () => {
  const c = normaliseCheckout({
    id: 'x',
    subtotalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'EUR' } },
    totalDiscountSet: { shopMoney: { amount: '10.00', currencyCode: 'EUR' } }
  });
  assert.equal(c.subtotalBeforeDiscount, 110);
});

test('updatedAt is carried, because the record is mutated in place', () => {
  // Observed live: one id went from ["QIRINESS10"] / 1 item / 219.87 to [] /
  // 2 items / 82.25 with createdAt unchanged. The record is a snapshot of now,
  // not a log of the attempt.
  const c = normaliseCheckout(NODE);
  assert.equal(c.createdAt, '2026-07-30T10:00:00Z');
  assert.equal(c.updatedAt, '2026-07-30T10:20:00Z');
});
