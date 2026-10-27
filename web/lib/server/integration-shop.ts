/**
 * The shop a connection belongs to: Klaviyo keys, Meta / Google / TikTok
 * tokens, tracked accounts and « Sync now ».
 *
 * THE SHOP MUST BE NAMED, NEVER ASSUMED. Insights falls back to the support
 * desk's shop when a request names none (request-shop.ts), which is harmless for
 * a read. Here the fallback would hand Barbara Gould's Klaviyo key, or a login
 * that sees Barbara Gould's pages, to Qiriness — wrong figures that fail
 * nothing. So every integrations request carries `?shop=<slug>`, the slug must
 * be one the dashboard serves, and anything else is refused. The OAuth callback
 * takes its shop from the signed state instead, and the shop must still be a
 * served one (`servedShopById`). docs/decisions/insights.md § Connections belong to one shop.
 *
 * Server-only.
 */

import { dashboardShops, shopForSlug } from "../../../scripts/lib/dashboard-shops.mjs";
import { getShopByDomain, type ShopRow } from "./shop";

export interface IntegrationShop extends ShopRow {
  slug: string;
  desk: boolean;
}

/** Thrown when the shop is missing, not served, or not synced; routes answer 400. */
export class ShopChoiceError extends Error {}

/** The served, synced shop a slug names. */
export async function integrationShopForSlug(slug: string | null | undefined): Promise<IntegrationShop> {
  if (!slug) throw new ShopChoiceError("Which shop? The request names none (?shop=).");
  const served = shopForSlug(slug, process.env) as { slug: string; domain: string; desk: boolean } | null;
  if (!served) throw new ShopChoiceError(`The dashboard does not serve a shop "${slug}".`);
  const row = await getShopByDomain(served.domain);
  if (!row) throw new ShopChoiceError(`No shop record for ${served.domain} yet. Run its nightly sync first.`);
  return { ...row, slug: served.slug, desk: served.desk };
}

/** The shop an integrations API request names in `?shop=`. */
export function integrationShop(request: Request): Promise<IntegrationShop> {
  return integrationShopForSlug(new URL(request.url).searchParams.get("shop"));
}

/** The served shop with this id, or null: an OAuth state's shop must still be one the dashboard serves. */
export async function servedShopById(shopId: string): Promise<IntegrationShop | null> {
  for (const served of dashboardShops(process.env) as { slug: string; domain: string; desk: boolean }[]) {
    const row = await getShopByDomain(served.domain).catch(() => null);
    if (row?.id === shopId) return { ...row, slug: served.slug, desk: served.desk };
  }
  return null;
}
