/**
 * The date range every Insights panel is read over, and the platform filter
 * beside it. Pure and isomorphic: the services resolve a range from the URL, the
 * filter bar renders the same presets, and the charts label the same buckets.
 *
 * WALL-CLOCK, NOT INSTANTS. A range is held as wall-clock timestamps in the
 * shop's timezone ('2026-09-01T00:00:00'), and the database converts them with
 * `at time zone` (see RANGED READS in 06_analytics.sql). Arithmetic here runs on
 * Dates whose UTC fields ARE the wall-clock fields, so a day is always 24 hours
 * of wall-clock and daylight saving is Postgres's problem, where it is solved.
 *
 * Series keys are the same strings PostgREST returns for a `timestamp` column,
 * so a bucket from SQL and a bucket generated here compare with `===`.
 */

// --- presets ----------------------------------------------------------------

/** The ranges the bar offers. Anything else is a custom from/to. */
export const RANGE_PRESETS = Object.freeze([
  { id: '24h', label: 'Last 24 hours', short: '24 h' },
  { id: '7d', label: 'Last 7 days', short: '7 days' },
  { id: '30d', label: 'Last 30 days', short: '30 days' },
  { id: '6m', label: 'Last 6 months', short: '6 months' },
  { id: '1y', label: 'Last year', short: '12 months' }
]);

export const DEFAULT_PRESET = '30d';

const PRESET_SHAPE = {
  '24h': { grain: 'hour', count: 24 },
  '7d': { grain: 'day', count: 7 },
  '30d': { grain: 'day', count: 30 },
  '6m': { grain: 'week', count: 26 },
  '1y': { grain: 'month', count: 12 }
};

/** A custom range longer than this is refused rather than drawn as 600 bars. */
const MAX_CUSTOM_DAYS = 366 * 5;

// --- platforms --------------------------------------------------------------

/**
 * Which sales channel handles make up each platform.
 *
 * A BUSINESS JUDGEMENT, SO IT LIVES HERE AND NOT IN SQL. Yves Rocher is not a
 * handle at all: it is the Mirakl Connect channel (`connect-dev-1`), and every
 * one of its orders is tagged `Yves Rocher FR`. Shopify is defined as every
 * channel that is NOT a marketplace — the online store, draft orders and the Shop
 * app — so a new first-party channel lands in Shopify rather than in nothing.
 */
export const MARKETPLACE_CHANNELS = Object.freeze({
  amazon: Object.freeze(['amazon']),
  yves_rocher: Object.freeze(['connect-dev-1'])
});

const ALL_MARKETPLACE_HANDLES = Object.freeze(Object.values(MARKETPLACE_CHANNELS).flat());

export const PLATFORMS = Object.freeze([
  { id: 'all', label: 'All platforms' },
  { id: 'shopify', label: 'Shopify' },
  { id: 'amazon', label: 'Amazon' },
  { id: 'yves_rocher', label: 'Yves Rocher' }
]);

export const DEFAULT_PLATFORM = 'all';

/** The channel arguments the ranged SQL functions take, for one platform. */
export function channelFilter(platform) {
  if (platform === 'amazon' || platform === 'yves_rocher') {
    return { channels: [...MARKETPLACE_CHANNELS[platform]], notChannels: null };
  }
  if (platform === 'shopify') return { channels: null, notChannels: [...ALL_MARKETPLACE_HANDLES] };
  return { channels: null, notChannels: null };
}

/** The platform a channel handle belongs to. */
export function platformOfChannel(handle) {
  for (const [platform, handles] of Object.entries(MARKETPLACE_CHANNELS)) {
    if (handles.includes(handle)) return platform;
  }
  return 'shopify';
}

/** True for a platform whose buyers are minted one customer per order. */
export function isMarketplacePlatform(platform) {
  return platform === 'amazon' || platform === 'yves_rocher';
}

export { ALL_MARKETPLACE_HANDLES };

export function parsePlatform(value) {
  return PLATFORMS.some((p) => p.id === value) ? value : DEFAULT_PLATFORM;
}

// --- wall-clock arithmetic ----------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** A wall-clock Date -> the key PostgREST prints for a `timestamp`. */
export function toKey(date) {
  return date.toISOString().slice(0, 19);
}

/** A key (or `YYYY-MM-DD`) -> a wall-clock Date. */
export function fromKey(key) {
  const text = key.length === 10 ? `${key}T00:00:00` : key.slice(0, 19);
  return new Date(`${text}Z`);
}

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock reading of an instant in `tz`, as a wall-clock Date. */
export function wallClock(instant, tz) {
  const date = instant instanceof Date ? instant : new Date(instant);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return new Date(
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    )
  );
}

