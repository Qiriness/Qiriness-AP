/**
 * The Segment Finder's sentences in the reader's language.
 *
 * `scripts/lib/segment-finder.mjs` (shared with the API and its tests) words its
 * validation errors and its one-line description in English. The segment itself
 * is structured, so the screen rebuilds the description from it, and maps each
 * known error to a dictionary key; an error it does not know prints as it came.
 */

import type { Locale } from "./i18n/locales";
import type { Translate } from "./i18n/translate";
import { decimal, integer } from "./insights-format";

interface Condition {
  metric: string;
  op: string;
  value: number;
}

export interface SegmentLike {
  windowMonths: number;
  conditions: Condition[];
  connectors: string[];
}

const OPERATOR_SYMBOL: Record<string, string> = { gt: ">", lt: "<" };
const WINDOWED = new Set(["orders", "spend"]);

function describeCondition(condition: Condition, windowMonths: number, t: Translate, locale: Locale): string {
  const euro = condition.metric !== "orders";
  const value = euro
    ? locale === "fr"
      ? `${decimal(condition.value, Number.isInteger(condition.value) ? 0 : 2, locale)} €`
      : `€${decimal(condition.value, Number.isInteger(condition.value) ? 0 : 2, locale)}`
    : integer(condition.value, locale);
  const scope = WINDOWED.has(condition.metric)
    ? ` ${t("insights.customers.finder.inLast", { count: windowMonths, n: windowMonths })}`
    : "";
  return `${t(`insights.customers.finder.metric.${condition.metric}`)}${scope} ${OPERATOR_SYMBOL[condition.op] ?? condition.op} ${value}`;
}

/** The whole segment as one line, bracketed wherever AND and OR are mixed. */
export function describeSegmentL(segment: SegmentLike, t: Translate, locale: Locale): string {
  const groups: Condition[][] = [[segment.conditions[0]]];
  segment.connectors.forEach((connector, index) => {
    const next = segment.conditions[index + 1];
    if (connector === "and") groups[groups.length - 1].push(next);
    else groups.push([next]);
  });
  const and = t("insights.customers.finder.and");
  const or = t("insights.customers.finder.or");
  return groups
    .map((group) => {
      const text = group.map((c) => describeCondition(c, segment.windowMonths, t, locale)).join(` ${and} `);
      return groups.length > 1 && group.length > 1 ? `(${text})` : text;
    })
    .join(` ${or} `);
}

const ERRORS: [RegExp, string, (match: RegExpMatchArray) => Record<string, string | number>][] = [
  [/^The time range must be a whole number of months, (\d+) to (\d+)\.$/, "range", (m) => ({ min: m[1], max: m[2] })],
  [/^Add at least one condition\.$/, "atLeastOne", () => ({})],
  [/^At most (\d+) conditions\.$/, "atMost", (m) => ({ n: m[1] })],
  [/^Condition (\d+): choose what to compare\.$/, "chooseMetric", (m) => ({ n: m[1] })],
  [/^Condition (\d+): choose more than or less than\.$/, "chooseOp", (m) => ({ n: m[1] })],
  [/^Condition (\d+): enter a number\.$/, "enterNumber", (m) => ({ n: m[1] })],
  [/^Condition (\d+): the number must be 0 or more\.$/, "nonNegative", (m) => ({ n: m[1] })],
  [/^Condition (\d+): that number is too large\.$/, "tooLarge", (m) => ({ n: m[1] })],
  [/^Condition (\d+): orders must be a whole number\.$/, "wholeOrders", (m) => ({ n: m[1] })],
  [/^Choose AND or OR between each pair of conditions\.$/, "chooseConnector", () => ({})],
];

/** A validation error from the shared module, in the reader's language when it is a known one. */
export function segmentError(error: string, t: Translate): string {
  for (const [pattern, key, params] of ERRORS) {
    const match = error.match(pattern);
    if (match) return t(`insights.customers.finder.error.${key}`, params(match));
  }
  return error;
}
