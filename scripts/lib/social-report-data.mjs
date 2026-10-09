import { createHash } from 'node:crypto';
import { effectiveRules } from './social-bands.mjs';

export const shiftMonth = (month, delta) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
};
export const endOfMonth = month => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).toISOString().slice(0, 10);
export function dateInZone(value, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type).value).join('-');
}
const number = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const sum = values => values.length && values.every(v => v !== null) ? values.reduce((a, b) => a + b, 0) : null;

/**
 * @typedef {{id: string, kind: string, enabled: boolean, engagement_basis?: string}} Account
 * @typedef {{account_id: string, day: string, followers: number|null, views: number|null, engagement: number|null, profile_visits: number|null, link_taps: number|null, posts: number|null}} Day
 * @typedef {{account_id: string, external_id: string, published_at: string, fetched_at: string, insights_at: string|null, caption_excerpt: string|null, media_type: string|null, views: number|null, reach: number|null, likes: number|null, comments: number|null, shares: number|null, saves: number|null, follows: number|null, engagement: number|null}} Post
 * @typedef {{account_id: string, captured_on: string, dimension: string, key: string, value: number}} Audience
 */
/**
 * @param {{companyId: string, timezone: string, endMonth: string, asOf: string, accounts: Account[], days: Day[], posts: Post[], audience: Audience[], tags?: {id: string, name: string}[], links?: {accountId: string, postId: string, tagId: string}[], bands?: {kind: string, metric: string, mode: string, low: number|null, high: number|null}[]}} input
 * Strict, dated adapter. No daily unique reach, post shortlist, or current demographic substitution. */
export function adaptSocialReport({ companyId, timezone, endMonth, asOf, accounts, days, posts, audience, tags = [], links = [], bands = [] }) {
  const enabled = accounts.filter(a => a.enabled && ['instagram', 'facebook', 'tiktok'].includes(a.kind));
  const platforms = [...new Set(enabled.map(a => a.kind))].map(kind => {
    const group = enabled.filter(a => a.kind === kind);
    const ids = new Set(group.map(a => a.id));
    const rows = days.filter(d => ids.has(d.account_id));
    const byDay = new Map(rows.map(d => [d.account_id + '|' + d.day, d]));
    const monthly = Array.from({ length: 24 }, (_, i) => {
      const month = shiftMonth(endMonth, i - 23), end = endOfMonth(month);
      const dates = Array.from({ length: +end.slice(8) }, (_, j) => month + '-' + String(j + 1).padStart(2, '0'));
      const cells = group.flatMap(a => dates.map(day => byDay.get(a.id + '|' + day)));
      const complete = end < asOf && cells.every(Boolean);
      const total = column => complete ? sum(cells.map(d => number(d[column]))) : null;
      const priorDay = new Date(Date.parse(month + '-01T00:00:00Z') - 86400000).toISOString().slice(0, 10);
      const followersAt = day => sum(group.map(a => number(byDay.get(a.id + '|' + day)?.followers)));
      return { month, status: complete ? 'complete' : 'partial', views: total('views'), interactions: total('engagement'),
        profileVisits: total('profile_visits'), linkTaps: total('link_taps'), postsPublished: total('posts'),
        followersStart: followersAt(priorDay), followersEnd: end < asOf ? followersAt(end) : null,
        impressions: null, likes: null, comments: null, shares: null, saves: null };
    });
    const eligibleAudience = audience.filter(a => ids.has(a.account_id) && a.captured_on <= endOfMonth(endMonth));
    const dates = [...new Set(eligibleAudience.map(a => a.captured_on))].sort();
    const audienceSnapshots = dates.filter(date => group.every(a => eligibleAudience.some(r => r.account_id === a.id && r.captured_on === date))).map(date => {
      const buckets = dimension => {
        if (!group.every(a => eligibleAudience.some(r => r.account_id === a.id && r.captured_on === date && r.dimension === dimension))) return [];
        const counts = new Map();
        for (const row of eligibleAudience.filter(r => r.captured_on === date && r.dimension === dimension)) counts.set(row.key, (counts.get(row.key) ?? 0) + Number(row.value));
        const total = [...counts.values()].reduce((a, b) => a + b, 0);
        return total > 0 ? [...counts].map(([label, value]) => ({ label: dimension === 'gender' ? ({ M: 'Male', F: 'Female', U: 'Unknown' }[label] ?? label) : label, value: value / total * 100 })) : [];
      };
      return { asOf: date, basis: 'followers', gender: buckets('gender'), age: buckets('age'), countries: buckets('country') };
    });
    return { id: kind, name: kind === 'instagram' ? 'Instagram' : kind === 'tiktok' ? 'TikTok' : 'Facebook', scope: 'account', monthly,
      engagementBasis: group[0].engagement_basis ?? 'reach',
      bandRules: effectiveRules(bands.filter(b => b.kind === kind)),
      followersByMonth: Object.fromEntries(monthly.map(m => [m.month, Object.fromEntries(group.map(a => [a.id, number(byDay.get(a.id + '|' + endOfMonth(m.month))?.followers)]))])),
      nativePeriodMetrics: /** @type {{start: string, end: string, reach: number|null, accountsEngaged: number|null, nonFollowerShare: number|null, nonFollowerBasis: string|null, provenance: string}[]} */ ([]), audienceSnapshots,
      posts: posts.filter(p => ids.has(p.account_id)).map(p => {
        // Base counts and insights are overwritten independently. Use the later observation conservatively.
        const observed = [p.fetched_at, p.insights_at].filter(Boolean).sort().at(-1);
        const postTags = links.filter(l => l.accountId === p.account_id && l.postId === p.external_id).map(l => tags.find(t => t.id === l.tagId)?.name).filter(Boolean);
        return { id: p.account_id + ':' + p.external_id, accountId: p.account_id, publishedAt: dateInZone(p.published_at, timezone),
          observedAt: observed ? dateInZone(observed, timezone) : asOf, caption: p.caption_excerpt ?? '', format: p.media_type ?? '', pillar: postTags.join(' · '),
          views: number(p.views), reach: number(p.reach), likes: number(p.likes), comments: number(p.comments), shares: number(p.shares), saves: number(p.saves),
          interactions: number(p.engagement), follows: number(p.follows), nonFollowerShare: null, nonFollowerBasis: null, metricScope: 'lifetime-at-snapshot' };
      }), activityTimes: null };
  });
  const data = { schemaVersion: 1, companyId, isDemo: false, source: 'Connected dashboard · provider-reported account activity (paid activity is not separately identified). Daily metrics use the provider clock; post dates use the company timezone. Historical post observations are not retained; only observations on or before the report end are eligible. Exact-period reach is available only for a single Instagram account over a complete period of at most 30 days. Account follower splits and audience activity windows are unavailable.', asOf, timezone, currency: 'EUR', platforms };
  return { ...data, datasetVersion: socialReportVersion(data) };
}

export function socialReportVersion(data) {
  const { datasetVersion, ...snapshot } = data;
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 20);
}
