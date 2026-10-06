/**
 * What every Insights panel service shares: a service-role client, and one way
 * to read an aggregate view.
 *
 * THE PANELS READ VIEWS AND NOTHING ELSE. Every figure on every panel is
 * produced by an aggregate in `06_analytics.sql`, never by pulling rows and
 * reducing them here. That is not a style preference — PostgREST caps a
 * response at 1,000 rows, and paging an unordered query returns overlapping
 * pages, so a client-side reduce over anything table-sized is silently wrong.
 * Measured while designing these panels: an unordered paged tally of the 58,201
 * customers gave CHAMPIONS as 438, then 554, then 472 on three consecutive
 * runs.
 *
 * `readView` therefore takes a hard `limit` and no pagination. A view that
 * could ever return more rows than that limit is the wrong shape and belongs
 * back in SQL as a further aggregate.
 *
 * Server-only, service-role: every table has RLS on with no policies. Never
 * import this from a client component.
 */

import { unstable_cache } from "next/cache";
import { loadConfig } from "../../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseRpc,
  supabaseSelect,
} from "../../../../scripts/lib/supabase-rest-client.mjs";
import { CACHE_TAGS } from "../cache-tags";

/**
 * HOW LONG A FIGURE MAY BE SERVED BEFORE IT IS RECOMPUTED (decided 2026-10-06).
 *
 * Every read below goes through Vercel's shared Data Cache, keyed by the
 * function or view and its exact arguments, so every person, tab and render
 * asking the same question shares one answer. Ranges are cut on hour or day
 * boundaries, which is what makes the keys repeat. A stale entry is served at
 * once and recomputed behind it. The ↻ button clears the tag.
 *
 * Read-only aggregates only. A token or a write never goes through here.
 */
export const INSIGHTS_TTL_SECONDS = 15 * 60;

const cachedRpc = unstable_cache(
  async (fn: string, args: Record<string, unknown>) => {
    const rows = await supabaseRpc(getSupabaseClient(), fn, args);
    return Array.isArray(rows) ? rows : [];
  },
  ["insights-rpc"],
  { revalidate: INSIGHTS_TTL_SECONDS, tags: [CACHE_TAGS.insights] }
);

const cachedView = unstable_cache(
  async (view: string, filters: Record<string, unknown>, order: string | undefined, limit: number) => {
    const rows = await supabaseSelect(getSupabaseClient(), view, filters, "*", { order, limit });
    return Array.isArray(rows) ? rows : [];
  },
  ["insights-view"],
  { revalidate: INSIGHTS_TTL_SECONDS, tags: [CACHE_TAGS.insights] }
);

/**
 * Call one of the ranged functions (RANGED READS in 06_analytics.sql).
 *
 * Every one is an aggregate bounded by its range and grain — a few dozen rows at
 * most — so there is no paging here either, for the same reason `readView` has
 * none. A function that could return a table's worth of rows is the wrong shape.
 */
export async function callRpc<T = Record<string, unknown>>(
  fn: string,
  args: Record<string, unknown>
): Promise<T[]> {
  return (await cachedRpc(fn, args)) as T[];
}

/** The one-row functions: a summary always returns exactly one row. */
export async function callRpcOne<T = Record<string, unknown>>(
  fn: string,
  args: Record<string, unknown>
): Promise<T | null> {
  const rows = await callRpc<T>(fn, args);
  return rows[0] ?? null;
}

/** The most rows any analytics view is allowed to return in one read. */
const MAX_VIEW_ROWS = 500;

export function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

/**
 * Read an aggregate view, scoped to this shop.
 *
 * `order` matters even on a small result set: PostgREST has no inherent row
 * order, so two renders of the same unordered view can disagree about which row
 * is first, and a "top blocker" that changes on refresh reads as a bug.
 */
export async function readView<T = Record<string, unknown>>(
  view: string,
  shopId: string,
  options: { order?: string; limit?: number; filters?: Record<string, unknown> } = {}
): Promise<T[]> {
  const filters = { shop_id: shopId, ...(options.filters ?? {}) };
  return (await cachedView(view, filters, options.order, options.limit ?? MAX_VIEW_ROWS)) as T[];
}

/** Read a view that aggregates to a single row per shop. */
export async function readOne<T = Record<string, unknown>>(
  view: string,
  shopId: string
): Promise<T | null> {
  const rows = await readView<T>(view, shopId, { limit: 1 });
  return rows[0] ?? null;
}

/**
 * Postgres numerics arrive over PostgREST as strings, and `percentile_cont`
 * returns null on an empty group. Both have to survive as null rather than
 * becoming 0, because "no orders were measured" and "measured at zero hours"
 * are different statements and only one of them is ever true.
 */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The same coercion where a missing value genuinely does mean zero — a count. */
export function count(value: unknown): number {
  return num(value) ?? 0;
}
