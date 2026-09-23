import assert from 'node:assert/strict';
import test from 'node:test';

import {
  averageOrderValue,
  inventoryStatus,
  managementSignals,
  revenueBridge,
  revenueDrivers
} from './sales-overview.mjs';

test('nothing on the shelf is out of stock, whether or not it sold', () => {
  assert.equal(inventoryStatus(0, 0), 'out');
  assert.equal(inventoryStatus(-1, null), 'out');
  assert.equal(inventoryStatus(0, null), 'out');
});

test('cover sets the status, and a month of cover is not an exception', () => {
  assert.equal(inventoryStatus(3, 2.5), 'critical');
  assert.equal(inventoryStatus(10, 7), 'critical');
  assert.equal(inventoryStatus(10, 7.1), 'low');
  assert.equal(inventoryStatus(10, 14), 'low');
  assert.equal(inventoryStatus(10, 29.9), 'watch');
  assert.equal(inventoryStatus(10, 45), null);
  // Stock that is not moving has no cover, so it is not at risk.
  assert.equal(inventoryStatus(10, null), null);
  assert.equal(inventoryStatus(null, 3), null);
});

test('AOV is net revenue over paid orders, and has no value without an order', () => {
  assert.equal(averageOrderValue(1000, 10), 100);
  assert.equal(averageOrderValue(0, 0), null);
});

test('the bridge reconciles gross sales to the revenue every card prints', () => {
  // August 2026, live: 10,242.28 net, 1,191.19 discounts, no refunds.
  const bridge = revenueBridge({ grossRevenue: 10242.28, revenue: 10242.28, discounts: 1191.19 });
  assert.equal(bridge.net, 10242.28);
  assert.equal(bridge.refunds, 0);
  assert.equal(Math.round(bridge.gross * 100), Math.round((10242.28 + 1191.19) * 100));
  const withRefund = revenueBridge({ grossRevenue: 500, revenue: 450, discounts: 20 });
  assert.equal(withRefund.gross - withRefund.discounts - withRefund.refunds, withRefund.net);
});

test('revenue drivers split volume from basket, and name the bigger move', () => {
  const d = revenueDrivers({ revenue: 1200, paidOrders: 10 }, { revenue: 1000, paidOrders: 10 });
  assert.equal(d.orders, 0);
  assert.ok(Math.abs(d.aov - 0.2) < 1e-9);
  assert.ok(Math.abs(d.total - 0.2) < 1e-9);
  assert.equal(d.lead, 'aov');
  assert.deepEqual(revenueDrivers({ revenue: 1, paidOrders: 1 }, null), { total: null, orders: null, aov: null, lead: null });
});

const base = { revenue: 1000, paidOrders: 10, grossRevenue: 1000, discounts: 100, measured: 10, over72h: 0 };

test('signals come in a fixed order and never exceed four', () => {
  const signals = managementSignals({
    compareLabel: 'July 2026',
    current: { ...base, revenue: 900, grossRevenue: 900, discounts: 200, over72h: 3 },
    previous: base,
    inventory: [{ status: 'out' }, { status: 'critical' }, { status: 'low' }]
  });
  assert.equal(signals.length, 4);
  assert.match(signals[0].title, /^Revenue fell 10\.0% vs July 2026$/);
  assert.equal(signals[0].tone, 'warn');
  assert.match(signals[1].title, /^Discount rate rose/);
  assert.equal(signals[1].tone, 'warn');
  assert.equal(signals[2].title, '1 product out of stock, 1 under a week of cover');
  assert.equal(signals[3].title, '30.0% of orders shipped after 3 days');
  assert.equal(signals[3].tone, 'warn');
});

test('with nothing to compare, a signal says so instead of inventing a direction', () => {
  const signals = managementSignals({ compareLabel: 'x', current: base, previous: null, inventory: [] });
  assert.equal(signals[0].tone, 'neutral');
  assert.match(signals[0].title, /No earlier period/);
  assert.equal(signals[1].tone, 'neutral');
  assert.equal(signals[2].title, 'No active product is out of stock');
});
