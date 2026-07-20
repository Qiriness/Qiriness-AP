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
  assert.equal(row.code, 'WELCOME10');
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.applies_once_per_customer, true);
  assert.equal(row.code_usage_count, 2);
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
  assert.equal(row.code, 'OLD10');
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
  assert.equal(row.code, null);
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
  assert.equal(row.code, 'JM-GQ0XYOY');
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
