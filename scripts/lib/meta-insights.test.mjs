import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dayWindows,
  daysBetween,
  foldAdInsights,
  foldAudience,
  foldInstagramDay,
  foldInstagramMedia,
  foldPageDays,
  foldPagePost,
  postsPerDay
} from './meta-insights.mjs';

test('days and windows are inclusive and oldest first', () => {
  assert.deepEqual(daysBetween('2026-01-30', '2026-02-02'), ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
  assert.deepEqual(dayWindows('2026-01-01', '2026-01-05', 2), [
    { since: '2026-01-01', until: '2026-01-02' },
    { since: '2026-01-03', until: '2026-01-04' },
    { since: '2026-01-05', until: '2026-01-05' }
  ]);
});

test('an Instagram day keeps what Meta answered and leaves the rest unmeasured', () => {
  const row = foldInstagramDay([
    { name: 'views', total_value: { value: 1200 } },
    { name: 'total_interactions', total_value: { value: 85 } }
  ]);
  assert.deepEqual(row, { views: 1200, engagement: 85 });
  assert.equal('profile_visits' in row, false);
});

test('follows and unfollows come from one breakdown, and an empty one is a measured zero', () => {
  const answered = foldInstagramDay([], [
    {
      name: 'follows_and_unfollows',
      total_value: { breakdowns: [{ dimension_keys: ['follow_type'], results: [{ dimension_values: ['FOLLOWER'], value: 12 }, { dimension_values: ['NON_FOLLOWER'], value: 3 }] }] }
    }
  ]);
  assert.deepEqual(answered, { follows: 12, unfollows: 3 });
  const quiet = foldInstagramDay([], [{ name: 'follows_and_unfollows', total_value: { breakdowns: [{ results: [] }] } }]);
  assert.deepEqual(quiet, { follows: 0, unfollows: 0 });
  assert.deepEqual(foldInstagramDay([], []), {});
});

test("a Page value belongs to the day before its end_time", () => {
  const days = foldPageDays([
    { name: 'page_post_engagements', period: 'day', values: [{ value: 40, end_time: '2026-09-02T07:00:00+0000' }, { value: 7, end_time: '2026-09-03T07:00:00+0000' }] },
    { name: 'page_follows', period: 'day', values: [{ value: 17946, end_time: '2026-09-02T07:00:00+0000' }] },
    { name: 'page_unknown_metric', period: 'day', values: [{ value: 1, end_time: '2026-09-02T07:00:00+0000' }] }
  ]);
  assert.deepEqual(days.get('2026-09-01'), { engagement: 40, followers: 17946 });
  assert.deepEqual(days.get('2026-09-02'), { engagement: 7 });
  assert.equal(days.size, 2);
});

test('posts are counted on their UTC day', () => {
  const counts = postsPerDay(['2026-09-01T10:00:00+0000', '2026-09-01T23:00:00+0000', '2026-09-02T01:00:00+0000']);
  assert.deepEqual([...counts], [['2026-09-01', 2], ['2026-09-02', 1]]);
});

test('an Instagram post folds its fields and insights; engagement prefers Meta total', () => {
  const media = {
    id: '1789',
    caption: 'Morning   skincare ritual\n3 steps',
    media_type: 'VIDEO',
    media_product_type: 'REELS',
    permalink: 'https://instagram.example/p/1',
    thumbnail_url: 'https://cdn.example/t.jpg',
    timestamp: '2026-09-28T08:00:00+0000',
    like_count: 1193,
    comments_count: 102
  };
  const post = foldInstagramMedia(media, [
    { name: 'views', values: [{ value: 18420 }] },
    { name: 'reach', values: [{ value: 14720 }] },
    { name: 'shares', values: [{ value: 253 }] },
    { name: 'saved', values: [{ value: 0 }] },
    { name: 'total_interactions', values: [{ value: 1548 }] }
  ]);
  assert.equal(post.media_type, 'reel');
  assert.equal(post.caption_excerpt, 'Morning skincare ritual 3 steps');
  assert.equal(post.views, 18420);
  assert.equal(post.likes, 1193);
  assert.equal(post.engagement, 1548);
  assert.equal(post.follows, null);

  const bare = foldInstagramMedia({ ...media, media_product_type: 'FEED', media_type: 'IMAGE' }, []);
  assert.equal(bare.media_type, 'image');
  assert.equal(bare.engagement, 1193 + 102);
  assert.equal(bare.views, null);
});

test('a Page post sums reactions, comments and shares; no shares field is zero shares', () => {
  const post = foldPagePost(
    {
      id: '1_2',
      message: 'Source d’Eau ingredient focus',
      created_time: '2026-09-12T09:00:00+0000',
      status_type: 'added_photos',
      reactions: { summary: { total_count: 610 } },
      comments: { summary: { total_count: 91 } }
    },
    [{ name: 'post_total_media_view_unique', values: [{ value: 7903 }] }]
  );
  assert.equal(post.shares, 0);
  assert.equal(post.engagement, 701);
  assert.equal(post.reach, 7903);
  assert.equal(post.views, null);
  assert.equal(post.media_type, 'added photos');
});

test('audience buckets are counts; gender is spelled out', () => {
  const rows = foldAudience('gender', [
    { name: 'follower_demographics', total_value: { breakdowns: [{ results: [{ dimension_values: ['F'], value: 690 }, { dimension_values: ['M'], value: 87 }, { dimension_values: ['U'], value: 223 }] }] } }
  ]);
  assert.deepEqual(rows, [
    { dimension: 'gender', key: 'female', value: 690 },
    { dimension: 'gender', key: 'male', value: 87 },
    { dimension: 'gender', key: 'unknown', value: 223 }
  ]);
  assert.deepEqual(foldAudience('city', []), []);
});

test('ad insights: one row per day and publisher, conversions of the chosen action only', () => {
  const rows = foldAdInsights(
    [
      {
        date_start: '2026-09-01',
        publisher_platform: 'instagram',
        spend: '12.345',
        impressions: '1000',
        clicks: '20',
        account_currency: 'EUR',
        actions: [{ action_type: 'link_click', value: '20' }, { action_type: 'omni_purchase', value: '2' }],
        action_values: [{ action_type: 'omni_purchase', value: '80.50' }]
      },
      { date_start: '2026-09-01', publisher_platform: 'facebook', spend: '5', impressions: '400', clicks: '4', account_currency: 'EUR' },
      { date_start: '2026-09-01', publisher_platform: 'something_new', spend: '1', impressions: '1', clicks: '0', account_currency: 'EUR' }
    ],
    { currency: 'EUR' }
  );
  assert.equal(rows.length, 3);
  const ig = rows.find((r) => r.publisher === 'instagram');
  assert.deepEqual(ig, { day: '2026-09-01', publisher: 'instagram', currency: 'EUR', spend: 12.35, impressions: 1000, clicks: 20, conversions: 2, conversion_value: 80.5 });
  assert.equal(rows.find((r) => r.publisher === 'facebook').conversions, 0);
  assert.ok(rows.find((r) => r.publisher === 'other'));

  const custom = foldAdInsights(
    [{ date_start: '2026-09-01', publisher_platform: 'facebook', spend: '1', actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '5' }], account_currency: 'EUR' }],
    { conversionAction: 'offsite_conversion.fb_pixel_purchase' }
  );
  assert.equal(custom[0].conversions, 5);
});

