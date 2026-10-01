import assert from 'node:assert/strict';
import test from 'node:test';

import { mapPromotionRows } from './shopify-promotion-mapper.mjs';

test('mapPromotionRows maps code discounts with appliesOncePerCustomer true', () => {
  const [row] = mapPromotionRows(codeDiscountNode({
    appliesOncePerCustomer: true,
    status: 'ACTIVE',
    code: 'WELCOME10',
    codeUsageCount: 2
  }), 'shop-id', '2026-07-20T00:00:00Z');

  assert.equal(row.method, 'code');
  assert.deepEqual(row.codes.map((c) => c.code), ['WELCOME10']);
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.applies_once_per_customer, true);
  // usage is PER CODE now, and lives inside the array.
  assert.equal(row.codes[0].usage_count, 2);
});

test('mapPromotionRows maps code discounts with appliesOncePerCustomer false', () => {
  const [row] = mapPromotionRows(codeDiscountNode({
    appliesOncePerCustomer: false,
    status: 'SCHEDULED',
    code: 'SUMMER20'
  }), 'shop-id', '2026-07-20T00:00:00Z');

  assert.equal(row.applies_once_per_customer, false);
  assert.equal(row.status, 'SCHEDULED');
});

test('mapPromotionRows keeps expired promotions', () => {
  const [row] = mapPromotionRows(codeDiscountNode({
    appliesOncePerCustomer: true,
    status: 'EXPIRED',
    code: 'OLD10'
  }), 'shop-id', '2026-07-20T00:00:00Z');

  assert.equal(row.status, 'EXPIRED');
  assert.deepEqual(row.codes.map((c) => c.code), ['OLD10']);
});

test('mapPromotionRows maps automatic discounts with null code', () => {
  const [row] = mapPromotionRows({
    id: 'gid://shopify/DiscountNode/2',
    discount: {
      __typename: 'DiscountAutomaticBasic',
      title: 'Automatic summer discount',
      status: 'ACTIVE',
      summary: '10% off automatically',
      shortSummary: '10% off',
      startsAt: '2026-07-01T00:00:00Z',
      endsAt: null,
      createdAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-02T00:00:00Z',
      asyncUsageCount: 5,
      discountClasses: ['ORDER'],
      combinesWith: {
        orderDiscounts: false,
        productDiscounts: true,
        shippingDiscounts: false
      }
    }
  }, 'shop-id', '2026-07-20T00:00:00Z');

  assert.equal(row.method, 'automatic');
  // An automatic discount has no code at all — an empty array, never null.
  assert.deepEqual(row.codes, []);
  assert.equal(row.applies_once_per_customer, null);
  assert.equal(row.promotion_key, 'gid://shopify/DiscountNode/2');
});

test('mapPromotionRows maps app/referral-style codes without filtering', () => {
  const [row] = mapPromotionRows(codeDiscountNode({
    title: 'Judge.me Referrals (Order #2330) Friend Discount',
    code: 'JM-GQ0XYOY',
    createdByTitle: 'Judge.me',
    status: 'EXPIRED',
    appliesOncePerCustomer: true
  }), 'shop-id', '2026-07-20T00:00:00Z');

  assert.equal(row.title, 'Judge.me Referrals (Order #2330) Friend Discount');
  assert.deepEqual(row.codes.map((c) => c.code), ['JM-GQ0XYOY']);
  assert.equal(row.source_app_name, 'Judge.me');
  assert.equal(row.status, 'EXPIRED');
});

function codeDiscountNode({
  title = 'Welcome discount',
  appliesOncePerCustomer,
  status,
  code,
  codeUsageCount = 0,
  createdByTitle = 'Shopify'
}) {
  return {
    id: 'gid://shopify/DiscountNode/1',
    discount: {
      __typename: 'DiscountCodeBasic',
      title,
      status,
      summary: '10% off',
      shortSummary: '10%',
      startsAt: '2026-07-01T00:00:00Z',
      endsAt: null,
      createdAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-02T00:00:00Z',
      usageLimit: null,
      asyncUsageCount: 4,
      appliesOncePerCustomer,
      discountClasses: ['ORDER'],
      combinesWith: {
        orderDiscounts: true,
        productDiscounts: false,
        shippingDiscounts: false
      },
      codes: {
        nodes: [{
          id: `gid://shopify/DiscountRedeemCode/${code}`,
          code,
          asyncUsageCount: codeUsageCount,
          createdBy: {
            title: createdByTitle
          }
        }]
      },
      codesCount: {
        count: 1
      }
    }
  };
}

test('a bulk discount is ONE row carrying all its codes', () => {
  // The change this table exists to make: 600 codes used to mean 600 rows, each
  // repeating the same title, dates and rule_snapshot.
  const node = codeDiscountNode({ appliesOncePerCustomer: true, status: 'ACTIVE', code: 'X' });
  node.discount.codes.nodes = Array.from({ length: 600 }, (_, i) => ({
    id: `gid://shopify/DiscountRedeemCode/${i}`,
    code: `BULK${i}`,
    asyncUsageCount: i === 7 ? 1 : 0,
    createdBy: { title: 'Shopify' }
  }));

  const rows = mapPromotionRows(node, 'shop-id', '2026-07-20T00:00:00Z');

  assert.equal(rows.length, 1, 'one row per discount, not per code');
  assert.equal(rows[0].codes.length, 600);
  // The one thing that genuinely varies per code survives.
  assert.equal(rows[0].codes.find((c) => c.code === 'BULK7').usage_count, 1);
  assert.equal(rows[0].codes.find((c) => c.code === 'BULK8').usage_count, 0);
});

