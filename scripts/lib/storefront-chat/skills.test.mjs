import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SKILLS, activeSkill, useSkillDefinition } from './skills.mjs';
import { createLlmAgent } from './llm-agent.mjs';
import { createAdvisor } from '../advisory/recommend.mjs';

// The routine builder as a skill (owner, 2026-10-13): its rules and tools only
// while it is open; opened by the code (« Oui ») or by the model (use_skill).
// The INVENTED sample set under the real playbooks, a scripted model.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const CONFIG = read('data/advisor/qiriness.json');
const CATALOGUE = read('data/advisor/sample/catalogue.json');
const product = (handle) => CATALOGUE.products.find((p) => p.handle === handle);

const answer = (reply) => ({ content: JSON.stringify({ reply, reply_language: 'fr', products: [], contact_link: false }), toolCalls: [], usage: {} });
const toolCall = (name, args) => ({ content: null, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, toolCalls: [{ id: 'c1', name, args, argsError: null }], usage: {} });
function scripted(...responses) {
  const calls = [];
  const client = { calls, async completeWithTools(args) { client.calls.push(structuredClone(args)); return args.tools ? responses.shift() ?? answer('…') : { content: JSON.stringify({ updates: [] }), toolCalls: [], usage: {} }; } };
  return client;
}
const agentWith = (client) => createLlmAgent({ client, company: { name: 'Lumen' }, catalogue: CATALOGUE, advisor: createAdvisor(CONFIG, CATALOGUE) });
const toolNames = (call) => (call.tools ?? []).map((t) => t.function.name);
const adviseDescription = (call) => call.tools.find((t) => t.function.name === 'advise').function.description;
const purchases = async () => ({ products: [{ product_id: product('test-serum-hydratant-aqua').shopifyId, title: 'x', first_purchased_on: '2026-06-01', last_purchased_on: '2026-09-01', times_purchased: 1, free_gift: false, returned: false }] });

test('the registry: the routine builder is open in builder mode only; use_skill lists it', () => {
  assert.deepEqual(SKILLS.map((s) => s.name), ['routine_builder']);
  assert.equal(activeSkill({ mode: 'routine_builder' })?.name, 'routine_builder');
  assert.equal(activeSkill({ mode: 'conversation' }), null);
  assert.deepEqual(useSkillDefinition().function.parameters.properties.name.enum, ['routine_builder']);
});

test('closed: use_skill and the targeted advise are offered; none of the builder rules are in the prompt', async () => {
  const client = scripted(answer('Pour un visage déshydraté, le Sérum Hydratant Aqua.'));
  await agentWith(client).respond({ message: "J'ai le visage déshydraté", context: { locale: 'fr' }, purchases });
  const call = client.calls[0];
  assert.ok(toolNames(call).includes('use_skill'));
  assert.ok(!toolNames(call).includes('get_past_purchases'));
  assert.match(adviseDescription(call), /targeted need/);
  assert.doesNotMatch(call.system, /SKILL OPEN/);
  assert.doesNotMatch(call.system, /First question: say in one short sentence/);
});

test('open (« construisez-moi une routine »): its rules and tools, and no use_skill', async () => {
  const client = scripted(answer('Avec plaisir. Quelle est votre préoccupation ?'));
  await agentWith(client).respond({ message: 'Pouvez-vous me construire une routine ?', context: { locale: 'fr' }, purchases });
  const call = client.calls[0];
  assert.match(call.system, /SKILL OPEN: routine_builder/);
  assert.match(call.system, /One question per turn/);
  assert.ok(!toolNames(call).includes('use_skill'));
  assert.ok(toolNames(call).includes('get_past_purchases'));
  assert.match(adviseDescription(call), /routine builder/);
});

test('not signed in: the skill has no past purchases tool', async () => {
  const client = scripted(answer('Avec plaisir.'));
  await agentWith(client).respond({ message: 'Pouvez-vous me construire une routine ?', context: { locale: 'fr' } });
  assert.ok(!toolNames(client.calls[0]).includes('get_past_purchases'));
});

test('the model opens it itself: builder mode, its tools in the next round, no routine offer after', async () => {
  const client = scripted(toolCall('use_skill', { name: 'routine_builder' }), answer('Avec plaisir, construisons votre routine.'));
  const reply = await agentWith(client).respond({ message: 'Mon visage est déshydraté, aidez-moi à tout organiser du matin au soir', context: { locale: 'fr' } });
  // The reply calls only (the profile reader may have run first, without tools).
  client.calls = client.calls.filter((c) => c.tools);
  assert.ok(toolNames(client.calls[0]).includes('use_skill'));
  const opened = JSON.parse(client.calls[1].messages.find((m) => m.role === 'tool').content);
  assert.equal(opened.status, 'open');
  assert.ok(opened.instructions.some((l) => /One question per turn/.test(l)));
  assert.ok(!toolNames(client.calls[1]).includes('use_skill'));
  assert.match(adviseDescription(client.calls[1]), /routine builder/);
  assert.equal(reply.advisor.mode, 'routine_builder');
  assert.equal(reply.advisor.flow.offer, 'accepted');
  assert.equal(reply.followUp, undefined);
  assert.equal(reply.trace.skill_opened, 'routine_builder');
});

test('get_past_purchases: names and days only, no order data', async () => {
  const client = scripted(toolCall('get_past_purchases', {}), answer('Vous avez acheté le Sérum Hydratant Aqua.'));
  await agentWith(client).respond({ message: 'Pouvez-vous me construire une routine avec ce que j\'ai déjà ?', context: { locale: 'fr' }, purchases });
  const out = JSON.parse(client.calls[1].messages.find((m) => m.role === 'tool').content);
  assert.equal(out.status, 'found');
  assert.equal(out.purchases[0].name, 'Sérum Hydratant Aqua (test)');
  assert.doesNotMatch(JSON.stringify(out), /gid:\/\/|order|€/);
});
