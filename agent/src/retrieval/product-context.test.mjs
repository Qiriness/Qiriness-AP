import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProductContext, buildStock, toPromptText } from './product-context.mjs';

const RICH = '{"type":"root","children":[{"type":"paragraph","children":[{"type":"text","value":"Oui, il convient à tous les types de peau."}]}]}';

const PRODUCT = {
  title: 'Masque LED Visage Éclat & Régénération',
  handle: 'masque-led',
  status: 'active',
  available_stock: 38,
  short_description: 'Masque LED nouvelle génération.',
  description: 'Description longue du masque.',
  usage_instructions: 'Appliquer 10 minutes, 3 fois par semaine.',
  usage_advice: 'Ne pas utiliser sur peau lésée.',
  active_ingredients: 'LED rouge et infrarouge',
  ingredients_popup: 'Liste INCI complète disponible.',
  product_ingredients: [
    { fields: { ingredients_text: { value: '{"type":"root","children":[{"type":"paragraph","children":[{"type":"text","value":"Acide hyaluronique."}]}]}' } } }
  ],
  product_faqs: [
    { question: 'Convient-il à tous les types de peau ?', answer: RICH, published: true },
    { question: 'Brouillon', answer: RICH, published: false }
  ],
  variants: [{ title: 'Taille unique', sku: 'LED-1', price: '249.00', available: true }]
};

test('the four sections support is actually asked about are all populated', () => {
  const c = buildProductContext(PRODUCT);
  assert.equal(c.description, 'Masque LED nouvelle génération.');
  assert.equal(c.usage.instructions, 'Appliquer 10 minutes, 3 fois par semaine.');
  assert.equal(c.ingredients.actives, 'LED rouge et infrarouge');
  assert.equal(c.faqs.length, 1);
});

test('rich-text FAQ answers and ingredient details are flattened, not raw JSON', () => {
  const c = buildProductContext(PRODUCT);
  assert.equal(c.faqs[0].answer, 'Oui, il convient à tous les types de peau.');
  assert.deepEqual(c.ingredients.details, ['Acide hyaluronique.']);
  assert.doesNotMatch(JSON.stringify(c), /"type":"root"/);
});

test('unpublished FAQs are excluded', () => {
  assert.deepEqual(buildProductContext(PRODUCT).faqs.map((f) => f.question), ['Convient-il à tous les types de peau ?']);
});

test('short and long description are kept apart, not collapsed', () => {
  const c = buildProductContext(PRODUCT);
  assert.equal(c.description, 'Masque LED nouvelle génération.');
  assert.equal(c.fullDescription, 'Description longue du masque.');
});

test('a product with only a long description still has a description', () => {
  const c = buildProductContext({ ...PRODUCT, short_description: null });
  assert.equal(c.description, 'Description longue du masque.');
  assert.equal(c.fullDescription, null, 'not repeated twice');
});

// --- stock -------------------------------------------------------------------

test('negative stock is never reported as in stock', () => {
  // Shopify allows overselling; one real row sits at -1.
  const s = buildStock({ status: 'active', available_stock: -1 });
  assert.equal(s.inStock, false);
  assert.equal(s.purchasable, false);
  assert.equal(s.available, -1, 'raw number kept for a human');
});

test('untracked stock is not the same as zero', () => {
  const s = buildStock({ status: 'active', available_stock: null });
  assert.equal(s.tracked, false);
  assert.equal(s.inStock, null);
});

test('a draft product is never purchasable however much stock it has', () => {
  assert.equal(buildStock({ status: 'draft', available_stock: 700 }).purchasable, false);
  assert.equal(buildStock({ status: 'active', available_stock: 700 }).purchasable, true);
});

// --- prompt rendering --------------------------------------------------------

test('the rendered text has named sections a model can navigate', () => {
  const text = toPromptText(buildProductContext(PRODUCT));
  for (const heading of ['# Masque LED', '## Description', "## Conseils d'utilisation", '## Ingrédients', '## Questions fréquentes']) {
    assert.ok(text.includes(heading), heading);
  }
  assert.match(text, /Disponibilité : en stock/);
});

test('empty sections are omitted rather than rendered as blank headings', () => {
  // A model shown an empty heading tends to fill it in.
  const bare = buildProductContext({ title: 'X', status: 'active', available_stock: 1 });
  const text = toPromptText(bare);
  assert.doesNotMatch(text, /## Ingrédients|## Questions fréquentes|## Conseils/);
});

test('a single variant is not rendered as a choice', () => {
  assert.doesNotMatch(toPromptText(buildProductContext(PRODUCT)), /## Déclinaisons/);
});
