/**
 * Isomorphic helpers for the Customers panel.
 *
 * Kept out of `lib/server/insights/customers-service.ts` because the call list
 * is the one interactive thing on the Insights screens — an operator re-sorts it
 * by spend or by wait — and a client component must not reach into
 * `lib/server/*`, which imports the service-role Supabase client. Anything both
 * sides need lives here, pure, exactly as `insights-format.ts` does for months.
 *
 * Untested for the same reason `insights-format.ts` is: the repo's runner is
 * `node --test` over `.mjs` and cannot import TypeScript. If these grow past
 * sorting and a day count they should move to a `.mjs` beside the other rules.
 */

import type { CustomerAtRisk } from "./types";
import { agoInDays } from "./insights-format";

/** The two orders an operator actually wants: biggest customer, or longest ignored. */
export type AtRiskSort = "spend" | "wait";

export const AT_RISK_SORTS: { id: AtRiskSort; label: string }[] = [
  { id: "spend", label: "Lifetime spend" },
  { id: "wait", label: "Waiting longest" },
];

/**
 * How long this ticket has been waiting, in whole days.
 *
 * Null when the ticket carries no `first_message_at` — a handful of rows
 * imported before ingestion recorded one. Those must not sort as "waiting 0
 * days", which would put the least-known rows at the top of a list whose whole
 * purpose is ranking by neglect.
 */
export function waitedDays(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  return agoInDays(iso, now);
}

/** The wait as a table cell. Em dash, not "0 days", when it cannot be known. */
export function formatWait(iso: string | null, now: Date = new Date()): string {
  const days = waitedDays(iso, now);
  if (days === null) return "—";
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

/**
 * Order the call list, stably.
 *
 * TIES BREAK ON `ticketId`, always. Without a total order two clicks of the
 * same sort button can produce two different row orders — `Array.prototype.sort`
 * is stable, but the input is a fresh array on every render, so "stable" only
 * preserves an order that was already arbitrary. An operator reading a list of
 * people to phone must see the same list twice.
 *
 * Rows with an unknown wait sink to the bottom of the wait sort rather than
 * floating to the top: an unrankable row is not an urgent one.
 */
export function sortAtRisk(
  rows: CustomerAtRisk[],
  sort: AtRiskSort,
  now: Date = new Date()
): CustomerAtRisk[] {
  return [...rows].sort((a, b) => {
    if (sort === "spend") {
      const bySpend = b.amountSpent - a.amountSpent;
      if (bySpend !== 0) return bySpend;
    } else {
      const aDays = waitedDays(a.firstMessageAt, now);
      const bDays = waitedDays(b.firstMessageAt, now);
      if (aDays === null || bDays === null) {
        if (aDays !== bDays) return aDays === null ? 1 : -1;
      } else if (bDays !== aDays) {
        return bDays - aDays;
      }
    }
    return a.ticketId.localeCompare(b.ticketId);
  });
}
