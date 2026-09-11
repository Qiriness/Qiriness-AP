import assert from 'node:assert/strict';
import test from 'node:test';

import * as segments from './customer-segments.mjs';

const { formatRfmGroup, normaliseRfmGroup } = segments;

test('Shopify segments no longer decide VIP status', () => {
  // VIP is the shop's own rule now (vip-rule.mjs). A second definition left
  // here would be imported by somebody and disagree with the first.
  assert.equal('isVipRfmGroup' in segments, false);
  assert.equal('VIP_RFM_GROUPS' in segments, false);
});

test('matching survives casing and padding', () => {
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
