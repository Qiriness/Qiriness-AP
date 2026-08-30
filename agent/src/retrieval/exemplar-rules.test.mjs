import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MATCHED,
  NEAR,
  buildExemplarQuery,
  classifyExemplarMatch,
  subjectsToSearch,
  summariseExemplarMatches
} from './exemplar-rules.mjs';

const at = (similarity, exemplarKey = 'P-16') => ({ exemplarKey, similarity });

// --- what to search ----------------------------------------------------------

test('an exemplar search is filtered to the ticket subject alone', () => {
  // The opposite of the knowledge policy, on purpose: an article written under
  // one subject answers another, but a situation does not generalise. « où est
  // ma commande » is never the answer to a promotions question.
  assert.deepEqual(subjectsToSearch('promotions'), ['promotions']);
  assert.deepEqual(subjectsToSearch('product'), ['product']);
});

test('an uncategorised ticket searches everything rather than nothing', () => {
  // No filter is a weaker claim than a wrong one.
  assert.equal(subjectsToSearch(null), null);
  assert.equal(subjectsToSearch('  '), null);
});

// --- the bands ---------------------------------------------------------------

test('the bands are ordered and separate', () => {
  assert.ok(NEAR < MATCHED, 'a near miss must sit below a match');
});

test('a score below the floor is nothing, not a weak match', () => {
  assert.equal(classifyExemplarMatch(NEAR - 0.01), 'none');
  assert.equal(classifyExemplarMatch(0), 'none');
  assert.equal(classifyExemplarMatch(null), 'none');
  assert.equal(classifyExemplarMatch(undefined), 'none');
  assert.equal(classifyExemplarMatch(Number.NaN), 'none');
});

test('the bands are exclusive at their boundaries', () => {
  assert.equal(classifyExemplarMatch(NEAR), 'near');
  assert.equal(classifyExemplarMatch(MATCHED - 0.001), 'near');
  assert.equal(classifyExemplarMatch(MATCHED), 'matched');
});

// --- choosing one, or none ---------------------------------------------------

test('a clear winner above the bar is the match', () => {
  const result = summariseExemplarMatches([at(0.71, 'P-16'), at(0.44, 'P-19')], { minMargin: 0.03 });
  assert.equal(result.matched, true);
  assert.equal(result.verdict, 'matched');
  assert.equal(result.exemplar.exemplarKey, 'P-16');
  assert.equal(result.bestSimilarity, 0.71);
});

test('two situations too close together resolve to ambiguous, not to the higher', () => {
  // At the precision these scores carry, 0.65 vs 0.64 is a tie. Committing to
  // the first would be reading confidence the number does not have — and it is
  // also the signal that two exemplars probably want merging.
  const result = summariseExemplarMatches([at(0.65, 'P-15'), at(0.64, 'P-16')], { minMargin: 0.03 });
  assert.equal(result.matched, false);
  assert.equal(result.verdict, 'ambiguous');
  assert.equal(result.exemplar, null);
  assert.ok(result.margin < 0.03);
});

test('everyone inside the margin is reported as tied, not just the runner-up', () => {
  // `margin` describes the top two and nothing else, so a third candidate can
  // sit inside the margin of the winner while being invisible to it: 0.66 and
  // 0.645 are 0.015 apart and both within 0.03 of 0.67. A caller resolving the
  // tie from the pair would settle a three-way one having seen two of them.
  const result = summariseExemplarMatches(
    [at(0.67, 'A'), at(0.66, 'B'), at(0.645, 'C'), at(0.52, 'D')],
    { minMargin: 0.03 }
  );
  assert.equal(result.verdict, 'ambiguous');
  assert.deepEqual(result.tied.map((m) => m.exemplarKey), ['A', 'B', 'C']);
});

test('a decided match reports no tie at all', () => {
  // Empty rather than "the winner alone": there is nothing here to resolve, and
  // a one-element tie would invite a caller to treat every match as a resolution.
  const result = summariseExemplarMatches([at(0.71, 'P-16'), at(0.44, 'P-19')], { minMargin: 0.03 });
  assert.deepEqual(result.tied, []);
});

test('the margin only bites when the winner already cleared the bar', () => {
  // Two near misses close together are still just near misses; calling that
  // "ambiguous" would imply a choice was available.
  const result = summariseExemplarMatches([at(0.55, 'A'), at(0.545, 'B')], { minMargin: 0.03 });
  assert.equal(result.verdict, 'near');
});

test('a single candidate has no margin and is not penalised for it', () => {
  const result = summariseExemplarMatches([at(0.8)], { minMargin: 0.03 });
  assert.equal(result.margin, null);
  assert.equal(result.matched, true);
});

test('near misses are still reported, because they are the corpus gap', () => {
  const result = summariseExemplarMatches([at(0.55, 'P-16'), at(0.51, 'P-19')]);
  assert.equal(result.matched, false);
  assert.equal(result.verdict, 'near');
  assert.equal(result.exemplar, null, 'a near miss is never acted on');
  assert.equal(result.candidates.length, 2, 'but it is visible');
});

test('nothing at all is a clean empty answer', () => {
  const result = summariseExemplarMatches([]);
  assert.equal(result.matched, false);
  assert.equal(result.verdict, 'none');
  assert.equal(result.bestSimilarity, null);
  assert.deepEqual(result.candidates, []);
});

test('unscored rows cannot become a match', () => {
  const result = summariseExemplarMatches([{ exemplarKey: 'X' }, { exemplarKey: 'Y', similarity: null }]);
  assert.equal(result.verdict, 'none');
  assert.deepEqual(result.candidates, []);
});

test('candidates come back ranked regardless of input order', () => {
  const result = summariseExemplarMatches([at(0.4, 'C'), at(0.9, 'A'), at(0.6, 'B')]);
  assert.deepEqual(result.candidates.map((c) => c.exemplarKey), ['A', 'B', 'C']);
});

test('summarising never throws on missing input', () => {
  assert.equal(summariseExemplarMatches().verdict, 'none');
  assert.equal(summariseExemplarMatches(null).verdict, 'none');
});

// --- the query ---------------------------------------------------------------

test('the query is subject then body, matching how messages were embedded', () => {
  // The stored message vector is only reusable as a query if a freshly composed
  // one would have been identical.
  assert.equal(buildExemplarQuery({ subject: 'Code promo', body: 'WELCOME20 ne marche pas' }),
    'Code promo WELCOME20 ne marche pas');
});

test('the query survives a missing half', () => {
  assert.equal(buildExemplarQuery({ body: 'juste le corps' }), 'juste le corps');
  assert.equal(buildExemplarQuery({ subject: 'juste le sujet' }), 'juste le sujet');
  assert.equal(buildExemplarQuery({}), '');
  assert.equal(buildExemplarQuery(), '');
});

test('a long quoted thread is truncated rather than drowning the question', () => {
  const query = buildExemplarQuery({ subject: 'x', body: 'a'.repeat(5000) }, { maxChars: 100 });
  assert.equal(query.length, 100);
});
