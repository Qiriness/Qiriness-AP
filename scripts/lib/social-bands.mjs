// Low / medium / high bands for the Post insights table (83_social_metric_bands).
//
// A RULE is { mode, low, high }. `mode` says what the two limits are relative to:
//   off        no colour
//   absolute   the metric itself (a count; a % for the engagement rate)
//   followers  the metric as a % of the account's followers
//   median     the metric as a % of the median of the platform's posts shown
// Below `low` is LOW, `high` and above is HIGH, between is MEDIUM. Every number
// that varies per business is data: the suggestions below are only a start,
// each platform's rules are the team's to change.
//
// Pure, so it is tested without a database or a screen.

export const BAND_METRICS = ['views', 'reach', 'engagement', 'engagementRate', 'likes', 'comments', 'shares', 'follows'];
export const BAND_MODES = ['off', 'absolute', 'followers', 'median'];

/** The engagement rate is already a ratio, so « % of followers » would divide a percentage. */
export function modesFor(metric) {
  return metric === 'engagementRate' ? ['off', 'absolute', 'median'] : BAND_MODES;
}

/** Suggested rules; a metric not listed starts off. */
export const DEFAULT_BANDS = {
  views: { mode: 'median', low: 50, high: 150 },
  reach: { mode: 'followers', low: 100, high: 300 },
  engagementRate: { mode: 'absolute', low: 3, high: 10 }
};

const OFF = { mode: 'off', low: null, high: null };

/** The rule a platform uses for a metric: its stored one, else the suggestion, else off. */
export function ruleFor(metric, stored) {
  return stored ?? DEFAULT_BANDS[metric] ?? OFF;
}

/** Stored rows ({ metric, mode, low, high }) -> one rule per metric, stored over suggested. */
export function effectiveRules(rows = []) {
  const stored = new Map(
    rows.map((r) => [r.metric, { mode: r.mode, low: r.low === null ? null : Number(r.low), high: r.high === null ? null : Number(r.high) }])
  );
  return Object.fromEntries(BAND_METRICS.map((metric) => [metric, ruleFor(metric, stored.get(metric))]));
}

/** A rule from user input, or the reason it is not one. */
export function validateRule(metric, input) {
  if (!BAND_METRICS.includes(metric)) return { ok: false, error: `unknown metric ${JSON.stringify(metric)}` };
  const mode = input?.mode;
  if (!modesFor(metric).includes(mode)) return { ok: false, error: `${metric} cannot be measured as ${JSON.stringify(mode)}` };
  if (mode === 'off') return { ok: true, rule: OFF };
  const blank = (v) => v === '' || v === null || v === undefined;
  const low = Number(input.low);
  const high = Number(input.high);
  if (blank(input.low) || blank(input.high) || !Number.isFinite(low) || !Number.isFinite(high)) {
    return { ok: false, error: `${metric}: both limits must be numbers` };
  }
  if (low < 0 || high < 0) return { ok: false, error: `${metric}: limits cannot be negative` };
  if (low > high) return { ok: false, error: `${metric}: the low limit is above the high limit` };
  return { ok: true, rule: { mode, low, high } };
}

/** The median of the known numbers, or null when there are none. */
export function median(values) {
  const known = values.filter((v) => v !== null && v !== undefined && Number.isFinite(v)).sort((a, b) => a - b);
  if (known.length === 0) return null;
  const mid = Math.floor(known.length / 2);
  return known.length % 2 ? known[mid] : (known[mid - 1] + known[mid]) / 2;
}

/**
 * 'low' | 'medium' | 'high', or null when there is no colour to give: the metric
 * is off, the value is unknown, or what it is measured against is (no follower
 * count, a zero median).
 */
export function bandOf(value, rule, { followers = null, median: med = null } = {}) {
  if (!rule || rule.mode === 'off' || value === null || value === undefined) return null;
  let measured = null;
  if (rule.mode === 'absolute') measured = value;
  else if (rule.mode === 'followers') measured = followers > 0 ? (value / followers) * 100 : null;
  else if (rule.mode === 'median') measured = med > 0 ? (value / med) * 100 : null;
  if (measured === null) return null;
  if (measured < rule.low) return 'low';
  if (measured >= rule.high) return 'high';
  return 'medium';
}

/**
 * Each post's band per metric, for the posts of ONE platform. Medians are of
 * that platform's posts as given.
 *
 * @param {Record<string, any>[]} posts   with the metric fields and accountId
 * @param {Record<string, {mode: string, low: number|null, high: number|null}>} rules  from effectiveRules
 * @param {Map<string, number|null>} followersByAccount
 * @returns {Record<string, 'low'|'medium'|'high'>[]} one object per post, same order; only metrics that have a band
 */
export function bandPosts(posts, rules, followersByAccount) {
  const medians = Object.fromEntries(BAND_METRICS.filter((m) => rules[m]?.mode === 'median').map((m) => [m, median(posts.map((p) => p[m]))]));
  return posts.map((post) => {
    const out = {};
    for (const metric of BAND_METRICS) {
      const band = bandOf(post[metric], rules[metric], { followers: followersByAccount.get(post.accountId) ?? null, median: medians[metric] ?? null });
      if (band) out[metric] = band;
    }
    return out;
  });
}
