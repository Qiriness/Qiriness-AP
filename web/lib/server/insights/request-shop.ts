/**
 * The Insights shop an API request is for: its `?shop=`, which every Insights
 * call from the browser carries (`useInsightsFrame().api`). Never a cookie: two
 * tabs open on two shops would then write into whichever was opened last.
 *
 * A request without `?shop=` is for the support desk's shop, as before shops
 * could be switched. Server-only.
 */

import { getShopByDomain, type ShopRow } from "../shop";
import { insightsShopFor } from "./context";

export async function requestShop(request: Request): Promise<ShopRow> {
  const selected = insightsShopFor({ shop: new URL(request.url).searchParams.get("shop") ?? undefined });
  const shop = await getShopByDomain(selected.domain);
  if (!shop) throw new Error(`No shop record found for ${selected.domain}. Run a Shopify sync first.`);
  return shop;
}
