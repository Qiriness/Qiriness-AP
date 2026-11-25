import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTraffic, foldSessions, metric, providerOf, salesByCampaign, salesByGroup, salesByProvider, sessionsByGroup } from './marketing-channels.mjs';

// Row shapes as ShopifyQL returned them on 2026-11-25 (referring_channel, traffic_type, utm_source, utm_medium).
const row = (channel, trafficType, source = null, medium = null, extra = {}) => ({
  referring_channel: channel,
  traffic_type: trafficType,
  utm_source: source,
  utm_medium: medium,
  ...extra
});

test('email wins over Shopify calling it paid, whatever the mail client', () => {
  assert.equal(classifyTraffic(row('klaviyo', 'paid', 'Klaviyo', 'email')), 'email');
  assert.equal(classifyTraffic(row('gmail', 'paid', 'Klaviyo', 'email')), 'email');
  assert.equal(classifyTraffic(row('google', 'paid', 'Klaviyo', 'email')), 'email');
  assert.equal(classifyTraffic(row('gmail', 'paid')), 'email');
  assert.equal(classifyTraffic(row('shopify_email', 'paid', 'OrderlyEmails', 'email')), 'email');
});

test('paid and organic search are told apart, and free listings are organic', () => {
  assert.equal(classifyTraffic(row('google', 'organic')), 'organic_search');
  assert.equal(classifyTraffic(row('google', 'paid')), 'paid_search'); // gclid, no UTM
  assert.equal(classifyTraffic(row('google', 'paid', 'google', 'cpc')), 'paid_search');
  assert.equal(classifyTraffic(row('syndicatedsearch', 'paid')), 'paid_search');
  assert.equal(classifyTraffic(row('google', 'paid', 'google', 'product_sync')), 'organic_search');
  assert.equal(classifyTraffic(row('bing', 'organic')), 'organic_search');
});

test('paid and organic social: the medium decides when there is one', () => {
  assert.equal(classifyTraffic(row('facebook', 'paid', 'fb', 'paid_social')), 'paid_social');
  assert.equal(classifyTraffic(row('instagram', 'paid', 'ig', 'paid_social')), 'paid_social');
  assert.equal(classifyTraffic(row('facebook', 'paid', 'fb-SiteLink', 'paid_social')), 'paid_social');
  assert.equal(classifyTraffic(row('an', 'paid', 'an', 'paid_social')), 'paid_social');
  assert.equal(classifyTraffic(row('instagram', 'organic', 'ig', 'social')), 'organic_social');
  // Shopify says paid because of the UTM; the medium says organic.
  assert.equal(classifyTraffic(row('instagram', 'paid', 'ig', 'social')), 'organic_social');
  assert.equal(classifyTraffic(row('facebook', 'organic')), 'organic_social');
});

test('direct, referral, affiliate, other and unknown', () => {
  assert.equal(classifyTraffic(row('direct', 'direct')), 'direct');
  assert.equal(classifyTraffic(row('marionnaud', 'organic')), 'referral');
  assert.equal(classifyTraffic(row('chatgpt', 'organic', 'chatgpt.com')), 'referral');
  assert.equal(classifyTraffic(row('promocodie', 'organic', 'promocodie', 'affiliate')), 'affiliate');
  assert.equal(classifyTraffic(row('lejsl', 'paid', 'lejsl', 'display')), 'other');
  assert.equal(classifyTraffic(row(null, null)), 'unknown');
  assert.equal(classifyTraffic(row('unknown', 'paid')), 'unknown');
});

