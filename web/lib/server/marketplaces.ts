/**
 * The shop's marketplaces (`sales_channels`, Setup -> Sales channels), read once
 * per request.
 *
 * Every Insights panel, the orders list and the ticket detail fold sales channel
 * handles onto platforms through this. It replaced constants naming this shop's
 * two marketplaces; an unreadable table reads as "no marketplaces", so a page
 * degrades to treating every order as the shop's own rather than failing.
 *
 * Server-only.
 */

import { cache } from "react";
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import { createSupabaseClient } from "../../../scripts/lib/supabase-rest-client.mjs";
import { NO_MARKETPLACES, loadMarketplaces } from "../../../scripts/lib/marketplaces.mjs";
import { getShop } from "./shop";

export type Marketplaces = typeof NO_MARKETPLACES;

/** One shop's marketplaces: pass `shopId` for an Insights shop, nothing for the support desk's. */
export const getMarketplaces = cache(async (shopId?: string): Promise<Marketplaces> => {
  try {
    const id = shopId ?? (await getShop())?.id;
    if (!id) return NO_MARKETPLACES;
    return await loadMarketplaces(createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>)), id);
  } catch (error) {
    console.warn("sales_channels unreadable", (error as Error).message);
    return NO_MARKETPLACES;
  }
});
