import assert from 'node:assert/strict';
import test from 'node:test';

import { NO_MARKETPLACES, buildMarketplaces, marketplaceNames } from './marketplaces.mjs';

// Example rows, shaped as `sales_channels` returns them. Deliberately not this
// shop's: the module must not know which marketplaces any shop has.
const MARKETPLACES = buildMarketplaces([
  { platform_key: 'market_b', label: 'Market B', handles: ['connect-b'], analytics_names: ['Mirakl Connect'], position: 1 },
  { platform_key: 'market_a', label: 'Market A', handles: ['market-a', 'market-a'], analytics_names: [], position: 0 }
]);

test('platforms map to channel handles, with Shopify as everything that is not a marketplace', () => {
  assert.deepEqual(MARKETPLACES.channelFilter('market_a'), { channels: ['market-a'], notChannels: null });
  assert.deepEqual(MARKETPLACES.channelFilter('market_b'), { channels: ['connect-b'], notChannels: null });
  assert.deepEqual(MARKETPLACES.channelFilter('shopify'), { channels: null, notChannels: ['market-a', 'connect-b'] });
  assert.deepEqual(MARKETPLACES.channelFilter('all'), { channels: null, notChannels: null });
  assert.equal(MARKETPLACES.platformOfChannel('shop-72'), 'shopify');
  assert.equal(MARKETPLACES.platformOfChannel('connect-b'), 'market_b');
  assert.equal(MARKETPLACES.parsePlatform('ebay'), 'all');
  assert.equal(MARKETPLACES.parsePlatform('market_b'), 'market_b');
});

test('the filter offers all, the shop’s store, then each marketplace in its order', () => {
  assert.deepEqual(MARKETPLACES.platforms.map((p) => p.id), ['all', 'shopify', 'market_a', 'market_b']);
  assert.equal(MARKETPLACES.labelOf('market_b'), 'Market B');
  assert.ok(MARKETPLACES.isMarketplace('market_a'));
  assert.ok(!MARKETPLACES.isMarketplace('shopify'));
});

test('Shopify Analytics names fold onto the same platforms, whatever their case', () => {
  assert.equal(MARKETPLACES.platformOfAnalyticsChannel('mirakl connect'), 'market_b');
  assert.equal(MARKETPLACES.platformOfAnalyticsChannel('Online Store'), 'shopify');
});

test('a shop with no marketplaces treats every order as its own store’s', () => {
  assert.deepEqual(NO_MARKETPLACES.handles, []);
  assert.equal(NO_MARKETPLACES.platformOfChannel('amazon'), 'shopify');
  assert.deepEqual(NO_MARKETPLACES.channelFilter('shopify'), { channels: null, notChannels: [] });
  assert.deepEqual(NO_MARKETPLACES.platforms.map((p) => p.id), ['all', 'shopify']);
});

test('the names read as a sentence in either language', () => {
  assert.equal(marketplaceNames(MARKETPLACES, 'en'), 'Market A and Market B');
  assert.equal(marketplaceNames(MARKETPLACES, 'fr'), 'Market A et Market B');
  assert.equal(marketplaceNames(NO_MARKETPLACES, 'fr'), 'les marketplaces');
});

test('the reserved keys cannot name a marketplace', () => {
  const built = buildMarketplaces([{ platform_key: 'shopify', label: 'X', handles: ['x'] }]);
  assert.deepEqual(built.list, []);
});
