/**
 * Storefront SESSIONS for closed months, kept in Supabase so a long range does
 * not have to be asked of ShopifyQL live. Money is never here: net sales and
 * AOV are read live at every range length (the owner's rule, 2026-09-24).
 *
 * WHY. ShopifyQL is rate-limited on a bucket of its own — 1,000 points a
 * minute, charged per ~30-day slice of the range. Measured 2026-09-24: one
 * year of the Overview cost 1,353 points, so it could never be answered in one
 * render, and a 6-month attempt drained the bucket and made the 7-day range
 * fail right after it. Splitting a range into monthly queries does not help:
 * six 1-month queries cost 108 against 126 for the 6-month one.
 *
 * THE SPLIT. A range is answered from stored WHOLE months that closed before
 * the live window, and ShopifyQL for everything else — the live window (this
 * month and the one before) and the stray days at either edge. A month the
 * range only partly covers is NEVER answered from the store: a range starting
 * on 30 March asks for 30–31 March live, not for all of March.
 *
 * COUNTS ONLY. Sessions, pageviews and the three funnel counts add up across
 * months; conversion is rebuilt as converted ÷ sessions, Shopify's own
 * definition. Unique visitors and bounce rate do not add up, so a range that
 * needed more than one piece reports them as unknown rather than wrong.
 *
 * Pure: no I/O. The nightly writer is storefront-months-sync.mjs; the reader
 * is web/lib/server/insights/analytics.ts.
 */

import { HUMAN_ONLY, rangeClause, toNumber } from './storefront-analytics.mjs';
import { fromKey } from './insights-range.mjs';

/**
 * How many months, counting the current one, are always read live. Two: a
 * month's sessions can still be restated shortly after it closes (bot
 * reclassification, late attribution), and the month just closed is also the
 * one a reader is most likely to check against the admin.
 */
export const LIVE_MONTHS = 2;

/**
 * How far back the nightly sync reaches. ShopifyQL caps one query's cost at
 * the bucket's 1,000, so three years is a single query whatever its length.
 */
export const LOOKBACK_MONTHS = 36;

/** The counts stored per month, in the order they are asked for. */
export const MONTH_COLUMNS = Object.freeze([
  'sessions',
  'pageviews',
  'sessions_with_cart_additions',
  'sessions_that_reached_checkout',
  'sessions_that_completed_checkout'
]);

const pad = (n) => String(n).padStart(2, '0');

