import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attributedSalesQuery,
  collectionCategory,
  foldTraffic,
  funnelOf,
  funnelSteps,
  handleOf,
  landingByDevice,
  landingByGroup,
  normalisePath,
  parseAttributionModel,
  readLandingPages,
  readTraffic,
  safeCountry,
  trafficQuery
} from './storefront-marketing.mjs';

const range = { from: '2026-10-26T00:00:00', to: '2026-11-25T00:00:00' };

test('attribution: the model is from a fixed list, default last non-direct click', () => {
  assert.equal(parseAttributionModel('first'), 'first');
  assert.equal(parseAttributionModel('nonsense'), 'lndc');
  assert.equal(parseAttributionModel(undefined), 'lndc');
  assert.equal(parseAttributionModel('__proto__'), 'lndc');
  assert.match(attributedSalesQuery(range), /WITH LAST_NON_DIRECT_CLICK_ATTRIBUTION$/);
  assert.match(attributedSalesQuery(range, 'linear'), /WITH LINEAR_ATTRIBUTION$/);
  assert.match(attributedSalesQuery(range), /SINCE 2026-10-26 UNTIL 2026-11-24/);
});

test('a country reaches the query only as plain letters', () => {
  assert.equal(safeCountry('United Kingdom'), 'United Kingdom');
  assert.equal(safeCountry('Côte d’Ivoire'), 'Côte d’Ivoire');
  assert.equal(safeCountry("France' OR 1=1"), null);
  assert.equal(safeCountry(''), null);
  assert.match(trafficQuery(range, { country: 'France' }), /AND session_country = 'France'/);
  assert.doesNotMatch(trafficQuery(range, { country: "x' or 'a'='a" }), /session_country/);
});

const traffic = readTraffic([
  { session_device_type: 'mobile', landing_page_type: 'Product', referring_channel: 'facebook', traffic_type: 'paid', utm_source: 'fb', utm_medium: 'paid_social', utm_campaign: 'LED Black Friday', sessions: '415', sessions_with_cart_additions: '12', sessions_that_reached_checkout: '4', sessions_that_completed_checkout: '0' },
  { session_device_type: 'desktop', landing_page_type: 'Homepage', referring_channel: 'google', traffic_type: 'organic', sessions: '300', sessions_with_cart_additions: '45', sessions_that_reached_checkout: '30', sessions_that_completed_checkout: '15' },
  { session_device_type: 'mobile', landing_page_type: 'Homepage', referring_channel: 'google', traffic_type: 'organic', sessions: '500', sessions_with_cart_additions: '50', sessions_that_reached_checkout: '25', sessions_that_completed_checkout: '10' },
  { session_device_type: 'Smart TV', landing_page_type: null, referring_channel: 'direct', traffic_type: 'direct', sessions: '5' }
]);

test('traffic rows carry their group, provider, device and campaign', () => {
  assert.equal(traffic[0].group, 'paid_social');
  assert.equal(traffic[0].provider, 'meta_ads');
  assert.equal(traffic[0].campaign, 'LED Black Friday');
  assert.equal(traffic[1].provider, null);
  assert.equal(traffic[3].device, 'unknown');
  assert.equal(traffic[3].landingType, 'Unknown');
});

test('filters combine: device x channel x landing type', () => {
  assert.equal(funnelOf(traffic).sessions, 1220);
  assert.equal(funnelOf(traffic, { device: 'mobile' }).sessions, 915);
  assert.deepEqual(funnelOf(traffic, { device: 'mobile', group: 'organic_search', landingType: 'Homepage' }), {
    sessions: 500,
    cartSessions: 50,
    checkoutSessions: 25,
    convertedSessions: 10
  });
  assert.equal(funnelOf(traffic, { group: 'email' }).sessions, 0);
  const byDevice = foldTraffic(traffic, 'device');
  assert.equal(byDevice.get('desktop').convertedSessions, 15);
});

