import assert from 'node:assert/strict';
import test from 'node:test';

import { careCollectionsInText } from './care-cues.mjs';

// The shop's real active categories, abbreviated — the ambiguity below is real.
const SERUMS = { handle: 'serums-visage', title: 'Sérums Visage', axis: 'category' };
const MAINS = { handle: 'cremes-mains-hydratation', title: 'Crèmes Mains', axis: 'category' };
const JOUR = { handle: 'cremes-de-jour', title: 'Crèmes de Jour', axis: 'category' };
const HYDRA = { handle: 'cremes-hydratantes', title: 'Crèmes Hydratantes', axis: 'category' };
const SOLAIRE = { handle: 'soins-solaires-et-teintes', title: 'Soins solaires et teintés', axis: 'category' };
const CONTOUR = { handle: 'soins-contour-des-yeux', title: 'Soins Contour des Yeux', axis: 'category' };
const PATCHS = { handle: 'patchs-visage', title: 'Patchs visage', axis: 'category' };
const MASQUES = { handle: 'masques-patch', title: 'Masques hydratants', axis: 'category' };
const MASQUES_CORPS = { handle: 'masques-corps', title: 'Masques et crème Corps', axis: 'category' };
const RIDES = { handle: 'diag-rides-et-ridules', title: 'Diag - Rides et ridules', axis: 'concern' };

const ACTIVE = [SERUMS, MAINS, JOUR, HYDRA, SOLAIRE, CONTOUR, PATCHS, RIDES];

const handles = (text, collections = ACTIVE) =>
  careCollectionsInText(text, collections).map((c) => c.handle);

test('the word the customer used finds the collection', () => {
  assert.deepEqual(handles("Je voudrais un sérum pour mon visage"), ['serums-visage']);
  assert.deepEqual(handles("auriez-vous une creme pour les mains ?"), ['cremes-mains-hydratation']);
  assert.deepEqual(handles("je cherche un patch pour les yeux"), ['patchs-visage']);
});

test('plurals and accents do not matter', () => {
  // A prefix match, which is French plurals and nothing cleverer.
  for (const text of ['un serum', 'des sérums', 'DES SERUMS', 'un Sérum']) {
    assert.deepEqual(handles(text), ['serums-visage'], text);
  }
});

test('a synonym reaches a collection whose title does not contain it', () => {
  // « SPF » is what a customer writes; « Soins solaires et teintés » is what the
  // shop called it. The cue bridges the two — that is the whole reason cues are
  // words rather than titles.
  assert.deepEqual(handles('avez-vous un SPF 50 ?'), ['soins-solaires-et-teintes']);
  assert.deepEqual(handles('une protection solaire'), ['soins-solaires-et-teintes']);
});

test('a longer phrase beats the bare word it contains', () => {
  // « crème pour les mains » must not read as the bare « crème », which names
  // nothing on its own.
  assert.deepEqual(handles('je cherche une crème pour les mains'), ['cremes-mains-hydratation']);
});

test('an ambiguous word names nothing rather than guessing', () => {
  // « une crème » is Crèmes de Jour, Crèmes Hydratantes and Crèmes Mains here.
  // Choosing one of three would be inventing the half the customer did not say.
  assert.deepEqual(handles('je voudrais une crème'), []);
  // Same for « masque » once both masque collections are live.
  assert.deepEqual(handles('un masque', [MASQUES, MASQUES_CORPS]), []);
  assert.deepEqual(handles('un masque', [MASQUES]), ['masques-patch']);
});

test('only category collections are reachable', () => {
  // A concern is what the model reads; this reads the form. « rides » must not
  // resolve here even though a live collection is named for it.
  assert.deepEqual(handles('j’ai des rides et des ridules'), []);
});

test('a cue whose collection is not active finds nothing', () => {
  // Activating a collection is what makes a cue reachable — not an edit here.
  assert.deepEqual(handles('je voudrais un sérum', [MAINS, JOUR]), []);
});

test('whole words only', () => {
  // « insensible » must not contain « sensible », and « seruminal » is not a serum.
  assert.deepEqual(handles('un produit seruminal'), []);
});

test('several types of care are all reported', () => {
  const found = handles('un sérum et un contour des yeux');
  assert.ok(found.includes('serums-visage'));
  assert.ok(found.includes('soins-contour-des-yeux'));
});

test('an empty or missing message is not a match', () => {
  assert.deepEqual(handles(''), []);
  assert.deepEqual(careCollectionsInText(null, ACTIVE), []);
  assert.deepEqual(careCollectionsInText('un sérum', []), []);
});