test('providers: Google Ads is Google paid search only, Meta Ads Meta paid social, Klaviyo its own email', () => {
  assert.equal(providerOf(row('google', 'paid')), 'google_ads');
  assert.equal(providerOf(row('google', 'organic')), null);
  assert.equal(providerOf(row('google', 'paid', 'google', 'product_sync')), null);
  assert.equal(providerOf(row('bing', 'paid', 'bing', 'cpc')), null);
  assert.equal(providerOf(row('instagram', 'paid', 'ig', 'paid_social')), 'meta_ads');
  assert.equal(providerOf(row('facebook', 'organic')), null);
  assert.equal(providerOf(row('gmail', 'paid', 'Klaviyo', 'email')), 'klaviyo');
  assert.equal(providerOf(row('gmail', 'paid')), null); // email, but nothing says Klaviyo
  assert.equal(providerOf(row('tiktok', 'paid', 'tiktok', 'cpc')), null); // not connected as a provider
});

test('metrics are read whatever the attribution suffix, and a missing one is 0', () => {
  assert.equal(metric({ net_sales__last_non_direct_click: '6710.32' }, 'net_sales'), 6710.32);
  assert.equal(metric({ net_sales: '12.5' }, 'net_sales'), 12.5);
  assert.equal(metric({ orders__linear: '79.781' }, 'orders'), 79.781);
  assert.equal(metric({}, 'orders'), 0);
});

test('folding: groups and providers sum attributed sales; sales and sessions fold the same way', () => {
  const sales = [
    row('klaviyo', 'paid', 'Klaviyo', 'email', { net_sales__last_non_direct_click: '6710.32', orders__last_non_direct_click: '97', new_customers__last_non_direct_click: '34' }),
    row('gmail', 'paid', 'Klaviyo', 'email', { net_sales__last_non_direct_click: '1476.68', orders__last_non_direct_click: '18', new_customers__last_non_direct_click: '9' }),
    row('google', 'paid', null, null, { net_sales__last_non_direct_click: '1040.99', orders__last_non_direct_click: '17', new_customers__last_non_direct_click: '10' }),
    row('google', 'organic', null, null, { net_sales__last_non_direct_click: '3476.71', orders__last_non_direct_click: '52', new_customers__last_non_direct_click: '36' })
  ];
  const groups = salesByGroup(sales);
  assert.equal(Math.round(groups.get('email').netSales * 100) / 100, 8187);
  assert.equal(groups.get('email').orders, 115);
  assert.equal(groups.get('paid_search').newCustomers, 10);
  assert.equal(groups.get('organic_search').orders, 52);
  const providers = salesByProvider(sales);
  assert.equal(providers.get('klaviyo').orders, 115);
  assert.equal(providers.get('google_ads').orders, 17);
  assert.equal(providers.has('meta_ads'), false);

  const sessions = sessionsByGroup([
    row('facebook', 'paid', 'fb', 'paid_social', { sessions: '633', sessions_with_cart_additions: '29', sessions_that_reached_checkout: '6', sessions_that_completed_checkout: '0' }),
    row('instagram', 'paid', 'ig', 'paid_social', { sessions: '446', sessions_with_cart_additions: '29', sessions_that_reached_checkout: '15', sessions_that_completed_checkout: '8' })
  ]);
  assert.deepEqual(sessions.get('paid_social'), { sessions: 1079, cartSessions: 58, checkoutSessions: 21, convertedSessions: 8 });
  assert.equal(foldSessions([{ sessions: 3 }], () => null).size, 0);
});

test('campaigns are the UTM campaign within one provider', () => {
  const sales = [
    row('instagram', 'paid', 'ig', 'paid_social', { utm_campaign: 'Main Black Friday', net_sales: '521.41', orders: '8' }),
    row('facebook', 'paid', 'fb', 'paid_social', { utm_campaign: 'Main Black Friday', net_sales: '10', orders: '1' }),
    row('google', 'paid', 'google', 'cpc', { utm_campaign: 'qiriness_led_search_nonbrand', net_sales: '270.63', orders: '2' })
  ];
  const meta = salesByCampaign(sales, 'meta_ads');
  assert.equal(meta.get('Main Black Friday').orders, 9);
  assert.equal(meta.has('qiriness_led_search_nonbrand'), false);
});
