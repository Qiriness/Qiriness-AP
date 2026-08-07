import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VIP_RFM_GROUPS,
  formatRfmGroup,
  isVipRfmGroup,
  normaliseRfmGroup
} from './customer-segments.mjs';

test('the VIP set is exactly the two best-customer segments', () => {
  // The business rule, asserted so a widening is a deliberate edit rather than
  // something that drifts in with a UI change.
  assert.deepEqual(VIP_RFM_GROUPS, ['CHAMPIONS', 'LOYAL']);
});

test('champions and loyal customers are VIPs', () => {
  assert.equal(isVipRfmGroup('CHAMPIONS'), true);
  assert.equal(isVipRfmGroup('LOYAL'), true);
});

test('ACTIVE is deliberately not VIP', () => {
  // "Has ordered recently" is most of the customer table; a badge nearly every
  // row carries tells an operator nothing.
  assert.equal(isVipRfmGroup('ACTIVE'), false);
});

test('every other group observed on real data is not VIP', () => {
  for (const group of ['PROSPECTS', 'DORMANT', 'AT_RISK', 'ALMOST_LOST', 'LOST']) {
    assert.equal(isVipRfmGroup(group), false, group);
  }
});

test('no group at all is never VIP', () => {
  // Absence of evidence is not VIP status: an unlinked ticket, or a customer
  // Shopify has not scored, must not be badged.
  for (const value of [null, undefined, '', '   ', 42, {}]) {
    assert.equal(isVipRfmGroup(value), false, String(value));
  }
});

test('matching survives casing and padding', () => {
  assert.equal(isVipRfmGroup('champions'), true);
  assert.equal(isVipRfmGroup('  Loyal  '), true);
  assert.equal(normaliseRfmGroup(' loyal '), 'LOYAL');
  assert.equal(normaliseRfmGroup(null), '');
});

test('a group Shopify adds later still renders, rather than vanishing', () => {
  // The label table is deliberately partial — Shopify owns this vocabulary.
  assert.equal(formatRfmGroup('POTENTIAL_LOYALIST'), 'Potential loyalist');
  assert.equal(formatRfmGroup('NEEDS_ATTENTION'), 'Needs attention');
});

test('known groups get their curated label', () => {
  assert.equal(formatRfmGroup('CHAMPIONS'), 'Champion');
  assert.equal(formatRfmGroup('AT_RISK'), 'At risk');
});

test('no group formats to null, not to an empty badge', () => {
  assert.equal(formatRfmGroup(null), null);
  assert.equal(formatRfmGroup('  '), null);
});
