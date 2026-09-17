import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseProducts, resolveRequirements } from './advice-collections.mjs';

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

// --- choosing ------------------------------------------------------------------

test('it returns what sits in every named collection', () => {
  const chosen = chooseProducts([SERUMS, RIDES]);
  assert.deepEqual(chosen.products, ['b', 'c']);
  assert.deepEqual(chosen.matchedOn, ['serums-visage', 'diag-rides-et-ridules']);
  assert.deepEqual(chosen.dropped, []);
  assert.equal(chosen.relaxed, false);
});

test('nothing in all three relaxes one, and says which', () => {
  // The reply may then say « pour les rides, en sérum » without also claiming
  // the product treats taches. Silence here would make a 2-of-3 product read
  // exactly like a 3-of-3 one.
  const chosen = chooseProducts([SERUMS, RIDES, TACHES]);
  assert.equal(chosen.relaxed, true);
  assert.deepEqual(chosen.dropped, ['diag-taches']);
  assert.deepEqual(chosen.products, ['b', 'c']);
  assert.deepEqual(chosen.matchedOn, ['serums-visage', 'diag-rides-et-ridules']);
});

test('the broadest concern goes before a narrower one', () => {
  const broad = { handle: 'broad', title: 'Broad', axis: 'concern', productIds: ['p', 'q', 'r', 's'] };
  const narrow = { handle: 'narrow', title: 'Narrow', axis: 'concern', productIds: ['z'] };
  const chosen = chooseProducts([broad, narrow]);
  assert.deepEqual(chosen.dropped, ['broad'], 'the one committing to least is dropped first');
  assert.deepEqual(chosen.products, ['z']);
});

test('the category the customer named survives every concern', () => {
  // « Un sérum pour mes rides » with no anti-wrinkle serum is better answered
  // with a serum than with an anti-wrinkle cream: swapping the form is a
  // different product, where a broader concern still answers the same question.
  const impossible = { handle: 'impossible', title: 'Impossible', axis: 'concern', productIds: ['zz'] };
  const chosen = chooseProducts([SERUMS, impossible]);
  assert.deepEqual(chosen.dropped, ['impossible']);
  assert.deepEqual(chosen.matchedOn, ['serums-visage']);
  assert.deepEqual(chosen.products, ['a', 'b', 'c']);
});

test('one collection alone is not relaxed away into nothing', () => {
  const empty = { handle: 'empty', title: 'Empty', axis: 'concern', productIds: [] };
  const chosen = chooseProducts([empty]);
  assert.deepEqual(chosen.products, []);
  assert.equal(chosen.relaxed, false, 'there was nothing to relax');
  assert.deepEqual(chosen.matchedOn, []);
});

test('no collections at all is an empty answer, not a crash', () => {
  const chosen = chooseProducts([]);
  assert.deepEqual(chosen, { products: [], matchedOn: [], dropped: [], relaxed: false });
});

test('the limit caps how many are put forward', () => {
  // Three is a recommendation; eight is a catalogue page, and the customer is
  // back where they started.
  assert.equal(chooseProducts([RIDES]).products.length, 3);
  assert.equal(chooseProducts([RIDES], { limit: 2 }).products.length, 2);
});

// --- the type of care is what the customer asked for ---------------------------

test('a category is never given up to satisfy two concerns', () => {
  // THE REGRESSION THIS EXISTS FOR. « Une crème pour les mains, j'ai la peau
  // sensible et mature » — no hand cream is in both concerns, but the two
  // concerns overlap on a face serum. Giving up the hand cream to keep them is
  // not a narrower answer, it is the wrong product.
  const mains = { handle: 'cremes-mains', title: 'Crèmes Mains', axis: 'category', productIds: ['h1', 'h2'] };
  const sensible = { handle: 'peaux-sensibles', title: 'Peaux Sensibles', axis: 'concern', productIds: ['h1', 'serum'] };
  const mature = { handle: 'anti-age', title: 'Anti-âge', axis: 'concern', productIds: ['h2', 'serum'] };

  const chosen = chooseProducts([mains, sensible, mature]);
  assert.ok(chosen.matchedOn.includes('cremes-mains'), 'the hand cream was given up');
  assert.ok(!chosen.dropped.includes('cremes-mains'));
  assert.ok(chosen.products.every((id) => mains.productIds.includes(id)), 'a non-hand-cream got through');
});

test('every product put forward is in the type of care that was named', () => {
  const serums = { handle: 'serums', title: 'Sérums', axis: 'category', productIds: ['s1', 's2'] };
  const impossible = { handle: 'impossible', title: 'Impossible', axis: 'concern', productIds: ['x'] };
  const other = { handle: 'other', title: 'Other', axis: 'concern', productIds: ['x'] };

  const chosen = chooseProducts([serums, impossible, other]);
  assert.deepEqual(chosen.matchedOn, ['serums']);
  assert.deepEqual(chosen.products, ['s1', 's2']);
  assert.deepEqual(chosen.dropped.sort(), ['impossible', 'other']);
});

test('two types of care that share nothing is a failure, not a pick', () => {
  // « Un sérum ET une crème » is two answers rather than one product, and this
  // module has no way to say so — so it reports nothing instead of silently
  // dropping one of the two things the customer asked for.
  const serums = { handle: 'serums', title: 'Sérums', axis: 'category', productIds: ['s1'] };
  const cremes = { handle: 'cremes', title: 'Crèmes', axis: 'category', productIds: ['c1'] };

  const chosen = chooseProducts([serums, cremes]);
  assert.deepEqual(chosen.products, []);
  assert.deepEqual(chosen.matchedOn, []);
});

test('with no category at all, concerns relax against each other as before', () => {
  const a = { handle: 'a', title: 'A', axis: 'concern', productIds: ['p', 'q', 'r'] };
  const b = { handle: 'b', title: 'B', axis: 'concern', productIds: ['z'] };
  const chosen = chooseProducts([a, b]);
  assert.equal(chosen.relaxed, true);
  assert.deepEqual(chosen.dropped, ['a'], 'the broadest went first');
  assert.deepEqual(chosen.products, ['z']);
});
