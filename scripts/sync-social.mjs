import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createShopifyClient, fetchShop } from './lib/shopify-admin-client.mjs';
import { createSupabaseClient } from './lib/supabase-rest-client.mjs';
import { syncShop } from './lib/shop-sync-service.mjs';
import { runSocialSync } from './lib/social-sync.mjs';

// Meta (Instagram, Facebook Page, Meta Ads) and Google Ads into Supabase:
//
//   npm run sync:social
//   npm run sync:social -- --provider=meta
//   npm run sync:social -- --dry-run
//
// The tokens are the ones granted on Insights -> Social media -> Connections
// (Supabase Vault). The app's own credentials (META_APP_ID, GOOGLE_...) come
// from the environment. The nightly runs the same step last, and the worker
// runs it when Connect or « Sync now » queues a `sync_social` job.

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv.filter((a) => !a.startsWith('--provider=')));
  const provider = argv.find((a) => a.startsWith('--provider='))?.split('=')[1] ?? null;
  const env = loadEnv();
  const config = loadConfig(env);
  const shopify = await createShopifyClient(config);
  const supabase = createSupabaseClient(config);
  const shopRow = await syncShop({ args, config, supabase, shop: await fetchShop(shopify) });
  const results = await runSocialSync({ supabase, shopRow, provider, env, dryRun: args.dryRun });
  console.log(`${args.dryRun ? 'Dry run: ' : ''}social ${JSON.stringify(results)}`);
  if (Object.values(results).some((r) => r.status === 'failed' || r.status === 'needs_reconnect')) process.exitCode = 1;
}
