/**
 * The other dashboards this one links to, for the shop switcher in the user menu.
 *
 * A LINK, NOT A CONTEXT. Each shop is its own deployment with its own Supabase
 * project and its own accounts, so « switching » is navigating to the other
 * deployment, where the person signs in on their own account there. Nothing here
 * reads or shares data between shops.
 *
 * CONFIG, NOT CODE. `SHOP_LINKS` lists `Name|https://host` pairs, comma
 * separated, the same value on every deployment:
 *
 *   SHOP_LINKS=Qiriness|https://qiriness-ap.vercel.app,Barbargould|https://barbaragould.vercel.app
 *
 * A third company is another entry, not a code change. Unset or empty, the
 * switcher is not drawn. Names cannot contain « , » or « | »; an entry that is
 * malformed or not an http(s) address is skipped rather than failing the page.
 *
 * Pure, so it runs in route handlers and under `node --test`.
 */

/**
 * @param {string | undefined | null} raw the SHOP_LINKS value
 * @returns {{ name: string, url: string }[]} entries in the order given; url is the origin only
 */
export function parseShopLinks(raw) {
  if (!raw || !raw.trim()) return [];
  const seen = new Set();
  const links = [];
  for (const entry of raw.split(',')) {
    const cut = entry.indexOf('|');
    if (cut < 1) continue;
    const name = entry.slice(0, cut).trim();
    let origin;
    try {
      const parsed = new URL(entry.slice(cut + 1).trim());
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
      origin = parsed.origin;
    } catch {
      continue;
    }
    if (!name || seen.has(origin)) continue;
    seen.add(origin);
    links.push({ name, url: origin });
  }
  return links;
}

/**
 * The links with the one for the host being served marked `current`, so the menu
 * can show where you are and offer only the others. Matching is on host, so a
 * preview URL that matches no entry marks nothing and lists every shop.
 *
 * @param {{ name: string, url: string }[]} links
 * @param {string | null | undefined} host the request's Host header
 */
export function markCurrentShop(links, host) {
  const wanted = String(host ?? '').trim().toLowerCase();
  return links.map((link) => ({ ...link, current: wanted !== '' && new URL(link.url).host === wanted }));
}
