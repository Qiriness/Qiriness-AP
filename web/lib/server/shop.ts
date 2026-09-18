/**
 * The one shop row every page reads against — its id and its clock.
 *
 * REMEMBERED FOR FIVE MINUTES, because it was the first read of every page and
 * it never changes while the server runs: `shops` is upserted on the domain, so
 * a sync keeps the id. The timezone is the one field a sync could move (it is
 * Shopify's `ianaTimezone`, null until the first shop sync), so the memory is
 * short rather than permanent — a newly set zone reaches the panels within
 * minutes, not at the next restart.
 *
 * A FAILURE IS NEVER REMEMBERED. A missing row ("run a sync first") or a failed
 * read is retried on the next request, so the fix is seen as soon as it lands.
 *
 * Server-only.
 */

import { T } from "../../../scripts/lib/tables.mjs";
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import { createSupabaseClient, supabaseSelect } from "../../../scripts/lib/supabase-rest-client.mjs";

export interface ShopRow {
  id: string;
  ianaTimezone: string | null;
}

const TTL_MS = 5 * 60 * 1000;

let remembered: { at: number; shop: Promise<ShopRow | null> } | null = null;

/** The shop row, or null when no shop has been synced for this domain. */
export function getShop(): Promise<ShopRow | null> {
  if (remembered && Date.now() - remembered.at < TTL_MS) return remembered.shop;

  const entry = { at: Date.now(), shop: readShop() };
  remembered = entry;
  // Concurrent requests share the one read in flight; a failure or a missing
  // row is dropped so the next request asks again.
  entry.shop.then(
    (shop) => {
      if (!shop && remembered === entry) remembered = null;
    },
    () => {
      if (remembered === entry) remembered = null;
    }
  );
  return entry.shop;
}

async function readShop(): Promise<ShopRow | null> {
  const config = loadConfig(process.env as Record<string, string | undefined>);
  const rows = (await supabaseSelect(
    createSupabaseClient(config),
    T.SHOPS,
    { shop_domain: config.shopDomain },
    "id,iana_timezone"
  )) as { id: string; iana_timezone: string | null }[];
  const row = rows?.[0];
  return row?.id ? { id: row.id, ianaTimezone: row.iana_timezone ?? null } : null;
}
