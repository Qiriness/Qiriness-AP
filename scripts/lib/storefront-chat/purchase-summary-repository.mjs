import { hashIdentifier } from '../compliance-audit.mjs';
import { T } from '../tables.mjs';
import { summarisePurchases } from './purchase-summary.mjs';

/**
 * THE ONE PLACE the storefront advisor reads orders — a signed-in customer's
 * own, for their own consultation (docs/decisions/storefront-advisor.md
 * § Purchase history: identity from the signature only). `data-access.test.mjs`
 * allows no other storefront file to name these tables.
 *
 * - **Scoped twice:** the shop the app proxy signed, and the customer it named.
 *   No other filter is ever accepted from the caller.
 * - **Named columns, no personal fields:** dates, channel and line facts. No
 *   address, email, name, order number or total is selected, so none can leak
 *   past `toPurchaseSummary` even by mistake.
 * - **Logged:** every read writes one `data_access_events` row (hashed customer
 *   id, counts only), as the support agent's customer lookup does.
 * - **The online store only:** a marketplace order's customer is synthetic.
 *   Marketplaces are the shop's `sales_channels` rows, not a list in code.
 */

/** Enough history to ask about; a regular buys far fewer than this in the window. */
export const MAX_ORDERS = 50;
const PURPOSE = 'storefront advice for the signed-in customer';
const ACTOR = 'storefront-advisor';

/**
 * @param {{
 *   select: (table: string, filters: object, columns: string, options?: object) => Promise<object[]>,
 *   logAccess: (row: object) => Promise<unknown>,
 * }} db
 * @returns {(query: { shopDomain: string, shopifyCustomerId: string }) => Promise<object | null>}
 */
export function createPurchaseSummaryReader(db) {
  return async function readPurchases({ shopDomain, shopifyCustomerId }) {
    if (!shopDomain || !/^[1-9]\d{0,19}$/.test(String(shopifyCustomerId ?? ''))) return null;
    const [shop] = await db.select(T.SHOPS, { shop_domain: shopDomain }, 'id', { limit: 1 });
    if (!shop) return null;

    // Orders store Shopify's GraphQL id; the app proxy signs the numeric one.
    const customerGid = `gid://shopify/Customer/${shopifyCustomerId}`;
    const [channels, orders] = await Promise.all([
      db.select(T.SALES_CHANNELS, { shop_id: shop.id }, 'handles'),
      db.select(
        T.ORDERS,
        { shop_id: shop.id, shopify_customer_id: customerGid, cancelled_at: { operator: 'is', value: 'null' }, deleted_at: { operator: 'is', value: 'null' } },
        'id,processed_at,sales_channel_handle',
        { order: 'processed_at.desc', limit: MAX_ORDERS }
      ),
    ]);
    const marketplaceHandles = channels.flatMap((c) => (Array.isArray(c.handles) ? c.handles : []));
    const lines = orders.length
      ? await db.select(
          T.ORDER_LINES,
          { shop_id: shop.id, order_id: { operator: 'in', value: `(${orders.map((o) => o.id).join(',')})` } },
          'order_id,product_id,title,quantity,current_quantity,discounted_total'
        )
      : [];
    const summary = summarisePurchases(orders, lines, { marketplaceHandles });

    await db.logAccess({
      shop_id: shop.id,
      actor_type: 'service',
      actor_id: ACTOR,
      action: 'purchase_summary_read',
      resource_type: T.ORDERS,
      resource_id_hash: hashIdentifier(customerGid),
      purpose: PURPOSE,
      metadata: { orders: orders.length, lines: lines.length, products: summary.products.length },
    });
    return summary;
  };
}
