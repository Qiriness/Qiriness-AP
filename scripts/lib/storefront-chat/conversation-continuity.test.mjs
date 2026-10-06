import assert from 'node:assert/strict';
import test from 'node:test';
import { createLlmAgent } from './llm-agent.mjs';
import { retrieveKnowledge } from './knowledge-router.mjs';
import { buildKnowledge } from './knowledge-repository.mjs';
import { languageContext } from './conversation-language.mjs';
import { createShoppingTurn } from './shopping-tools.mjs';
import { fixture } from './shopping-cases.mjs';
import { createPublicPromotionReader } from './shopping-repository.mjs';

const HISTORY = [
  { role: 'user', content: 'Can I get free shipping?' },
  { role: 'assistant', content: 'Which country would your order be delivered to?', context: { replyLanguage: 'en', trace: { knowledge: { topics: ['delivery'] } } } }
];
test('France retains English conversation language and stores the reply language', async () => {
  const agent = createLlmAgent({ client: { async completeWithTools(input) {
    assert.ok(input.system.includes('"previous_language":"en"'));
    assert.ok(input.system.includes('"neutral_followup":true'));
    assert.ok(input.schema.required.includes('reply_language'));
    return { content: JSON.stringify({ reply: 'For France, I cannot confirm a current offer.', reply_language: 'en', products: [] }), toolCalls: [] };
  } } });
  const reply = await agent.respond({ message: 'France', history: HISTORY, context: { locale: 'fr' } });
  assert.equal(reply.replyLanguage, 'en');
});

test('Bare country answers retain the immediate delivery topic deterministically', () => {
  const knowledge = buildKnowledge([], [], []);
  const result = retrieveKnowledge({ message: 'France', history: HISTORY, knowledge });
  assert.deepEqual(result.topics, ['delivery']);
  assert.equal(result.country, 'FR');
  assert.equal(result.results[0].tool, 'get_policy');
});

test('Cart prompt explains meaningful limitations without technical snapshot wording', async () => {
  const agent = createLlmAgent({ readShopping: async () => ({ status: 'unavailable' }), client: { async completeWithTools(input) {
    assert.ok(input.system.includes('Do not say "unverified snapshot"'));
    assert.ok(input.system.includes('Do not volunteer missing variant metadata'));
    return { content: JSON.stringify({ reply: 'Your cart contains two creams.', reply_language: 'en', products: [] }), toolCalls: [] };
  } } });
  await agent.respond({ message: 'What is in my cart again?' });
});

test('Neutral answers inherit English, French and Spanish without confusing site locale with language', () => {
  for (const previous of ['en', 'fr', 'es']) for (const message of ['France', 'FR', 'Belgium', 'yes', 'oui', '70', '👍']) {
    const history = [{ role: 'assistant', content: 'previous', context: { replyLanguage: previous } }];
    assert.equal(languageContext(message, history).previous_language, previous);
    assert.equal(languageContext(message, history).neutral_followup, true);
  }
  assert.equal(languageContext('Please answer in Spanish', HISTORY).neutral_followup, false);
  assert.equal(languageContext('Pouvez-vous répondre en français ?', HISTORY).neutral_followup, false);
  assert.equal(languageContext('France', [{ role: 'assistant', content: 'Older English answer' }]).has_history, true);
  assert.equal(languageContext('France', []).previous_language, null);
});

test('Country continuation never revives delivery after the topic has changed', () => {
  const knowledge = buildKnowledge([], [], []);
  const history = [...HISTORY, { role: 'user', content: 'What cream is suitable?' }, { role: 'assistant', content: 'Which skin type?', context: { trace: { knowledge: { topics: [] } } } }];
  assert.deepEqual(retrieveKnowledge({ message: 'France', history, knowledge }).topics, []);
});

test('Free shipping reads public promotion terms without estimating delivery cost', async () => {
  const f = fixture();
  f.promotion.discount_type = 'DiscountCodeFreeShipping';
  f.promotion.rule_snapshot.minimum_requirement = { type: 'subtotal', amount: '70', currency: 'EUR' };
  f.promotion.rule_snapshot.destination = { scope: 'countries', countries: ['FR'], include_rest_of_world: false };
  const turn = createShoppingTurn({ message: 'Can I get free shipping?', readShopping: async () => f.source, shopDomain: f.source.shopDomain });
  const opening = await turn.opening();
  assert.equal(opening.results[0].tool, 'get_active_promotions');
  const offer = opening.results[0].result.promotions[0];
  assert.equal(offer.mechanic, 'free_shipping');
  assert.deepEqual(offer.destination.countries, ['FR']);
  assert.equal(offer.minimum.amount, 70);
  assert.ok(!JSON.stringify(opening).includes('estimated_delivery_cost'));
  const followup = createShoppingTurn({ message: 'France', readShopping: async () => f.source, shopDomain: f.source.shopDomain, history: [{ role: 'assistant', content: 'Which country?', context: { trace: { shopping: { topics: ['free_shipping'] } } } }] });
  assert.deepEqual((await followup.opening()).topics, ['free_shipping']);
});

