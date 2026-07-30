import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clusterByAverageLink,
  dedupeNearIdentical,
  normalise,
  parseVector,
  cosine
} from './cluster-messages.mjs';

/** A 2-D unit vector at `deg` degrees — easy to reason about by hand. */
function at(deg, id) {
  const rad = (deg * Math.PI) / 180;
  return { id, vector: [Math.cos(rad), Math.sin(rad)] };
}

test('groups vectors that point the same way, separates those that do not', () => {
  const items = [at(0, 'a1'), at(4, 'a2'), at(8, 'a3'), at(90, 'b1'), at(94, 'b2')];
  const groups = clusterByAverageLink(items, { threshold: 0.9 });

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].members.map((m) => m.id).sort(), ['a1', 'a2', 'a3']);
  assert.deepEqual(groups[1].members.map((m) => m.id).sort(), ['b1', 'b2']);
});

test('average-link resists the chaining that breaks single-link', () => {
  // A—B and B—C are each close, but A—C is far. Single-link would merge all
  // three (it did exactly this on the real corpus: 52 of 55 in one blob);
  // average-link must not, because C does not resemble the {A,B} group as a whole.
  const items = [at(0, 'a'), at(25, 'b'), at(50, 'c')];
  const groups = clusterByAverageLink(items, { threshold: 0.9, minSize: 1 });
  const sizes = groups.map((g) => g.distinct).sort();
  assert.notDeepEqual(sizes, [3], 'all three should not collapse into one group');
});

test('the medoid is the member most typical of its group', () => {
  // The middle vector is closest to both others, so it represents them.
  const items = [at(0, 'edge-low'), at(10, 'middle'), at(20, 'edge-high')];
  const [group] = clusterByAverageLink(items, { threshold: 0.9 });
  assert.equal(group.medoid.id, 'middle');
});

test('groups are returned largest first', () => {
  const items = [at(0, 'a1'), at(3, 'a2'), at(6, 'a3'), at(90, 'b1'), at(93, 'b2')];
  const groups = clusterByAverageLink(items, { threshold: 0.9 });
  assert.ok(groups[0].size >= groups[1].size);
});

test('minSize hides singletons by default', () => {
  const items = [at(0, 'pair1'), at(3, 'pair2'), at(90, 'loner')];
  assert.equal(clusterByAverageLink(items, { threshold: 0.9 }).length, 1);
  assert.equal(clusterByAverageLink(items, { threshold: 0.9, minSize: 1 }).length, 2);
});

test('a higher threshold splits, a lower one merges', () => {
  const items = [at(0, 'a'), at(20, 'b'), at(40, 'c')];
  const loose = clusterByAverageLink(items, { threshold: 0.6, minSize: 1 });
  const tight = clusterByAverageLink(items, { threshold: 0.99, minSize: 1 });
  assert.ok(tight.length > loose.length);
});

test('weight reports how tight a group is', () => {
  const tightGroup = clusterByAverageLink([at(0, 'a'), at(1, 'b')], { threshold: 0.9 });
  const looseGroup = clusterByAverageLink([at(0, 'a'), at(24, 'b')], { threshold: 0.9 });
  assert.ok(tightGroup[0].weight > looseGroup[0].weight);
});

// --- deduplication -----------------------------------------------------------

test('near-identical messages collapse to one, carrying their count', () => {
  // A resend or a self-quoting thread would otherwise form a perfect cluster
  // that looks like demand — on the real corpus a "group of 5" was one message
  // sent five times.
  const items = [at(0, 'original'), at(0.2, 'resend'), at(0.3, 'resend2'), at(90, 'other')];
  const deduped = dedupeNearIdentical(items, { threshold: 0.97 });

  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].id, 'original');
  assert.equal(deduped[0].duplicates, 2);
  assert.deepEqual(deduped[0].duplicateIds, ['resend', 'resend2']);
  assert.equal(deduped[1].duplicates, 0);
});

test('duplicates still count towards group size, so demand stays honest', () => {
  // `b` sits at 20 degrees: similar enough to cluster with `a` (cos 20 ~ 0.94,
  // above the 0.9 cluster threshold) but far enough not to be read as a copy of
  // it (below the 0.97 dedup threshold).
  const items = [at(0, 'a'), at(0.1, 'a-copy'), at(20, 'b')];
  const deduped = dedupeNearIdentical(items, { threshold: 0.97 });
  const [group] = clusterByAverageLink(deduped, { threshold: 0.9 });

  // Two distinct messages survive clustering...
  assert.equal(group.distinct, 2);
  // ... but they stand for three actual emails.
  assert.equal(group.size, 3);
});

test('genuinely different messages are never deduped', () => {
  const items = [at(0, 'a'), at(30, 'b')];
  assert.equal(dedupeNearIdentical(items, { threshold: 0.97 }).length, 2);
});

// --- vector plumbing ---------------------------------------------------------

test('pgvector text literals are parsed', () => {
  assert.deepEqual(parseVector('[0.1,0.2,0.3]'), [0.1, 0.2, 0.3]);
  assert.deepEqual(parseVector([1, 2]), [1, 2]);
  assert.deepEqual(parseVector(''), []);
  assert.deepEqual(parseVector(null), []);
});

test('vectors are unit-normalised so a dot product is the cosine', () => {
  const unit = normalise([3, 4]);
  assert.ok(Math.abs(Math.hypot(...unit) - 1) < 1e-12);
  // Scale must not change similarity.
  assert.ok(Math.abs(cosine([1, 0], [5, 0]) - 1) < 1e-12);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-12);
});

test('a zero vector does not produce NaN', () => {
  assert.deepEqual(normalise([0, 0]), [0, 0]);
  assert.equal(Number.isNaN(cosine([0, 0], [1, 0])), false);
});

test('clustering an empty or single-item set does not throw', () => {
  assert.deepEqual(clusterByAverageLink([], { threshold: 0.9 }), []);
  assert.deepEqual(clusterByAverageLink([at(0, 'only')], { threshold: 0.9 }), []);
  assert.equal(clusterByAverageLink([at(0, 'only')], { threshold: 0.9, minSize: 1 }).length, 1);
});
