// Read-only LIVE retrieval checks. No model, embeddings, customer/order reads or writes.
import assert from 'node:assert/strict';
import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelect, supabaseSelectAll } from './lib/supabase-rest-client.mjs';
import { loadCatalogue } from './lib/storefront-chat/product-repository.mjs';
import { loadKnowledge, createProductPolicyReader } from './lib/storefront-chat/knowledge-repository.mjs';
import { getPolicy, searchFaqs, runKnowledgeTool } from './lib/storefront-chat/knowledge-tools.mjs';
import { retrieveKnowledge } from './lib/storefront-chat/knowledge-router.mjs';
import { buildResolutionIndex, resolveProducts } from './lib/storefront-chat/product-resolver.mjs';

const env = loadEnv();
const db = createSupabaseClient(loadConfig(env));
const [shop] = await supabaseSelect(db, 'shops', { shop_domain: env.SHOPIFY_STORE_DOMAIN }, 'id');
if (!shop) throw new Error('Catalogue shop not found.');
const reader = { selectAll: (table, filters, columns) => supabaseSelectAll(db, table, filters, columns) };
const [knowledge, catalogue] = await Promise.all([loadKnowledge(reader, shop.id), loadCatalogue(reader, shop.id)]);
const readProductPolicies = createProductPolicyReader(reader, shop.id);
const index = buildResolutionIndex(catalogue);
let passed = 0; let failed = 0;
const timings = [];
async function check(label, run) {
  try { await run(); passed += 1; console.log(`PASS ${label}`); }
  catch (error) { failed += 1; console.log(`FAIL ${label}: ${error.message}`); }
}

for (const [message, expectedKey] of [
  ['Quels sont les délais de livraison en France ?', 'delivery_time_policy'],
  ['Combien de temps prend la livraisson en Belgique ?', 'delivery_time_policy'],
  ['Quels sont les frais de livraison ?', 'shipping_cost_policy'],
  ['Quels sont les délais d’expédition ?', 'dispatch_time_policy'],
  ['Puis-je retourner un article ouvert ?', 'return_policy'],
  ['Quel est le délai de remboursement ?', 'refund_policy'],
  ['Puis-je payer en plusieurs fois ?', 'payment_policy'],
  ['Les codes promo sont cumulables ?', 'promotion_discount_policy'],
  ['Puis-je annuller ma commande ?', 'order_cancellation_policy']
]) await check(message, () => {
  const started = performance.now();
  const result = retrieveKnowledge({ message, knowledge });
  timings.push(performance.now() - started);
  assert.equal(result.route, 'general_policy');
  assert.ok(result.results.some(({ result }) => result.sources?.some((s) => s.policy_key === expectedKey)), `Missing ${expectedKey}`);
});

await check('Parameter delivery fact and country scope', () => {
  const fr = getPolicy(knowledge, { topic: 'delivery', country: 'FR' });
  assert.equal(fr.facts.delivery_time.parameter_key, 'france_delivery_days');
  assert.equal(String(fr.facts.delivery_time.value), String(knowledge.parameters.get('france_delivery_days')));
  const be = getPolicy(knowledge, { topic: 'delivery', country: 'BE' });
  assert.equal(be.facts.delivery_time.parameter_key, 'abroad_delivery_days');
});
await check('Shipping threshold retains policy conditions', () => {
  const result = getPolicy(knowledge, { topic: 'delivery', country: 'FR', context: { query: 'Livraison gratuite ?' } });
  assert.equal(result.facts.free_shipping_threshold.parameter_key, 'free_shipping_threshold');
  assert.ok(result.sources.find((s) => s.policy_key === 'shipping_cost_policy').passages.length);
});
await check('Canonical approved account FAQ', () => {
  const result = searchFaqs(knowledge, { query: 'Dois-je créer un compte pour passer une commande ?' });
  assert.equal(result.status, 'found');
  assert.equal(result.matches[0].match_stage, 'exact');
});
await check('Country FAQ links to policy instead of copied answer', () => {
  const result = searchFaqs(knowledge, { query: 'Puis-je me faire livrer à l’étranger ?' });
  assert.equal(result.status, 'found');
  assert.equal(result.matches[0].answer, undefined);
  assert.equal(result.matches[0].policy_reference[0].topic, 'delivery');
});
await check('Missing privacy policy is explicit', () => {
  assert.equal(getPolicy(knowledge, { topic: 'privacy' }).status, 'not_found');
});
await check('Resolved LED product retrieves only its linked warranty guidance', async () => {
  const resolution = resolveProducts('Quelle est la garantie du Masque LED Visage ?', { index });
  assert.equal(resolution.status, 'resolved');
  assert.equal(resolution.products.length, 1);
  const id = resolution.products[0].id;
  const result = await runKnowledgeTool('get_product_policy', { product_id: id, topic: 'warranty', query: 'Quelle est la garantie du Masque LED ?' }, knowledge, {
    catalogue, resolvedIds: new Set([id]), productDataIds: new Set([id]), readProductPolicies
  });
  assert.equal(result.status, 'found');
  assert.match(result.matches[0].canonical_question, /garantie/i);
});

timings.sort((a, b) => a - b);
console.log(`${passed}/${passed + failed} checks passed; median warm retrieval ${(timings[Math.floor(timings.length / 2)] ?? 0).toFixed(2)} ms; no model calls or writes.`);
if (failed) process.exitCode = 1;