/** Start of the bucket containing `date`. Weeks start on Monday, as `date_trunc('week')`. */
export function truncate(date, grain) {
  const d = new Date(date.getTime());
  d.setUTCMinutes(0, 0, 0);
  if (grain === 'hour') return d;
  d.setUTCHours(0);
  if (grain === 'day') return d;
  if (grain === 'week') {
    const offset = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - offset);
    return d;
  }
  d.setUTCDate(1);
  return d;
}

/** `date` moved by `n` buckets. Months move on the calendar, not by 30 days. */
export function step(date, grain, n = 1) {
  const d = new Date(date.getTime());
  if (grain === 'hour') d.setUTCHours(d.getUTCHours() + n);
  else if (grain === 'day') d.setUTCDate(d.getUTCDate() + n);
  else if (grain === 'week') d.setUTCDate(d.getUTCDate() + 7 * n);
  else d.setUTCMonth(d.getUTCMonth() + n);
  return d;
}

/** Every bucket key from the one containing `from` up to (not including) `to`. */
export function bucketKeys(from, to, grain) {
  const keys = [];
  for (let d = truncate(from, grain); d < to; d = step(d, grain)) keys.push(toKey(d));
  return keys;
}

/** The grain a custom span is drawn at: enough points to read, never hundreds. */
export function grainForSpan(days) {
  if (days <= 2) return 'hour';
  if (days <= 62) return 'day';
  if (days <= 190) return 'week';
  return 'month';
}

// --- resolving a range --------------------------------------------------------

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The range a request asks for, resolved against the shop clock.
 *
 * `from`/`to` are wall-clock keys, half-open. `to` is the END of the current
 * bucket, so today's bar exists and is marked partial rather than missing.
 *
 * THE COMPARISON IS LIKE FOR LIKE. `previous` covers the same ELAPSED time one
 * span earlier — the last 30 days, 14:00 today, against the 30 days before that
 * up to 14:00 — so a period still in progress is never set against a finished
 * one. Comparing half a day of today with a whole day would invent a drop.
 *
 * Unknown or invalid input falls back to the default preset rather than
 * throwing: a mistyped URL should show the dashboard, not an error page.
 */
export function resolveRange(query = {}, { tz = 'UTC', now = new Date() } = {}) {
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const nowWall = wallClock(now, zone);
  const today = truncate(nowWall, 'day');

  const custom = parseCustom(query, today);
  if (custom) {
    const { fromDay, toDay } = custom;
    const from = fromDay;
    const to = step(toDay, 'day');
    const days = Math.round((to - from) / DAY_MS);
    const grain = grainForSpan(days);
    const effectiveEnd = to < nowWall ? to : nowWall;
    const span = to - from;
    const previousFrom = new Date(from.getTime() - span);
    const previousTo = new Date(previousFrom.getTime() + (effectiveEnd - from));
    return finalise({
      preset: 'custom',
      from,
      to,
      grain,
      nowWall,
      previousFrom,
      previousTo,
      tz: zone,
      label: `${formatDay(from)} – ${formatDay(toDay)}`,
      compareLabel: `previous ${days} day${days === 1 ? '' : 's'}`
    });
  }

  const preset = PRESET_SHAPE[query.range] ? query.range : DEFAULT_PRESET;
  const { grain, count } = PRESET_SHAPE[preset];
  const to = step(truncate(nowWall, grain), grain);
  const from = step(to, grain, -count);
  const previousFrom = step(from, grain, -count);
  const previousTo = step(nowWall, grain, -count);
  const meta = RANGE_PRESETS.find((p) => p.id === preset);

  return finalise({
    preset,
    from,
    to,
    grain,
    nowWall,
    previousFrom,
    previousTo,
    tz: zone,
    label: meta.label,
    compareLabel: `previous ${meta.short}`
  });
}

function parseCustom(query, today) {
  const { from, to } = query;
  if (!ISO_DATE.test(from ?? '') || !ISO_DATE.test(to ?? '')) return null;
  const fromDay = fromKey(from);
  let toDay = fromKey(to);
  if (Number.isNaN(fromDay.getTime()) || Number.isNaN(toDay.getTime())) return null;
  if (toDay > today) toDay = today;
  if (fromDay > toDay) return null;
  if ((toDay - fromDay) / DAY_MS > MAX_CUSTOM_DAYS) return null;
  return { fromDay, toDay };
}

