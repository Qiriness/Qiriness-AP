import { mapShop } from './shopify-shop-mapper.mjs';
import { supabaseSelectAll, supabaseUpsert } from './supabase-rest-client.mjs';

/**
 * Upsert the shop and return THE STORED ROW, not the payload we just sent.
 *
 * WHY THE DISTINCTION IS NOT PEDANTIC. `mapShop` returns a fixed column set, and
 * the columns it omits are exactly the ones that are ours rather than Shopify's
 * — `order_retention_mode` above all. Returning the mapped payload therefore
 * handed every caller a shop with no retention setting on it, which
 * `readRetentionPolicy` reads as "unset" and resolves to the 6-month fallback.
 *
 * That was live: with the shop set to `indefinite`, an order sync would have
 * re-stamped all 2,006 orders with 6-month delete dates and then purged
 * everything older than six months in the same pass — deleting order history
 * that Shopify itself no longer returns, and silently undoing migration 10. The
 * upsert already asks for `return=representation`; the row was there and was
 * being thrown away.
 */
export async function syncShop({ args, config, supabase, shop }) {
  const shopRow = mapShop(shop, config);

  if (args.dryRun) {
    console.log(`Dry run: would upsert shop ${shopRow.shop_domain}`);
    // READ THE STORED ROW ANYWAY. A dry run exists to report what a real run
    // would do, and the settings that decide that live on the row, not in the
    // payload. Reporting the fallback policy while the shop is set to something
    // else makes the dry run actively misleading — which is how this bug was
    // found. Best-effort: a shop that does not exist yet is a normal state.
    try {
      const stored = await supabaseSelectAll(supabase, 'shops', { shop_domain: shopRow.shop_domain });
      if (stored[0]) {
        return { ...stored[0], ...stripUndefined(shopRow), id: stored[0].id };
      }
    } catch {
      console.log('Dry run: could not read the stored shop row; reporting defaults.');
    }
    return shopRow;
  }

  const rows = await supabaseUpsert(supabase, 'shops', [shopRow], 'shop_domain');
  const stored = rows[0];
  if (!stored?.id) {
    throw new Error('Supabase did not return a shop id after upsert.');
  }

  // The stored row is the base so that locally-owned columns survive; the mapped
  // values sit on top because they are what this run just wrote.
  return { ...stored, ...stripUndefined(shopRow), id: stored.id };
}

/** Undefined keys in the payload must not blank out stored columns. */
function stripUndefined(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}
