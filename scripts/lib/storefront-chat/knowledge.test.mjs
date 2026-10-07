import assert from 'node:assert/strict';
import test from 'node:test';
import { buildKnowledge, loadKnowledge, createProductPolicyReader, KNOWLEDGE_TTL_MS } from './knowledge-repository.mjs';
import { faqRecords, matchFaqs } from './faq-matcher.mjs';
import { getPolicy, searchFaqs, runKnowledgeTool, knowledgeToolDefinitions } from './knowledge-tools.mjs';
import { retrieveKnowledge } from './knowledge-router.mjs';
import { countryForTurn } from './knowledge-topics.mjs';
import { buildCatalogue } from './product-repository.mjs';
import { buildResolutionIndex, resolveProducts } from './product-resolver.mjs';
import { createLlmAgent } from './llm-agent.mjs';
import { parseChatRequest } from './request-schema.mjs';
import { KNOWLEDGE_CASES } from './knowledge-cases.mjs';

const policy = (key, content) => ({ policy_key: key, content, active: true, version: 2, updated_at: '2026-10-01' });
const doc = (id, sections, more = {}) => ({ id, sections, approval_status: 'approved', product_ids: [], locale: 'fr', category: 'faq', updated_at: '2026-10-01', ...more });
const section = (anchor, heading, text) => ({ anchor, heading, text });
const PARAMS = [
  ['france_delivery_days', '4'], ['abroad_delivery_days', '8'], ['dispatch_days', '2'],
  ['free_shipping_threshold', '85'], ['returns_window_days', '21'], ['refund_processing_days', '6'], ['returns_address', 'Entrepôt fictif']
].map(([parameter_key, value]) => ({ parameter_key, value, updated_at: '2026-10-02' }));
const POLICIES = [
  policy('delivery_time_policy', 'Les délais sont habituels, à compter de l’expédition.\nFrance : {france_delivery_days}\nInternational : {abroad_delivery_days}\n\nAucune confirmation de perte ne peut être déduite de ce délai.'),
  policy('delivery_location_policy', 'Nous livrons vers les destinations suivantes :\n\nFrance,\nBelgique,\n\nSi la destination ne figure pas dans cette liste, elle n’est pas desservie.'),
  policy('dispatch_time_policy', 'La préparation prend typiquement {dispatch_days} jours après réception du paiement.'),
  policy('shipping_cost_policy', 'Ponctuellement, la livraison gratuite à partir de {free_shipping_threshold} euros peut être proposée en France.\n\nLa gratuité ne s’applique pas à l’étranger.'),
  policy('return_policy', 'Pour les achats sur notre site, le retour peut être demandé dans les {returns_window_days} jours après livraison.\n\nLe produit doit être neuf, non utilisé et dans son emballage d’origine.\n\nAdresse de retour : {returns_address}.\n\nLes produits défectueux suivent une procédure distincte.'),
  policy('refund_policy', 'Après émission du remboursement, le délai bancaire peut être de {refund_processing_days} jours ouvrés.'),
  policy('payment_policy', 'Les cartes et PayPal sont acceptés.\n\nLe paiement fractionné n’est pas disponible dans cette boutique fictive.'),
  policy('promotion_discount_policy', 'Les conditions propres à chaque offre s’appliquent.\n\nUne offre peut ne pas être cumulable.'),
  policy('order_cancellation_policy', 'Une commande validée ne peut plus être annulée automatiquement.'),
  policy('address_change_policy', 'Le service client vérifie si une modification est encore possible.'),
  policy('order_modification_policy', 'Aucune modification ne doit être confirmée sans vérification.')
];
const DOCUMENTS = [
  doc('accounts', [section('account', 'Dois-je créer un compte pour commander ?', 'Puis-je commander sans compte ?\nLa commande sans compte est possible dans cet exemple.')]),
  doc('delivery-faq', [section('timing', 'Combien de temps prend la livraison ?', 'Quel délai pour la livraison ?\nAncien délai de 999 jours, ne doit jamais être utilisé.')]),
  doc('draft', [section('secret', 'Quels secrets ?', 'Ne pas utiliser ce brouillon.')], { approval_status: 'draft' }),
  doc('unlinked-product', [section('usage', 'Comment utiliser un appareil ?', 'Guidance non liée.')], { category: 'product' })
];
const GUIDANCE = faqRecords([doc('mask-guide', [
  section('eyes', 'Quelles précautions pour les yeux ?', 'Consultez les précautions du manuel avant la séance.'),
  section('warranty', 'Quelle est la garantie du masque ?', 'La garantie est décrite dans le manuel fourni.')
], { category: 'product', product_ids: ['mask'] })]);
const CATALOGUE = buildCatalogue([
  { id: 'cream', handle: 'brume', title: 'Crème hydratante - Caresse Brume', usage_instructions: 'Appliquer matin et soir.', variants: [], available_stock: 1,
    product_faqs: [{ faq_id: 'cream-faq', question: 'Comment conserver le produit ?', answer: 'Conserver dans un endroit sec.', published: true }, { question: 'Question cachée', answer: 'Ne pas exposer', published: false }] },
  { id: 'mask', handle: 'lumiere', title: 'Appareil visage - Masque Lumière', description: 'Un appareil pour le visage.', variants: [], available_stock: 1 }
], []);
const INDEX = buildResolutionIndex(CATALOGUE);
const makeKnowledge = (changes = {}) => buildKnowledge({ policies: POLICIES, parameters: PARAMS, documents: DOCUMENTS, ...changes });

