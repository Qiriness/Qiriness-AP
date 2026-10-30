import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseInsert, supabaseSelect, supabaseSelectAll } from './lib/supabase-rest-client.mjs';
import { parseAllowedShops } from './lib/storefront-chat/app-proxy-signature.mjs';
import { backfillTurns } from './lib/storefront-chat/turn-backfill.mjs';
import { STOREFRONT_AGENT_T, STOREFRONT_CHAT_T } from './lib/tables.mjs';

// The storefront agent's turns from before migration 07, rebuilt from the chat
// log into storefront_agent_turns (turn-backfill.mjs), so the dashboard has the
// history the log still holds (it is purged after STOREFRONT_CHAT_RETENTION_DAYS).
//
//   npm run storefront:backfill-turns -- --dry-run     count what would be written, write nothing
//   npm run storefront:backfill-turns                  write the missing turns
//   npm run storefront:backfill-turns -- --shop x.myshopify.com
//
// IDEMPOTENT: a question that already has a turn (live or from an earlier run)
// is skipped, by user_message_id. Products are named by the advisor's catalogue
// (STOREFRONT_CHAT_CATALOGUE_SHOP_DOMAIN on the dev store, else the dashboard's).

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const dryRun = args.includes('--dry-run');

const env = loadEnv();
const config = loadConfig(env);
const db = createSupabaseClient(config);
const shops = flag('--shop') ? [flag('--shop')] : [...parseAllowedShops(env.STOREFRONT_CHAT_ALLOWED_SHOPS)];
if (!shops.length) {
  console.error('No shop: set STOREFRONT_CHAT_ALLOWED_SHOPS or pass --shop.');
  process.exit(1);
}

const catalogueDomain = env.STOREFRONT_CHAT_CATALOGUE_SHOP_DOMAIN || config.shopDomain;
const [catalogueShop] = await supabaseSelect(db, 'shops', { shop_domain: catalogueDomain }, 'id', { limit: 1 });
const products = catalogueShop ? await supabaseSelectAll(db, 'products', { shop_id: catalogueShop.id }, 'id,handle') : [];
const productIdByHandle = new Map(products.filter((p) => p.handle).map((p) => [p.handle, p.id]));

for (const shopDomain of shops) {
  const sessions = await supabaseSelectAll(db, STOREFRONT_CHAT_T.SESSIONS, { shop_domain: shopDomain }, 'id');
  const ids = new Set(sessions.map((s) => s.id));
  const messages = (
    await supabaseSelectAll(
      db,
      STOREFRONT_CHAT_T.MESSAGES,
      {},
      'id,session_id,role,content,action,context,model,input_tokens,output_tokens,created_at'
    )
  ).filter((m) => ids.has(m.session_id));
  const existing = await supabaseSelectAll(db, STOREFRONT_AGENT_T.TURNS, { shop_domain: shopDomain }, 'user_message_id');
  const skip = new Set(existing.map((t) => t.user_message_id).filter(Boolean));
  const rows = backfillTurns(messages, { shopDomain, productIdByHandle, skip });

  const tally = (key) => Object.entries(rows.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] ?? 0) + 1 }), {}));
  console.log(`${shopDomain}: ${sessions.length} sessions, ${messages.length} messages, ${skip.size} turns already recorded, ${rows.length} to write`);
  console.log(`  by route  ${JSON.stringify(Object.fromEntries(tally('route')))}`);
  console.log(`  by intent ${JSON.stringify(Object.fromEntries(tally('intent')))}`);
  console.log(`  by status ${JSON.stringify(Object.fromEntries(tally('status')))}`);
  if (dryRun || !rows.length) continue;
  for (let i = 0; i < rows.length; i += 200) {
    await supabaseInsert(db, STOREFRONT_AGENT_T.TURNS, rows.slice(i, i + 200), { returning: 'minimal' });
  }
  console.log(`  written: ${rows.length}`);
}
if (dryRun) console.log('Dry run: nothing written.');
