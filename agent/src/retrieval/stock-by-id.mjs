import { supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';

import { buildStock } from './product-context.mjs';

// STOCK OF PRODUCTS ALREADY NAMED BY ID — a gift from an offer's rules, a
// sample from an order line. No matching: the id is the product.
//
// One reader for both, so "can it be sent?" means the same thing for a missing
// gift and a missing sample: `buildStock().purchasable`, under which a draft or
// archived product, or a -1 count, is never in stock. Samples are deliberately
// NOT excluded here, unlike every customer-facing lookup: being sent in a
// parcel is exactly what they are for.

/** `[{ id, title, purchasable }]` for the ids that have a product row. */
export async function readStockByShopifyIds(supabase, shopId, ids = []) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
  if (wanted.length === 0) return [];
  const rows = await supabaseSelectAll(
    supabase,
    'products',
    {
      shop_id: shopId,
      // Quoted: a Shopify gid carries `/` and `:`, which `in.()` would split on.
      shopify_product_id: { operator: 'in', value: `(${wanted.map((id) => `"${id}"`).join(',')})` }
    },
    'shopify_product_id,title,status,available_stock,deleted_at'
  );
  return (rows || [])
    .filter((row) => wanted.includes(row.shopify_product_id))
    .map((row) => ({
      id: row.shopify_product_id,
      title: row.title || null,
      purchasable: !row.deleted_at && buildStock(row).purchasable
    }));
}

/**
 * Whether every candidate can be sent now.
 *
 * `[]` → `none`: there is nothing to send. `null` → `unknown`: the items could
 * not be named. An id with no product row makes the whole answer `unknown`
 * rather than a guess. `partial`: only some of the candidates are in stock.
 */
export function stockOfAll(ids, products = []) {
  if (Array.isArray(ids) && ids.length === 0) return 'none';
  if (!Array.isArray(ids)) return 'unknown';
  const byId = new Map(products.map((p) => [p.id, p]));
  if (ids.some((id) => !byId.has(id))) return 'unknown';
  const sendable = ids.filter((id) => byId.get(id).purchasable).length;
  if (sendable === ids.length) return 'in_stock';
  return sendable === 0 ? 'out_of_stock' : 'partial';
}