for (const c of KNOWLEDGE_CASES) test(`French route: ${c.message}`, async () => {
  const resolution = resolveProducts(c.message, { index: INDEX });
  const knowledge = makeKnowledge();
  const opening = retrieveKnowledge({ message: c.message, knowledge, resolution });
  assert.equal(opening.route, c.route);
  assert.deepEqual(opening.results.map((r) => r.tool), c.tools);
  for (const key of c.policies ?? []) assert.ok(opening.results.some(({ result }) => result.sources?.some((s) => s.policy_key === key)), `Missing ${key}`);
  if (c.country) assert.equal(opening.country, c.country);
  if (c.support) assert.equal(opening.results[0].result.country_support, c.support);
  if (c.status) assert.equal(opening.results[0].result.status, c.status);
  if (c.faq) {
    assert.equal(opening.results[0].result.matches[0].id, c.faq);
    assert.equal(opening.results[0].result.matches[0].match_stage, c.stage);
  }
  if (c.products) assert.deepEqual(resolution.products.map((p) => p.id), c.products);
  for (const forbidden of c.forbidden ?? []) assert.ok(!opening.results.some((r) => r.tool === forbidden));
  if (c.fallback) {
    let reads = 0;
    const result = await runKnowledgeTool(c.fallback.tool, { product_id: c.products[0], topic: c.fallback.topic, query: c.fallback.query ?? c.message }, knowledge, {
      catalogue: CATALOGUE, resolvedIds: new Set(c.products), productDataIds: new Set(c.products), query: c.message,
      readProductPolicies: async (id) => { reads += 1; assert.equal(id, c.products[0]); return GUIDANCE; }
    });
    assert.equal(reads, 1);
    assert.equal(result.status, 'found');
    assert.equal(result.matches[0].id, c.fallback.result);
  }
});

test('policy facts use referenced parameters, exact scopes, provenance and current values', () => {
  const k = makeKnowledge();
  const result = getPolicy(k, { topic: 'delivery', country: 'FR', context: { query: 'Quels délais de livraison ?' } });
  assert.equal(result.facts.delivery_time.value, 4);
  assert.equal(result.facts.delivery_time.starts_at, 'dispatch');
  assert.equal(result.facts.delivery_time.updated_at, '2026-10-02');
  assert.equal(result.sources[0].version, 2);
  assert.ok(result.sources[0].passages[0].includes('France : 4'));
  k.parameters.set('france_delivery_days', '5');
  assert.equal(getPolicy(k, { topic: 'delivery', country: 'FR' }).facts.delivery_time.value, 5);
  assert.equal(getPolicy(k, { topic: 'delivery', country: 'BE' }).facts.delivery_time.value, 8);
  assert.equal(getPolicy(k, { topic: 'delivery', country: 'CH' }).country_support, 'unsupported');
  assert.equal(getPolicy(k, { topic: 'delivery', country: 'CH' }).facts.delivery_time, undefined);
  assert.equal(getPolicy(k, { topic: 'delivery' }).facts.delivery_time, undefined);
});

