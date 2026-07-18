import { mapShop } from './shopify-shop-mapper.mjs';
import { supabaseUpsert } from './supabase-rest-client.mjs';

export async function syncShop({ args, config, supabase, shop }) {
  const shopRow = mapShop(shop, config);

  if (args.dryRun) {
    console.log(`Dry run: would upsert shop ${shopRow.shop_domain}`);
    return shopRow;
  }

  const rows = await supabaseUpsert(supabase, 'shops', [shopRow], 'shop_domain');
  shopRow.id = rows[0]?.id;
  if (!shopRow.id) {
    throw new Error('Supabase did not return a shop id after upsert.');
  }

  return shopRow;
}
