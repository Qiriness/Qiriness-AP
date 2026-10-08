import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, loadEnv } from '../lib/sync-config.mjs';
import { createSupabaseClient, supabaseDelete, supabaseInsert, supabaseSelect, supabaseSelectAll } from '../lib/supabase-rest-client.mjs';
import { loadCatalogue } from '../lib/storefront-chat/product-repository.mjs';
import { checkCatalogue, validateConfig } from '../lib/advisory/config.mjs';
import { ADVISOR_T, configToRows } from '../lib/advisory/advisory-repository.mjs';

// Loads the brand's advisory config — playbooks, mappings, merchandising — from
// its authored file into the advisor tables (migration 80).
//
//   npm run advisor:load -- --dry-run                 validate + check against the live catalogue, write nothing
//   npm run advisor:load                              replace this shop's config with the file
//   npm run advisor:load -- --file data/advisor/x.json --shop x.myshopify.com
//
// THE FILE IS THE SOURCE. A load replaces the shop's three config tables
// whole (delete, then insert), so a playbook removed from the file is removed
// from the advisor. Events are never touched.
//
// Every family, slot, concern and area is checked against the live catalogue
// first: a collection handle that no longer exists, a tag on no product, a
// slot that matches nothing are printed. They are warnings — the advisor
// skips an empty step — but each one is a step a customer will not get.

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const dryRun = args.includes('--dry-run');
const file = path.resolve(flag('--file') ?? 'data/advisor/qiriness.json');

const env = loadEnv();
const config = loadConfig(env);
const db = createSupabaseClient(config);
const shopDomain = flag('--shop') ?? config.shopDomain;

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const errors = validateConfig(raw);
if (errors.length) {
  console.error(`${path.basename(file)} is not valid:\n  - ${errors.join('\n  - ')}`);
  process.exit(1);
}

const [shop] = await supabaseSelect(db, 'shops', { shop_domain: shopDomain }, 'id,shop_domain');
if (!shop) {
  console.error(`No shop row for ${shopDomain}.`);
  process.exit(1);
}

const catalogue = await loadCatalogue({ selectAll: (t, f, c) => supabaseSelectAll(db, t, f, c) }, shop.id);
const { problems } = checkCatalogue(raw, catalogue);
const rows = configToRows(raw, shop.id);

console.log(`${path.basename(file)} → ${shopDomain}`);
console.log(`  ${rows.playbooks.length} playbooks, ${rows.mappings.length} mapping entries, ${rows.merchandising.length} merchandising entries`);
console.log(`  catalogue: ${catalogue.products.length} live products, ${catalogue.collections.length} active collections`);
if (problems.length) console.log(`  ${problems.length} reference(s) resolve to nothing:\n    - ${problems.join('\n    - ')}`);
else console.log('  every family, slot, concern and area resolves on this catalogue');

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

for (const table of [ADVISOR_T.MERCHANDISING, ADVISOR_T.MAPPINGS, ADVISOR_T.PLAYBOOKS]) {
  await supabaseDelete(db, table, { shop_id: shop.id });
}
await supabaseInsert(db, ADVISOR_T.PLAYBOOKS, rows.playbooks);
await supabaseInsert(db, ADVISOR_T.MAPPINGS, rows.mappings);
if (rows.merchandising.length) await supabaseInsert(db, ADVISOR_T.MERCHANDISING, rows.merchandising);
console.log('\nLoaded. The storefront advisor picks it up within five minutes (its catalogue refresh).');