test('funnel steps: rates against the entry and the step before, and the drop-off', () => {
  const steps = funnelSteps({ sessions: 1000, cartSessions: 100, checkoutSessions: 60, convertedSessions: 20 });
  assert.deepEqual(steps.map((s) => s.ofEntry), [100, 10, 6, 2]);
  assert.equal(steps[0].ofPrevious, null);
  assert.equal(steps[2].ofPrevious, 60);
  assert.equal(steps[3].dropOff, 40);
  assert.equal(funnelSteps({ sessions: 0, cartSessions: 0, checkoutSessions: 0, convertedSessions: 0 })[1].ofEntry, null);
});

test('paths: one page whatever the tracking parameters, case or trailing slash', () => {
  assert.equal(normalisePath('/products/Masque-LED-Visage/?utm_source=fb'), '/products/masque-led-visage');
  assert.equal(normalisePath('/'), '/');
  assert.equal(normalisePath(''), null);
  assert.equal(handleOf('/collections/source-deau', 'collections'), 'source-deau');
  assert.equal(handleOf('/products/x', 'collections'), null);
});

test('landing pages merge duplicates honestly: counts add, visitors do not', () => {
  const pages = readLandingPages([
    { landing_page_type: 'Product', landing_page_path: '/products/a', sessions: '100', online_store_visitors: '90', bounce_rate: '0.5', sessions_with_cart_additions: '10', sessions_that_reached_checkout: '5', sessions_that_completed_checkout: '2' },
    { landing_page_type: 'Product', landing_page_path: '/products/a/', sessions: '100', online_store_visitors: '95', bounce_rate: '0.3', sessions_with_cart_additions: '10', sessions_that_reached_checkout: '5', sessions_that_completed_checkout: '2' },
    { landing_page_type: 'Homepage', landing_page_path: '/', sessions: '50', online_store_visitors: '45', bounce_rate: '0.2', sessions_with_cart_additions: '5', sessions_that_reached_checkout: '3', sessions_that_completed_checkout: '1' }
  ]);
  assert.equal(pages.length, 2);
  const [a, home] = pages;
  assert.equal(a.sessions, 200);
  assert.equal(a.visitors, null);
  assert.equal(a.merged, true);
  assert.equal(Math.round(a.bounceRate), 40);
  assert.equal(a.conversionRate, 2);
  assert.equal(home.visitors, 45);
  assert.equal(home.bounceRate, 20);
});

test('landing breakdowns by channel group and by device', () => {
  const rows = [
    { landing_page_path: '/products/a', referring_channel: 'google', traffic_type: 'paid', session_device_type: 'mobile', sessions: '10', sessions_that_completed_checkout: '1' },
    { landing_page_path: '/products/a', referring_channel: 'google', traffic_type: 'organic', session_device_type: 'desktop', sessions: '20', sessions_that_completed_checkout: '2' }
  ];
  assert.equal(landingByGroup(rows).get('/products/a').get('paid_search').sessions, 10);
  assert.equal(landingByDevice(rows).get('/products/a').get('desktop').convertedSessions, 2);
});

test('collection categories: concerns and ranges from data, promotions from the handle', () => {
  const known = { concerns: new Set(['anti-age-anti-ride-ridule']), ranges: new Set(['source-deau']), categories: new Set(['cremes-visage']) };
  assert.equal(collectionCategory('anti-age-anti-ride-ridule', known), 'concern');
  assert.equal(collectionCategory('source-deau', known), 'range');
  assert.equal(collectionCategory('black-friday', known), 'promo');
  assert.equal(collectionCategory('soldes-hiver-2026', known), 'promo');
  assert.equal(collectionCategory('offre-sur-notre-selection-de-soins-en-edition-limitee', known), 'promo');
  assert.equal(collectionCategory('cremes-visage', known), 'general');
  assert.equal(collectionCategory('meilleures-ventes', known), 'general');
  assert.equal(collectionCategory('all', known), 'general');
  assert.equal(collectionCategory('soin-haute-performance-qiriness', known), 'other');
});
