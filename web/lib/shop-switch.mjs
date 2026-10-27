/**
 * The sidebar's shop switcher: which shop a page shows, and where a switch goes.
 *
 * ONLY INSIGHTS AND SETTINGS ARE PER SHOP. They carry the shop in their address
 * (`?shop=`, filled in by the middleware). Every other page — tickets, orders,
 * conversations, agent setup, Home — is the support desk's shop, so the switcher
 * shows the desk shop there, and picking another shop opens that shop's
 * Insights. docs/decisions/insights.md § The shop is picked in the sidebar.
 */

/** Insights panels that only the desk shop has (`DESK_ONLY_PANELS` in lib/types.ts). */
const DESK_ONLY_PANELS = ['support', 'agent'];

/** Settings tabs about the desk's agents (SettingsView `DESK_ONLY`). */
const DESK_ONLY_TABS = ['agents', 'dev'];

/** Whether this page shows the shop its address names. */
export function isShopPage(pathname) {
  return pathname === '/insights' || pathname.startsWith('/insights/') || pathname === '/settings';
}

/**
 * The shop a page shows: its `?shop=` on a shop page when that is a served shop,
 * else the desk shop (else the first listed).
 * @param {{ slug: string, desk: boolean }[]} shops
 */
export function currentShop(pathname, shopParam, shops) {
  const named = isShopPage(pathname) ? shops.find((shop) => shop.slug === shopParam) : null;
  return named ?? shops.find((shop) => shop.desk) ?? shops[0] ?? null;
}

/**
 * Where picking `target` from this page goes, or null to stay. The same panel,
 * period and tab on the other shop where it has them; a desk-only panel or tab
 * opens the other shop's Overview or Settings instead.
 * @param {{ pathname: string, search: string, target: { slug: string, desk: boolean } }} input
 */
export function switchHref({ pathname, search, target }) {
  const params = new URLSearchParams(search);
  if (!isShopPage(pathname)) {
    return target.desk ? null : `/insights?shop=${encodeURIComponent(target.slug)}`;
  }
  params.set('shop', target.slug);
  let path = pathname;
  if (!target.desk && pathname.startsWith('/insights/') && DESK_ONLY_PANELS.includes(pathname.slice('/insights/'.length).split('/')[0])) {
    path = '/insights/overview';
  }
  if (!target.desk && pathname === '/settings' && DESK_ONLY_TABS.includes(params.get('tab') ?? '')) {
    params.delete('tab');
  }
  return `${path}?${params.toString()}`;
}

/** A nav link with the shop on screen, for the per-shop sections; any other link as it is. */
export function navHref(href, shop, shopCount) {
  if (shopCount < 2 || !shop || !isShopPage(href)) return href;
  return `${href}?shop=${encodeURIComponent(shop.slug)}`;
}
