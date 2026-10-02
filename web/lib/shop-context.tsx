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