/** `YYYY-MM-01T00:00:00` for the month `offset` months from the one containing `date`. */
function monthStart(date, offset = 0) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01T00:00:00`;
}

/**
 * The first moment that is always read live, on the shop's wall clock: the
 * first day of the month before the current one.
 *
 * @param {Date} nowWall the shop's wall clock, as `wallClock()` returns it
 */
export function liveFrom(nowWall, liveMonths = LIVE_MONTHS) {
  return monthStart(nowWall, -(liveMonths - 1));
}

/** The window the nightly sync stores: LOOKBACK_MONTHS closed months ending where the live window starts. */
export function storedSpan(nowWall, { liveMonths = LIVE_MONTHS, lookback = LOOKBACK_MONTHS } = {}) {
  const to = liveFrom(nowWall, liveMonths);
  return { from: monthStart(fromKey(to), -lookback), to };
}

/**
 * Which parts of a window come from the store and which are asked live.
 *
 * @param {{ from: string, to: string }} window half-open, wall-clock keys
 * @param {{ liveFrom: string, stored: Iterable<string> }} store `stored` holds
 *   the months present in the table, as `YYYY-MM-01`
 * @returns {{ months: string[], live: { from: string, to: string }[] }}
 *   `months` as `YYYY-MM-01`; `live` as contiguous half-open windows, merged
 */
export function planSessionWindow(window, { liveFrom: boundary, stored }) {
  const have = new Set([...stored].map((m) => String(m).slice(0, 10)));
  const months = [];
  const live = [];
  const addLive = (from, to) => {
    if (from >= to) return;
    const last = live[live.length - 1];
    if (last && last.to === from) last.to = to;
    else live.push({ from, to });
  };

  let cursor = window.from;
  while (cursor < window.to) {
    const start = monthStart(fromKey(cursor));
    const next = monthStart(fromKey(cursor), 1);
    const end = next < window.to ? next : window.to;
    const whole = cursor === start && end === next;
    const month = start.slice(0, 10);
    if (whole && next <= boundary && have.has(month)) months.push(month);
    else addLive(cursor, end);
    cursor = end;
  }
  return { months, live };
}

/** The monthly counts the nightly sync stores. Human sessions only, as every sessions query here. */
export function sessionMonthsQuery(window) {
  return `FROM sessions SHOW ${MONTH_COLUMNS.join(', ')} ${HUMAN_ONLY} TIMESERIES month ${rangeClause(window)}`;
}

/**
 * ShopifyQL's monthly rows -> table rows. THROWS rather than writing a guess:
 * a row with a missing count, or a bucket that is not the first of a month,
 * means the response is not what was measured, and a stored month is read as
 * the truth for as long as it sits there.
 */
export function readSessionMonths(rows = [], shopId) {
  return rows.map((row) => {
    const month = String(row.month ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-01$/.test(month)) throw new Error(`ShopifyQL month bucket is not a month: ${JSON.stringify(row.month)}`);
    const counts = MONTH_COLUMNS.map((column) => {
      const n = toNumber(row[column]);
      if (n === null || n < 0 || !Number.isInteger(n)) throw new Error(`ShopifyQL ${column} for ${month} is not a count: ${JSON.stringify(row[column])}`);
      return n;
    });
    const [sessions, pageviews, cart, checkout, converted] = counts;
    return {
      shop_id: shopId,
      month,
      sessions,
      pageviews,
      cart_sessions: cart,
      checkout_sessions: checkout,
      converted_sessions: converted
    };
  });
}

/**
 * Months whose stored counts a fresh read disagrees with. The nightly logs
 * these: a closed month that moves is the reason the live window exists, and
 * one that keeps moving past it is a reason to widen it.
 */
export function monthDrift(before = [], after = []) {
  const old = new Map(before.map((row) => [String(row.month).slice(0, 10), row]));
  const changed = [];
  for (const row of after) {
    const prior = old.get(row.month);
    if (!prior) continue;
    const fields = ['sessions', 'pageviews', 'cart_sessions', 'checkout_sessions', 'converted_sessions'].filter(
      (key) => Number(prior[key]) !== Number(row[key])
    );
    if (fields.length > 0) changed.push({ month: row.month, fields, before: Number(prior.sessions), after: row.sessions });
  }
  return changed;
}

/**
 * Stored months + live pieces -> the totals the cards read.
 *
 * ONE LIVE PIECE AND NOTHING STORED is Shopify's answer untouched — visitors,
 * bounce rate and its own conversion rate included. Anything assembled from
 * more than one piece is summed, conversion is converted ÷ sessions, and
 * visitors and bounce rate are null: they do not add up, and a sum of them
 * would be a plausible wrong number.
 *
 * @param {object[]} storedRows table rows for the plan's months
 * @param {object[]} liveTotals `readTotals()` of each live piece
 */
export function combineSessionTotals(storedRows = [], liveTotals = []) {
  if (storedRows.length === 0 && liveTotals.length === 1) return liveTotals[0];
  const n = (v) => toNumber(v) ?? 0;
  const sum = (storedKey, liveKey) =>
    storedRows.reduce((t, r) => t + n(r[storedKey]), 0) + liveTotals.reduce((t, r) => t + n(r[liveKey]), 0);
  const sessions = sum('sessions', 'sessions');
  const converted = sum('converted_sessions', 'convertedSessions');
  return {
    sessions,
    visitors: null,
    conversionRate: sessions > 0 ? (converted / sessions) * 100 : null,
    pageviews: sum('pageviews', 'pageviews'),
    bounceRate: null,
    cartSessions: sum('cart_sessions', 'cartSessions'),
    checkoutSessions: sum('checkout_sessions', 'checkoutSessions'),
    convertedSessions: converted
  };
}

/** Months of a stored window, as `YYYY-MM-01`, for reading the table. */
export function monthsBetween(from, to) {
  const out = [];
  for (let cursor = monthStart(fromKey(from)); cursor < to; cursor = monthStart(fromKey(cursor), 1)) {
    if (cursor >= from) out.push(cursor.slice(0, 10));
  }
  return out;
}

