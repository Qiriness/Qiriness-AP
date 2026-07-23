import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEmbeddingInput, hashEmbeddingInput } from './embedding-input.mjs';

test('composes title, category, heading, and text in a fixed order', () => {
  const input = buildEmbeddingInput({
    title: 'Livraison',
    category: 'delivery',
    section_heading: 'Delais',
    chunk_text: 'Nous livrons en 3 jours.'
  });
  assert.equal(input, 'Livraison\n\ndelivery\n\nDelais\n\nNous livrons en 3 jours.');
});

test('is deterministic and whitespace-stable in the prefix fields', () => {
  const a = buildEmbeddingInput({
    title: '  Livraison  ',
    category: 'delivery',
    section_heading: 'Delais\t',
    chunk_text: 'Nous livrons en 3 jours.'
  });
  const b = buildEmbeddingInput({
    title: 'Livraison',
    category: 'delivery',
    section_heading: 'Delais',
    chunk_text: 'Nous livrons en 3 jours.'
  });
  assert.equal(a, b);
  assert.equal(hashEmbeddingInput(a), hashEmbeddingInput(b));
});

test('preserves internal paragraph structure of the chunk body', () => {
  const input = buildEmbeddingInput({
    title: 'T',
    chunk_text: 'Para un.\n\nPara deux.'
  });
  assert.match(input, /Para un\.\n\nPara deux\./);
});

test('omits blank prefix fields instead of emitting empty separators', () => {
  const input = buildEmbeddingInput({ title: '', category: '', section_heading: '', chunk_text: 'Texte.' });
  assert.equal(input, 'Texte.');
});

test('a category rename changes the hash even when chunk text is identical', () => {
  const base = { title: 'T', section_heading: 'H', chunk_text: 'Same body.' };
  const before = hashEmbeddingInput(buildEmbeddingInput({ ...base, category: 'old' }));
  const after = hashEmbeddingInput(buildEmbeddingInput({ ...base, category: 'new' }));
  assert.notEqual(before, after);
});

test('a heading rename changes the hash', () => {
  const base = { title: 'T', category: 'c', chunk_text: 'Same body.' };
  const before = hashEmbeddingInput(buildEmbeddingInput({ ...base, section_heading: 'A' }));
  const after = hashEmbeddingInput(buildEmbeddingInput({ ...base, section_heading: 'B' }));
  assert.notEqual(before, after);
});