test('shipping threshold never loses conditional wording or becomes a current promotion', () => {
  const result = getPolicy(makeKnowledge(), { topic: 'delivery', country: 'FR', context: { query: 'Livraison gratuite ?' } });
  assert.equal(result.facts.free_shipping_threshold.value, 85);
  assert.match(result.sources[0].passages[0], /Ponctuellement.*peut être proposée/);
  assert.equal(result.facts.shipping_cost, undefined);
  assert.equal(getPolicy(makeKnowledge(), { topic: 'delivery', country: 'BE', context: { query: 'Livraison gratuite ?' } }).facts.free_shipping_threshold, undefined);
});

test('unset, invalid or unknown placeholders withhold the entire affected source', () => {
  for (const value of [null, '', 'not-a-number', '-3']) {
    const k = makeKnowledge(); k.parameters.set('returns_window_days', value);
    const result = getPolicy(k, { topic: 'returns' });
    assert.equal(result.status, 'not_found');
    assert.equal(result.sources.length, 0);
    assert.ok(result.missing.includes('parameter:returns_window_days'));
    assert.equal(JSON.stringify(result).includes('{returns_window_days}'), false);
  }
  const result = getPolicy(makeKnowledge({ policies: [policy('payment_policy', '{unknown_parameter}')] }), { topic: 'payments' });
  assert.equal(result.status, 'not_found');
});

test('opened-product return retains eligibility restrictions even with different wording', () => {
  const result = getPolicy(makeKnowledge(), { topic: 'returns', context: { query: 'Puis-je retourner cette crème ouverte ?' } });
  assert.match(result.sources[0].passages.join('\n'), /neuf, non utilisé/);
});

test('country-only follow-ups reuse the retrieval topic but explicit countries replace history', () => {
  const history = [
    { role: 'user', content: 'Quels délais de livraison en France ?' },
    { role: 'assistant', content: 'Réponse', context: { trace: { knowledge: { topics: ['delivery'] } } } }
  ];
  const result = retrieveKnowledge({ message: 'Et en Italie ?', knowledge: makeKnowledge(), history });
  assert.equal(result.route, 'general_policy');
  assert.equal(result.country, 'IT');
  assert.equal(result.results[0].result.country_support, 'unsupported');
  assert.equal(retrieveKnowledge({ message: 'Et les délais ?', knowledge: makeKnowledge(), history }).country, 'FR');
});

test('a model cannot manufacture a destination from French locale', async () => {
  const result = await runKnowledgeTool('get_policy', { topic: 'delivery', country: 'FR' }, makeKnowledge(), { query: 'Quels délais de livraison ?', locale: 'fr-FR' });
  assert.equal(result.country, null);
  assert.equal(result.facts.delivery_time, undefined);
});

test('inactive sources, operational parameters and expired snapshots are withheld', () => {
  const inactive = makeKnowledge({ policies: [{ ...POLICIES[6], active: false }] });
  assert.equal(getPolicy(inactive, { topic: 'payments' }).status, 'not_found');
  const expired = makeKnowledge({ loadedAt: Date.now() - KNOWLEDGE_TTL_MS - 1 });
  assert.equal(getPolicy(expired, { topic: 'returns' }).status, 'unavailable');
  assert.equal(searchFaqs(expired, { query: 'compte' }).status, 'unavailable');
  const k = makeKnowledge({ policies: [policy('payment_policy', 'Délai interne : {holding_reply_interval_days}')], parameters: [{ parameter_key: 'holding_reply_interval_days', value: '3' }] });
  assert.deepEqual(getPolicy(k, { topic: 'payments' }).parameters, []);
});

