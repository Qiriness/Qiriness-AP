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
 * ONE MEMORY PER SHOP. `getShop()` is the support desk's shop (SHOPIFY_STORE_DOMAIN),
 * which every page outside Insights reads; Insights reads the shop its URL names
 * through `getShopByDomain` (scripts/lib/dashboard-shops.mjs).
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
  /** Shopify's shop name, null until the first shop sync. Signs the forwarding acknowledgement. */
  shopName: string | null;
  /** Where customers go (Shopify's primary domain), null until the first shop sync. */
  storefrontUrl: string | null;
}

const TTL_MS = 5 * 60 * 1000;

const remembered = new Map<string, { at: number; shop: Promise<ShopRow | null> }>();

/** The support desk's shop row, or null when no shop has been synced for its domain. */
export function getShop(): Promise<ShopRow | null> {
  return getShopByDomain(loadConfig(process.env as Record<string, string | undefined>).shopDomain);
}

/** One shop's row by its store domain, or null when that shop has not been synced yet. */
export function getShopByDomain(domain: string): Promise<ShopRow | null> {
  const hit = remembered.get(domain);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.shop;

  const entry = { at: Date.now(), shop: readShop(domain) };
  remembered.set(domain, entry);
  // Concurrent requests share the one read in flight; a failure or a missing
  // row is dropped so the next request asks again.
  const forget = () => {
    if (remembered.get(domain) === entry) remembered.delete(domain);
  };
  entry.shop.then((shop) => {
    if (!shop) forget();
  }, forget);
  return entry.shop;
}

async function readShop(domain: string): Promise<ShopRow | null> {
  const config = loadConfig(process.env as Record<string, string | undefined>);
  const rows = (await supabaseSelect(
    createSupabaseClient(config),
    T.SHOPS,
    { shop_domain: domain },
    "id,iana_timezone,shop_name,storefront_url"
  )) as { id: string; iana_timezone: string | null; shop_name: string | null; storefront_url: string | null }[];
  const row = rows?.[0];
  return row?.id
    ? {
        id: row.id,
        ianaTimezone: row.iana_timezone ?? null,
        shopName: row.shop_name ?? null,
        storefrontUrl: row.storefront_url ?? null
      }
    : null;
}
