import assert from 'node:assert/strict';
import test from 'node:test';

import { bestTier, careGroups, rankGroup, resolveRequirements } from './advice-collections.mjs';

const SERUMS = { handle: 'serums-visage', title: 'Sérums Visage', axis: 'category', productIds: ['a', 'b', 'c'] };
const RIDES = {
  handle: 'diag-rides-et-ridules',
  title: 'Diag - Rides et ridules',
  axis: 'concern',
  productIds: ['b', 'c', 'd', 'e', 'f']
};
const TACHES = { handle: 'diag-taches', title: 'Diag - Taches', axis: 'concern', productIds: ['x', 'y'] };
const ACTIVE = [SERUMS, RIDES, TACHES];

// --- naming a requirement ------------------------------------------------------

test('a requirement resolves by title or by handle, folded', () => {
  // The model is shown the activated titles, so both spellings have to land —
  // and « serums visage » must find « Sérums Visage », because a French
  // catalogue typed quickly loses its accents.
  for (const named of ['Sérums Visage', 'serums-visage', 'serums visage', 'SERUMS VISAGE']) {
    const { matched } = resolveRequirements([named], ACTIVE);
    assert.deepEqual(matched.map((c) => c.handle), ['serums-visage'], named);
  }
});

test('a requirement matching nothing is reported, never dropped in silence', () => {
  // It is the signal that the customer asked for something nobody curated. A
  // reply that ignored it would answer a question they did not ask.
  const { matched, unknown } = resolveRequirements(['Sérums Visage', 'Soins Solaires'], ACTIVE);
  assert.deepEqual(matched.map((c) => c.handle), ['serums-visage']);
  assert.deepEqual(unknown, ['Soins Solaires']);
});

test('a collection the team never activated cannot be reached', () => {
  // `is_active` is the only gate there is, so this is the assertion that keeps
  // Black Friday out of a recommendation.
  const { matched, unknown } = resolveRequirements(['black-friday'], ACTIVE);
  assert.deepEqual(matched, []);
  assert.deepEqual(unknown, ['black-friday']);
});

test('the same collection named twice counts once', () => {
  const { matched } = resolveRequirements(['Sérums Visage', 'serums-visage'], ACTIVE);
  assert.equal(matched.length, 1);
});

// --- grouping ------------------------------------------------------------------

test('each type of care is its own group, and the concerns stay beside them', () => {
  const cremes = { handle: 'cremes', title: 'Crèmes', axis: 'category', productIds: ['c1'] };
  const { groups, concerns } = careGroups([{ label: 'sérum', collections: [SERUMS] }], [cremes, RIDES]);
  assert.deepEqual(
    groups.map((g) => [g.label, g.collections.map((c) => c.handle)]),
    [
      ['sérum', ['serums-visage']],
      ['Crèmes', ['cremes']]
    ]
  );
  assert.deepEqual(concerns.map((c) => c.handle), ['diag-rides-et-ridules']);
});

test('a category the cues already hold is not a second group', () => {
  const { groups } = careGroups([{ label: 'sérum', collections: [SERUMS] }], [SERUMS]);
  assert.equal(groups.length, 1);
});

test('with no type of care, the concerns are the pool', () => {
  // « Quoi pour mes rides ? » is still answerable: from the rides collection.
  const { groups } = careGroups([], [RIDES]);
  assert.deepEqual(groups, [{ label: null, collections: [RIDES] }]);
});

test('nothing named is nothing to group', () => {
  assert.deepEqual(careGroups([], []), { groups: [], concerns: [] });
});

// --- ranking inside a group --------------------------------------------------------

test('products meeting the concern come first; the rest are kept behind them', () => {
  const ranked = rankGroup([SERUMS], [RIDES]);
  assert.deepEqual(ranked.map((r) => r.id), ['b', 'c', 'a']);
  assert.deepEqual(ranked[0].meets, ['diag-rides-et-ridules']);
  assert.deepEqual(ranked[2].meets, []);
});

