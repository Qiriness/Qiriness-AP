/**
 * The Customers panel's Segment Finder: what an operator may ask for, checked,
 * and turned into the shape `customer_segment_find()` evaluates.
 *
 * Pure and isomorphic: the browser uses it to describe the segment as it is
 * built, the route uses it to refuse bad input, and the tests read both.
 *
 * AND BINDS TIGHTER THAN OR, as in every query language. The form is a flat list
 * of conditions with AND or OR in each gap; `segmentGroups` turns that into
 * OR-of-AND groups, and `describeSegment` prints the brackets that makes
 * explicit, so what the operator reads is what SQL runs.
 */

export const SEGMENT_METRICS = Object.freeze([
  { id: 'orders', label: 'Orders', unit: 'count', windowed: true },
  { id: 'spend', label: 'Spent', unit: 'euro', windowed: true },
  { id: 'lifetime_spend', label: 'Lifetime spend', unit: 'euro', windowed: false }
]);

export const SEGMENT_OPERATORS = Object.freeze([
  { id: 'gt', symbol: '>', label: 'more than' },
  { id: 'lt', symbol: '<', label: 'less than' }
]);

export const SEGMENT_CONNECTORS = Object.freeze(['and', 'or']);

export const SEGMENT_WINDOW_MONTHS = Object.freeze({ min: 1, max: 120, default: 6 });

/** Past this many conditions a segment stops being readable as a sentence. */
export const MAX_SEGMENT_CONDITIONS = 6;

/** How many matching customers are named; the totals count all of them. */
export const SEGMENT_MEMBER_LIMIT = 25;

const MAX_VALUE = 1_000_000_000;

/**
 * @typedef {{ metric: 'orders' | 'spend' | 'lifetime_spend', op: 'gt' | 'lt', value: number }} SegmentCondition
 * @typedef {{ windowMonths: number, conditions: SegmentCondition[], connectors: ('and' | 'or')[] }} Segment
 * @typedef {{ ok: true, segment: Segment } | { ok: false, error: string }} SegmentCheck
 */

/** @param {string} error @returns {{ ok: false, error: string }} */
const fail = (error) => ({ ok: false, error });

/**
 * `{windowMonths, conditions: [{metric, op, value}], connectors: ['and'|'or']}`
 * -> `{ok: true, segment}` or `{ok: false, error}` in words for the form.
 *
 * @param {any} input
 * @returns {SegmentCheck}
 */
export function validateSegment(input) {
  const windowMonths = Number(input?.windowMonths);
  if (
    !Number.isInteger(windowMonths) ||
    windowMonths < SEGMENT_WINDOW_MONTHS.min ||
    windowMonths > SEGMENT_WINDOW_MONTHS.max
  ) {
    return fail(`The time range must be a whole number of months, ${SEGMENT_WINDOW_MONTHS.min} to ${SEGMENT_WINDOW_MONTHS.max}.`);
  }

  const conditions = Array.isArray(input?.conditions) ? input.conditions : [];
  if (conditions.length === 0) return fail('Add at least one condition.');
  if (conditions.length > MAX_SEGMENT_CONDITIONS) return fail(`At most ${MAX_SEGMENT_CONDITIONS} conditions.`);

  const clean = [];
  for (const [index, condition] of conditions.entries()) {
    const n = index + 1;
    const metric = SEGMENT_METRICS.find((m) => m.id === condition?.metric);
    if (!metric) return fail(`Condition ${n}: choose what to compare.`);
    if (!SEGMENT_OPERATORS.some((o) => o.id === condition?.op)) return fail(`Condition ${n}: choose more than or less than.`);
    const raw = condition?.value;
    if (raw === null || raw === undefined || String(raw).trim() === '') return fail(`Condition ${n}: enter a number.`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return fail(`Condition ${n}: the number must be 0 or more.`);
    if (value > MAX_VALUE) return fail(`Condition ${n}: that number is too large.`);
    if (metric.unit === 'count' && !Number.isInteger(value)) return fail(`Condition ${n}: orders must be a whole number.`);
    clean.push({ metric: metric.id, op: condition.op, value });
  }

  const connectors = Array.isArray(input?.connectors) ? input.connectors : [];
  if (connectors.length !== clean.length - 1 || !connectors.every((c) => SEGMENT_CONNECTORS.includes(c))) {
    return fail('Choose AND or OR between each pair of conditions.');
  }

  return { ok: true, segment: { windowMonths, conditions: clean, connectors: [...connectors] } };
}

/** The flat list -> OR-of-AND groups: `a AND b OR c` is `[[a, b], [c]]`. */
export function segmentGroups(segment) {
  const groups = [[segment.conditions[0]]];
  segment.connectors.forEach((connector, index) => {
    const next = segment.conditions[index + 1];
    if (connector === 'and') groups[groups.length - 1].push(next);
    else groups.push([next]);
  });
  return groups;
}

/** `Orders in the last 6 months > 2`, `Lifetime spend > €500`. */
export function describeCondition(condition, windowMonths) {
  const metric = SEGMENT_METRICS.find((m) => m.id === condition.metric);
  const operator = SEGMENT_OPERATORS.find((o) => o.id === condition.op);
  const value =
    metric.unit === 'euro'
      ? `€${condition.value.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`
      : condition.value.toLocaleString('en-GB');
  const scope = metric.windowed ? ` in the last ${windowMonths === 1 ? 'month' : `${windowMonths} months`}` : '';
  return `${metric.label}${scope} ${operator.symbol} ${value}`;
}

/** The whole segment as one line, bracketed wherever AND and OR are mixed. */
export function describeSegment(segment) {
  const groups = segmentGroups(segment);
  return groups
    .map((group) => {
      const text = group.map((c) => describeCondition(c, segment.windowMonths)).join(' AND ');
      return groups.length > 1 && group.length > 1 ? `(${text})` : text;
    })
    .join(' OR ');
}

/**
 * The arguments `customer_segment_find()` takes.
 *
 * @param {string} shopId
 * @param {Segment} segment
 * @param {string[] | null} [notChannels]
 * @param {number} [limit]
 */
export function segmentArgs(shopId, segment, notChannels = null, limit = SEGMENT_MEMBER_LIMIT) {
  return {
    p_shop: shopId,
    p_window_months: segment.windowMonths,
    p_groups: segmentGroups(segment),
    p_not_channels: notChannels,
    p_limit: limit
  };
}
