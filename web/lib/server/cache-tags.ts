import { revalidateTag } from "next/cache";

/**
 * Tags on the shared server cache (`unstable_cache`, Vercel's Data Cache).
 *
 * Cached reads are shop-level and never per person: the role check happens
 * before a cached read, never inside one.
 */
export const CACHE_TAGS = {
  /** Anything a ticket list or count shows: badges, queues. */
  tickets: "tickets",
  /** Every Insights panel and the context around it. */
  insights: "insights",
} as const;

/**
 * A person changed a ticket from the dashboard: counts and lists cached before
 * the change must not outlive it. Mail the worker stores is not seen here; that
 * is what the caches' short lifetimes are for.
 *
 * Never throws: outside a request (a script, a test) there is no cache to clear.
 */
export function ticketsChanged(): void {
  try {
    revalidateTag(CACHE_TAGS.tickets);
  } catch {
    // Not in a request scope.
  }
}
