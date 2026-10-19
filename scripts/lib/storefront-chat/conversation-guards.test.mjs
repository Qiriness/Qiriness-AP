import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { emptyFlow, followUpFor } from './routine-flow.mjs';
import { asksConcern, createLlmAgent, endsWithQuestion } from './llm-agent.mjs';
import { advisorStateFromHistory } from './advisor-state.mjs';
import { buildStorefrontSystemPrompt } from './system-prompt.mjs';
import { createAdvisor } from '../advisory/recommend.mjs';
import { knowledgeIndex, parseKnowledgeRows } from '../advisory/product-knowledge.mjs';

// THE OWNER'S NOTES V4 (2026-10-19), conversation side: the routine offer waits for the conversation and
// never follows a referral; a medical turn shows no product; the concern buttons only under the concern
// question; the contact form is truthful and asks for the order number. On the INVENTED sample set.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const CONFIG = read('data/advisor/qiriness.json');
const CATALOGUE = read('data/advisor/sample/catalogue.json');
const SHEET = read('data/advisor/sample/knowledge.json');
const KNOWLEDGE = knowledgeIndex(parseKnowledgeRows(SHEET.rows, { concerns: SHEET.concerns }).products);
const product = (handle) => CATALOGUE.products.find((p) => p.handle === handle);
const answer = (reply, products = [], { lang = 'fr', contact = false } = {}) => ({ content: JSON.stringify({ reply, reply_language: lang, products, contact_link: contact }), toolCalls: [], usage: { prompt_tokens: 800, completion_tokens: 40 } });
function scripted(...responses) {
  const calls = [];
  return { calls, async completeWithTools(args) { calls.push(structuredClone(args)); return responses.shift() ?? answer('…'); } };
}
const agentWith = (client) => createLlmAgent({ client, company: { name: 'Lumen', contactFormPath: '/pages/contact' }, catalogue: CATALOGUE, advisor: createAdvisor(CONFIG, CATALOGUE, { knowledge: KNOWLEDGE }), productKnowledge: KNOWLEDGE });
const next = (history, message, reply) => [...history, { role: 'user', content: message }, { role: 'assistant', content: reply.text, context: { advisor: reply.advisor } }];
const page = product('test-creme-hydratante-light');
const onPage = { locale: 'fr', productHandle: page.handle };
const OFFER = 'flow:routine:yes';

test('the offer waits while the engine asks its question; a caution turn gets no follow-up at all', () => {
  const base = { flow: emptyFlow(), lang: 'fr', builder: false, answer: null, advice: null, showsProducts: true, anchor: null, purchaseAsk: null, runningLow: null, treat: null, purchaseChoices: () => [] };
  assert.equal(followUpFor({ ...base, engineAsks: true }).followUp, null);
  assert.equal(followUpFor({ ...base, engineAsks: true }).flow.offer, null);
  assert.equal(followUpFor(base).followUp.kind, 'offer');
  // Not even the treat after a « Non ».
  assert.equal(followUpFor({ ...base, caution: true, flow: { ...emptyFlow(), offer: 'declined' }, answer: 'no', treat: { product_id: page.id } }).followUp, null);
});

test('a reply ending with its own question: no offer under it, and the offer comes on the next turn (« this doubling of messages »)', async () => {
  const agent = agentWith(scripted(answer('Elle convient aux peaux mixtes. Votre peau tiraille-t-elle en fin de journée ?'), answer('Elle convient très bien aux peaux mixtes.')));
  const r1 = await agent.respond({ message: 'Cette crème est-elle adaptée à ma peau ?', context: onPage });
  assert.equal(r1.followUp, undefined);
  assert.equal(r1.advisor.flow.offer, null);
  const history = next([], 'Cette crème est-elle adaptée à ma peau ?', r1);
  const r2 = await agent.respond({ message: "Oui, un peu, et j'aime les textures légères", context: onPage, history, advisorState: advisorStateFromHistory(history) });
  assert.equal(r2.followUp?.choices[0].value, OFFER);
});

test('the same in English', async () => {
  const reply = await agentWith(scripted(answer('It suits combination skin. Does your skin feel tight by the evening?', [], { lang: 'en' }))).respond({ message: 'Is this cream right for my skin?', context: { ...onPage, locale: 'en' } });
  assert.equal(reply.followUp, undefined);
});

test('no routine offer after a referral to a doctor, a pharmacist or customer service, FR and EN', async () => {
  for (const reply of [
    answer("Un grain de beauté qui change doit être examiné rapidement par un médecin ou un dermatologue."),
    answer('Please ask your pharmacist before using it.', [], { lang: 'en' }),
    answer('Notre service client pourra vous aider à signaler cette réaction.', [], { contact: true })
  ]) {
    const r = await agentWith(scripted(reply)).respond({ message: 'Cette crème est-elle adaptée à ma peau ?', context: onPage });
    assert.equal(r.followUp, undefined, JSON.parse(reply.content).reply);
    assert.equal(r.advisor.flow.offer, null);
  }
});

