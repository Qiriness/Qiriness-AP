import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelect, supabaseSelectAll } from './lib/supabase-rest-client.mjs';
import { loadCatalogue } from './lib/storefront-chat/product-repository.mjs';
import { buildResolutionIndex, resolveProducts } from './lib/storefront-chat/product-resolver.mjs';
import { RESOLUTION_CASES } from './lib/storefront-chat/resolution-cases.mjs';

// The storefront advisor's product resolver against the LIVE catalogue.
//
//   npm run eval:resolution            every case, failures listed
//   npm run eval:resolution -- --all   every case printed
//
// FREE: one catalogue read, no model, no embeddings. The bar before later tools
// depend on it (DECISIONS § Storefront advisor): exact, references and
// discovery at 100%, at least 90% overall, and NO silent wrong pick — one
// product chosen where the expectation is ambiguous is a hard failure.

const verbose = process.argv.includes('--all');
const env = loadEnv();
const db = createSupabaseClient(loadConfig(env));
const [shop] = await supabaseSelect(db, 'shops', { shop_domain: env.SHOPIFY_STORE_DOMAIN }, 'id');
const catalogue = await loadCatalogue({ selectAll: (t, f, c) => supabaseSelectAll(db, t, f, c) }, shop.id);
const index = buildResolutionIndex(catalogue);

const byPattern = (pattern) => {
  const found = catalogue.products.filter((p) => pattern.test(p.name));
  if (found.length !== 1 && !(pattern.source.includes('Source d.Eau') && pattern === pattern)) {
    // Patterns in refs/expect must name exactly one live product.
  }
  return found;
};
const one = (pattern, where) => {
  const found = byPattern(pattern);
  if (found.length !== 1) throw new Error(`${where}: ${pattern} matches ${found.length} live products`);
  return found[0].id;
};

console.log(`catalogue: ${catalogue.products.length} products · care types ${[...index.careTypes.values()].join(', ')}`);
console.log(`synonyms: ${[...index.synonyms].map(([k, v]) => `${k}→${index.careTypes.get(v)}`).join(', ')}\n`);

const results = [];
const timings = [];
for (const c of RESOLUTION_CASES) {
  const refs = c.refs || c.pending
    ? {
        lastSet: (c.refs?.lastSet ?? []).map((p) => one(p, c.message)),
        lastRecommended: (c.refs?.lastRecommended ?? []).map((p) => one(p, c.message)),
        lastSingle: null,
        focus: c.refs?.focus ? one(c.refs.focus, c.message) : null,
        pending: c.pending ? { mention: c.pending.mention, ids: byPattern(c.pending.among).map((p) => p.id) } : null
      }
    : null;
  if (refs) refs.lastSingle = refs.lastSet.length === 1 ? refs.lastSet[0] : null;
  const choice = c.choice instanceof RegExp ? one(c.choice, c.message) : c.choice ?? null;
  const pageProductId = c.page ? one(c.page, c.message) : null;

  const started = process.hrtime.bigint();
  const r = resolveProducts(c.message, { index, pageProductId, refs, choice });
  timings.push(Number(process.hrtime.bigint() - started) / 1e6);

  const problems = [];
  if (c.expect.status && r.status !== c.expect.status) problems.push(`status ${r.status} ≠ ${c.expect.status}`);
  if (c.expect.products) {
    const want = c.expect.products.map((p) => one(p, c.message)).sort();
    const got = r.products.map((p) => p.id).sort();
    if (want.join() !== got.join()) problems.push(`products [${r.products.map((p) => p.name).join(' | ')}]`);
  }
  if (c.expect.clarification && r.clarification?.kind !== c.expect.clarification) problems.push(`clarification ${r.clarification?.kind ?? 'none'} ≠ ${c.expect.clarification}`);
  if (c.expect.range && !r.range) problems.push('no range');
  const silentPick = c.expect.status === 'ambiguous' && r.status === 'resolved' && r.products.length > 0;
  results.push({ c, r, ok: problems.length === 0, problems, silentPick });
}

const cats = [...new Set(RESOLUTION_CASES.map((c) => c.cat))];
for (const cat of cats) {
  const rows = results.filter((x) => x.c.cat === cat);
  console.log(`${cat.padEnd(12)} ${rows.filter((x) => x.ok).length}/${rows.length}`);
}
const hard = results.filter((x) => !x.c.soft);
const silent = results.filter((x) => x.silentPick);
console.log(`\nHARD ${hard.filter((x) => x.ok).length}/${hard.length} · ALL ${results.filter((x) => x.ok).length}/${results.length} · silent wrong picks ${silent.length}`);
const sorted = [...timings].sort((a, b) => a - b);
console.log(`time per message: median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)} ms, worst ${sorted.at(-1).toFixed(2)} ms\n`);

for (const x of results) {
  if (x.ok && !verbose) continue;
  console.log(`${x.ok ? '✓' : x.c.soft ? '~' : '✗'} [${x.c.cat}] ${x.c.message}`);
  if (!x.ok) console.log(`    ${x.problems.join(' · ')}`);
  if (!x.ok || verbose) {
    console.log(`    → ${x.r.status}; ${x.r.products.map((p) => `${p.name} (${p.match_strength}: ${p.match_reason})`).join(' | ') || '—'}`);
    if (x.r.clarification) console.log(`    clarification ${x.r.clarification.kind}: ${x.r.clarification.options.map((o) => o.label).join(' / ')}`);
    if (x.r.unresolved_mentions.length) console.log(`    unresolved: ${x.r.unresolved_mentions.join(' | ')}`);
  }
}
