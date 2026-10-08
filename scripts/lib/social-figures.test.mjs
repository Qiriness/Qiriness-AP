import assert from 'node:assert/strict';
import test from 'node:test';

import { bucketSeries, driverSummary, netFollows, organicDrivers, organicTotals, paidTotals, sumKnown } from './social-figures.mjs';

test('a sum over nothing measured is null, not zero', () => {
  assert.equal(sumKnown([null, undefined]), null);
  assert.equal(sumKnown([null, 0]), 0);
  assert.equal(sumKnown([2, null, 3]), 5);
});

const series = [
  { kind: 'instagram', account_id: 'ig', bucket: '2026-09-01T00:00:00', views: 100, engagement: 10, profile_visits: null, link_taps: 2, follows: 5, unfollows: 1, posts: 1 },
  { kind: 'instagram', account_id: 'ig', bucket: '2026-09-02T00:00:00', views: 50, engagement: null, profile_visits: null, link_taps: 1, follows: 3, unfollows: 0, posts: 0 },
  { kind: 'facebook', account_id: 'fb', bucket: '2026-09-01T00:00:00', views: 20, engagement: 4, profile_visits: 7, link_taps: null, follows: null, unfollows: null, posts: 2 }
];
const followers = [
  { kind: 'instagram', account_id: 'ig', followers_end: 21419, followers_start: 21400 },
  { kind: 'facebook', account_id: 'fb', followers_end: 17946, followers_start: 17900 }
];
const postTotals = [
  { kind: 'instagram', account_id: 'ig', posts: 3, views: 900, engagement: 120, rated_engagement: 100, rated_reach: 1000 },
  { kind: 'facebook', account_id: 'fb', posts: 2, views: null, engagement: 20, rated_engagement: null, rated_reach: null }
];

test('organic totals: counts summed, growth from follows else from the two ends, rate over rated posts', () => {
  const all = organicTotals({ series, followers, postTotals });
  assert.equal(all.views, 170);
  assert.equal(all.engagement, 14);
  assert.equal(all.profileVisits, 7);
  assert.equal(all.followers, 21419 + 17946);
  assert.equal(all.growth, 7 + 46, 'Instagram reports follows (8 − 1); the Page only its counts (17946 − 17900)');
  assert.equal(all.posts, 5);
  assert.equal(all.engagementRate, 10);

  const fb = organicTotals({ series, followers, postTotals }, ['facebook']);
  assert.equal(fb.engagementRate, null, 'no post with both figures: no rate');
  assert.equal(fb.linkTaps, null);
});

test('no stored day and no post: posts are unknown, not zero', () => {
  assert.equal(organicTotals({}).posts, null);
  assert.equal(organicTotals({ series }, ['instagram']).posts, 0);
});

test('series sum accounts per bucket and keep unmeasured buckets null', () => {
  assert.deepEqual(bucketSeries(series, 'engagement'), [
    { bucket: '2026-09-01T00:00:00', value: 14 },
    { bucket: '2026-09-02T00:00:00', value: null }
  ]);
  assert.deepEqual(bucketSeries(series, netFollows, ['instagram']), [
    { bucket: '2026-09-01T00:00:00', value: 4 },
    { bucket: '2026-09-02T00:00:00', value: 3 }
  ]);
});

test('paid totals never add currencies, and rebuild the rates', () => {
  const totals = paidTotals([
    { kind: 'meta_ads', currency: 'EUR', spend: '100', impressions: 10000, clicks: 200, conversions: '5', conversion_value: '342' },
    { kind: 'google_ads', currency: 'EUR', spend: '50', impressions: 5000, clicks: 50, conversions: '0', conversion_value: '0' },
    { kind: 'google_ads', currency: 'GBP', spend: '10', impressions: 100, clicks: 0, conversions: '0', conversion_value: '0' }
  ]);
  const eur = totals.find((t) => t.currency === 'EUR');
  assert.equal(eur.spend, 150);
  assert.equal(eur.ctr, (250 / 15000) * 100);
  assert.equal(eur.cpc, 150 / 250);
  assert.equal(eur.cpa, 30);
  assert.equal(eur.roas, 342 / 150);
  const gbp = totals.find((t) => t.currency === 'GBP');
  assert.equal(gbp.cpc, null, 'no clicks: no cost per click');
  assert.equal(gbp.roas, 0);
});

