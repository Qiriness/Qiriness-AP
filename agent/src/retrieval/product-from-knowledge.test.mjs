import assert from 'node:assert/strict';
import test from 'node:test';

import { productFromKnowledge } from './product-from-knowledge.mjs';

// Bands come from retrieval-rules: >= 0.60 answerable, >= 0.50 weak, below none.
const STRONG = 0.66;
const WEAK = 0.52;

const chunk = (over = {}) => ({
  documentId: 'doc-led',
  productIds: ['prod-led'],
  similarity: STRONG,
  ...over
});

test('an article resolves the product the title matcher could not', () => {
  // « la batterie de mon masque ne tient pas la charge » — no title contains
  // « batterie », so the matcher reports partial_match and identifies nothing.
  // The article answering it is tagged to the mask.
  const result = productFromKnowledge(
    { match: null, range: null, ambiguous: false, reason: 'partial_match' },
    [chunk()]
  );
  assert.deepEqual(result.productIds, ['prod-led']);
  assert.equal(result.ambiguous, false);
});

test('a product the customer named always wins over an article tag', () => {
  // THE PRECEDENCE RULE. A named product is the customer's own word; a tag is an
  // inference about what they meant. An article about the LED mask retrieved
  // alongside a question that plainly names a cream must not redirect it.
  const named = { match: { id: 'prod-creme' }, range: null, ambiguous: false };
  assert.equal(productFromKnowledge(named, [chunk()]), null);
});

test('a range or an honest ambiguity is also an answer, and also stands', () => {
  // Both are resolutions, not failures — the matcher said something true about
  // the question, and an article tag must not overwrite either.
  assert.equal(
    productFromKnowledge({ match: null, range: { name: 'temps sublime' }, ambiguous: false }, [chunk()]),
    null
  );
  assert.equal(
    productFromKnowledge({ match: null, range: null, ambiguous: true }, [chunk()]),
    null
  );
});

test('a weak chunk may never assert a product', () => {
  // THE GUARD THAT KEEPS THIS FROM BECOMING THE FAILURE IT PREVENTS. The bands
  // refused to answer from this chunk; letting it name a product would turn the
  // same untrusted retrieval into a hard fact by a longer route.
  const result = productFromKnowledge(
    { match: null, ambiguous: false, reason: 'partial_match' },
    [chunk({ similarity: WEAK })]
  );
  assert.equal(result, null);
});

test('a strong chunk carries, and the weak ones behind it do not', () => {
  // `searchKnowledge` passes chunks whenever the BEST is answerable, so a mixed
  // list is the normal case rather than an edge one.
  const result = productFromKnowledge({ match: null, ambiguous: false }, [
    chunk(),
    chunk({ documentId: 'doc-other', productIds: ['prod-creme'], similarity: WEAK })
  ]);
  assert.deepEqual(result.productIds, ['prod-led'], 'a weak chunk contributed a product');
  assert.equal(result.ambiguous, false);
});

test('several products on ONE article is a range, not a conflict', () => {
  // Ranges are computed from title bigrams and have no id to store, so attaching
  // several products IS how « toute la gamme Temps Sublime » is expressed.
  const result = productFromKnowledge({ match: null, ambiguous: false }, [
    chunk({ documentId: 'doc-range', productIds: ['prod-b', 'prod-a'] })
  ]);
  assert.deepEqual(result.productIds, ['prod-a', 'prod-b'], 'sorted, so the value is stable');
  assert.equal(result.ambiguous, false);
});

test('two articles naming different products is an ambiguity, not a pick', () => {
  const result = productFromKnowledge({ match: null, ambiguous: false }, [
    chunk(),
    chunk({ documentId: 'doc-creme', productIds: ['prod-creme'] })
  ]);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.productIds, ['prod-creme', 'prod-led']);
  assert.equal(result.documentIds.length, 2);
});

test('two articles agreeing on the same products is not an ambiguity', () => {
  const result = productFromKnowledge({ match: null, ambiguous: false }, [
    chunk(),
    chunk({ documentId: 'doc-led-faq' })
  ]);
  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.productIds, ['prod-led']);
});

test('untagged articles resolve nothing, which is most of the library', () => {
  // 17 of 17 documents carry no tag today; the common path must be null and
  // never an empty-array "answer" a caller could mistake for a resolution.
  assert.equal(productFromKnowledge({ match: null, ambiguous: false }, [chunk({ productIds: [] })]), null);
  assert.equal(productFromKnowledge({ match: null, ambiguous: false }, []), null);
  assert.equal(productFromKnowledge({ match: null, ambiguous: false }, null), null);
});

test('a missing matcher result still resolves, since the matcher may not have run', () => {
  assert.deepEqual(productFromKnowledge(null, [chunk()]).productIds, ['prod-led']);
});

test('a chunk with no similarity is never trusted', () => {
  // Lexical-only hits carry a null score. Fusion is meant to backfill one from
  // the dense side; when it could not, the chunk was never banded and must not
  // be treated as though it had passed.
  assert.equal(productFromKnowledge({ match: null, ambiguous: false }, [chunk({ similarity: null })]), null);
});
