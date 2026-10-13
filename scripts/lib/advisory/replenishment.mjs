/**
 * Replenishment — Phase 3 of purchase history (docs/storefront-advisor-plan.md § 5):
 * has this customer probably used up what they bought?
 *
 * The expected interval comes from, in order:
 *   1. measured: the median gap before customers of this shop rebought the same
 *      product (`npm run advisor:repurchase`), when 10+ repurchases were seen;
 *   2. stated: the brand's « Durée d'utilisation » (`usage_weeks`).
 * Only for DAILY care (knowledge `frequency: daily`) that is a product used up
 * on a schedule: never a mask, kit, tool, treat or gift, which customers buy
 * occasionally (measured 2026-10-13: Wrap d'Or rebought anywhere from 3 to 23
 * weeks). No knowledge, no interval: nothing is guessed from the name.
 *
 * A due product is a QUESTION for the consultant (« il vous en reste ? »),
 * never a claim that they have run out.
 */

export const MIN_MEASURED_GAPS = 10;
/** Past this many intervals they have most likely stopped or buy elsewhere: not mentioned. */
export const STALE_AFTER = 3;
const NOT_SCHEDULED = new Set(['mask', 'kit', 'tool', 'out_of_routine']);
const WEEK_MS = 7 * 24 * 3600 * 1000;

/** The measured file's rows by handle: the size with the most repurchases. */
export function measuredIndex(file) {
  const out = new Map();
  for (const row of file?.products ?? []) {
    if (!row?.handle || !(row.gaps >= MIN_MEASURED_GAPS) || !(row.median_weeks > 0)) continue;
    const seen = out.get(row.handle);
    if (!seen || row.gaps > seen.gaps) out.set(row.handle, row);
  }
  return out;
}

/** Is this product used up on a schedule at all? */
export function isScheduled(k) {
  return Boolean(k) && k.frequency === 'daily' && !NOT_SCHEDULED.has(k.functional_type) && k.treat !== true && k.gift !== true;
}

/** @returns {{ weeks: number, source: 'measured' | 'stated' } | null} */
export function expectedInterval(handle, { knowledge, measured }) {
  const k = knowledge?.get(handle);
  if (!isScheduled(k)) return null;
  const m = measured?.get(handle);
  if (m) return { weeks: m.median_weeks, source: 'measured' };
  if (k.usage_weeks) return { weeks: k.usage_weeks, source: 'stated' };
  return null;
}

/**
 * @param {string} lastPurchasedOn  YYYY-MM-DD
 * @returns {{ due: boolean, weeks_since: number, expected_weeks: number, source: string } | null}
 */
export function replenishment(handle, lastPurchasedOn, { knowledge, measured, now = new Date() }) {
  const expected = expectedInterval(handle, { knowledge, measured });
  const last = Date.parse(`${lastPurchasedOn}T00:00:00Z`);
  if (!expected || !Number.isFinite(last)) return null;
  const weeksSince = Math.max(0, Math.floor((now.getTime() - last) / WEEK_MS));
  const due = weeksSince >= expected.weeks && weeksSince < expected.weeks * STALE_AFTER;
  return { due, weeks_since: weeksSince, expected_weeks: Math.round(expected.weeks), source: expected.source };
}

/**
 * The brand's stated duration far from what customers actually do: worth a
 * look by the brand. Measured is when they rebuy, an upper bound on how long it
 * lasts, so only « measured under half or over twice stated » is flagged.
 */
export function durationsDisagree(statedWeeks, measuredWeeks) {
  if (!(statedWeeks > 0) || !(measuredWeeks > 0)) return false;
  return measuredWeeks < statedWeeks / 2 || measuredWeeks > statedWeeks * 2;
}
