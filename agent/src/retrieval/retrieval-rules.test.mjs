import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANSWERABLE,
  WEAK,
  buildRetrievalQuery,
  categoriesToSearch,
  classifyMatch,
  fuseByRank,
  summariseMatches
} from './retrieval-rules.mjs';

test('a ticket searches its own subject plus faq', () => {
  assert.deepEqual(categoriesToSearch('product'), ['product', 'faq', 'brand_story']);
  assert.deepEqual(categoriesToSearch('account'), ['account', 'faq', 'brand_story']);
});

test('the always-searched categories are not duplicated when they ARE the subject', () => {
  assert.deepEqual(categoriesToSearch('faq'), ['faq', 'brand_story']);
  assert.deepEqual(categoriesToSearch('brand_story'), ['faq', 'brand_story']);
});

test('a missing subject still searches faq rather than everything', () => {
  // Searching all categories on a null subject would quietly turn a
  // mis-categorised ticket into a library-wide scan.
  assert.deepEqual(categoriesToSearch(null), ['faq', 'brand_story']);
  assert.deepEqual(categoriesToSearch('  '), ['faq', 'brand_story']);
});

test('brand_story IS searched — the old rule confused two different things', () => {
  // The concern was always the drafting VOICE: the singleton core_topic =
  // 'brand' row, which is correctly never chunked or embedded. The brand_story
  // CATEGORY is ordinary knowledge that answers real customer questions, and
  // its chunks were being embedded all along — excluding it from search just
  // made 9 existing vectors permanently unreachable.
  for (const subject of ['product', 'account', 'order', null]) {
    assert.ok(categoriesToSearch(subject).includes('brand_story'), String(subject));
  }
});

test('the brand VOICE row stays unsearchable, because it is never chunked', () => {
  // The gate that matters is core_topic !== 'brand' in the embedding pipeline,
  // not the category. Asserted so the two are not conflated again.
  assert.ok(!categoriesToSearch('product').includes('brand'));
});

// --- the bands ---------------------------------------------------------------

test('the bands match what the corpus actually produced', () => {
  // Re-derived on a 61-chunk library: relevant chunks ran 0.30-0.66 (median
  // 0.517), irrelevant 0.17-0.578 (median 0.424, p75 0.458). The floor sits
  // above that p75 so the bulk of the noise never reaches a model.
  assert.equal(classifyMatch(0.62), 'answerable');
  assert.equal(classifyMatch(0.52), 'weak');
  // 0.458 was the irrelevant p75 — a quarter of the noise used to clear the
  // old 0.45 floor and be shown as context.
  assert.equal(classifyMatch(0.458), 'none');
  assert.equal(classifyMatch(0.38), 'none');
});

test('the band boundaries are inclusive at the bar', () => {
  assert.equal(classifyMatch(ANSWERABLE), 'answerable');
  assert.equal(classifyMatch(WEAK), 'weak');
  assert.equal(classifyMatch(WEAK - 0.001), 'none');
});

test('a missing or broken score is never answerable', () => {
  for (const value of [undefined, null, NaN, 'x']) {
    assert.equal(classifyMatch(value), 'none', String(value));
  }
});

// --- summarising -------------------------------------------------------------

const M = (similarity, id) => ({ similarity, chunkId: id, text: `chunk ${id}` });

test('answerable follows the best match, not the crowd', () => {
  // Three weak chunks are not evidence; averaging would let them outvote the
  // absence of a real match.
  const weakPile = summariseMatches([M(0.5, 'a'), M(0.52, 'b'), M(0.49, 'c')]);
  assert.equal(weakPile.answerable, false);
  assert.equal(weakPile.verdict, 'weak');

  const oneGood = summariseMatches([M(0.5, 'a'), M(0.71, 'b')]);
  assert.equal(oneGood.answerable, true);
  assert.equal(oneGood.chunks[0].chunkId, 'b', 'best first');
});

test('chunks below the floor are dropped, not merely ranked last', () => {
  // Passing a `none`-band chunk as context invites the model to answer from it.
  const result = summariseMatches([M(0.7, 'good'), M(0.2, 'noise')]);
  assert.deepEqual(result.chunks.map((c) => c.chunkId), ['good']);
});