test('FAQ intent links to policy and drops obsolete embedded changing facts', () => {
  const result = searchFaqs(makeKnowledge(), { query: 'Combien de temps prend la livraison ?' });
  assert.equal(result.status, 'found');
  assert.equal(result.matches[0].answer, undefined);
  assert.equal(result.matches[0].policy_reference[0].topic, 'delivery');
  assert.doesNotMatch(JSON.stringify(result), /999/);
});

test('FAQ topic narrowing, duplicate canonical questions and vague matches are conservative', () => {
  const records = faqRecords([doc('a', [section('a', 'Comment nettoyer le masque ?', 'Réponse A'), section('b', 'Comment nettoyer le sérum ?', 'Réponse B')])]);
  assert.equal(matchFaqs(records, { query: 'nettoyer' }).status, 'not_found');
  const duplicated = [...records, { ...records[0], id: 'duplicate' }];
  const result = matchFaqs(duplicated, { query: records[0].canonical_question });
  assert.equal(result.status, 'ambiguous');
  assert.equal(JSON.stringify(result).includes('Réponse'), false);
  const topical = searchFaqs(makeKnowledge(), { query: 'temps livraison', topic: 'delivery' });
  assert.equal(topical.matches[0].match_stage, 'topic');
});

test('FAQ aliases are only explicit leading questions; oversized sections are not truncated', () => {
  const records = faqRecords([doc('a', [section('a', 'Question ?', 'Une instruction.\nUne autre phrase ?\nRéponse.'), section('large', 'Longue question ?', 'x'.repeat(1801))])]);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].aliases, []);
  assert.match(records[0].answer, /^Une instruction/);
});

test('account topic finds general-document FAQs; editing a profile is not a privacy policy', () => {
  assert.equal(searchFaqs(makeKnowledge(), { query: 'Dois-je créer un compte pour commander ?', topic: 'account' }).status, 'found');
  const k = makeKnowledge({ documents: [doc('profile', [section('edit', 'Comment modifier mes données personnelles ?', 'Utilisez la page de votre compte.')])] });
  const opening = retrieveKnowledge({ message: 'Comment modifier mes données personnelles ?', knowledge: k });
  assert.equal(opening.route, 'general_faq');
  assert.equal(opening.results[0].result.matches[0].answer, 'Utilisez la page de votre compte.');
});

test('explicit country beats model/passive context; locale alone supplies no country', async () => {
  assert.equal(countryForTurn('Livraison en Belgique ?', { country: 'FR', locale: 'fr-FR' }).country, 'BE');
  assert.equal(countryForTurn('Livraison ?', { locale: 'fr-FR' }).country, null);
  assert.equal(countryForTurn('Livraison en France et Belgique ?').ambiguous, true);
  assert.equal(countryForTurn('Livraison à l’étranger ?', { country: 'FR' }).country, null);
  const result = await runKnowledgeTool('get_policy', { topic: 'delivery', country: 'FR' }, makeKnowledge(), { query: 'Quel délai en Belgique ?', country: 'FR' });
  assert.equal(result.country, 'BE');
  assert.equal(result.facts.delivery_time.value, 8);
  assert.equal(parseChatRequest({ message: 'bonjour', context: { country: 'BE', customerId: 'ignore' } }).context.country, 'BE');
  assert.equal(parseChatRequest({ message: 'bonjour', context: { country: 'Belgique' } }).context.country, undefined);
});

test('unresolved, ambiguous or unrelated products cannot read guidance; data is required first', async () => {
  let reads = 0;
  const options = { catalogue: CATALOGUE, readProductPolicies: async () => { reads += 1; return GUIDANCE; } };
  assert.equal((await runKnowledgeTool('get_product_policy', { product_id: 'mask', query: 'garantie' }, makeKnowledge(), options)).status, 'forbidden');
  assert.equal((await runKnowledgeTool('get_product_policy', { product_id: 'mask', query: 'garantie' }, makeKnowledge(), { ...options, resolvedIds: new Set(['mask']) })).status, 'product_data_required');
  assert.equal(reads, 0);
});

