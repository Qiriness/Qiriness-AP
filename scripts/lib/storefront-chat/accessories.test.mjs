import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLlmAgent } from './llm-agent.mjs';
import { buildAdvisorKnowledge } from '../advisory/advisor-knowledge.mjs';
import { asksForAccessory } from '../advisory/lexicon.mjs';
import { isAccessory, knowledgeIndex } from '../advisory/product-knowledge.mjs';
import { createAdvisor } from '../advisory/recommend.mjs';

// OWNER, 2026-10-29: « Agent should not propose accessories unless explicitly asked » (« products under
// 40 pounds » gave the Gua Sha Quartz Rose, an « Accessoire » the sheet also marks « Petit plaisir »).
// On Qiriness's real sheet, every product in stock; a product's id is its handle here.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const built = buildAdvisorKnowledge({ sheet: read('data/advisor/qiriness-knowledge.json'), settings: read('data/advisor/qiriness-routine-settings.json') });
const CATALOGUE = {
  products: built.products.map((k) => ({ id: k.handle, handle: k.handle, name: k.title ?? k.handle, type: null, short: null, keyIngredients: null, inStock: true, priceFrom: Number(k.price) || 10, variants: [], collections: [], tags: [] })),
  collections: [],
};
const KNOWLEDGE = knowledgeIndex(built.products);
const GUA_SHA = 'gua-sha-visage-cou-quartz-rose';
const ACCESSORIES = CATALOGUE.products.filter((p) => isAccessory(KNOWLEDGE.get(p.handle))).map((p) => p.handle);

const answer = (reply, products = [], lang = 'fr') => ({ content: JSON.stringify({ reply, reply_language: lang, products }), toolCalls: [], usage: { prompt_tokens: 800, completion_tokens: 40 } });
const search = (query) => ({
  content: null,
  message: { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'search_products', arguments: JSON.stringify({ query, collection: null, limit: 12 }) } }] },
  toolCalls: [{ id: 's1', name: 'search_products', args: { query, collection: null, limit: 12 }, argsError: null }],
  usage: { prompt_tokens: 900, completion_tokens: 20 }
});
/** The reply model's calls are scripted; the profile reader (a budget is a partial reading) reads nothing. */
function scripted(...responses) {
  const calls = [];
  return { calls, async completeWithTools(args) {
    if (args.pass === 'storefront_profile_read') return { content: '{"profile_updates":[]}', usage: null };
    calls.push(structuredClone(args));
    return responses.shift() ?? answer('…');
  } };
}
const agentWith = (client) => createLlmAgent({ client, company: { name: 'Qiriness' }, catalogue: CATALOGUE, advisor: createAdvisor(read('data/advisor/qiriness.json'), CATALOGUE, { knowledge: KNOWLEDGE, routines: built.routines }), productKnowledge: KNOWLEDGE });
/** The handles search_products returned to the model (the tool message of its next call). */
const searched = (client) => JSON.parse(client.calls.flatMap((c) => c.messages).find((m) => m.role === 'tool').content).products.map((p) => p.handle);
const cards = (reply) => reply.products.map((c) => c.id);

test('the sheet has accessories and devices to hold back (the Gua Sha, the roller, the LED mask)', () => {
  assert.ok(ACCESSORIES.includes(GUA_SHA));
  assert.ok(ACCESSORIES.length >= 3, ACCESSORIES.join(', '));
});

test('« products under 40 »: search returns no accessory, and a card the model lists for one is dropped, FR and EN', async () => {
  for (const [message, lang] of [['Quels produits avez-vous à moins de 40 € ?', 'fr'], ['What products do you have under 40 pounds?', 'en']]) {
    // « visage » reaches the Gua Sha (« Gua Sha Visage & Cou »): it was the second result before.
    const client = scripted(search('visage cou'), answer('Voici quelques idées.', [{ handle: GUA_SHA, rationale: 'x' }], lang));
    const r = await agentWith(client).respond({ message, context: { locale: lang } });
    const found = searched(client);
    assert.ok(found.length > 0, message);
    assert.deepEqual(found.filter((h) => ACCESSORIES.includes(h)), [], message);
    assert.deepEqual(cards(r).filter((h) => ACCESSORIES.includes(h)), [], message);
  }
});

test('an accessory asked for by its kind is offered, FR and EN', async () => {
  for (const [message, lang] of [['Avez-vous un accessoire pour le visage ?', 'fr'], ['Do you sell any face tools?', 'en']]) {
    const client = scripted(search('gua sha'), answer('Oui, le voici.', [{ handle: GUA_SHA, rationale: 'x' }], lang));
    const r = await agentWith(client).respond({ message, context: { locale: lang } });
    assert.ok(searched(client).includes(GUA_SHA), message);
    assert.ok(cards(r).includes(GUA_SHA), message);
  }
});

test('an accessory on its own page is not held back', async () => {
  const r = await agentWith(scripted(answer('Il s’utilise sur peau propre.', [{ handle: GUA_SHA, rationale: 'x' }]))).respond({ message: 'Comment l’utiliser ?', context: { locale: 'fr', productHandle: GUA_SHA } });
  assert.ok(cards(r).includes(GUA_SHA));
});

test('the accessory words, FR and EN; a skincare question is not one', () => {
  for (const m of ['Un accessoire pour le visage ?', 'Vous avez un roller ?', 'Le masque LED est-il efficace ?', 'Do you have any beauty tools?', 'Is there a device for wrinkles?']) assert.ok(asksForAccessory(m), m);
  for (const m of ['Quels produits à moins de 40 € ?', 'Une crème pour peau sèche', 'Products under 40 pounds', 'Something for puffy eyes']) assert.ok(!asksForAccessory(m), m);
});
