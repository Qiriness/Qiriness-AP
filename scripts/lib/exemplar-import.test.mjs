import assert from 'node:assert/strict';
import test from 'node:test';

import { parseExemplarDocument, validateExemplar } from './exemplar-import.mjs';

const parse = (markdown) => {
  const warnings = [];
  const exemplars = parseExemplarDocument(markdown, { warn: (m) => warnings.push(m) });
  return { exemplars, warnings };
};

const ENTRY = `
### P-16 · Le code de 20 % première commande ne s'applique pas à mon panier.
\`promotions\` · \`problem\` · **16 msgs** · 🟢

**Variantes réelles**
- « J'essaie de passer ma PREMIÈRE commande mais les 20 % ne s'appliquent pas »
- « le code ne marche pas au paiement »

**needs** \`promotion_identity\`, \`promotion_validity\`, \`promotion_eligibility\`
**exemplaires** → jeu \`promo\`

**Contenu stable** _(à rédiger)_
>
`;

test('an entry becomes one exemplar with its metadata', () => {
  const { exemplars } = parse(ENTRY);
  assert.equal(exemplars.length, 1);
  const [e] = exemplars;
  assert.equal(e.exemplarKey, 'P-16');
  assert.equal(e.canonicalQuestion, "Le code de 20 % première commande ne s'applique pas à mon panier.");
  assert.equal(e.category, 'promotions');
  assert.equal(e.requestKind, 'problem');
  assert.equal(e.demandMessageCount, 16);
  assert.deepEqual(e.requirementNeeds, [
    'promotion_identity',
    'promotion_validity',
    'promotion_eligibility'
  ]);
});

test('the canonical question is phrasing zero, variants follow it', () => {
  // Index 0 is stable across re-imports, which is what lets the upsert key on it.
  const [e] = parse(ENTRY).exemplars;
  assert.equal(e.phrasings.length, 3);
  assert.deepEqual(e.phrasings.map((p) => p.index), [0, 1, 2]);
  assert.equal(e.phrasings[0].kind, 'canonical');
  assert.equal(e.phrasings[0].text, e.canonicalQuestion);
  assert.deepEqual(e.phrasings.slice(1).map((p) => p.kind), ['variant', 'variant']);
  assert.equal(e.phrasings[1].text, "J'essaie de passer ma PREMIÈRE commande mais les 20 % ne s'appliquent pas");
});

test('only bullets under the variants heading are read', () => {
  // A quoted line elsewhere is prose about the situation, not a way of saying it.
  const { exemplars } = parse(`
### D-01 · Où est ma commande ?
\`delivery\` · \`problem\` · **19 msgs** · 🟢

**Variantes réelles**
- « toujours rien reçu »

**needs** \`order_identity\`
**exemplaires** → jeu \`commande\`

**Contenu stable**
> « ceci est une citation dans le contenu, pas une variante »
`);
  assert.deepEqual(exemplars[0].phrasings.map((p) => p.text), [
    'Où est ma commande ?',
    'toujours rien reçu'
  ]);
});

test('a phrasing quoting our own reply is skipped and named', () => {
  // Embedding an ANSWER into the corpus of QUESTIONS is the single thing the
  // separate-tables decision exists to prevent.
  const { exemplars, warnings } = parse(`
### P-18 · Puis-je cumuler plusieurs offres ?
\`promotions\` · \`question\` · **3 msgs** · 🟢

**Variantes réelles**
- « Les offres ne sont pas cumulables… » _(our own reply — the customer-side phrasing needs writing)_

**needs** \`policy_answer\`
`);
  assert.equal(exemplars[0].phrasings.length, 1, 'only the canonical question survives');
  assert.match(warnings.join('\n'), /our own reply/);
});

test('a second subject is kept as a note, not silently dropped', () => {
  // `category` drives the retrieval filter and a ticket has one subject to match
  // against. Which of the two is really primary is a reviewer's call.
  const [e] = parse(`
### P-17 · Le masque offert ne s'ajoute pas au panier.
\`order\` / \`promotions\` · \`problem\` · **9 msgs** · 🔒 \`checkout_state\`

**needs** \`promotion_validity\`, \`checkout_state\`
`).exemplars;
  assert.equal(e.category, 'order');
  assert.match(e.sourceNote, /second subject: promotions/);
  assert.match(e.sourceNote, /blocked/);
});

test('a need the investigation cannot score is dropped loudly', () => {
  // Writing it would fail the check constraint at insert; dropping it silently
  // would leave a requirement nothing could ever satisfy.
  const { exemplars, warnings } = parse(`
### X-01 · Une question
\`product\` · \`question\` · **2 msgs** · 🟢

**needs** \`product_property\`, \`vibes\`
`);
  assert.deepEqual(exemplars[0].requirementNeeds, ['product_property']);
  assert.match(warnings.join('\n'), /unknown need « vibes »/);
});

test('an entry with no message count parses without one', () => {
  // Several say `_no cluster — see note_` or `_(within D-03's cluster)_`.
  const [e] = parse(`
### D-07 · Quels sont vos délais de livraison ?
\`delivery\` · \`question\` · _no cluster — see note_ · 🟢

**needs** \`policy_answer\`
`).exemplars;
  assert.equal(e.demandMessageCount, null);
  assert.equal(e.category, 'delivery');
});

test('duplicate phrasings collapse, including one matching the question', () => {
  const [e] = parse(`
### A-01 · Je ne peux pas me connecter
\`account\` · \`problem\` · **5 msgs** · 🟢

**Variantes réelles**
- « Je ne peux pas me connecter »
- « impossible de me connecter »
- « Impossible de me connecter »
`).exemplars;
  assert.deepEqual(e.phrasings.map((p) => p.text), [
    'Je ne peux pas me connecter',
    'impossible de me connecter'
  ]);
});