test('drivers: four in order, the rate in points, bars against the largest move', () => {
  const drivers = organicDrivers(
    { views: 118.4, engagement: 111.2, growth: 106.9, engagementRate: 5.86 },
    { views: 100, engagement: 100, growth: 100, engagementRate: 6.26 }
  );
  assert.deepEqual(drivers.map((d) => d.key), ['views', 'engagement', 'growth', 'engagementRate']);
  assert.ok(Math.abs(drivers[0].change - 18.4) < 1e-9);
  assert.ok(Math.abs(drivers[3].change - -0.4) < 1e-9);
  assert.equal(drivers[0].share, 1);
  assert.equal(driverSummary(drivers), 'exposureUpRateDown');
  assert.equal(driverSummary(organicDrivers({ views: 1 }, null)), 'none');
});

test('post activity: counts by type and tag, and the best hours and weekdays by average engagement', async () => {
  const { postActivity } = await import('./social-figures.mjs');
  const post = (id, publishedAt, engagement, mediaType = 'image') => ({ accountId: 'a', id, mediaType, publishedAt, engagement });
  const posts = [
    post('1', '2026-10-05T07:30:00Z', 100), // Mon 09:30 Paris
    post('2', '2026-10-05T07:45:00Z', 300, 'reel'), // Mon 09:45 Paris
    post('3', '2026-10-06T16:00:00Z', 50), // Tue 18:00 Paris
    post('4', '2026-10-07T10:00:00Z', null) // no engagement measured
  ];
  const out = postActivity(posts, [{ id: 't1', name: 'promo' }, { id: 't2', name: 'unused' }], [{ tagId: 't1', accountId: 'a', postId: '1' }, { tagId: 't1', accountId: 'a', postId: 'gone' }], 'Europe/Paris');
  assert.deepEqual(out.byType, [{ key: 'image', posts: 3 }, { key: 'reel', posts: 1 }]);
  assert.deepEqual(out.byTag, [{ id: 't1', name: 'promo', posts: 1 }], 'a tag on a post outside the set is not counted, and an unused tag is left out');
  assert.equal(out.untagged, 3);
  assert.deepEqual(out.peakHours[0], { slot: 9, average: 200, posts: 2 });
  assert.deepEqual(out.peakDays[0], { slot: 0, average: 200, posts: 2 });
  assert.ok(out.peakHours.every((h) => h.slot !== 12), 'a post with no engagement does not make a slot');
});

test('engagement rate by basis: per post, and pooled per platform', async () => {
  const { postEngagementRate, organicTotals } = await import('./social-figures.mjs');
  const post = { engagement: 50, reach: 400, views: 1000 };
  assert.equal(postEngagementRate(post, 'reach', 5000), 12.5);
  assert.equal(postEngagementRate(post, 'views', 5000), 5);
  assert.equal(postEngagementRate(post, 'followers', 5000), 1);
  assert.equal(postEngagementRate(post, 'followers', null), null, 'no follower count, no rate');
  assert.equal(postEngagementRate({ ...post, views: 0 }, 'views', 5000), null, 'a zero denominator is not a rate');

  const totals = [
    { kind: 'instagram', account_id: 'a', posts: 3, engagement: 150, engaged_posts: 3, rated_engagement: 100, rated_reach: 800, rated_views_engagement: 150, rated_views: 3000 },
    { kind: 'facebook', account_id: 'b', posts: 2, engagement: 20, engaged_posts: 2, rated_engagement: 20, rated_reach: 200, rated_views_engagement: null, rated_views: null }
  ];
  const followers = [{ kind: 'instagram', account_id: 'a', followers_end: 1000 }, { kind: 'facebook', account_id: 'b', followers_end: 500 }];
  const rate = (kinds, bases) => organicTotals({ postTotals: totals, followers }, kinds, bases).engagementRate;
  assert.equal(rate(['instagram'], {}), 12.5, 'reach is the default');
  assert.equal(rate(['instagram'], { instagram: 'views' }), 5);
  assert.equal(rate(['instagram'], { instagram: 'followers' }), 5, '150 interactions over 3 posts × 1000 followers');
  assert.equal(rate(['instagram', 'facebook'], {}), 12, 'two platforms on the same basis pool: 120 / 1000');
  assert.equal(rate(['instagram', 'facebook'], { instagram: 'views' }), null, 'two definitions are not pooled');
});
