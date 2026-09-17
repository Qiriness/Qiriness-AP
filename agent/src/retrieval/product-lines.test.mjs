import assert from 'node:assert/strict';
import test from 'node:test';

import { productLine, productLines, skinPhrase } from './product-lines.mjs';

test('a suggestion carries the name, what it does, and who it is for', () => {
  // The whole point: three bare names tell the customer nothing they could not
  // get from the menu, and they still have to open all three.
  const line = productLine({
    title: 'Sérum Anti-âge Liftant',
    summary: 'Lisse les rides installées et redensifie la peau.',
    tags: ['sérum', 'peaux matures']
  });
  assert.equal(
    line,
    '- Sérum Anti-âge Liftant — Lisse les rides installées et redensifie la peau. Pour peau mature.'
  );
});

test('one sentence, not the whole description', () => {
  // `short_description` runs to three or four sentences on some products, and a
  // suggestion list of paragraphs stops being a list.
  const line = productLine({
    title: 'Crème',
    summary: 'Hydrate en profondeur. Sa texture fond immédiatement. Convient au quotidien.',
    tags: []
  });
  assert.equal(line, '- Crème — Hydrate en profondeur.');
});

test('a summary with no full stop gets one', () => {
  assert.match(productLine({ title: 'X', summary: 'Hydrate en profondeur', tags: [] }), /Hydrate en profondeur\.$/);
});

test('a product with no summary is named and nothing is invented for it', () => {
  // A description composed here about a cosmetic is precisely the drafting
  // mistake this layer exists to prevent.
  assert.equal(productLine({ title: 'Masque', summary: null, tags: [] }), '- Masque');
  assert.equal(productLine({ title: 'Masque', summary: '   ', tags: [] }), '- Masque');
});

// --- who it suits --------------------------------------------------------------

test('the shop saying "tous les types de peaux" is quoted as such', () => {
  assert.equal(skinPhrase(['tous les types de peaux']), 'Convient à tous les types de peaux.');
});

test('a product tagged for most skin types reads as universal, not as a list', () => {
  // Measured on the catalogue: a cleanser carries nine skin types at once.
  // Listing four of them instead of the phrase the shop itself uses is worse
  // French for the same fact.
  const many = ['peaux sensibles', 'peaux sèches', 'peaux grasses', 'peaux mixtes'];
  assert.equal(skinPhrase(many), 'Convient à tous les types de peaux.');
});

test('one or two skin types are named', () => {
  assert.equal(skinPhrase(['peaux sensibles']), 'Pour peau sensible ou réactive.');
  assert.equal(
    skinPhrase(['peaux sensibles', 'peaux sèches']),
    'Pour peau sensible ou réactive et peau sèche ou déshydratée.'
  );
});

test('tags that say nothing about skin say nothing', () => {
  // Silence is honest. « convient à tous les types de peaux » asserted from no
  // skin tag at all would be a claim nobody checked.
  assert.equal(skinPhrase(['sérum', 'anti-âge', 'best seller']), null);
  assert.equal(skinPhrase([]), null);
  assert.equal(skinPhrase(), null);
});

test('several products render as one block, one line each', () => {
  const block = productLines([
    { title: 'A', summary: 'Fait ceci.', tags: ['peaux sensibles'] },
    { title: 'B', summary: null, tags: [] }
  ]);
  assert.equal(block, '- A — Fait ceci. Pour peau sensible ou réactive.\n- B');
});
