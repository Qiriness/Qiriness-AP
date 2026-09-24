import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createShopifyClient, fetchShop } from './lib/shopify-admin-client.mjs';
import { createSupabaseClient } from './lib/supabase-rest-client.mjs';
import { syncShop } from './lib/shop-sync-service.mjs';
import { runStorefrontMonthsSync } from './lib/storefront-months-sync.mjs';

// Closed months of storefront sessions into Supabase, on their own:
//
//   npm run sync:storefront-months
//   npm run sync:storefront-months -- --dry-run
//
// The nightly sync runs the same step last; this is the backfill and the
// button for when a night was missed.

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(loadEnv());
  const shopify = await createShopifyClient(config);
  const supabase = createSupabaseClient(config);
  const shopRow = await syncShop({ args, config, supabase, shop: await fetchShop(shopify) });
  const counts = await runStorefrontMonthsSync({ shopify, supabase, shopRow, dryRun: args.dryRun });
  console.log(`${args.dryRun ? 'Dry run: ' : ''}storefront months ${JSON.stringify(counts)}`);
}
