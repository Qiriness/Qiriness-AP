/**
 * What the storefront advisor may know of a signed-in customer's purchases —
 * the contract, Phase 0 (docs/storefront-advisor-plan.md § 5).
 *
 * The reader that fills it (Phase 1, from the orders table, online store only) is not
 * built. Whatever it returns passes through `toPurchaseSummary` before the
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
 * The one narrow, typed function the advisor reads purchases through. Phase 0
 * wires none: with no reader, or for an anonymous visitor, there is no summary.
 * A reader is asked for exactly one customer, the signed one, of one shop.
 *
 * @param {null | ((query: { shopDomain: string, shopifyCustomerId: string }) => Promise<unknown>)} reader
 */
export function createPurchaseSummaryLookup(reader) {
  return async function purchaseSummaryFor(identity, shopDomain) {
    if (!reader || identity?.kind !== 'customer') return null;
    return toPurchaseSummary(await reader({ shopDomain, shopifyCustomerId: identity.shopifyCustomerId }));
  };
}
