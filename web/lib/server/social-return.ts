import { shopForSlug } from "../../../scripts/lib/dashboard-shops.mjs";

/**
 * Where a person lands after connecting a provider. A fixed list, never the
 * query string's own value: an open redirect on a login callback is the classic
 * way to hand someone a convincing link to somewhere else.
 *
 * Each entry ends in a query string so the callback can append to it. The shop
 * is appended as `&shop=`, and only a slug the dashboard serves: the person
 * lands on the shop they connected, which the callback takes from the signed
 * state, not from the browser.
 */
const RETURNS: Record<string, string> = {
  social: "/insights/social?connections=1",
  settings: "/settings?tab=integrations",
};

/** The return key, if it is one of ours; else the default. */
export function returnKey(key: unknown): string {
  return typeof key === "string" && key in RETURNS ? key : "social";
}

/** The landing path for a return key, on `shopSlug` when the dashboard serves it. */
export function returnPath(key: unknown, shopSlug?: string | null): string {
  const path = RETURNS[returnKey(key)];
  const shop = shopForSlug(shopSlug, process.env) as { slug: string } | null;
  return shop ? `${path}&shop=${encodeURIComponent(shop.slug)}` : path;
}
