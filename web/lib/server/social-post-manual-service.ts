/**
 * Figures a person types in for a post because the API will not give them:
 * today the percentage of non-followers reached (84_post_non_followers.sql).
 *
 * Read live, never through the Insights cache, so an entry shows on the next
 * render. The sync never writes this column.
 *
 * Server-only.
 */

import { supabaseSelectAll, supabaseUpdate } from "../../../scripts/lib/supabase-rest-client.mjs";
import { SOCIAL_T } from "../../../scripts/lib/tables.mjs";
import { getSupabaseClient } from "./insights/shared";
import { getShopId } from "./knowledge-service";

/** `accountId|postId` -> percent, for the posts that have one. Empty, never a throw, when the column is missing. */
export async function readNonFollowers(shopId: string): Promise<Map<string, number>> {
  try {
    const rows = (await supabaseSelectAll(
      getSupabaseClient(),
      SOCIAL_T.POSTS,
      { shop_id: shopId, non_followers_pct: { operator: "not.is", value: "null" } },
      "account_id,external_id,non_followers_pct",
      { order: "external_id.asc" }
    )) as { account_id: string; external_id: string; non_followers_pct: number | string }[];
    return new Map(rows.map((r) => [`${r.account_id}|${r.external_id}`, Number(r.non_followers_pct)]));
  } catch {
    return new Map();
  }
}

/** A percentage of 0–100 (empty clears it), or the reason it is not one. */
export function checkPercent(value: unknown): { ok: true; percent: number | null } | { ok: false; error: string } {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return { ok: true, percent: null };
  const percent = typeof value === "number" ? value : Number(String(value).trim().replace(",", ".").replace(/%$/, ""));
  if (!Number.isFinite(percent)) return { ok: false, error: "percent must be a number" };
  if (percent < 0 || percent > 100) return { ok: false, error: "percent must be between 0 and 100" };
  return { ok: true, percent: Math.round(percent * 100) / 100 };
}

/** Sets (or clears) a post's share of non-followers. False when the shop has no such post. */
export async function setNonFollowers(accountId: string, postId: string, percent: number | null): Promise<boolean> {
  const rows = await supabaseUpdate(
    getSupabaseClient(),
    SOCIAL_T.POSTS,
    { shop_id: await getShopId(), account_id: accountId, external_id: postId },
    { non_followers_pct: percent },
    { select: "external_id" }
  );
  return rows.length > 0;
}
