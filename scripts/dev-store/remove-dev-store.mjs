import { loadConfig, loadEnv } from '../lib/sync-config.mjs';
import { createSupabaseClient, supabaseDelete, supabaseSelect } from '../lib/supabase-rest-client.mjs';
import { devStoreTarget } from './dev-store-config.mjs';

// DEV STORE ONLY. Removes everything `dev-store:sync` wrote, and the advisor's
// chat log for the dev store.
//
//   npm run dev-store:remove            what would be removed, nothing removed
//   npm run dev-store:remove -- --yes   remove
//
// Deleting the dev `shops` row removes its products, collections, promotions
// and metaobjects with it (every one cascades on shop_id). Chat sessions are
// keyed by domain (no foreign key), so they are deleted by domain; their
// messages cascade. Only a row labelled `development` is ever deleted.

const env = loadEnv();
const target = devStoreTarget(env);
const supabase = createSupabaseClient(loadConfig(env));
const confirmed = process.argv.includes('--yes');

const shops = await supabaseSelect(supabase, 'shops', { shop_domain: target.domain }, 'id,environment');
const sessions = await supabaseSelect(supabase, 'storefront_chat_sessions', { shop_domain: target.domain }, 'id');
if (shops.some((s) => s.environment !== 'development')) throw new Error(`${target.domain} has a non-development shop row. Refusing.`);

const counts = {};
for (const shop of shops) {
  for (const table of ['products', 'advice_collections', 'promotions']) {
    counts[table] = (counts[table] ?? 0) + (await supabaseSelect(supabase, table, { shop_id: shop.id }, 'id')).length;
  }
}
console.log(`Dev store ${target.domain}: ${shops.length} shop row, ${JSON.stringify(counts)}, ${sessions.length} chat sessions.`);

if (!confirmed) {
  console.log('Nothing removed. Re-run with --yes to remove.');
} else {
  for (const shop of shops) await supabaseDelete(supabase, 'shops', { id: shop.id, environment: 'development' });
  await supabaseDelete(supabase, 'storefront_chat_sessions', { shop_domain: target.domain });
  console.log('Removed. Unset STOREFRONT_CHAT_CATALOGUE_SHOP_DOMAIN and STOREFRONT_CHAT_PRODUCT_BASE_URL if set.');
}
