"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { shopLabel, useNavShops, useShop, type NavShop } from "@/lib/shop-context";
import { currentShop } from "@/lib/shop-switch.mjs";

/**
 * The shop on screen and every shop served, for the sidebar and the top bar.
 * Insights and Settings show the shop their address names; every other page the
 * desk shop (web/lib/shop-switch.mjs). With no shop list (DASHBOARD_SHOPS
 * unset) it is the desk shop alone, from the root layout's shop row.
 */
export function useShopOnScreen(): { shops: NavShop[]; shop: NavShop; pathname: string; search: string } {
  const pathname = usePathname() ?? "";
  const params = useSearchParams();
  const listed = useNavShops();
  const desk = useShop();
  const shops: NavShop[] = listed.length
    ? listed
    : [{ slug: "", name: shopLabel(desk), desk: true, storefrontUrl: desk.storefrontUrl, logo: "/brand/logo.png" }];
  const shop = (currentShop(pathname, params?.get("shop") ?? null, shops) as NavShop | null) ?? shops[0];
  return { shops, shop, pathname, search: params?.toString() ?? "" };
}
