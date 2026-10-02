import { supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { isValidTimeZone } from '../../../scripts/lib/insights-range.mjs';

// Resolve the local shops.id for a Shopify store domain. Shared by the worker
// entrypoint and the blocklist CLI so neither reimplements it.
export async function resolveShopId(supabase, shopDomain) {
  const rows = await supabaseSelect(supabase, 'shops', { shop_domain: shopDomain }, 'id,shop_domain');
  if (rows.length === 0) {
    throw new Error(`No shops row for domain ${shopDomain}. Run the Shopify sync first.`);
  }
  return rows[0].id;
}

/**
 * The shop's IANA time zone (`shops.iana_timezone`, from Shopify), or UTC when
 * it is unset or not a zone this runtime knows. Read where a prompt shows a
 * time a person at the shop would recognise.
 */
export async function loadShopTimeZone(supabase, shopId) {
  const rows = await supabaseSelect(supabase, 'shops', { id: shopId }, 'iana_timezone');
  const zone = rows[0]?.iana_timezone;
  return isValidTimeZone(zone) ? zone : 'UTC';
}
