import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLlmAgent } from './llm-agent.mjs';
import { cartAnswer, emptyFlow } from './routine-flow.mjs';
import { languageContext, displayLanguage } from './conversation-language.mjs';
import { buildCatalogue } from './product-repository.mjs';
import { buildAdvisorKnowledge } from '../advisory/advisor-knowledge.mjs';
import { knowledgeIndex } from '../advisory/product-knowledge.mjs';
import { createAdvisor } from '../advisory/recommend.mjs';
import { detectLanguage, extractProfile } from '../advisory/lexicon.mjs';
import { messages } from '../i18n/languages.mjs';

// EVERY LANGUAGE THE STORE SPEAKS (owner, 2026-10-30: FR, EN, IT, DE, NL, and ES before it is on the
// site). On Qiriness's real sheet: the same sentence reads the same profile in each language, the
// language is recognised, a routine is built from typed answers alone, and the cart question is
// answered in words. The model never answers here: every turn below is the code's.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const built = buildAdvisorKnowledge({ sheet: read('data/advisor/qiriness-knowledge.json'), settings: read('data/advisor/qiriness-routine-settings.json') });
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CATALOGUE = buildCatalogue(
  built.products.map((k, i) => ({
    id: uuid(i + 1), shopify_product_id: `gid://shopify/Product/${i + 1}`, handle: k.handle, title: k.title ?? k.handle,
    product_type: 'Soin', tags: [], short_description: `La description courte de ${k.handle}.`,
    variants: [{ id: `gid://shopify/ProductVariant/${i + 1}`, title: '50 ml', price: String(Number(k.price) || 30), inventory_quantity: 5 }], available_stock: 5,
  })),
  [],
);
const advisor = createAdvisor(read('data/advisor/qiriness.json'), CATALOGUE, { knowledge: knowledgeIndex(built.products), routines: built.routines });

/** The same nine sentences as advisory.test.mjs's French / English pairs, in each language. */
const SENTENCES = {
  en: ["I have dry skin and I'm starting to get wrinkles", 'I have wrinkles around my eyes', 'A cream for my husband, he has oily skin', 'Very dry and dehydrated skin, an essential routine', 'I have dark spots, I already use a cleanser and a cream', 'My skin is sensitive, fragrance-free', "I'm 52 and my skin is sagging", 'Combination skin with blackheads', "I'm looking for a serum for redness"],
  it: ['Ho la pelle secca e comincio ad avere le prime rughe', 'Ho delle rughe intorno agli occhi', 'Una crema per mio marito, ha la pelle grassa', 'Pelle molto secca e disidratata, una routine essenziale', 'Ho delle macchie, uso già un detergente e una crema', 'La mia pelle è sensibile, senza profumo', 'Ho 52 anni e la pelle che cede', 'Pelle mista con punti neri', 'Cerco un siero per i rossori'],
  de: ['Ich habe trockene Haut und bekomme erste Falten', 'Ich habe Falten um die Augen', 'Eine Creme für meinen Mann, er hat fettige Haut', 'Sehr trockene und dehydrierte Haut, eine einfache Routine', 'Ich habe Pigmentflecken, ich benutze schon einen Reiniger und eine Creme', 'Meine Haut ist empfindlich, ohne Parfum', 'Ich bin 52 und meine Haut ist erschlafft', 'Mischhaut mit Mitessern', 'Ich suche ein Serum gegen Rötungen'],
  nl: ['Ik heb een droge huid en krijg de eerste rimpels', 'Ik heb rimpels rond mijn ogen', 'Een crème voor mijn man, hij heeft een vette huid', 'Zeer droge en uitgedroogde huid, een eenvoudige routine', 'Ik heb pigmentvlekken, ik gebruik al een reiniger en een crème', 'Mijn huid is gevoelig, zonder parfum', 'Ik ben 52 en mijn huid wordt slap, verslapping', 'Gemengde huid met mee-eters', 'Ik zoek een serum voor roodheid'],
  es: ['Tengo la piel seca y empiezo a tener arrugas', 'Tengo arrugas alrededor de los ojos', 'Una crema para mi marido, tiene la piel grasa', 'Piel muy seca y deshidratada, una rutina esencial', 'Tengo manchas, ya uso un limpiador y una crema', 'Mi piel es sensible, sin perfume', 'Tengo 52 años y flacidez', 'Piel mixta con puntos negros', 'Busco un sérum para las rojeces'],
};
const profileOf = (m) => extractProfile(m).updates.map((u) => [u.field, u.value]).sort((a, b) => a.join().localeCompare(b.join()));

