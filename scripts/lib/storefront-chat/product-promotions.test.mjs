import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { promotionsForProduct } from './shopping-evaluator.mjs';
import { createLlmAgent } from './llm-agent.mjs';
import { createAdvisor } from '../advisory/recommend.mjs';
import { knowledgeIndex, parseKnowledgeRows } from '../advisory/product-knowledge.mjs';

// One product proposed, with its offer (owner, 2026-10-13; the foundation
// engine). INVENTED promotions and products only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const CONFIG = read('data/advisor/qiriness.json');
const CATALOGUE = read('data/advisor/sample-routines/catalogue.json');
const SHEET = read('data/advisor/sample-routines/knowledge.json');
const ROUTINES = read('data/advisor/sample-routines/routines.json');
const KNOWLEDGE = knowledgeIndex(parseKnowledgeRows(SHEET.rows, { concerns: SHEET.concerns }).products);
const gid = (handle) => CATALOGUE.products.find((p) => p.handle === handle).shopifyId;

const promo = (id, over = {}) => ({
  id, title: `Offre ${id}`, codes: [], method: 'automatic', discount_type: 'DiscountAutomaticBasic', status: 'ACTIVE',
  discount_classes: ['PRODUCT'], describable_in_replies: true, offerable_in_replies: false, starts_at: '2026-01-01T00:00:00Z', ends_at: null,
  rule_snapshot: { customer_gets: { percentage: 0.2, items: { scope: 'products', products: [{ id: gid('t-serum-aqua'), title: 'Sérum' }] } } },
  ...over,
});
const source = (promotions, members = new Map()) => ({ status: 'ok', promotions, members, products: [], loadedAt: Date.now() });

test('the offers on one product: its own, its collection\'s, every product\'s; never free shipping, expired or private', () => {
  const serum = gid('t-serum-aqua');
  const rows = [
    promo('own'),
    promo('collection', { rule_snapshot: { customer_gets: { percentage: 0.1, items: { scope: 'collections', collections: [{ id: 'c1', title: 'Aqua' }] } } } }),
    promo('shipping', { discount_type: 'DiscountAutomaticFreeShipping', discount_classes: ['SHIPPING'] }),
    promo('expired', { ends_at: '2026-01-02T00:00:00Z' }),
    promo('private', { method: 'code', describable_in_replies: false, offerable_in_replies: false, codes: [{ code: 'SECRET' }] }),
    promo('other', { rule_snapshot: { customer_gets: { percentage: 0.3, items: { scope: 'products', products: [{ id: gid('t-creme-aqua'), title: 'Crème' }] } } } }),
  ];
  const found = promotionsForProduct(source(rows, new Map([['c1', new Set([serum])]])), serum);
  assert.deepEqual(found.map((o) => o.promotion_id), ['own', 'collection']);
  assert.equal(found[0].reward.percentage, 20);
  assert.deepEqual(promotionsForProduct(source([promo('all', { rule_snapshot: { customer_gets: { percentage: 0.1, items: { scope: 'all' } } } })]), serum).map((o) => o.promotion_id), ['all']);
  assert.deepEqual(promotionsForProduct({ status: 'unavailable' }, serum), []);
});

const answer = (reply) => ({ content: JSON.stringify({ reply, reply_language: 'fr', products: [], contact_link: false }), toolCalls: [], usage: {} });
function scripted() {
  const calls = [];
  return { calls, async completeWithTools(args) { calls.push(structuredClone(args)); return args.tools ? answer('…') : { content: JSON.stringify({ updates: [] }), toolCalls: [], usage: {} }; } };
}
const agentWith = (client, routines = ROUTINES) => createLlmAgent({
  client, company: { name: 'Lumen' }, catalogue: CATALOGUE,
  advisor: createAdvisor(CONFIG, CATALOGUE, { knowledge: KNOWLEDGE, routines }),
  readShopping: async () => source([promo('own')]),
});
const replyCall = (client) => client.calls.filter((c) => c.tools).at(-1);

test('one product proposed (foundation engine): its offer reaches the prompt and the trace', async () => {
  const client = scripted();
  const reply = await agentWith(client).respond({ message: "J'ai le visage déshydraté, que me conseillez-vous ?", context: { locale: 'fr' }, shopDomain: 'test.myshopify.com' });
  assert.equal(reply.trace.advice.steps.length, 1);
  assert.match(replyCall(client).system, /"promotions":\[\{"promotion_id":"own","name":"Offre own"/);
  assert.match(replyCall(client).system, /A step, or a product in resolution, with promotions: a public offer running on that product now/);
  assert.deepEqual(reply.trace.advice.promotions, ['own']);
});

test('a routine (several products) or the playbook engine: no offer added', async () => {
  const routine = scripted();
  await agentWith(routine).respond({ message: 'Pouvez-vous me construire une routine pour mon visage déshydraté ?', action: 'build_routine', context: { locale: 'fr' }, shopDomain: 'test.myshopify.com' });
  assert.doesNotMatch(replyCall(routine).system, /"promotions":\[/);
  const old = scripted();
  await agentWith(old, null).respond({ message: "J'ai le visage déshydraté, que me conseillez-vous ?", context: { locale: 'fr' }, shopDomain: 'test.myshopify.com' });
  assert.doesNotMatch(replyCall(old).system, /"promotions":\[\{"promotion_id"/);
});