test('Unsynced dev shop can preview public brand offers without borrowing cart eligibility or stock', async () => {
  const f = fixture(); let previews = 0;
  const turn = createShoppingTurn({ message: 'What offers are available?', shopDomain: 'dev.myshopify.com', readShopping: async () => ({ status: 'unavailable', reason: 'shop_not_synced' }), readPublicPromotions: async () => { previews++; return f.source; } });
  const result = await turn.run('get_active_promotions');
  assert.equal(result.status, 'ok');
  assert.equal(result.store_eligibility, 'not_confirmed');
  assert.equal(result.offer_preview, true);
  assert.equal(result.promotions[0].code, 'WELCOME20');
  assert.equal((await turn.run('evaluate_promotions_for_cart')).status, 'unavailable');
  assert.equal((await turn.run('get_stock_context')).status, 'unavailable');
  assert.equal(previews, 1);
});

test('Public preview reader is allow-listed, whitelisted, cached and promotion-only', async () => {
  const f = fixture(); const reads = [];
  const reader = createPublicPromotionReader({ async selectAll(table, filters, columns) {
    reads.push({ table, filters, columns });
    return filters.method === 'code' ? [f.promotion, { ...f.promotion, offerable_in_replies: false }] : [];
  } }, { shopId: 'brand', catalogueShopDomain: 'brand.myshopify.com', allowedShops: new Set(['dev.myshopify.com']) });
  assert.equal((await reader('other.myshopify.com')).status, 'unavailable');
  assert.equal((await reader('brand.myshopify.com')).status, 'unavailable');
  assert.equal(reads.length, 0);
  const source = await reader('dev.myshopify.com');
  assert.equal(source.promotions.length, 1);
  await reader('dev.myshopify.com');
  assert.equal(reads.length, 2);
  assert.ok(reads.every((r) => r.table === 'promotions' && r.filters.shop_id === 'brand' && !r.columns.includes('raw_shopify_payload')));
  assert.equal(reads[0].filters.offerable_in_replies, true);
  assert.equal(reads[1].filters.describable_in_replies, true);
});

test('Preview is not used to mask a real shopping source outage', async () => {
  let called = false;
  const turn = createShoppingTurn({ shopDomain: 'dev.myshopify.com', readShopping: async () => { throw new Error('dummy outage'); }, readPublicPromotions: async () => { called = true; return fixture().source; } });
  assert.equal((await turn.run('get_active_promotions')).status, 'unavailable');
  assert.equal(called, false);
});

test('Language and public promotion preview reach the same opening call on a France follow-up', async () => {
  const f = fixture(); f.promotion.discount_type = 'DiscountCodeFreeShipping';
  f.promotion.rule_snapshot.minimum_requirement = { type: 'subtotal', amount: '70', currency: 'EUR' };
  f.promotion.rule_snapshot.destination = { scope: 'countries', countries: ['FR'], include_rest_of_world: false };
  const agent = createLlmAgent({ readShopping: async () => ({ status: 'unavailable', reason: 'shop_not_synced' }), readPublicPromotions: async () => f.source, client: { async completeWithTools(input) {
    assert.deepEqual(input.schema.properties.reply_language.enum, ['en']);
    assert.ok(input.system.includes('"offer_preview":true'));
    assert.ok(input.system.includes('"countries":["FR"]'));
    assert.ok(input.system.includes('"amount":70'));
    assert.ok(input.system.includes('"store_eligibility":"not_confirmed"'));
    return { content: JSON.stringify({ reply: 'Qiriness has a published free-shipping offer for France, but I cannot confirm it applies to this cart.', reply_language: 'en', products: [] }), toolCalls: [] };
  } } });
  await agent.respond({ message: 'France', shopDomain: 'dev.myshopify.com', history: HISTORY });
});

test('Private-code redaction retains the English reply language', () => {
  const turn = createShoppingTurn({ message: 'Does code PRIVATE20 work?', readShopping: async () => ({ status: 'unavailable' }) });
  assert.equal(turn.sanitizeReply('I cannot confirm PRIVATE20.', 'en'), 'I cannot confirm that code.');
});