function finalise({ preset, from, to, grain, nowWall, previousFrom, previousTo, tz, label, compareLabel }) {
  const keys = bucketKeys(from, to, grain);
  return {
    preset,
    tz,
    grain,
    label,
    compareLabel,
    from: toKey(from),
    to: toKey(to),
    now: toKey(nowWall),
    previous: { from: toKey(previousFrom), to: toKey(previousTo) },
    keys,
    // The bar still being filled in: the one that holds "now". A custom range
    // that ended yesterday has none.
    currentKey: keys.find((key, i) => {
      const start = fromKey(key);
      const end = i + 1 < keys.length ? fromKey(keys[i + 1]) : to;
      return start <= nowWall && nowWall < end;
    }) ?? null,
    // The query that reproduces this range, for links that must keep it.
    query: preset === 'custom' ? { from: toKey(from).slice(0, 10), to: toKey(step(to, 'day', -1)).slice(0, 10) } : { range: preset }
  };
}

// --- coverage -----------------------------------------------------------------

/**
 * Each bucket's standing against what a source actually holds.
 *
 *   'measured'  inside the source's coverage: an empty bucket here is a real 0
 *   'partial'   the source's edge, or "now", falls inside it
 *   'missing'   wholly before the source begins or after it was last synced
 *
 * `coverage.from` / `coverage.through` are INSTANTS (from the freshness row) and
 * are converted to the shop clock here. A null edge means unbounded on that side.
 * This is what keeps "no mail synced after 20 August" from drawing as zero mail.
 */
export function bucketCoverage(range, coverage = {}) {
  const start = coverage.from ? wallClock(coverage.from, range.tz) : null;
  const through = coverage.through ? wallClock(coverage.through, range.tz) : null;
  const nowWall = fromKey(range.now);
  const to = fromKey(range.to);

  return range.keys.map((key, i) => {
    const bucketStart = fromKey(key);
    const bucketEnd = i + 1 < range.keys.length ? fromKey(range.keys[i + 1]) : to;
    if (start && bucketEnd <= start) return 'missing';
    if (through && bucketStart > through) return 'missing';
    if (bucketStart > nowWall) return 'missing';
    if (start && bucketStart < start) return 'partial';
    if (through && through < bucketEnd) return 'partial';
    if (nowWall < bucketEnd) return 'partial';
    return 'measured';
  });
}

/**
 * Whether a window is inside a source's coverage, so a comparison against it
 * means anything. The previous 30 days starting before the first synced mail is
 * not a quiet period, it is an unmeasured one.
 */
export function windowCovered(window, coverage = {}, tz = 'UTC') {
  if (coverage.from && fromKey(window.from) < wallClock(coverage.from, tz)) return false;
  return true;
}

// --- series and deltas --------------------------------------------------------

/**
 * Line a sparse series up with the range's buckets.
 *
 * SQL returns only non-empty buckets; every other key gets `empty(key)`. The
 * key is normalised to the 19-character form because PostgREST and pg format a
 * `timestamp` differently, and a series keyed one way and looked up the other
 * would read as empty everywhere.
 */
export function fillSeries(keys, rows, keyOf, empty) {
  const byKey = new Map(rows.map((row) => [normaliseKey(keyOf(row)), row]));
  return keys.map((key) => byKey.get(key) ?? empty(key));
}

export function normaliseKey(value) {
  if (value instanceof Date) return toKey(value);
  return String(value).replace(' ', 'T').slice(0, 19);
}

/**
 * The change against the previous period, as a fraction, or null where no
 * honest comparison exists — nothing to compare with, or a baseline of zero
 * (where every change is infinite and no percentage means anything).
 */
export function change(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

// --- labels -------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDay(date) {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** The axis label for one bucket. */
export function bucketLabel(key, grain) {
  const d = fromKey(key);
  if (grain === 'hour') return `${pad(d.getUTCHours())}:00`;
  if (grain === 'month') return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The tooltip label for one bucket: says what span the point covers. */
export function bucketTitle(key, grain) {
  const d = fromKey(key);
  if (grain === 'hour') return `${formatDay(d)}, ${pad(d.getUTCHours())}:00–${pad((d.getUTCHours() + 1) % 24)}:00`;
  if (grain === 'day') return `${DAY_NAMES[d.getUTCDay()]} ${formatDay(d)}`;
  if (grain === 'week') return `Week of ${formatDay(d)}`;
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];

/** A wall-clock key as a short date for the range pill: `11 Sep 2026`. */
export function formatKeyDay(key) {
  return formatDay(fromKey(key));
}
