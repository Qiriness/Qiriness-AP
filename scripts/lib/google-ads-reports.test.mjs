import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoogleAdsClient, exchangeGoogleCode } from './google-ads-client.mjs';
import { dailyQuery, foldDaily, foldDiscovery, publisherOfNetwork } from './google-ads-reports.mjs';

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the daily query takes dates only', () => {
  assert.match(dailyQuery('2026-09-01', '2026-09-30'), /BETWEEN '2026-09-01' AND '2026-09-30'/);
  assert.throws(() => dailyQuery("2026-09-01' OR '1'='1", '2026-09-30'));
});

test('networks fold into publishers', () => {
  assert.equal(publisherOfNetwork('SEARCH_PARTNERS'), 'google_search');
  assert.equal(publisherOfNetwork('CONTENT'), 'google_display');
  assert.equal(publisherOfNetwork('YOUTUBE_WATCH'), 'youtube');
  assert.equal(publisherOfNetwork('PERFORMANCE_MAX'), 'google_other');
});

test('rows: micros become money, int64 strings become numbers, search partners join search', () => {
  const rows = foldDaily([
    { segments: { date: '2026-09-01', adNetworkType: 'SEARCH' }, customer: { currencyCode: 'EUR' }, metrics: { costMicros: '12345678', impressions: '1000', clicks: '40', conversions: 2.5, conversionsValue: 99.9 } },
    { segments: { date: '2026-09-01', adNetworkType: 'SEARCH_PARTNERS' }, customer: { currencyCode: 'EUR' }, metrics: { costMicros: '1000000', impressions: '10', clicks: '1' } },
    { segments: { date: '2026-09-01', adNetworkType: 'YOUTUBE' }, customer: { currencyCode: 'EUR' }, metrics: { costMicros: '0', impressions: '5' } }
  ]);
  const search = rows.find((r) => r.publisher === 'google_search');
  assert.deepEqual(search, { day: '2026-09-01', publisher: 'google_search', currency: 'EUR', spend: 13.35, impressions: 1010, clicks: 41, conversions: 2.5, conversion_value: 99.9 });
  assert.equal(rows.length, 2);
});

test('discovery: direct accounts as they are, a manager through its enabled clients, never twice', () => {
  const accounts = foldDiscovery([
    { id: '111', customer: { id: '111', descriptiveName: 'Shop FR', currencyCode: 'EUR', manager: false } },
    {
      id: '900',
      customer: { id: '900', descriptiveName: 'Agency', manager: true },
      clients: [
        { customerClient: { id: '111', descriptiveName: 'Shop FR', currencyCode: 'EUR', manager: false, status: 'ENABLED' } },
        { customerClient: { id: '222', descriptiveName: 'Shop UK', currencyCode: 'GBP', manager: false, status: 'ENABLED' } },
        { customerClient: { id: '333', descriptiveName: 'Old', currencyCode: 'EUR', manager: false, status: 'CANCELED' } }
      ]
    },
    { id: '444', error: 'not enabled' }
  ]);
  assert.deepEqual(accounts, [
    { external_id: '111', name: 'Shop FR', currency: 'EUR', login_customer_id: null },
    { external_id: '222', name: 'Shop UK', currency: 'GBP', login_customer_id: '900' }
  ]);
});

test('the client refreshes once, and sends the manager it goes through', async () => {
  const seen = [];
  const responses = [reply(200, { access_token: 'ya29.dummy', expires_in: 3600 }), reply(200, [{ results: [{ a: 1 }] }, { results: [{ a: 2 }] }]), reply(200, [{ results: [] }])];
  const ads = createGoogleAdsClient({
    refreshToken: 'r',
    clientId: 'c',
    clientSecret: 's',
    apiVersion: 'v21',
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return responses.shift();
    }
  });
  assert.deepEqual(await ads.search('123', 'SELECT x', { loginCustomerId: '900' }), [{ a: 1 }, { a: 2 }]);
  await ads.search('123', 'SELECT y');
  assert.equal(seen.length, 3, 'the access token is reused');
  assert.equal(seen[1].url, 'https://googleads.googleapis.com/v21/customers/123/googleAds:searchStream');
  assert.equal(seen[1].init.headers['developer-token'], undefined, 'developer tokens were sunset on 2026-09-09');
  assert.equal(seen[1].init.headers['login-customer-id'], '900');
  assert.equal(seen[2].init.headers['login-customer-id'], undefined);
});

test('a refused refresh token asks for a reconnect', async () => {
  const ads = createGoogleAdsClient({
    refreshToken: 'r',
    clientId: 'c',
    clientSecret: 's',
    fetchImpl: async () => reply(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
  });
  await assert.rejects(ads.listAccessibleCustomers(), (error) => error.needsReconnect === true);
});

test('a code exchange without a refresh token is refused', async () => {
  await assert.rejects(
    exchangeGoogleCode({ clientId: 'c', clientSecret: 's', redirect: 'r', code: 'x', fetchImpl: async () => reply(200, { access_token: 'a' }) }),
    /no refresh token/
  );
});

test('a legacy developer token, when still set, is sent; Google ignores it', async () => {
  const seen = [];
  const responses = [reply(200, { access_token: 'a', expires_in: 3600 }), reply(200, [{ results: [] }])];
  const ads = createGoogleAdsClient({
    refreshToken: 'r',
    clientId: 'c',
    clientSecret: 's',
    developerToken: 'legacy',
    fetchImpl: async (url, init) => {
      seen.push(init);
      return responses.shift();
    }
  });
  await ads.search('1', 'SELECT x');
  assert.equal(seen[1].headers['developer-token'], 'legacy');
});

test('campaign rows: micros become money, the latest row names the campaign', async () => {
  const { campaignDailyQuery, foldCampaignDaily } = await import('./google-ads-reports.mjs');
  assert.match(campaignDailyQuery('2026-09-01', '2026-09-02'), /FROM campaign WHERE segments\.date BETWEEN '2026-09-01' AND '2026-09-02'/);
  assert.throws(() => campaignDailyQuery('x', '2026-09-02'));
  const { campaigns, days } = foldCampaignDaily([
    { campaign: { id: '77', name: 'Brand (old)', status: 'ENABLED', advertisingChannelType: 'SEARCH' }, segments: { date: '2026-09-01' }, customer: { currencyCode: 'EUR' }, metrics: { costMicros: '2500000', impressions: '100', clicks: '7', conversions: 1, conversionsValue: 59 } },
    { campaign: { id: '77', name: 'Brand', status: 'PAUSED', advertisingChannelType: 'SEARCH' }, segments: { date: '2026-09-02' }, customer: { currencyCode: 'EUR' }, metrics: { costMicros: '1000000', impressions: '50', clicks: '2' } }
  ]);
  assert.deepEqual(campaigns, [{ external_id: '77', name: 'Brand', status: 'PAUSED', objective: 'SEARCH' }]);
  assert.deepEqual(days.map((d) => [d.day, d.spend, d.clicks, d.conversion_value]), [['2026-09-01', 2.5, 7, 59], ['2026-09-02', 1, 2, 0]]);
});
