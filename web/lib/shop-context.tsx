"use client";

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

/**
 * The shop the dashboard runs for, as the browser needs it: its name and where
 * its storefront is.
 *
 * WHY A CONTEXT. The name used to be written into the components (« Qiriness »
 * on our replies, the logo's alt text, the store link to qiriness.com), so the
 * dashboard deployed for another shop would have shown the wrong company. The
 * root layout reads `shops` once on the server and hands the two values down.
 * `useT` also reads the name, so any string with `{store}` resolves to it.
 */
export interface ShopInfo {
  /** Shopify's shop name. Null before the first shop sync. */
  name: string | null;
  /** `shops.storefront_url`, where customers go. Null before the first sync. */
  storefrontUrl: string | null;
  /** The marketplaces from `sales_channels`, in display order (Setup -> Sales channels). */
  marketplaces: { key: string; label: string }[];
}

const ShopContext = createContext<ShopInfo>({ name: null, storefrontUrl: null, marketplaces: [] });

export function ShopProvider({ shop, children }: { shop: ShopInfo; children: ReactNode }) {
  return <ShopContext.Provider value={shop}>{children}</ShopContext.Provider>;
}

export function useShop(): ShopInfo {
  return useContext(ShopContext);
}

/**
 * One shop the dashboard serves, as the sidebar's switcher draws it
 * (scripts/lib/dashboard-shops.mjs). Read once by the root layout.
 */
export interface NavShop {
  /** The `.myshopify.com` subdomain: what `?shop=` carries. */
  slug: string;
  /** Shopify's shop name, or the slug before the first sync. */
  name: string;
  /** The support desk's shop: the only one with tickets, orders and the agent. */
  desk: boolean;
  storefrontUrl: string | null;
  /**
   * The mark to draw. The desk shop's is `/brand/logo.png` (also the tab icon);
   * another shop's is `/brand/shops/<slug>.png`, dropped into `web/public` — a
   * file, not code — and a shop without one shows its initial.
   */
  logo: string;
}

const NavShopsContext = createContext<NavShop[]>([]);

export function NavShopsProvider({ shops, children }: { shops: NavShop[]; children: ReactNode }) {
  return <NavShopsContext.Provider value={shops}>{children}</NavShopsContext.Provider>;
}

/** Every shop the dashboard serves, desk shop included; one entry when there is no other. */
export function useNavShops(): NavShop[] {
  return useContext(NavShopsContext);
}

/**
 * The marketplaces' names for a sentence, in the reader's language: « Amazon and
 * Yves Rocher », « Amazon et Yves Rocher ». `{marketplaces}` in any string.
 */
export function marketplaceList(shop: ShopInfo | null | undefined, locale: string): string {
  const names = (shop?.marketplaces ?? []).map((m) => m.label);
  if (names.length === 0) return locale === "fr" ? "les marketplaces" : "the marketplaces";
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

/** The name to print: the shop's, or a generic word before the first sync. */
export function shopLabel(shop: ShopInfo | null | undefined): string {
  return shop?.name?.trim() || "Support";
}
