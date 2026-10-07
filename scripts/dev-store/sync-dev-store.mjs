import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig, loadEnv } from '../lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelect, supabaseUpdate } from '../lib/supabase-rest-client.mjs';
import { devStoreTarget } from './dev-store-config.mjs';

// DEV STORE ONLY. Copies the dev store's products (with stock), collections
// (with membership) and discounts into Supabase under its OWN shop row,
// labelled `development`, so the storefront advisor can evaluate a dev cart,
// dev stock and dev promotions for real.
//
//   npm run dev-store:sync -- --dry-run     what would be written, nothing written
//   npm run dev-store:sync                  write
//
// It runs the SAME sync scripts as production, as child processes with the dev
// store's domain and the advisor app's credentials (dev-store-config.mjs holds
// the guards). Production rows, orders and customers are never touched.
// Removal: npm run dev-store:remove.

const env = loadEnv();
const target = devStoreTarget(env);
const dryRun = process.argv.includes('--dry-run');
const root = fileURLToPath(new URL('../..', import.meta.url));

function run(script, extra = []) {
  console.log(`\n→ ${script} ${[...extra, ...(dryRun ? ['--dry-run'] : [])].join(' ')}`);
  const result = spawnSync(process.execPath, [`scripts/${script}`, ...extra, ...(dryRun ? ['--dry-run'] : [])], {
    cwd: root,
    env: target.childEnv,
    stdio: 'inherit'
  });
  if (result.status !== 0) throw new Error(`${script} failed (exit ${result.status}).`);
}

console.log(`Dev store: ${target.domain}${dryRun ? ' (dry run)' : ''}`);
run('sync-shopify-products.mjs');
run('sync-shopify-promotions.mjs');
run('sync-shopify-collections.mjs');

if (!dryRun) {
  // Collection membership is fetched only for ACTIVE collections. On the dev
  // shop every collection is switched on, so collection-scoped discounts can
  // be evaluated against a dev cart; the dashboard never shows this shop.
  const supabase = createSupabaseClient(loadConfig(target.childEnv));
  const [shop] = await supabaseSelect(supabase, 'shops', { shop_domain: target.domain, environment: 'development' }, 'id', { limit: 1 });
  if (!shop) throw new Error(`No development shop row for ${target.domain} after the sync.`);
  await supabaseUpdate(supabase, 'advice_collections', { shop_id: shop.id, is_active: false }, { is_active: true });
  run('sync-shopify-collections.mjs');
  console.log(`\nDone. Set STOREFRONT_CHAT_CATALOGUE_SHOP_DOMAIN=${target.domain} for the advisor to use this catalogue.`);
}