test('explicit catalogue usage and Shopify FAQ answers avoid product guidance entirely', async () => {
  let reads = 0;
  const options = { catalogue: CATALOGUE, resolvedIds: new Set(['cream']), productDataIds: new Set(['cream']), readProductPolicies: async () => { reads += 1; return GUIDANCE; } };
  for (const query of ['Puis-je utiliser ce soin matin et soir ?', 'Comment conserver le produit ?']) {
    const result = await runKnowledgeTool('get_product_policy', { product_id: 'cream', query }, makeKnowledge(), options);
    assert.equal(result.status, 'use_product_data');
  }
  assert.equal(reads, 0);
  assert.equal(CATALOGUE.products[0].faqs.length, 1);
});

test('source failures are sanitized and never broaden to another product', async () => {
  const options = { catalogue: CATALOGUE, resolvedIds: new Set(['mask']), productDataIds: new Set(['mask']), query: 'garantie' };
  const result = await runKnowledgeTool('get_product_policy', { product_id: 'mask' }, makeKnowledge(), { ...options, readProductPolicies: async () => { throw new Error('secret transport detail'); } });
  assert.equal(result.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  const wrong = await runKnowledgeTool('get_product_policy', { product_id: 'mask' }, makeKnowledge(), { ...options, readProductPolicies: async () => GUIDANCE.map((r) => ({ ...r, product_ids: ['cream'] })) });
  assert.equal(wrong.status, 'not_found');
});

test('repository filters by shop, approval and scope, with named columns only', async () => {
  const calls = [];
  const db = { selectAll: async (table, filters, columns) => {
    calls.push({ table, filters, columns });
    return table === 'company_policies' ? POLICIES : table === 'support_parameters' ? PARAMS : DOCUMENTS;
  } };
  const k = await loadKnowledge(db, 'shop-test');
  assert.equal(k.faqs.length, 2);
  for (const call of calls) {
    assert.equal(call.filters.shop_id, 'shop-test');
    assert.doesNotMatch(call.columns, /\*|raw_|embedding|updated_by/);
  }
  const faqRead = calls.find((c) => c.table === 'knowledge_documents');
  assert.equal(faqRead.filters.approval_status, 'approved');
  assert.deepEqual(faqRead.filters.product_ids, { operator: 'eq', value: '{}' });
});

test('product reader is lazy, scoped, coalesced, bounded by TTL, and does not serve stale on failure', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  let now = 100; let reads = 0; let fail = false;
  const reader = createProductPolicyReader({ selectAll: async (table, filters, columns) => {
    reads += 1;
    assert.equal(table, 'knowledge_documents');
    assert.deepEqual(filters.product_ids, { operator: 'cs', value: `{${id}}` });
    assert.equal(filters.shop_id, 'shop-test');
    assert.ok(!columns.includes('*'));
    if (fail) throw new Error('offline');
    return [doc('guide', [section('a', 'Comment utiliser le masque ?', 'Lire le manuel.')], { product_ids: [id] })];
  } }, 'shop-test', { now: () => now });
  assert.equal(reads, 0);
  const results = await Promise.all([reader(id), reader(id)]);
  assert.equal(reads, 1); assert.equal(results[0].length, 1);
  await reader(id); assert.equal(reads, 1);
  now += KNOWLEDGE_TTL_MS + 1; fail = true;
  await assert.rejects(reader(id), /offline/); assert.equal(reads, 2);
  assert.deepEqual(await reader('not-an-id'), []);
});

test('tool contracts are narrow, strict, read-only and reject bad topic/country/limit', async () => {
  for (const tool of knowledgeToolDefinitions()) {
    assert.equal(tool.function.strict, true);
    assert.equal(tool.function.parameters.additionalProperties, false);
    assert.deepEqual(tool.function.parameters.required, Object.keys(tool.function.parameters.properties));
  }
  assert.equal(getPolicy(makeKnowledge(), { topic: 'sql' }).status, 'invalid_arguments');
  assert.equal(getPolicy(makeKnowledge(), { topic: 'delivery', country: 'Belgique' }).status, 'invalid_arguments');
  assert.equal(searchFaqs(makeKnowledge(), { query: 'compte', limit: -1 }).status, 'invalid_arguments');
});

