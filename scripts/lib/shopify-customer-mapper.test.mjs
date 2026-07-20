import assert from 'node:assert/strict';
import test from 'node:test';

import { isOnEmailMarketingList, mapCustomer } from './shopify-customer-mapper.mjs';

test('mapCustomer stores Shopify RFM group without local VIP fields', () => {
  const row = mapCustomer(
    {
      id: 'gid://shopify/Customer/1',
      legacyResourceId: '1',
      displayName: 'Jane Customer',
      firstName: 'Jane',
      lastName: 'Customer',
      locale: 'fr',
      state: 'ENABLED',
      tags: ['newsletter'],
      numberOfOrders: 3,
      verifiedEmail: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
      statistics: {
        rfmGroup: 'LOYAL'
      },
      amountSpent: {
        amount: '120.50',
        currencyCode: 'EUR'
      },
      defaultEmailAddress: {
        emailAddress: 'jane@example.com',
        marketingState: 'SUBSCRIBED',
        marketingOptInLevel: 'SINGLE_OPT_IN',
        marketingUpdatedAt: '2026-01-02T00:00:00Z',
        validFormat: true
      },
      defaultPhoneNumber: {
        phoneNumber: '+33123456789'
      },
      defaultAddress: {
        city: 'Paris',
        province: 'Ile-de-France',
        country: 'France',
        countryCodeV2: 'FR',
        formattedArea: 'Paris, France'
      },
      lastOrder: {
        id: 'gid://shopify/Order/1',
        name: '#1001',
        createdAt: '2026-06-01T00:00:00Z',
        currentTotalPriceSet: {
          shopMoney: {
            amount: '45.00',
            currencyCode: 'EUR'
          }
        }
      }
    },
    'shop-id',
    '2026-07-20T00:00:00Z'
  );

  assert.equal(row.rfm_group, 'LOYAL');
  assert.equal(row.is_vip, undefined);
  assert.equal(row.vip_reasons, undefined);
  assert.equal(row.vip_rule_snapshot, undefined);
  assert.deepEqual(row.raw_shopify_payload.statistics, { rfmGroup: 'LOYAL' });
});

test('isOnEmailMarketingList only treats subscribed customers as on-list', () => {
  assert.equal(isOnEmailMarketingList({ email_marketing_state: 'SUBSCRIBED' }), true);
  assert.equal(isOnEmailMarketingList({ email_marketing_state: 'UNSUBSCRIBED' }), false);
  assert.equal(isOnEmailMarketingList({ email_marketing_state: 'NOT_SUBSCRIBED' }), false);
  assert.equal(isOnEmailMarketingList({ email_marketing_state: null }), false);
});