test('the number of chunks returned is capped', () => {
  const many = [M(0.9, 'a'), M(0.88, 'b'), M(0.86, 'c'), M(0.84, 'd')];
  assert.equal(summariseMatches(many, { limit: 2 }).chunks.length, 2);
});

test('no matches is a clean, honest result rather than a throw', () => {
  for (const input of [[], null, undefined]) {
    const result = summariseMatches(input);
    assert.deepEqual(result, { answerable: false, verdict: 'none', bestSimilarity: null, chunks: [] });
  }
});

test('malformed rows are ignored instead of poisoning the ranking', () => {
  const result = summariseMatches([{ chunkId: 'bad' }, M(0.8, 'good')]);
  assert.equal(result.chunks.length, 1);
  assert.equal(result.bestSimilarity, 0.8);
});

// --- the query ---------------------------------------------------------------

test('the query is subject plus body, matching how messages were embedded', () => {
  // Composing the query differently from the stored vectors would compare two
  // different things.
  const q = buildRetrievalQuery({ subject: 'Masque LED', body: 'Est-il compatible ?' });
  assert.equal(q, 'Masque LED Est-il compatible ?');
});

test('whitespace is flattened and a long thread is truncated', () => {
  const q = buildRetrievalQuery({ subject: 'S', body: 'x'.repeat(5000) }, { maxChars: 100 });
  assert.equal(q.length, 100);
  assert.doesNotMatch(buildRetrievalQuery({ subject: 'a\n\n  b', body: '' }), /\n/);
});

test('an empty ticket produces an empty query the caller can short-circuit on', () => {
  assert.equal(buildRetrievalQuery({}), '');
  assert.equal(buildRetrievalQuery({ subject: '   ', body: null }), '');
});

// --- hybrid fusion -----------------------------------------------------------

test('a chunk found by BOTH retrievers outranks one found by either alone', () => {
  // The property that makes fusion worth doing: agreement between two different
  // notions of relevance is the strongest signal either can give.
  const dense = [{ chunkId: 'a', similarity: 0.52 }, { chunkId: 'b', similarity: 0.58 }];
  const lexical = [{ chunkId: 'a' }, { chunkId: 'c' }];

  const fused = fuseByRank([dense, lexical]);
  assert.equal(fused[0].chunkId, 'a', 'found by both, despite ranking below b on cosine');
  assert.equal(fused[0].foundBy, 2);
});

test('fusion is rank-based, so the two incomparable score scales never mix', () => {
  // Cosine sits at 0.45-0.60 here while ts_rank_cd runs 0.1-4.6. Normalising
  // them would invent a relationship that does not exist.
  const dense = [{ chunkId: 'a', similarity: 0.46 }];
  const lexical = [{ chunkId: 'b', rank: 4.6 }];

  const fused = fuseByRank([dense, lexical]);
  assert.equal(fused.length, 2);
  // Both were rank 1 in their own list, so neither wins on score magnitude.
  assert.equal(fused[0].fusedScore, fused[1].fusedScore);
});

test('rank order within a list is preserved', () => {
  const dense = [{ chunkId: 'a' }, { chunkId: 'b' }, { chunkId: 'c' }];
  const fused = fuseByRank([dense]);
  assert.deepEqual(fused.map((f) => f.chunkId), ['a', 'b', 'c']);
});

test('a dense similarity survives fusion even when the lexical copy has none', () => {
  // The bands are still read off cosine, so the score must not be lost just
  // because the same chunk also arrived from the lexical side.
  const fused = fuseByRank([[{ chunkId: 'a' }], [{ chunkId: 'a', similarity: 0.57 }]]);
  assert.equal(fused[0].similarity, 0.57);
});

test('a lexical-only chunk carries a null similarity rather than a fake one', () => {
  // Inventing a cosine score for something the dense search never returned
  // would let it clear a band it was never measured against.
  const fused = fuseByRank([[], [{ chunkId: 'x' }]]);
  assert.equal(fused[0].similarity, null);
});

test('empty and missing lists are handled without special-casing at the call site', () => {
  assert.deepEqual(fuseByRank([]), []);
  assert.deepEqual(fuseByRank([[], null, undefined]), []);
});

test('items without a chunkId are dropped rather than colliding', () => {
  const fused = fuseByRank([[{ similarity: 0.9 }, { chunkId: 'a' }]]);
  assert.deepEqual(fused.map((f) => f.chunkId), ['a']);
});