const answer = { content: JSON.stringify({ reply: 'Réponse issue des sources.', products: [] }) };
const toolCall = (name, args) => ({ toolCalls: [{ id: 'call', name, args }], message: { role: 'assistant', tool_calls: [{ id: 'call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } });

test('common policy question takes one model call with facts preloaded; trace contains no query', async () => {
  let calls = 0;
  const agent = createLlmAgent({ catalogue: CATALOGUE, knowledge: makeKnowledge(), client: { completeWithTools: async (input) => {
    calls += 1; assert.match(input.system, /"delivery_time"/); assert.match(input.system, /"value":4/); return answer;
  } } });
  const reply = await agent.respond({ message: 'Quels délais de livraison en France ?' });
  assert.equal(calls, 1); assert.equal(reply.trace.tools.length, 0);
  assert.equal(reply.trace.knowledge.route, 'general_policy');
  assert.doesNotMatch(JSON.stringify(reply.trace), /Quels délais/);
});

test('product guidance is lazy in the agent and its source id reaches the trace', async () => {
  let calls = 0; let reads = 0;
  const agent = createLlmAgent({ catalogue: CATALOGUE, knowledge: makeKnowledge(), readProductPolicies: async (id) => { reads += 1; assert.equal(id, 'mask'); return GUIDANCE; }, client: { completeWithTools: async (input) => {
    calls += 1;
    if (calls === 1) { assert.equal(reads, 0); return toolCall('get_product_policy', { product_id: 'mask', topic: 'warranty', query: 'Quelle est la garantie du masque ?' }); }
    assert.equal(JSON.parse(input.messages.find((m) => m.role === 'tool').content).matches[0].id, 'mask-guide:warranty');
    return answer;
  } } });
  const reply = await agent.respond({ message: 'Quelle est la garantie du Masque Lumière ?' });
  assert.equal(reads, 1); assert.equal(calls, 2);
  assert.deepEqual(reply.trace.tools[0].ids, ['mask-guide:warranty']);
});

test('FAQ-linked policy is resolved in the same round and obsolete FAQ prose stays absent', async () => {
  let calls = 0;
  const agent = createLlmAgent({ catalogue: CATALOGUE, knowledge: makeKnowledge(), client: { completeWithTools: async (input) => {
    calls += 1;
    if (calls === 1) return toolCall('search_faqs', { query: 'Combien de temps prend la livraison ?', topic: null, limit: null });
    assert.match(JSON.stringify(input.messages), /delivery_time_policy/);
    assert.doesNotMatch(JSON.stringify(input.messages), /999/);
    return answer;
  } } });
  await agent.respond({ message: 'Une question générale' });
  assert.equal(calls, 2);
});

test('a product question no FAQ question matches gets that product’s FAQ, most relevant first', async () => {
  const guide = faqRecords([doc('mask-remote', [
    section('remote', 'La télécommande ne fonctionne plus', 'La télécommande pilote l’allumage, les modes et l’intensité.'),
    section('sessions', 'Combien de séances par semaine ?', 'Mettez les lunettes, puis connectez la télécommande et choisissez un mode.'),
    section('warranty', 'Quelle est la garantie du masque ?', 'La garantie est décrite dans le manuel fourni.')
  ], { category: 'product', product_ids: ['mask'] })]);
  const options = { catalogue: CATALOGUE, resolvedIds: new Set(['mask']), productDataIds: new Set(['mask']), readProductPolicies: async () => guide, query: 'Comment utiliser le masque avec la télécommande ?' };
  const result = await runKnowledgeTool('get_product_policy', { product_id: 'mask' }, makeKnowledge(), options);
  assert.equal(result.status, 'found');
  assert.equal(result.match_stage, 'product_faq_digest');
  assert.deepEqual(result.matches.map((m) => m.canonical_question), ['La télécommande ne fonctionne plus', 'Combien de séances par semaine ?'], 'entries sharing no word with the question are left out');
});