test('whitespace is collapsed the same way the embedder collapses it', () => {
  // A mismatch here would make every phrasing hash differently from the text
  // that was embedded, and the reconciler would re-embed for ever.
  const [e] = parse(`
### X-02 · Une    question   espacée
\`product\` · \`question\` · **1 msgs** · 🟢

**Variantes réelles**
- «   trop    d'espaces   »
`).exemplars;
  assert.equal(e.canonicalQuestion, 'Une question espacée');
  assert.equal(e.phrasings[1].text, "trop d'espaces");
});

test('multiple entries in one document are separated', () => {
  const { exemplars } = parse(`${ENTRY}\n${ENTRY.replace('P-16', 'P-19')}`);
  assert.deepEqual(exemplars.map((e) => e.exemplarKey), ['P-16', 'P-19']);
});

test('a repeated key keeps the first and says so', () => {
  const { exemplars, warnings } = parse(`${ENTRY}\n${ENTRY}`);
  assert.equal(exemplars.length, 1);
  assert.match(warnings.join('\n'), /duplicate exemplar key P-16/);
});

test('prose outside any entry is ignored', () => {
  const { exemplars } = parse(`
# Livraison — 8 questions · 70 messages

Some preamble with \`backticks\` and **bold** that is not an entry.

${ENTRY}
`);
  assert.equal(exemplars.length, 1);
});

test('parsing never throws on empty or absent input', () => {
  assert.deepEqual(parseExemplarDocument('').length, 0);
  assert.deepEqual(parseExemplarDocument(null).length, 0);
  assert.deepEqual(parseExemplarDocument(undefined).length, 0);
});

// --- validation --------------------------------------------------------------

test('a complete exemplar has no problems', () => {
  assert.deepEqual(validateExemplar(parse(ENTRY).exemplars[0]), []);
});

test('validation names every missing piece rather than the first', () => {
  // One unreadable entry in 32 must not stop the other 31, so problems are
  // reported as a list rather than thrown at the first.
  const problems = validateExemplar({ canonicalQuestion: '', category: null, phrasings: [] });
  assert.equal(problems.length, 3);
});

// --- phrasing language -------------------------------------------------------

const LANGUAGES = `
### D-33 · Livrez-vous dans mon pays ?
\`delivery\` · \`question\` · **7 msgs** · 🟢

**Variantes réelles**
- « Est-ce que vous livrez en Italie ? »
- « Do you ship to Germany? »  _(en)_
- « Mi pedido num. 6298 ha venido erróneo »  _(es — extrait, la suite est sur D-08)_
- « Kan geen bestelling plaatsen »  _(nl)_
- « Je n'arrive pas à sélectionner mon pays »  _(authored)_
- « nouvelle adresse pour recevoir mon coli »  _(objet du message)_

**needs** \`policy_answer\`
`;

test('a variant is French unless its annotation opens with a language code', () => {
  const { exemplars } = parse(LANGUAGES);
  const byText = new Map(exemplars[0].phrasings.map((p) => [p.text.slice(0, 12), p.language]));

  assert.equal(byText.get('Est-ce que v'), 'fr');
  assert.equal(byText.get('Do you ship '), 'en');
  assert.equal(byText.get('Mi pedido nu'), 'es');
  assert.equal(byText.get('Kan geen bes'), 'nl');
});

test('a prose annotation is not read as a language code', () => {
  const { exemplars, warnings } = parse(LANGUAGES);
  const byText = new Map(exemplars[0].phrasings.map((p) => [p.text.slice(0, 12), p.language]));

  // « authored » and « objet du message » both open with letters; neither has
  // the marker's shape, so neither may change a phrasing's language.
  assert.equal(byText.get("Je n'arrive "), 'fr');
  assert.equal(byText.get('nouvelle adr'), 'fr');
  assert.deepEqual(warnings, []);
});

test('the canonical question is always French', () => {
  const { exemplars } = parse(LANGUAGES);
  assert.equal(exemplars[0].phrasings[0].kind, 'canonical');
  assert.equal(exemplars[0].phrasings[0].language, 'fr');
});

test('a two-letter opener that is not a language is reported, not read as one', () => {
  const { exemplars, warnings } = parse(`
### D-99 · Une question.
\`delivery\` · \`question\` · **1 msgs** · 🟢

**Variantes réelles**
- « une phrase »  _(xx — pas un code)_

**needs** \`policy_answer\`
`);

  assert.equal(exemplars[0].phrasings[1].language, 'fr');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown language marker/);
});

test('the real corpus declares exactly the foreign phrasings it holds', async () => {
  const { readFileSync } = await import('node:fs');
  const markdown = readFileSync(new URL('../../Email-Example-Queries.md', import.meta.url), 'utf8');
  const { exemplars, warnings } = parse(markdown);

  const foreign = exemplars.flatMap((e) =>
    e.phrasings.filter((p) => p.language !== 'fr').map((p) => `${e.exemplarKey}:${p.language}`)
  );

  // Twelve, and the count is the point: before the marker existed every one of
  // these was written to the table as French, so the language column measured
  // the opposite of what it was added to measure. The twelfth is D-01's Italian
  // near miss, added 2026-09-15.
  assert.equal(foreign.length, 12);
  assert.deepEqual(
    [...new Set(foreign.map((f) => f.split(':')[1]))].sort(),
    ['en', 'es', 'it', 'nl']
  );
  assert.ok(
    !warnings.some((w) => /language marker/.test(w)),
    `unread language markers: ${warnings.join('; ')}`
  );
});
