import assert from 'node:assert/strict';
import test from 'node:test';

import { change, channelRows, compareProvider, divide, executiveFigures, trackingCoverage } from './marketing-metrics.mjs';

const base = {
  websiteNet: 30000,
  adSpend: 3000,
  adSpendReason: null,
  otherMarketingCosts: null,
  providerRevenue: 6500,
  shopifyPaidNet: 3000,
  shopifyPaidOrders: 40,
  newCustomers: 250,
  newCustomerNet: 14000,
  returningNet: 16000
};

test('the definitions: MER, ROAS both ways, CAC is not CPA', () => {
  const f = executiveFigures(base);
  assert.equal(f.mer.value, 10);
  assert.equal(f.providerRoas.value, 6500 / 3000);
  assert.equal(f.shopifyRoas.value, 1);
  assert.equal(f.newCustomerMer.value, 14000 / 3000);
  assert.equal(f.cac.value, 12); // spend over NEW customers
  assert.equal(f.cpa.value, 75); // spend over paid-credited ORDERS
  assert.equal(f.revenueAfterAds.value, 27000);
  assert.equal(f.marketingCosts.value, 3000);
});

test('eMER needs costs beyond ads; without them it is not configured, never a copy of MER', () => {
  assert.equal(executiveFigures(base).emer.state, 'not_configured');
  const f = executiveFigures({ ...base, otherMarketingCosts: 1000 });
  assert.equal(f.emer.value, 30000 / 4000);
  assert.equal(f.marketingCosts.value, 4000);
});

test('no ad spend source: every spend-based figure is unavailable with the reason, never 0 or infinity', () => {
  const f = executiveFigures({ ...base, adSpend: null, adSpendReason: 'insights.mkt.state.mixedCurrency' });
  for (const key of ['adSpend', 'mer', 'cac', 'cpa', 'providerRoas', 'shopifyRoas', 'revenueAfterAds']) {
    assert.equal(f[key].value, null, key);
    assert.equal(f[key].state, 'unavailable', key);
    assert.equal(f[key].reason, 'insights.mkt.state.mixedCurrency', key);
  }
  assert.equal(f.websiteNet.value, 30000);
});

test('a zero denominator is insufficient, a zero numerator is a real zero', () => {
  assert.equal(divide(5, 0).state, 'insufficient');
  assert.equal(divide(0, 5).value, 0);
  assert.equal(divide(0, 5).state, 'measured');
  const f = executiveFigures({ ...base, newCustomers: 0, shopifyPaidOrders: 0 });
  assert.equal(f.cac.state, 'insufficient');
  assert.equal(f.cpa.state, 'insufficient');
  assert.equal(executiveFigures({ ...base, adSpend: 0 }).mer.state, 'insufficient');
});

test('profitability and cohort figures are labelled, not invented', () => {
  const f = executiveFigures(base);
  assert.equal(f.contribution.state, 'not_configured');
  assert.equal(f.ltvCac.state, 'unavailable');
  assert.equal(f.ltgpCac.value, null);
});

test('change: absolute and per cent; from zero there is no percentage', () => {
  assert.deepEqual(change(120, 100), { abs: 20, pct: 20 });
  assert.deepEqual(change(5, 0), { abs: 5, pct: null });
  assert.equal(change(5, null), null);
});

test('provider against Shopify: revenue compared on total sales, ROAS on net', () => {
  const row = compareProvider({
    provider: { revenue: 3819.14, conversions: 84 },
    shopify: { netSales: 566.63, totalSales: 700, orders: 9, newCustomers: 6 },
    sessions: { sessions: 1079, convertedSessions: 8 },
    spend: 1819.25
  });
  assert.equal(Math.round(row.difference.revenue.abs * 100) / 100, 3119.14);
  assert.equal(Math.round(row.difference.revenue.pct), 446);
  assert.equal(row.difference.orders.abs, 75);
  assert.equal(row.shopify.roas, 566.63 / 1819.25);
  assert.equal(row.provider.cpa, 1819.25 / 84);
  assert.equal(row.shopify.cac, 1819.25 / 6);
  assert.equal(Math.round(row.conversionRate * 100) / 100, 0.74);

  const owned = compareProvider({ provider: { revenue: 9000, conversions: 120 }, shopify: { netSales: 6710, totalSales: 8342, orders: 97, newCustomers: 34 }, sessions: null, spend: null });
  assert.equal(owned.provider.roas, null);
  assert.equal(owned.shopify.cpa, null);
  assert.equal(owned.difference.orders.abs, 23);

  const nothingClaimed = compareProvider({ provider: null, shopify: { netSales: 0, totalSales: 0, orders: 0, newCustomers: 0 }, sessions: null, spend: 10 });
  assert.equal(nothingClaimed.difference, null);
  assert.equal(nothingClaimed.shopify.cpa, null);
});

test('channel rows: shares, spend only where a provider carries it, empty groups dropped', () => {
  const rows = channelRows({
    groups: ['paid_search', 'organic_search', 'referral'],
    salesByGroup: new Map([
      ['paid_search', { netSales: 2000, totalSales: 2400, orders: 30, newCustomers: 20 }],
      ['organic_search', { netSales: 6000, totalSales: 7200, orders: 90, newCustomers: 50 }]
    ]),
    sessionsByGroup: new Map([
      ['paid_search', { sessions: 1000, cartSessions: 100, checkoutSessions: 50, convertedSessions: 25 }],
      ['organic_search', { sessions: 3000, cartSessions: 300, checkoutSessions: 150, convertedSessions: 75 }]
    ]),
    spendByGroup: new Map([['paid_search', 1000]])
  });
  assert.equal(rows.length, 2);
  const [paid, organic] = rows;
  assert.equal(paid.revenueShare, 25);
  assert.equal(paid.roas, 2);
  assert.equal(paid.cac, 50);
  assert.equal(paid.spendShare, 100);
  assert.equal(organic.spend, null);
  assert.equal(organic.roas, null);
  assert.equal(organic.conversionRate, 2.5);
  assert.equal(organic.revenuePerSession, 2);
});

test('tracking coverage counts the orders Shopify could not place', () => {
  const cov = trackingCoverage(new Map([['unknown', { orders: 189 }], ['email', { orders: 115 }], ['direct', { orders: 19 }]]));
  assert.equal(cov.unknownOrders, 189);
  assert.equal(Math.round(cov.knownShare), 41);
});