test('the raw payload samples codes rather than mirroring all 600', () => {
  // Otherwise the duplication just moves into the largest jsonb on the row.
  const node = codeDiscountNode({ appliesOncePerCustomer: true, status: 'ACTIVE', code: 'X' });
  node.discount.codes.nodes = Array.from({ length: 600 }, (_, i) => ({
    id: `gid://shopify/DiscountRedeemCode/${i}`, code: `BULK${i}`, asyncUsageCount: 0, createdBy: null
  }));

  const [row] = mapPromotionRows(node, 'shop-id', '2026-07-20T00:00:00Z');
  assert.ok(row.raw_shopify_payload.redeemCodes.length <= 5);
  assert.equal(row.raw_shopify_payload.redeemCodeCount, 600, 'but the true count is still recorded');
});

test('promotion_key is the discount, so a re-sync updates rather than duplicates', () => {
  const node = codeDiscountNode({ appliesOncePerCustomer: true, status: 'ACTIVE', code: 'A' });
  const [row] = mapPromotionRows(node, 'shop-id', '2026-07-20T00:00:00Z');
  assert.equal(row.promotion_key, 'gid://shopify/DiscountNode/1');
});

test('the mapper never writes offerable_in_replies', () => {
  // THE INVARIANT A LOCAL COLUMN ON A SYNCED TABLE RESTS ON. `offerable_in_replies`
  // is the one column on `promotions` Shopify does not own — an operator decides
  // which codes support may offer a customer — and it survives the sync only
  // because this mapper omits it and the upsert merges duplicates.
  //
  // Add the key here and the next sync silently resets every one of those
  // decisions to false, which would show up as codes quietly vanishing from the
  // picker rather than as an error.
  const [row] = mapPromotionRows(
    {
      id: 'gid://shopify/DiscountCodeNode/1',
      discount: {
        __typename: 'DiscountCodeBasic',
        title: 'BIENVENUE',
        status: 'ACTIVE',
        codes: { nodes: [{ code: 'BIENVENUE' }] }
      }
    },
    'shop-1',
    '2026-08-30T00:00:00Z'
  );
  assert.ok(!('offerable_in_replies' in row), 'the sync would reset the operator’s choices');
});

test('a free-shipping discount stores the countries it applies to', () => {
  const [row] = mapPromotionRows({
    id: 'gid://shopify/DiscountAutomaticNode/9',
    discount: {
      __typename: 'DiscountAutomaticFreeShipping',
      title: 'Frais de port offerts à partir de 70€',
      status: 'ACTIVE',
      destinationSelection: { __typename: 'DiscountCountries', countries: ['FR'], includeRestOfWorld: false },
      minimumRequirement: {
        __typename: 'DiscountMinimumSubtotal',
        greaterThanOrEqualToSubtotal: { amount: '70.0', currencyCode: 'EUR' }
      }
    }
  }, 'shop-id', '2026-10-01T00:00:00Z');

  assert.deepEqual(row.rule_snapshot.destination, {
    scope: 'countries',
    countries: ['FR'],
    include_rest_of_world: false
  });
  assert.equal(row.rule_snapshot.destination_selection_type, 'DiscountCountries');
});

test('a worldwide free-shipping discount says so, and a non-shipping one has no destination', () => {
  const [worldwide] = mapPromotionRows({
    id: 'gid://shopify/DiscountCodeNode/10',
    discount: {
      __typename: 'DiscountCodeFreeShipping',
      title: 'LIVRAISONQ',
      status: 'ACTIVE',
      destinationSelection: { __typename: 'DiscountCountryAll', allCountries: true }
    }
  }, 'shop-id', '2026-10-01T00:00:00Z');
  assert.deepEqual(worldwide.rule_snapshot.destination, { scope: 'all' });

  const [basic] = mapPromotionRows({
    id: 'gid://shopify/DiscountCodeNode/11',
    discount: { __typename: 'DiscountCodeBasic', title: 'QIRINESS10', status: 'ACTIVE' }
  }, 'shop-id', '2026-10-01T00:00:00Z');
  assert.ok(!('destination' in basic.rule_snapshot));
});

test('the mapper never writes describable_in_replies either', () => {
  // Same invariant as offerable_in_replies: the operator's choice to keep an
  // automatic offer out of replies survives the sync only because it is absent.
  const [row] = mapPromotionRows({
    id: 'gid://shopify/DiscountAutomaticNode/12',
    discount: { __typename: 'DiscountAutomaticFreeShipping', title: 'Frais de port offerts', status: 'ACTIVE' }
  }, 'shop-id', '2026-10-01T00:00:00Z');
  assert.ok(!('describable_in_replies' in row), 'the sync would reset the operator’s choices');
});

test('a buy-X-get-Y reward stores how many items and how much off them', () => {
  const [row] = mapPromotionRows({
    id: 'gid://shopify/DiscountAutomaticNode/13',
    discount: {
      __typename: 'DiscountAutomaticBxgy',
      title: 'Masque offert dès 65€',
      status: 'ACTIVE',
      customerBuys: { value: { __typename: 'DiscountPurchaseAmount', amount: '65.0' } },
      customerGets: {
        value: {
          __typename: 'DiscountOnQuantity',
          quantity: { quantity: '1' },
          effect: { __typename: 'DiscountPercentage', percentage: 1 }
        }
      }
    }
  }, 'shop-id', '2026-10-01T00:00:00Z');
  assert.equal(row.rule_snapshot.customer_gets.percentage, 1);
  assert.equal(row.rule_snapshot.customer_gets.quantity, 1);
  assert.equal(row.rule_snapshot.customer_buys.amount, '65.0');
});
