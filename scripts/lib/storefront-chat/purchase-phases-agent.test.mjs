import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLlmAgent } from './llm-agent.mjs';
import { createAdvisor } from '../advisory/recommend.mjs';
import { knowledgeIndex, parseKnowledgeRows } from '../advisory/product-knowledge.mjs';
import { measuredIndex } from '../advisory/replenishment.mjs';

// Phases 2 and 3 through the storefront agent: the INVENTED sample set
// (data/advisor/sample/), the real playbooks, a scripted model.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const CONFIG = read('data/advisor/qiriness.json');
const CATALOGUE = read('data/advisor/sample/catalogue.json');
const SHEET = read('data/advisor/sample/knowledge.json');
const KNOWLEDGE = knowledgeIndex(parseKnowledgeRows(SHEET.rows, { concerns: SHEET.concerns }).products);
const MEASURED = measuredIndex(read('data/advisor/sample/repurchase.json'));
const product = (handle) => CATALOGUE.products.find((p) => p.handle === handle);

const answer = (reply) => ({ content: JSON.stringify({ reply, reply_language: 'fr', products: [] }), toolCalls: [], usage: { prompt_tokens: 800, completion_tokens: 40 } });
function scripted(...responses) {
  const calls = [];
  return { calls, async completeWithTools(args) { calls.push(structuredClone(args)); return responses.shift(); } };
}
const agentWith = (client) => createLlmAgent({
  client,
  company: { name: 'Lumen' },
  catalogue: CATALOGUE,
  advisor: createAdvisor(CONFIG, CATALOGUE, { knowledge: KNOWLEDGE }),
  productKnowledge: KNOWLEDGE,
  repurchaseIntervals: MEASURED,
});
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const line = (handle, days, over = {}) => ({ product_id: product(handle).shopifyId, title: product(handle).name, first_purchased_on: daysAgo(days + 120), last_purchased_on: daysAgo(days), times_purchased: 1, returned: false, free_gift: false, ...over });
const loader = (...lines) => async () => ({ products: lines });
const quick = (value) => ({ value, source: 'quick_choice', confidence: 'high', turn: 1 });

const builderState = (extra = {}) => ({
  profile: { primary_concern: quick('dryness'), skin_type: quick('dry'), routine_scope: quick('complete') },
  // The builder's own questions answered: the turn recommends.
  mode: 'routine_builder', asked: ['skin_type', 'sensitivity', 'current_routine', 'routine_scope', 'age_band'], last_question: null, last_advice: null,
  ...extra,
});

test('« build around » a kit: it fills three steps of a complete routine; the model is told to keep theirs', async () => {
  const kit = product('test-coffret-hydratation');
  const client = scripted(answer('Continuez avec votre coffret ; il vous manque le masque.'));
  const reply = await agentWith(client).respond({
    message: 'Construire ma routine autour', choice: `purchase:around:${kit.id}`, context: { locale: 'fr' },
    advisorState: builderState({ purchases: { asked: [kit.id], around: [], running_low: [], focus: [] } }),
    purchases: loader(line('test-coffret-hydratation', 30)),
  });
  assert.deepEqual(reply.advisor.purchases.around, [kit.id]);
  const system = client.calls[0].system;
  for (const name of ['Lait Nettoyant Doux (test)', 'Sérum Hydratant Aqua (test)', 'Crème Hydratante Riche (test)']) {
    assert.match(system, new RegExp(`"reason":"already_owned","customer_product":"${name.replace(/[()]/g, '\\$&')}"`));
  }
  assert.deepEqual(reply.trace.advice.steps.map((s) => s.id), [product('test-masque-hydratant-wrap').id]);
});

test('a daily cream bought twice, its usual interval passed: flagged as data, and its range nudges the routine', async () => {
  const client = scripted(answer('…'));
  const reply = await agentWith(client).respond({
    message: "J'ai la peau sèche",
    context: { locale: 'fr' },
    purchases: loader(line('test-creme-hydratante-riche', 140, { times_purchased: 2 }), line('test-masque-hydratant-wrap', 140, { times_purchased: 3 })),
  });
  const system = client.calls[0].system;
  assert.match(system, /"name":"Crème Hydratante Riche \(test\)"[^}]*"bought_repeatedly":true,"may_be_running_low":true/);
  // A mask is never on a schedule, however long ago.
  assert.doesNotMatch(system, /"name":"Masque Hydratant Wrap \(test\)"[^}]*may_be_running_low/);
  assert.match(system, /never say they have run out/);
  assert.equal(reply.trace.purchases.running_low, 1);
  assert.equal(reply.trace.purchases.ranges, 1);
});

test('without product knowledge the agent behaves as Phase 1: nothing flagged, nothing nudged', async () => {
  const client = scripted(answer('…'));
  const agent = createLlmAgent({ client, company: { name: 'Lumen' }, catalogue: CATALOGUE, advisor: createAdvisor(CONFIG, CATALOGUE) });
  const reply = await agent.respond({ message: "J'ai la peau sèche", context: { locale: 'fr' }, purchases: loader(line('test-creme-hydratante-riche', 140, { times_purchased: 2 })) });
  assert.doesNotMatch(client.calls[0].system, /"may_be_running_low":true/);
  assert.equal(reply.trace.purchases.running_low, undefined);
  assert.equal(reply.trace.purchases.ranges, undefined);
});

test('in the builder, while the engine still needs the concern, its question comes first: no purchase question', async () => {
  const client = scripted(answer('Quelle est votre principale préoccupation ?'));
  const reply = await agentWith(client).respond({ message: "J'ai la peau sèche", action: 'build_routine', context: { locale: 'fr' }, purchases: loader(line('test-masque-hydratant-wrap', 60)) });
  assert.equal(reply.trace.advice.status, 'needs_info');
  assert.ok(!JSON.stringify(reply).includes('purchase:'));
  assert.ok(reply.choices.some((c) => c.value.startsWith('profile:primary_concern:')));
});

test('in the builder, a product probably running low is asked about before a more recent one', async () => {
  const client = scripted(answer('Voici votre routine.'));
  const reply = await agentWith(client).respond({
    message: "J'ai la peau sèche et déshydratée",
    action: 'build_routine',
    context: { locale: 'fr' },
    purchases: loader(line('test-creme-hydratante-riche', 140, { times_purchased: 2 }), line('test-masque-hydratant-wrap', 30)),
  });
  assert.match(reply.text, /^Je vois que vous avez déjà acheté Crème Hydratante Riche \(test\)\./);
  assert.ok(reply.choices.every((c) => c.value.endsWith(product('test-creme-hydratante-riche').id)));
});
