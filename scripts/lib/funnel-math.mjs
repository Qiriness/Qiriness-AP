/**
 * The funnel arithmetic, with no imports: the server builds tables with it and
 * the Funnel tab folds the same rows in the browser when a filter changes, so
 * both sides compute a rate the same way.
 *
 * A row is { sessions, cartSessions, checkoutSessions, convertedSessions }
 * plus whatever it is filtered or grouped on (device, landingType, group).
 */

export const emptyCounts = () => ({ sessions: 0, cartSessions: 0, checkoutSessions: 0, convertedSessions: 0 });
export const add = (acc, row) => {
  acc.sessions += row.sessions;
  acc.cartSessions += row.cartSessions;
  acc.checkoutSessions += row.checkoutSessions;
  acc.convertedSessions += row.convertedSessions;
  return acc;
};

/** Funnel counts of the rows that pass a filter ({device, landingType, group}; null = any). */
export function funnelOf(rows = [], filter = {}) {
  return rows
    .filter((r) => (!filter.device || r.device === filter.device) && (!filter.landingType || r.landingType === filter.landingType) && (!filter.group || r.group === filter.group))
    .reduce(add, emptyCounts());
}

/** Funnel counts per value of one field. */
export function foldTraffic(rows = [], field) {
  const out = new Map();
  for (const row of rows) {
    const key = row[field];
    if (key === null || key === undefined) continue;
    out.set(key, add(out.get(key) ?? emptyCounts(), row));
  }
  return out;
}

/**
 * The four sequential steps with their rates. Each step is a subset of the one
 * before by Shopify's definition (a session that completed checkout reached
 * it), so step-to-step ratios are progression rates. The one exception is
 * the cart: an express checkout (Shop Pay, Apple Pay from a product page)
 * reaches checkout without a cart addition, so in a small slice the checkout
 * step can exceed the cart step. The ratio is shown as it is, above 100%,
 * rather than clamped into a number that was never measured.
 */
export function funnelSteps(c) {
  const steps = [
    ['sessions', c.sessions],
    ['cart', c.cartSessions],
    ['checkout', c.checkoutSessions],
    ['purchase', c.convertedSessions]
  ];
  return steps.map(([key, value], i) => ({
    key,
    value,
    ofEntry: c.sessions > 0 ? (value / c.sessions) * 100 : null,
    ofPrevious: i === 0 ? null : steps[i - 1][1] > 0 ? (value / steps[i - 1][1]) * 100 : null,
    dropOff: i === 0 ? null : steps[i - 1][1] - value
  }));
}

/** Rates of a counts object, as the tables print them. */
export function rates(c) {
  return {
    cartRate: c.sessions > 0 ? (c.cartSessions / c.sessions) * 100 : null,
    checkoutRate: c.sessions > 0 ? (c.checkoutSessions / c.sessions) * 100 : null,
    conversionRate: c.sessions > 0 ? (c.convertedSessions / c.sessions) * 100 : null,
    checkoutCompletion: c.checkoutSessions > 0 ? (c.convertedSessions / c.checkoutSessions) * 100 : null
  };
}

