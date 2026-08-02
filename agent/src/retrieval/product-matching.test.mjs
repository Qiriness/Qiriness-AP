import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProductIndex, matchProduct, normalise, tokenise } from './product-matching.mjs';

// The real catalogue, titles verbatim — typographic apostrophes, en dashes and
// all. Matching that works on tidied-up strings is not matching that works.
const CATALOGUE = [
  { id: '1', title: "Déodorant Bille Anti-transpirant 48H - Fleur d'Oranger 100% Naturel - Roll On - Sans Alcool" },
  { id: '2', title: 'Coffret Temps Sublime – Rituel Anti-Âge Global Crème et Gommage' },
  { id: '3', title: 'Coffret Source d’Eau – Rituel Hydratation Intense Crème et Exfoliant' },
  { id: '4', title: 'Crème Nuit Anti-Âge Régénérante Rétinol Vitamine C - Caresse Temps Sublime' },
  { id: '5', title: 'Crème Mains Hydratante & Réparatrice - Caresse Mains Velours' },
  { id: '6', title: 'Kit Rituel Spa Corps Revitalisant' },
  { id: '7', title: 'Coffret Hydratation Visage & Regard – Caresse Source d’Eau' },
  { id: '8', title: 'Patch Anti-imperfections Aloe Vera - Flash Patch®' },
  { id: '9', title: 'Coffret Énergie Lift – Le trio vitalité bonne mine' },
  { id: '10', title: 'Crème Anti-Âge Homme - Acide Hyaluronique & Niacinamide' },
  { id: '11', title: 'Masque LED Visage Éclat & Régénération' },
  { id: '12', title: 'Crème Hydratante Visage Homme - Peaux Sèches - Baume Visage' },
  { id: '13', title: 'Sérum Anti-Taches Niacinamide & Mica - Élixir Éclat Parfait' },
  { id: '14', title: 'Eau Qi – Eau de Parfum Énergisante & Revitalisante' }
];

const index = buildProductIndex(CATALOGUE);
const titleOf = (question, options) => matchProduct(question, index, options).match?.title ?? null;

test('accents, typographic apostrophes and en dashes all fold away', () => {
  assert.equal(normalise('Coffret Source d’Eau – Rituel'), 'coffret source d eau rituel');
  assert.equal(normalise('Éclat & Régénération'), 'eclat regeneration');
  assert.deepEqual(tokenise('la Crème de Nuit'), ['creme', 'nuit']);
});

test('a real customer phrasing finds the product despite word order', () => {
  // "votre masque visage LED" vs "Masque LED Visage Éclat & Régénération".
  assert.match(
    titleOf('Bonjour, avant de procéder à l’achat potentiel de votre masque visage LED'),
    /Masque LED Visage/
  );
});

test('a distinctive word outweighs a common one', () => {
  // `creme` appears in a third of the titles and should barely move a score;
  // `led` appears in exactly one and is nearly decisive. That relative
  // weighting is IDF doing its job, not a hand-kept synonym list.
  assert.match(titleOf('je cherche le masque LED'), /Masque LED/);
  assert.match(titleOf('le sérum anti-taches'), /Sérum Anti-Taches/);
  assert.match(titleOf('la crème mains velours'), /Caresse Mains Velours/);
});

test('a genuinely ambiguous name is reported, never guessed', () => {
  // "Caresse Temps Sublime" is in a coffret AND a night cream. Picking one and
  // quoting its ingredients at someone asking about an allergy is the failure
  // this prevents.
  const result = matchProduct('le coffret Caresse Temps sublime jour et nuit', index);
  assert.equal(result.match, null);
  assert.equal(result.ambiguous, true);
  assert.ok(result.candidates.length >= 2);
  assert.ok(result.candidates.some((c) => /Temps Sublime/.test(c.product.title)));
});

test('a product that does not exist matches nothing', () => {
  // A real ticket: "Galets Bain lacté relaxant : je ne vois plus ce produit ?"
  // — discontinued. Returning the nearest cosmetic would be worse than nothing.
  const result = matchProduct('Galets Bain lacté relaxant, je ne vois plus ce produit', index);
  assert.equal(result.match, null);
  assert.equal(result.ambiguous, false);
});

test('a question naming no product at all matches nothing', () => {
  for (const question of ['Bonjour, où est ma commande ?', '', 'merci beaucoup']) {
    assert.equal(matchProduct(question, index).match, null, question);
  }
});

test('an empty catalogue does not throw', () => {
  const empty = buildProductIndex([]);
  assert.deepEqual(matchProduct('masque LED', empty), {
    match: null, confidence: 0, ambiguous: false, tied: [], candidates: []
  });
});

test('stopwords alone never constitute a match', () => {
  assert.equal(matchProduct('le la les de des pour avec', index).match, null);
});

test('confidence is reported so a caller can be stricter than the default', () => {
  const loose = matchProduct('crème', index, { minScore: 0.05 });
  const strict = matchProduct('crème', index, { minScore: 0.9 });
  assert.ok(loose.candidates.length > 0);
  assert.equal(strict.match, null, 'a bare common word should not clear a high bar');
});

test('candidates come back ranked with what matched, for a human to check', () => {
  const result = matchProduct('masque LED visage', index, { minScore: 0.1 });
  assert.ok(result.candidates[0].score >= result.candidates[result.candidates.length - 1].score);
  assert.ok(result.candidates[0].matchedTokens.includes('led'));
});
