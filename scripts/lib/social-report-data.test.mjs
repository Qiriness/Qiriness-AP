import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptSocialReport, dateInZone, socialReportVersion } from './social-report-data.mjs';
import { renderSocialReport, socialReportState } from './social-report.mjs';
import template from './social-report-template.mjs';

function fixture() {
  return {
    companyId: 'dummy-shop', timezone: 'Europe/Paris', endMonth: '2026-09', asOf: '2026-10-09',
    accounts: [{ id: 'ig', kind: 'instagram', enabled: true, engagement_basis: 'views' }, { id: 'off', kind: 'facebook', enabled: false }],
    days: Array.from({ length: 31 }, (_, i) => ({ account_id: 'ig', day: i ? `2026-09-${String(i).padStart(2, '0')}` : '2026-08-31', followers: 100 + i, views: 10, engagement: 1, profile_visits: 0, link_taps: null, posts: 0 })),
    posts: [{ account_id: 'ig', external_id: 'post', published_at: '2026-09-30T22:30:00Z', fetched_at: '2026-10-01T00:00:00Z', insights_at: '2026-10-01T00:00:00Z', caption_excerpt: 'Dummy post', media_type: 'image', views: 10, reach: 5, likes: 1, comments: 0, shares: 0, saves: 0, follows: 0, engagement: 1 }],
    audience: [{ account_id: 'ig', captured_on: '2026-09-30', dimension: 'country', key: 'Other', value: 10 }, { account_id: 'ig', captured_on: '2026-10-01', dimension: 'country', key: 'FR', value: 999 }],
    bands: [{ kind: 'instagram', metric: 'views', mode: 'absolute', low: 20, high: 100 }],
  };
}

test('TikTok reports keep lifetime video counters separate from unavailable daily activity', () => {
  const input = fixture();
  input.accounts = [{ id: 'tik', kind: 'tiktok', enabled: true, engagement_basis: 'views' }];
  input.days = input.days.map(({ day, followers }) => ({ account_id: 'tik', day, followers }));
  input.posts = [{ ...input.posts[0], account_id: 'tik', published_at: '2026-09-20T10:00:00Z', insights_at: '2026-09-30T10:00:00Z', views: 120, reach: null }];
  const platform = adaptSocialReport(input).platforms[0];
  assert.equal(platform.id, 'tiktok');
  assert.equal(platform.name, 'TikTok');
  assert.equal(platform.monthly.at(-1).views, null);
  assert.equal(platform.monthly.at(-1).followersEnd, 130);
  assert.equal(platform.posts[0].views, 120);
  assert.equal(platform.posts[0].metricScope, 'lifetime-at-snapshot');
  assert.equal(platform.posts[0].reach, null);
});

test('complete month totals preserve zero, null, exact followers and platform selection', () => {
  const data = adaptSocialReport(fixture());
  assert.equal(data.isDemo, false);
  assert.equal(data.platforms.length, 1);
  const month = data.platforms[0].monthly.at(-1);
  assert.equal(month.status, 'complete');
  assert.equal(month.views, 300);
  assert.equal(month.profileVisits, 0);
  assert.equal(month.linkTaps, null);
  assert.equal(month.followersStart, 100);
  assert.equal(month.followersEnd, 130);
  assert.deepEqual(data.platforms[0].nativePeriodMetrics, []);
  assert.equal(data.platforms[0].posts[0].publishedAt, '2026-10-01');
  assert.equal(data.platforms[0].audienceSnapshots.length, 2);
  assert.deepEqual(data.platforms[0].audienceSnapshots[0].countries, [{ label: 'Other', value: 100 }]);
  assert.deepEqual(data.platforms[0].bandRules.views, { mode: 'absolute', low: 20, high: 100 });
});

test('missing day, missing metric and current month cannot become complete totals', () => {
  const input = fixture();
  input.days.pop();
  let data = adaptSocialReport(input);
  assert.equal(data.platforms[0].monthly.at(-1).status, 'partial');
  assert.equal(data.platforms[0].monthly.at(-1).views, null);
  const missingMetric = fixture();
  missingMetric.days[5].views = null;
  assert.equal(adaptSocialReport(missingMetric).platforms[0].monthly.at(-1).views, null);
  assert.equal(adaptSocialReport({ ...fixture(), asOf: '2026-09-30' }).platforms[0].monthly.at(-1).status, 'partial');
});

test('timezone boundaries and snapshot revisions follow dates and rules', () => {
  assert.equal(dateInZone('2026-09-30T23:00:00Z', 'Europe/Paris'), '2026-10-01');
  const data = adaptSocialReport(fixture());
  assert.equal(socialReportVersion(data), data.datasetVersion);
  data.platforms[0].bandRules.views.high = 200;
  assert.notEqual(socialReportVersion(data), data.datasetVersion);
});

test('historical dashboard exports retain publication date and label later lifetime observations', () => {
  const input = fixture();
  input.endMonth = '2025-12';
  input.posts[0].published_at = '2025-12-31T23:30:00Z';
  const data = adaptSocialReport(input);
  assert.equal(data.postObservationPolicy, 'latest-available');
  assert.equal(data.platforms[0].posts[0].publishedAt, '2026-01-01');
  assert.equal(data.platforms[0].posts[0].observedAt, '2026-10-01');
  assert.match(data.source, /not period-only activity totals/);
  assert.equal(data.platforms[0].monthly.at(-1).views, null);
});

test('report embeds only supplied company, escapes scripts, preserves CSS and rejects empty platforms', () => {
  const data = adaptSocialReport(fixture());
  const state = socialReportState(data, { name: '</script><script>bad()</script> $&', endMonth: '2026-09', platforms: ['instagram'] });
  const html = renderSocialReport(state);
  assert.ok(!html.includes('</script><script>bad()'));
  assert.ok(html.includes('\\u003c/script>'));
  const embedded = JSON.parse(html.match(/<script id="saved-state" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(embedded.companies.length, 1);
  assert.equal(embedded.companies[0].brand.name, state.companies[0].brand.name);
  assert.equal(html.match(/<style>[\s\S]*?<\/style>/)[0], template.match(/<style>[\s\S]*?<\/style>/)[0]);
  assert.throws(() => socialReportState(data, { name: 'Dummy', endMonth: '2026-09', platforms: [] }));
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(match[1]));
});
