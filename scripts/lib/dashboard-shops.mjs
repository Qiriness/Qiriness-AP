/**
 * The shops the dashboard's Insights serve, and which one is the support desk's.
 *
 * ONE DATABASE, ONE DEPLOYMENT, SEVERAL SHOPS (owner, 2026-10-26: Qiriness and
 * Barbara Gould, both Lap Groupe). Insights is per shop and picked in the
 * header; everything else — tickets, orders, agent setup, the worker — is the
 * support desk's shop alone. Why: docs/decisions/insights.md § Several shops, one
 * dashboard.
 *
 * `DASHBOARD_SHOPS` lists the store domains, comma separated, in switcher
 * order. `SHOPIFY_STORE_DOMAIN` is the desk shop and is always served, first if
 * the list leaves it out. Unset, the dashboard serves the desk shop alone,
 * exactly as before. A shop's slug is its `.myshopify.com` subdomain: it is what
 * the URL carries (`?shop=qiriness`), so it never holds a name or a secret.
 *
 * Every shop is reached with the same Shopify app (the client-credentials token
 * is minted per store domain), so a shop here needs no credentials of its own.
 */

const MYSHOPIFY = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function cleanDomain(value) {
  const domain = String(value ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return MYSHOPIFY.test(domain) ? domain : null;
}

export function shopSlug(domain) {
  return domain.replace(/\.myshopify\.com$/, '');
}

/**
 * `[{ slug, domain, desk }]`, desk shop first unless the list places it. A
 * malformed entry is dropped, a duplicate kept once.
 */
export function dashboardShops(env = process.env) {
  const desk = cleanDomain(env.SHOPIFY_STORE_DOMAIN);
  const listed = String(env.DASHBOARD_SHOPS ?? '')
    .split(',')
    .map(cleanDomain)
    .filter(Boolean);
  const domains = [...new Set(listed.length ? (desk && !listed.includes(desk) ? [desk, ...listed] : listed) : desk ? [desk] : [])];
  return domains.map((domain) => ({ slug: shopSlug(domain), domain, desk: domain === desk }));
}

/** The shop a URL's `?shop=` names, or null when it names none the dashboard serves. */
export function shopForSlug(slug, env = process.env) {
  const wanted = String(slug ?? '').trim().toLowerCase();
  return wanted ? (dashboardShops(env).find((shop) => shop.slug === wanted) ?? null) : null;
}

/** The shop for a store domain (a webhook's `X-Shopify-Shop-Domain`), or null. */
export function shopForDomain(domain, env = process.env) {
  const wanted = cleanDomain(domain);
  return wanted ? (dashboardShops(env).find((shop) => shop.domain === wanted) ?? null) : null;
}

/** The shop Insights opens on: the one last looked at (a cookie's slug) if still served, else the first. */
export function defaultShop(rememberedSlug, env = process.env) {
  return shopForSlug(rememberedSlug, env) ?? dashboardShops(env)[0] ?? null;
}

/** The cookie that remembers the shop last looked at. */
export const SHOP_COOKIE = 'insights_shop';
