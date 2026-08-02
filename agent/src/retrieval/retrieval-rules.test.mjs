import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANSWERABLE,
  WEAK,
  buildRetrievalQuery,
  categoriesToSearch,
  classifyMatch,
  summariseMatches
} from './retrieval-rules.mjs';

test('a ticket searches its own subject plus faq', () => {
  assert.deepEqual(categoriesToSearch('product'), ['product', 'faq']);
  assert.deepEqual(categoriesToSearch('account'), ['account', 'faq']);
});

test('faq is not duplicated when the subject is already faq', () => {
  assert.deepEqual(categoriesToSearch('faq'), ['faq']);
});

test('a missing subject still searches faq rather than everything', () => {
  // Searching all categories on a null subject would quietly turn a
  // mis-categorised ticket into a library-wide scan.
  assert.deepEqual(categoriesToSearch(null), ['faq']);
  assert.deepEqual(categoriesToSearch('  '), ['faq']);
});

test('brand_story is never searched', () => {
  // It is drafting voice, not an answer — and is never embedded at all.
  for (const subject of ['product', 'account', 'order', null]) {
    assert.ok(!categoriesToSearch(subject).includes('brand_story'), String(subject));
  }
});

// --- the bands ---------------------------------------------------------------

test('the bands match what the corpus actually produced', () => {
  // A genuinely correct match measured 0.62; topics with no article at all
  // still scored 0.38-0.48, so "not zero" means nothing on French support mail.
  assert.equal(classifyMatch(0.62), 'answerable');
  assert.equal(classifyMatch(0.48), 'weak');
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