test('campaign insights: one row per campaign and day, the chosen action only; the list keeps effective status', async () => {
  const { foldCampaignInsights, foldMetaCampaigns } = await import('./meta-insights.mjs');
  const days = foldCampaignInsights(
    [
      { campaign_id: '120', campaign_name: 'Black Friday', date_start: '2026-09-01', spend: '40.004', impressions: '5000', clicks: '90', account_currency: 'EUR', actions: [{ action_type: 'omni_purchase', value: '3' }], action_values: [{ action_type: 'omni_purchase', value: '164' }] },
      { campaign_id: '121', campaign_name: 'Retargeting', date_start: '2026-09-01', spend: '10', impressions: '800', clicks: '12', account_currency: 'EUR' },
      { campaign_id: null, date_start: '2026-09-01', spend: '1' }
    ],
    { currency: 'EUR' }
  );
  assert.deepEqual(days[0], { campaign_id: '120', campaign_name: 'Black Friday', day: '2026-09-01', currency: 'EUR', spend: 40, impressions: 5000, clicks: 90, conversions: 3, conversion_value: 164 });
  assert.equal(days.length, 2);
  assert.deepEqual(foldMetaCampaigns([{ id: 120, name: 'Black Friday', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED', objective: 'OUTCOME_SALES' }, {}]), [
    { external_id: '120', name: 'Black Friday', status: 'CAMPAIGN_PAUSED', objective: 'OUTCOME_SALES' }
  ]);
});
