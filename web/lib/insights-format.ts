/**
 * Isomorphic formatting for the Insights panels — the same file on the server
 * that maps the rows and in the components that render them, so a month cannot
 * be labelled two ways on one screen.
 *
 * Pure: no Supabase import, nothing server-only. Mirrors ticket-stats.ts's role
 * for the queue. Keep it that way — the reads live in lib/server/insights/.
 */

/** `2026-07-01` -> `Jul 2026`. Month keys are dates, so they also sort as strings. */
export function formatMonth(month: string): string {
  const parsed = new Date(`${month}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return month;
  return parsed.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * Is this month key the one we are currently living through?
 *
 * Used to mark the newest bar as partial. Without it the current month always
 * reads as a collapse, because it is half a month of data drawn against full
 * ones — which is how a dashboard invents a trend that never happened.
 */
export function isCurrentMonth(month: string, now: Date = new Date()): boolean {
  return String(month).slice(0, 7) === now.toISOString().slice(0, 7);
}

/** How long ago, in the words a staleness banner needs. */
export function agoInDays(iso: string, now: Date = new Date()): number | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

export function formatAge(iso: string, now: Date = new Date()): string {
  const days = agoInDays(iso, now);
  if (days === null) return "unknown";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
