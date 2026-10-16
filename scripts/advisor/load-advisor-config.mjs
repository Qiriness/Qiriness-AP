import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, loadEnv } from '../lib/sync-config.mjs';
import { createSupabaseClient, supabaseDelete, supabaseInsert, supabaseSelect, supabaseSelectAll, supabaseUpdate } from '../lib/supabase-rest-client.mjs';
import { loadCatalogue } from '../lib/storefront-chat/product-repository.mjs';
import { checkCatalogue, validateConfig } from '../lib/advisory/config.mjs';
import { ADVISOR_T, configToRows } from '../lib/advisory/advisory-repository.mjs';
import { buildAdvisorKnowledge, knowledgeRow } from '../lib/advisory/advisor-knowledge.mjs';

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

// THE KNOWLEDGE (owner, 2026-10-16): the spreadsheet's transcription and the
// brand's routine settings, next to the config file (qiriness.json →
// qiriness-knowledge.json, qiriness-routine-settings.json). With both, the
// foundation engine runs; without, the playbooks above, as before.
const brandFile = (suffix) => file.replace(/\.json$/, `-${suffix}.json`);
const knowledgeFile = path.resolve(flag('--knowledge') ?? brandFile('knowledge'));
const settingsFile = path.resolve(flag('--settings') ?? brandFile('routine-settings'));
let knowledge = null;
if (fs.existsSync(knowledgeFile) && fs.existsSync(settingsFile)) {
  knowledge = buildAdvisorKnowledge({ sheet: JSON.parse(fs.readFileSync(knowledgeFile, 'utf8')), settings: JSON.parse(fs.readFileSync(settingsFile, 'utf8')) });
  const handles = new Set(catalogue.products.map((p) => p.handle));
  const advised = knowledge.products.filter((p) => p.status !== 'do_not_advise');
  const unsold = advised.filter((p) => !handles.has(p.handle)).map((p) => p.handle);
  const unknown = catalogue.products.filter((p) => !knowledge.products.some((k) => k.handle === p.handle)).map((p) => p.handle);
  console.log(`\n${path.basename(knowledgeFile)} + ${path.basename(settingsFile)}`);
  console.log(`  ${knowledge.products.length} products (${advised.length} advisable), ${knowledge.routines.foundations.length} foundations, ${knowledge.routines.modules.length} modules`);
  if (unsold.length) console.log(`  ${unsold.length} in the sheet, not live in this catalogue: ${unsold.join(', ')}`);
  if (unknown.length) console.log(`  ${unknown.length} live, not in the sheet (never advised): ${unknown.join(', ')}`);
  if (knowledge.warnings.length) console.log(`  ${knowledge.warnings.length} warning(s):\n    - ${knowledge.warnings.join('\n    - ')}`);
  if (knowledge.errors.length) {
    console.error(`  ${knowledge.errors.length} error(s), nothing written:\n    - ${knowledge.errors.join('\n    - ')}`);
    process.exit(1);
  }
} else console.log(`\nNo knowledge (${path.basename(knowledgeFile)} and ${path.basename(settingsFile)} are both needed): the playbooks run.`);

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

for (const table of [ADVISOR_T.MERCHANDISING, ADVISOR_T.MAPPINGS, ADVISOR_T.PLAYBOOKS]) {
  await supabaseDelete(db, table, { shop_id: shop.id }, { returning: 'minimal' });
}
await supabaseInsert(db, ADVISOR_T.PLAYBOOKS, rows.playbooks, { returning: 'minimal' });
await supabaseInsert(db, ADVISOR_T.MAPPINGS, rows.mappings, { returning: 'minimal' });
if (rows.merchandising.length) await supabaseInsert(db, ADVISOR_T.MERCHANDISING, rows.merchandising);

// A new version each load: the previous one archived (kept, to compare or roll back).
if (knowledge) {
  const versions = await supabaseSelectAll(db, ADVISOR_T.KNOWLEDGE, { shop_id: shop.id }, 'id,version,status');
  const previous = versions.find((v) => v.status === 'active');
  const version = Math.max(0, ...versions.map((v) => v.version)) + 1;
  if (previous) await supabaseUpdate(db, ADVISOR_T.KNOWLEDGE, { id: previous.id }, { status: 'archived' }, { returning: 'minimal' });
  try {
    await supabaseInsert(db, ADVISOR_T.KNOWLEDGE, [knowledgeRow({ shopId: shop.id, version, source: path.basename(knowledgeFile), products: knowledge.products, routines: knowledge.routines, warnings: knowledge.warnings })], { returning: 'minimal' });
  } catch (error) {
    // Never leave the shop without its knowledge: the previous version comes back.
    if (previous) await supabaseUpdate(db, ADVISOR_T.KNOWLEDGE, { id: previous.id }, { status: 'active' }, { returning: 'minimal' });
    throw error;
  }
  console.log(`\nKnowledge version ${version} active${previous ? ` (version ${previous.version} archived)` : ''}.`);
}
console.log('\nLoaded. The storefront advisor picks it up within five minutes (its catalogue refresh).');