test('a medical question shows no card and no offer, whatever the advice or the model listed, FR and EN', async () => {
  const listed = [{ handle: page.handle, rationale: 'x' }];
  for (const [message, lang] of [["Je prends un traitement dermatologique contre l'acné. Puis-je ajouter vos soins exfoliants et anti-âge ?", 'fr'], ["I'm on a prescribed acne treatment. Can I add your exfoliating care?", 'en']]) {
    const client = scripted(answer('Demandez conseil à votre dermatologue avant d’ajouter ces soins.', listed, { lang }));
    const r = await agentWith(client).respond({ message, context: { ...onPage, locale: lang } });
    assert.deepEqual(r.products, [], message);
    assert.equal(r.followUp, undefined, message);
    assert.deepEqual(r.choices, [], message);
    assert.equal(client.calls.length, 1, 'no profile-reader call');
    assert.match(client.calls[0].system, /CAUTION/);
    assert.doesNotMatch(client.calls[0].system, /ADVICE FOR THIS CUSTOMER/);
  }
  // A product asked to be shown still is.
  const shown = await agentWith(scripted(answer('La voici.', listed))).respond({ message: 'Je suis allergique au parfum, montrez-moi cette crème', context: onPage });
  assert.equal(shown.products.length, 1);
});

test('the concern buttons only under the concern question: « De quelle crème s’agit-il ? » drops them and does not count it as asked', async () => {
  const dropped = await agentWith(scripted(answer('En général oui, sauf indication contraire. De quelle crème s’agit-il ?'))).respond({ message: "J'ai des rides", context: { locale: 'fr' } });
  assert.deepEqual(dropped.choices, []);
  assert.ok(!dropped.advisor.asked.includes('primary_concern'));
  assert.equal(dropped.advisor.last_question, null);
  // Asked in the model's words: kept.
  const kept = await agentWith(scripted(answer('Avez-vous aussi l’une de ces préoccupations ?'))).respond({ message: "J'ai des rides", context: { locale: 'fr' } });
  assert.ok(kept.choices.length > 0);
  assert.ok(kept.advisor.asked.includes('primary_concern'));
});

test('the concern question is recognised in the model\'s words, FR and EN', () => {
  const options = [{ label: 'Déshydratation' }, { label: 'Imperfections' }, { label: 'Taches et teint terne' }, { label: 'Rides' }];
  assert.ok(asksConcern('Cherchez-vous à cibler la déshydratation, les imperfections, les taches ?', options));
  assert.ok(asksConcern('Quelle est votre priorité ?', options));
  assert.ok(asksConcern('Which of these concerns matters most to you?', [{ label: 'Dehydration' }]));
  assert.ok(asksConcern('For the eye area, what would you most like to address?', [{ label: 'Dehydration' }]));
  assert.ok(asksConcern('Que souhaitez-vous cibler en priorité ?', options));
  assert.ok(!asksConcern('De quelle crème s’agit-il ? Je pourrai vérifier.', options));
  assert.ok(!asksConcern('Si vous me donnez leurs noms, je pourrai vérifier.', options));
  assert.ok(endsWithQuestion('Je comprends. Quel âge avez-vous ?'));
  assert.ok(!endsWithQuestion('Quel âge avez-vous ? Je vous conseille ce sérum.'));
});

test('an order question sent to the contact form reminds them of the order number, once, FR and EN', async () => {
  const fr = await agentWith(scripted(answer('Notre service client pourra vérifier la situation ; contactez-le via le formulaire.', [], { contact: true }))).respond({ message: 'Le suivi indique « livré », mais je n’ai reçu aucun colis. Que dois-je faire ?', context: { locale: 'fr' } });
  assert.ok(fr.contact);
  assert.match(fr.text, /N'oubliez pas d'indiquer votre numéro de commande dans le formulaire\.$/);
  const en = await agentWith(scripted(answer('Our customer service will look into it; please use the contact form.', [], { lang: 'en', contact: true }))).respond({ message: 'I received a different product from the one I ordered.', context: { locale: 'fr' } });
  assert.match(en.text, /Don't forget to include your order number in the form\.$/);
  const once = await agentWith(scripted(answer('Contactez notre service client via le formulaire en indiquant votre numéro de commande.', [], { contact: true }))).respond({ message: "J'ai reçu un produit différent de celui commandé", context: { locale: 'fr' } });
  assert.doesNotMatch(once.text, /N'oubliez pas/);
  // Not an order question: no reminder.
  const other = await agentWith(scripted(answer('Notre service client vous répondra via le formulaire.', [], { contact: true }))).respond({ message: 'Je veux parler à une vraie personne', context: { locale: 'fr' } });
  assert.doesNotMatch(other.text, /N'oubliez pas/);
});

test('the prompt: the contact form never sees the chat; a brand question is answered from the description, never with products', () => {
  const system = buildStorefrontSystemPrompt({ company: { name: 'Lumen', description: 'soins visage' }, hasTools: true, hasAdvisor: true });
  assert.match(system, /customer service never sees this conversation/);
  assert.match(system, /question about Lumen itself/);
  assert.match(system, /Never answer it with product suggestions/);
  assert.match(system, /area_fallback/);
  assert.doesNotMatch(system, /CAUTION/);
});

test('a profile chip is our own label, never a product name: no « which one? » in place of the next question', async () => {
  // « Moins de 25 ans » had resolved to the hand products (« moins » one letter from « mains »).
  const r = await agentWith(scripted(answer('Souhaitez-vous une routine pour le jour, pour la nuit, ou les deux ?'))).respond({ message: page.name, choice: 'profile:age_band:under_25', context: { locale: 'fr' } });
  assert.equal(r.resolution, null);
  assert.ok(!r.choices.some((c) => c.value === page.id || c.label === page.name));
});
