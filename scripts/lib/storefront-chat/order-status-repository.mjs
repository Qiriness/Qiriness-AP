import { hashIdentifier } from '../compliance-audit.mjs';
import { T } from '../tables.mjs';

/**
 * The second place the storefront advisor reads orders (the first is the
 * signed-in customer's purchase summary): ONE order's status, by its number
 * (owner, 2026-10-13; docs/decisions/storefront-advisor.md § The storefront
 * agent reads one order's status by its number). `data-access.test.mjs`
 * allows no other storefront file to name the order tables.
 *
 * - **By number only**, on the catalogue's shop. Anyone holding a number may
 *   ask: guests are most customers. Numbers are sequential, so what comes back
 *   is kept to what a guess may reveal: status and days, nothing about the person.
 * - **Named columns:** dates, statuses, the channel, the destination COUNTRY
 *   (only to choose the home or abroad delivery time) and the fulfilments,
 *   cut here to their dates and status. No name, email, phone, address,
 *   amount, product or tracking leaves this file.
 * - **Online store only:** a marketplace order is « not found », as the
 *   marketplaces answer for their own orders.
 * - **Logged:** every lookup, found or not, writes one `data_access_events`
 *   row (hashed shop and number). A lookup that cannot be logged is not used.
 */

const ACTOR = 'storefront-advisor';
const PURPOSE = 'order status asked by its number in the storefront advisor';
const COLUMNS = 'name,processed_at,fulfillment_status,cancelled_at,delivered_at,sales_channel_handle,fulfillments,country:shipping_destination->>country_code';

/**
 * @param {{
 *   select: (table: string, filters: object, columns: string, options?: object) => Promise<object[]>,
 *   logAccess: (row: object) => Promise<unknown>,
 * }} db
 * @returns {(query: { shopDomain: string, orderNumber: number }) => Promise<object | null>}
 */
export function createOrderStatusReader(db) {
  return async function readOrder({ shopDomain, orderNumber }) {
    if (!shopDomain || !Number.isSafeInteger(orderNumber) || orderNumber <= 0) return null;
    const [shop] = await db.select(T.SHOPS, { shop_domain: shopDomain }, 'id', { limit: 1 });
    if (!shop) return null;
    const [channels, rows] = await Promise.all([
      db.select(T.SALES_CHANNELS, { shop_id: shop.id }, 'handles'),
      db.select(T.ORDERS, { shop_id: shop.id, order_number: orderNumber, deleted_at: { operator: 'is', value: 'null' } }, COLUMNS, { limit: 1 }),
    ]);
    const marketplaces = new Set(channels.flatMap((c) => (Array.isArray(c.handles) ? c.handles : [])));
    const row = rows[0] && !marketplaces.has(rows[0].sales_channel_handle) ? rows[0] : null;
    await db.logAccess({
      shop_id: shop.id,
      actor_type: 'service',
      actor_id: ACTOR,
      action: 'order_status_read',
      resource_type: T.ORDERS,
      resource_id_hash: hashIdentifier(`${shop.id}:${orderNumber}`),
      purpose: PURPOSE,
      metadata: { found: Boolean(row) },
    });
    if (!row) return null;
    return {
      name: typeof row.name === 'string' ? row.name : `#${orderNumber}`,
      processed_at: row.processed_at ?? null,
      fulfillment_status: row.fulfillment_status ?? null,
      cancelled_at: row.cancelled_at ?? null,
      delivered_at: row.delivered_at ?? null,
      country: typeof row.country === 'string' ? row.country.toUpperCase() : null,
      fulfillments: (Array.isArray(row.fulfillments) ? row.fulfillments : []).map((f) => ({ created_at: f?.created_at ?? null, status: f?.status ?? null })),
    };
  };
}
