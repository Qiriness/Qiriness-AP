/**
 * The team's low / medium / high limits for post metrics (83_social_metric_bands.sql).
 *
 * Read live, never through the Insights cache: a limit someone just changed
 * must colour the next render. A failed read is « no stored rules » (the
 * suggestions apply), never an error: the table works without the colours.
 *
 * Server-only.
 */

import { supabaseDelete, supabaseSelect, supabaseUpsert } from "../../../scripts/lib/supabase-rest-client.mjs";
import { ORGANIC_KINDS } from "../../../scripts/lib/social-model.mjs";
import { BAND_METRICS, validateRule } from "../../../scripts/lib/social-bands.mjs";
import { SOCIAL_BAND_T } from "../../../scripts/lib/tables.mjs";
import { getSupabaseClient } from "./insights/shared";
import { getShopId } from "./knowledge-service";

export interface BandRow {
  kind: string;
  metric: string;
  mode: string;
  low: number | null;
  high: number | null;
}

export async function readBandRows(shopId?: string): Promise<BandRow[]> {
  try {
    const rows = (await supabaseSelect(getSupabaseClient(), SOCIAL_BAND_T.BANDS, { shop_id: shopId ?? (await getShopId()) }, "kind,metric,mode,low,high", {
      limit: 200,
    })) as BandRow[];
    return rows.map((r) => ({ ...r, low: r.low === null ? null : Number(r.low), high: r.high === null ? null : Number(r.high) }));
  } catch {
    return [];
  }
}

/**
 * Saves a platform's rules: `{ metric: { mode, low, high } }`. Every rule is
 * checked before any is written, so a bad one saves nothing. Returns the
 * reason when it fails.
 */
export async function saveBands(kind: unknown, rules: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(ORGANIC_KINDS as string[]).includes(kind as string)) return { ok: false, error: "Unknown platform" };
  if (!rules || typeof rules !== "object") return { ok: false, error: "rules must be an object" };
  const shopId = await getShopId();
  const rows: Record<string, unknown>[] = [];
  for (const [metric, input] of Object.entries(rules as Record<string, unknown>)) {
    const checked = validateRule(metric, input) as { ok: true; rule: { mode: string; low: number | null; high: number | null } } | { ok: false; error: string };
    if (!checked.ok) return { ok: false, error: checked.error };
    rows.push({ shop_id: shopId, kind, metric, mode: checked.rule.mode, low: checked.rule.low, high: checked.rule.high, updated_at: new Date().toISOString() });
  }
  if (rows.length === 0) return { ok: false, error: "no rule given" };
  await supabaseUpsert(getSupabaseClient(), SOCIAL_BAND_T.BANDS, rows, "shop_id,kind,metric", { returning: "minimal" });
  return { ok: true };
}

/** Forgets a platform's stored rules, so the suggestions apply again. */
export async function resetBands(kind: unknown): Promise<boolean> {
  if (!(ORGANIC_KINDS as string[]).includes(kind as string)) return false;
  await supabaseDelete(getSupabaseClient(), SOCIAL_BAND_T.BANDS, { shop_id: await getShopId(), kind: kind as string });
  return true;
}

export { BAND_METRICS };