for (const lang of ['it', 'de', 'nl', 'es']) {
  test(`${lang}: the lexicon reads the same profile as from the English, and knows the language`, () => {
    SENTENCES[lang].forEach((sentence, i) => {
      assert.deepEqual(profileOf(sentence), profileOf(SENTENCES.en[i]), `${sentence} ≠ ${SENTENCES.en[i]}`);
      assert.equal(detectLanguage(sentence), lang, sentence);
    });
  });
}

test('the French and English are still read as French and English beside four more languages', () => {
  for (const [m, lang] of [["Bonjour, j'ai la peau sèche", 'fr'], ['Quelle crème pour les rides ?', 'fr'], ['Hello, I have oily skin', 'en'], ['Which serum for dark spots?', 'en']]) assert.equal(detectLanguage(m), lang, m);
});

/** A routine built from typed words only, the page in that language: [the request, concern, skin type, age, moment]. */
const TYPED = {
  it: ['Vorrei costruire la mia routine', 'Rughe', 'Pelle secca', 'Ho 40 anni', 'Routine del mattino'],
  de: ['Stellen Sie mir eine Routine zusammen', 'Falten', 'Trockene Haut', 'Ich bin 40', 'Morgenroutine'],
  nl: ['Stel een routine voor mij samen', 'Rimpels', 'Droge huid', 'Ik ben 40', 'Ochtendroutine'],
  es: ['Quiero crear mi rutina', 'Arrugas', 'Piel seca', 'Tengo 40 años', 'Rutina de mañana'],
};

for (const [lang, turns] of Object.entries(TYPED)) {
  test(`${lang}: a routine built from typed answers, every question and the routine in that language`, async () => {
    const calls = [];
    const client = { async completeWithTools(args) { calls.push(args); return { content: JSON.stringify({ reply: '…', reply_language: lang, products: [] }), toolCalls: [], usage: {} }; } };
    const agent = createLlmAgent({ client, company: { name: 'Qiriness' }, catalogue: CATALOGUE, advisor });
    let state = null;
    let last = null;
    const history = [];
    for (const message of turns) {
      last = await agent.respond({ message, advisorState: state, history, context: { locale: lang } });
      history.push({ role: 'user', content: message }, { role: 'assistant', content: last.text, context: { replyLanguage: last.replyLanguage ?? lang } });
      state = last.advisor;
    }
    assert.ok(last.routineView, `no routine after: ${turns.join(' / ')}`);
    assert.equal(last.routineView.chosen, 'day');
    assert.equal(last.routineView.locale, lang);
    assert.equal(last.text, messages(lang).flow.routineReady);
  });
}

test('the cart question answered in words, in each language', () => {
  const flow = { ...emptyFlow(), cart: { pending: [{ id: uuid(1), variant_id: null }], asked: [] } };
  const answers = {
    it: [['Sì, aggiungi', 'yes'], ['No grazie', 'no'], ['Sto ancora guardando', 'no'], ['Aggiungilo al carrello', 'yes']],
    de: [['Ja, gerne', 'yes'], ['Nein danke', 'no'], ['Ich schaue noch', 'no'], ['Bitte in den Warenkorb legen', 'yes']],
    nl: [['Ja, graag', 'yes'], ['Nee bedankt', 'no'], ['Ik kijk nog', 'no'], ['Voeg het toe aan mijn winkelmandje', 'yes']],
    es: [['Sí, añadir', 'yes'], ['No gracias', 'no'], ['Sigo mirando', 'no'], ['Añádelo al carrito', 'yes']],
  };
  for (const [lang, pairs] of Object.entries(answers)) for (const [message, expected] of pairs) assert.equal(cartAnswer(flow, { message }), expected, `${lang}: ${message}`);
});

test('the language of the code\'s own text: the message\'s, then the conversation\'s, then the page\'s; English for any other', () => {
  assert.equal(displayLanguage(languageContext('Ho la pelle secca'), 'fr'), 'it');
  assert.equal(displayLanguage(languageContext('Sì'), 'de'), 'de');
  assert.equal(displayLanguage(languageContext('ok'), 'pt-BR'), 'en');
  assert.equal(displayLanguage(languageContext('ok', [{ role: 'assistant', content: '…', context: { replyLanguage: 'nl' } }]), 'fr'), 'nl');
});
