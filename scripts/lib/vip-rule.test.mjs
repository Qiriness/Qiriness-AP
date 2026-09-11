import assert from 'node:assert/strict';
import test from 'node:test';

import { describeVipRule, readVipRule, validateVipRule, vipArgs } from './vip-rule.mjs';

test('an unset rule is no rule, never a default', () => {
  assert.equal(readVipRule(null), null);
  assert.equal(readVipRule({ vip_min_spend: null, vip_min_orders: null, vip_window_months: null }), null);
  // Half a rule is not a rule either: the database refuses it, and so does this.
  assert.equal(readVipRule({ vip_min_spend: '300', vip_min_orders: null, vip_window_months: 12 }), null);
});

test('a stored rule reads back as numbers, whatever PostgREST sent', () => {
  assert.deepEqual(readVipRule({ vip_min_spend: '300.00', vip_min_orders: 2, vip_window_months: '12' }), {
    minSpend: 300,
    minOrders: 2,
    windowMonths: 12
  });
});

test('validation says what is wrong, in words for the form', () => {
  assert.equal(validateVipRule({ minSpend: -1, minOrders: 1, windowMonths: 12 }).ok, false);
  assert.match(validateVipRule({ minSpend: 100, minOrders: 1.5, windowMonths: 12 }).error, /whole number/);
  assert.match(validateVipRule({ minSpend: 100, minOrders: 1, windowMonths: 0 }).error, /1 to 120/);
  assert.match(validateVipRule({ minSpend: 'abc', minOrders: 1, windowMonths: 12 }).error, /euros/);
  assert.deepEqual(validateVipRule({ minSpend: '300.456', minOrders: '2', windowMonths: '12' }), {
    ok: true,
    rule: { minSpend: 300.46, minOrders: 2, windowMonths: 12 }
  });
});

test('the sentence states both conditions and the window', () => {
  assert.equal(
    describeVipRule({ minSpend: 300, minOrders: 2, windowMonths: 12 }),
    'More than €300 spent and more than 2 orders in the last 12 months'
  );
  assert.equal(describeVipRule({ minSpend: 50, minOrders: 1, windowMonths: 1 }), 'More than €50 spent and more than 1 order in the last month');
  assert.equal(describeVipRule(null), 'No VIP rule is set');
});

test('every VIP read leaves out the marketplaces', () => {
  const args = vipArgs('shop-1', { minSpend: 300, minOrders: 2, windowMonths: 12 });
  assert.deepEqual(args.p_not_channels, ['amazon', 'connect-dev-1']);
  assert.equal(args.p_min_orders, 2);
});
