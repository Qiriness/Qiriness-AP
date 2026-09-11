// How long orders are kept, held once so the clock, the purge and the fetch
// window cannot disagree about it.
//
// WHY THE DURATION LEFT THE RULE NAME. `retention_rule` used to say both why the
// clock started and how long it ran — `delivered_plus_3_months` — enumerated in
// a check constraint and compared literally in `deriveOrderStatus`. That made
// the period unswitchable: every new window multiplied the enum
// (`delivered_plus_12_months`, `delivered_plus_24_months`, `delivered_never`)
// and needed a matching branch in code that only ever cared WHY. It is also, on
// the evidence, how the live database drifted from this repo — the 3→6 month
// change was applied to the constraint by hand and never written down here.
//
// So the rule now names the reason only, and `retention_delete_after` carries
// the arithmetic. Four reasons, a constraint that never has to change again, and
// one number that a person can set.
//
// NULL `retention_delete_after` MEANS KEPT INDEFINITELY. Not a sentinel date and
// not a special case in the delete path: `deleteExpiredOrders` selects rows
// whose date is `lte` now, and a null is simply never matched.

/**
 * Why an order's retention clock started. The duration is NOT in here — that is
 * the whole point. Mirrored by `orders_retention_rule_check` in 02_shopify.sql,
 * and asserted against it by the migration test.
 */
export const RETENTION_REASONS = [
  'delivered',
  'undelivered',
  'return_refund_open',
  'return_refund_completed'
];

/** Mirrored by `shops_order_retention_check` in 01_foundation.sql. */
export const RETENTION_MODES = ['months', 'indefinite'];

/**
 * What retention falls back to when the setting cannot be read.
 *
 * FAILS SAFE, NOT OPEN, and this is the opposite of how `parameters.mjs`
 * behaves. A support parameter that cannot be read makes a reply decline to
 * quote a number — inconvenient, harmless. A retention setting that cannot be
 * read must never resolve to "keep for ever": a typo in a column would silently
 * turn into indefinite retention of personal data, which is the one outcome
 * nobody would notice and everybody would have to answer for.
 *
 * 6 months is what the code did before the switch existed, so an unreadable
 * setting behaves like the version that had no setting at all.
 */
export const FALLBACK_RETENTION_MONTHS = 6;

/**
 * Extra months of fetch window on top of retention.
 *
 * Absorbs month-length clamping (31 Aug + 1 month) and a sync that has not run
 * for a few weeks. Without it an order could age past the fetch window while
 * still being inside its retention window, and the sync would never see it
 * again to refresh it.
 */
export const SYNC_WINDOW_MARGIN_MONTHS = 1;

/** The policy the code applied before any of this was configurable. */
export const DEFAULT_RETENTION_POLICY = Object.freeze({
  mode: 'months',
  months: FALLBACK_RETENTION_MONTHS
});

/**
 * Read the policy off a `shops` row.
 *
 * A row that has never been through the 10 migration has neither column, which
 * reads as the default rather than as an error — the sync must not stop because
 * a setting is new.
 */
export function readRetentionPolicy(shopRow = {}) {
  const mode = shopRow.order_retention_mode;

  if (mode === 'indefinite') {
    // The only way to reach indefinite is for somebody to have chosen the word.
    // It is never what a missing or malformed value resolves to.
    return Object.freeze({ mode: 'indefinite', months: null });
  }

  if (mode === 'months' || mode === undefined || mode === null) {
    const months = toPositiveInteger(shopRow.order_retention_months);
    return Object.freeze({
      mode: 'months',
      months: months ?? FALLBACK_RETENTION_MONTHS
    });
  }

  // A mode this code has never heard of. Fall back rather than guess.
  return DEFAULT_RETENTION_POLICY;
}

export function isIndefinite(policy) {
  return readPolicy(policy).mode === 'indefinite';
}

/**
 * When an order whose clock started at `anchor` may be deleted.
 *
 * Returns null when retention is indefinite, which is the value that goes into
 * `retention_delete_after` — see the note at the top about why that is not a
 * special case anywhere else.
 */
export function retentionDeleteAfter(anchor, policy) {
  const resolved = readPolicy(policy);
  if (resolved.mode === 'indefinite') {
    return null;
  }
  return addMonths(anchor, resolved.months);
}

/**
 * How far back to ask Shopify for orders, in months, or null for no bound.
 *
 * DERIVED FROM RETENTION RATHER THAN SET BESIDE IT. These were two independent
 * constants and the pair had to be kept in step by hand: a retention window
 * longer than the fetch window is a table that can never fill, and the setting
 * would look broken rather than misconfigured.
 */
export function orderSyncMonths(policy) {
  const resolved = readPolicy(policy);
  if (resolved.mode === 'indefinite') {
    return null;
  }
  return resolved.months + SYNC_WINDOW_MARGIN_MONTHS;
}

/** One line for the sync log, so a run states the policy it ran under. */
export function describeRetentionPolicy(policy) {
  const resolved = readPolicy(policy);
  return resolved.mode === 'indefinite'
    ? 'kept indefinitely (no retention deletion)'
    : `kept for ${resolved.months} months after the retention clock starts`;
}

/**
 * Accepts a policy or a raw shops row, so callers cannot pass the wrong one.
 * Everything public here goes through it.
 */
function readPolicy(policy) {
  if (policy && RETENTION_MODES.includes(policy.mode)) {
    return policy;
  }
  if (policy && typeof policy === 'object' && 'order_retention_mode' in policy) {
    return readRetentionPolicy(policy);
  }
  return DEFAULT_RETENTION_POLICY;
}

function toPositiveInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function addMonths(value, months) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  // UTC throughout, for the reason `orderSyncQuery` states: setMonth/getMonth
  // work in local time while toISOString emits UTC, and the mixed pair moved the
  // result by a day depending on where the sync ran.
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString();
}
