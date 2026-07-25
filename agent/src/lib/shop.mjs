import { supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';

// Resolve the local shops.id for a Shopify store domain. Shared by the worker
// entrypoint and the blocklist CLI so neither reimplements it.
export async function resolveShopId(supabase, shopDomain) {
  const rows = await supabaseSelect(supabase, 'shops', { shop_domain: shopDomain }, 'id,shop_domain');
  if (rows.length === 0) {
    throw new Error(`No shops row for domain ${shopDomain}. Run the Shopify sync first.`);
  }
  return rows[0].id;
}
