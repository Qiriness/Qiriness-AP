/**
 * What the storefront advisor may know of a signed-in customer's purchases —
 * the contract (docs/storefront-advisor-plan.md § 5, Phases 0–1).
 *
 * The reader (purchase-summary-repository.mjs, the online store's orders only)
 * hands its rows to `summarisePurchases`; whatever results passes through
 * `toPurchaseSummary` before the
 * model or the log sees it, so a column added to the reader later cannot leak
 * by accident: the shape below is the whole of what leaves.
 *
 * ALLOWED: product id, title, first and last purchase date (day only), how many
 * orders held it, whether it was returned, whether it only ever came free (a
 * €0 line is a promotional gift and never a preference).
 * NEVER: addresses, emails, names, phone numbers, order numbers or ids,
 * amounts paid, discount codes, notes.
 *
 * A purchase is a fact to ask about, not a profile: it never sets skin type
 * and never overrides what the customer says.
 */

/** Most recent first; enough to ask about, small enough for a prompt. */
export const MAX_SUMMARY_PRODUCTS = 20;

const DAY = /^(\d{4}-\d{2}-\d{2})/;

/**
 * @typedef {{ product_id: string, title: string, first_purchased_on: string | null,
 *   last_purchased_on: string | null, times_purchased: number, returned: boolean, free_gift: boolean }} PurchasedProduct
 * @typedef {{ products: PurchasedProduct[] }} PurchaseSummary
 *
 * @param {unknown} raw what a reader returned
 * @returns {PurchaseSummary | null} null when there is nothing usable
 */
export function toPurchaseSummary(raw) {
  const rows = Array.isArray(raw?.products) ? raw.products : [];
  const products = rows
    .map(toProduct)
    .filter(Boolean)
    .sort((a, b) => String(b.last_purchased_on ?? '').localeCompare(String(a.last_purchased_on ?? '')))
    .slice(0, MAX_SUMMARY_PRODUCTS);
  return products.length ? { products } : null;
}

function toProduct(row) {
  const productId = typeof row?.product_id === 'string' ? row.product_id.trim() : '';
  const title = typeof row?.title === 'string' ? row.title.trim().slice(0, 200) : '';
  if (!productId || !title) return null;
  const times = Number(row.times_purchased);
  return {
    product_id: productId,
    title,
    first_purchased_on: day(row.first_purchased_on),
    last_purchased_on: day(row.last_purchased_on),
    times_purchased: Number.isInteger(times) && times > 0 ? times : 1,
    returned: row.returned === true,
    free_gift: row.free_gift === true,
  };
}

function day(value) {
  const text = value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : '';
  return DAY.exec(text)?.[1] ?? null;
}

/**
 * One customer's order rows → the summary's raw form, per product. Pure.
 *
 * - Cancelled and deleted orders count for nothing; neither do marketplace
 *   orders (`sales_channels.handles`): their customers are synthetic, one per
 *   order, so they are never this person's.
 * - `free_gift`: every line of that product cost 0 — a promotional gift or a
 *   sample, never a preference.
 * - `returned`: none of it was kept (every unit refunded or removed).
 * - `times_purchased`: orders that held it, not units.
 *
 * @param {{ id: string, processed_at: string | null, sales_channel_handle: string | null, cancelled_at?: string | null, deleted_at?: string | null }[]} orders
 * @param {{ order_id: string, product_id: string | null, title: string | null, quantity: string | number | null, current_quantity: string | number | null, discounted_total: string | number | null }[]} lines
 * @param {{ marketplaceHandles?: Iterable<string> }} options
 */
export function summarisePurchases(orders, lines, { marketplaceHandles = [] } = {}) {
  const marketplace = new Set([...marketplaceHandles].map((h) => String(h).toLowerCase()));
  const kept = new Map(
    (orders ?? [])
      .filter((o) => o && !o.cancelled_at && !o.deleted_at && !marketplace.has(String(o.sales_channel_handle ?? '').toLowerCase()))
      .map((o) => [o.id, day(o.processed_at)])
  );
  const byProduct = new Map();
  for (const line of lines ?? []) {
    if (!line?.product_id || !kept.has(line.order_id)) continue;
    const on = kept.get(line.order_id);
    const p = byProduct.get(line.product_id) ?? { product_id: line.product_id, title: null, titleOn: '', first: null, last: null, orders: new Set(), bought: 0, keptUnits: 0, paid: false };
    if (line.title && (on ?? '') >= p.titleOn) { p.title = line.title; p.titleOn = on ?? ''; }
    if (on && (!p.first || on < p.first)) p.first = on;
    if (on && (!p.last || on > p.last)) p.last = on;
    p.orders.add(line.order_id);
    p.bought += number(line.quantity);
    p.keptUnits += line.current_quantity === null || line.current_quantity === undefined ? number(line.quantity) : number(line.current_quantity);
    if (number(line.discounted_total) > 0) p.paid = true;
    byProduct.set(line.product_id, p);
  }
  return {
    products: [...byProduct.values()].map((p) => ({
      product_id: p.product_id,
      title: p.title,
      first_purchased_on: p.first,
      last_purchased_on: p.last,
      times_purchased: p.orders.size,
      returned: p.bought > 0 && p.keptUnits <= 0,
      free_gift: !p.paid,
    })),
  };
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The one narrow, typed function the advisor reads purchases through. With no
 * reader, or for an anonymous visitor, there is no summary. A reader is asked
 * for exactly one customer, the signed one, of one shop.
 *
 * @param {null | ((query: { shopDomain: string, shopifyCustomerId: string }) => Promise<unknown>)} reader
 */
export function createPurchaseSummaryLookup(reader) {
  return async function purchaseSummaryFor(identity, shopDomain) {
    if (!reader || identity?.kind !== 'customer') return null;
    return toPurchaseSummary(await reader({ shopDomain, shopifyCustomerId: identity.shopifyCustomerId }));
  };
}
