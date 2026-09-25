import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createShopifyClient, fetchShop } from './lib/shopify-admin-client.mjs';
import { createSupabaseClient } from './lib/supabase-rest-client.mjs';
import { syncShop } from './lib/shop-sync-service.mjs';
import { runKlaviyoSync } from './lib/klaviyo-sync.mjs';

// Klaviyo flows and campaigns into Supabase, on their own:
//
//   npm run sync:klaviyo
//   npm run sync:klaviyo -- --dry-run
//
// The key is the one saved on Settings -> Integrations (Supabase Vault); there
// is no environment variable for it. The nightly sync runs the same step last;
// this is the first backfill and the button for when a night was missed.

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
  const counts = await runKlaviyoSync({ supabase, shopRow, dryRun: args.dryRun });
  console.log(`${args.dryRun ? 'Dry run: ' : ''}klaviyo ${JSON.stringify(counts)}`);
}