test('a concern nothing meets does not lose the group', () => {
  // THE REGRESSION THIS EXISTS FOR. The intersection gave up whichever side
  // stood in the way; now the type of care is always answered and the concern
  // only orders it. The caller reports the concern as unmet.
  const ranked = rankGroup([SERUMS], [TACHES]);
  assert.deepEqual(ranked.map((r) => r.id), ['a', 'b', 'c']);
  assert.ok(ranked.every((r) => r.meets.length === 0));
});

test('meeting more concerns beats meeting a narrower one', () => {
  const pool = { handle: 'p', title: 'P', axis: 'category', productIds: ['one', 'both'] };
  const x = { handle: 'x', title: 'X', axis: 'concern', productIds: ['one'] };
  const y = { handle: 'y', title: 'Y', axis: 'concern', productIds: ['both', 'q', 'r'] };
  const z = { handle: 'z', title: 'Z', axis: 'concern', productIds: ['both', 's', 't'] };
  assert.deepEqual(rankGroup([pool], [x, y, z]).map((r) => r.id), ['both', 'one']);
});

test('at equal count the narrower selection leads', () => {
  // A product in a 3-product selection says more than one in a 50-product one.
  const pool = { handle: 'p', title: 'P', axis: 'category', productIds: ['broad', 'narrow'] };
  const broad = { handle: 'broad', title: 'Broad', axis: 'concern', productIds: ['broad', 'q', 'r', 's'] };
  const narrow = { handle: 'narrow', title: 'Narrow', axis: 'concern', productIds: ['narrow'] };
  assert.deepEqual(rankGroup([pool], [broad, narrow]).map((r) => r.id), ['narrow', 'broad']);
});

test('a group spanning several collections is one pool, without duplicates', () => {
  const cremes = { handle: 'cremes-hydratantes', title: 'Crèmes Hydratantes', axis: 'category', productIds: ['h1', 'h2'] };
  const soins = { handle: 'soins-hydratants', title: 'Soins Hydratants', axis: 'category', productIds: ['h2', 'h3'] };
  const sensible = { handle: 'peaux-sensibles', title: 'Soins Peaux Sensibles', axis: 'concern', productIds: ['h3'] };
  assert.deepEqual(rankGroup([cremes, soins], [sensible]).map((r) => r.id), ['h3', 'h1', 'h2']);
});

test('what an earlier group put forward is not offered again', () => {
  assert.deepEqual(rankGroup([SERUMS], [], { exclude: new Set(['a']) }).map((r) => r.id), ['b', 'c']);
});

// --- the best tier -------------------------------------------------------------------

test('only the best tier is put forward', () => {
  // Two moisturisers in the sensitive-skin selection: a third that is not has
  // no business beside them in a reply to somebody with allergies.
  const ranked = rankGroup([SERUMS], [RIDES]);
  assert.deepEqual(bestTier(ranked).map((r) => r.id), ['b', 'c']);
});

test('with nothing meeting a concern, plain members of the type are the tier', () => {
  const ranked = rankGroup([SERUMS], [TACHES]);
  assert.deepEqual(bestTier(ranked, { limit: 2 }).map((r) => r.id), ['a', 'b']);
});

test('a tick reorders within the tier and never lifts a product into it', () => {
  const ranked = rankGroup([SERUMS], [RIDES]);
  const ticked = (id) => (entry) => entry.id === id;
  assert.deepEqual(bestTier(ranked, { isPreferred: ticked('c') }).map((r) => r.id), ['c', 'b']);
  assert.deepEqual(bestTier(ranked, { isPreferred: ticked('a') }).map((r) => r.id), ['b', 'c']);
});

test('an empty group is an empty answer, not a crash', () => {
  assert.deepEqual(bestTier([]), []);
  assert.deepEqual(rankGroup([], [RIDES]), []);
});
