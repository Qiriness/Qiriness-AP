import assert from 'node:assert/strict';
import test from 'node:test';

import { CARE_CUES, careGroupsInText } from './care-cues.mjs';

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
const SOINS_HYDRA = { handle: 'soins-hydratants', title: 'Soins Hydratants', axis: 'category' };
const NETTOYANTS = { handle: 'nettoyants-et-lotions', title: 'Nettoyants & démaquillants', axis: 'category' };
const EXFOLIANTS = { handle: 'exfoliant-lotion-gommage', title: 'Exfoliants & Lotions', axis: 'category' };
const YEUX_LEVRES = { handle: 'soins-yeux-et-levres', title: 'Soins Yeux & Lèvres', axis: 'category' };
const RIDES = { handle: 'diag-rides-et-ridules', title: 'Diag - Rides et ridules', axis: 'concern' };

const ACTIVE = [SERUMS, MAINS, JOUR, HYDRA, SOLAIRE, CONTOUR, PATCHS, RIDES];

const handles = (text, collections = ACTIVE) =>
  careGroupsInText(text, collections).flatMap((g) => g.collections.map((c) => c.handle));
const groups = (text, collections = ACTIVE) =>
  careGroupsInText(text, collections).map((g) => g.collections.map((c) => c.handle));

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

test('a word shared by several collections is one group holding all of them', () => {
  // THE REGRESSION THIS EXISTS FOR (2026-09-19): « nettoyant, hydratant,
  // protection » read as a cleanser alone, because « hydratant » landed on three
  // collections and the first build dropped any word that did. All three are a
  // fair answer to it, and the group is answered as a whole.
  assert.deepEqual(groups('un soin hydratant', [HYDRA, SOINS_HYDRA, MASQUES, SERUMS]), [
    ['cremes-hydratantes', 'soins-hydratants', 'masques-patch']
  ]);
  assert.deepEqual(groups('un masque', [MASQUES, MASQUES_CORPS]), [['masques-patch', 'masques-corps']]);
});

test('bare « crème » is still no cue', () => {
  // It spans day creams, moisturisers and hand creams — a group that wide is a
  // catalogue page, not what the customer asked for.
  assert.deepEqual(handles('je voudrais une crème'), []);
});

test('a routine listed as three words is three groups, in the order written', () => {
  // The ticket that found it: « (nettoyant, hydratant, protection, etc.) ».
  const found = careGroupsInText(
    'quels produits essentiels (nettoyant, hydratant, protection, etc.. ) me conseilleriez-vous',
    [NETTOYANTS, HYDRA, SOINS_HYDRA, SOLAIRE]
  );
  assert.deepEqual(
    found.map((g) => [g.label, g.collections.map((c) => c.handle)]),
    [
      ['nettoyant', ['nettoyants-et-lotions']],
      ['hydratant', ['cremes-hydratantes', 'soins-hydratants']],
      ['protection', ['soins-solaires-et-teintes']]
    ]
  );
});

test('two words naming the same collections are one group', () => {
  // « nettoyant » and « démaquillant » both mean Nettoyants & démaquillants;
  // answering it twice would put the same products forward twice.
  assert.equal(careGroupsInText('un nettoyant démaquillant', [NETTOYANTS]).length, 1);
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

test('several types of care are each their own group', () => {
  const found = groups('un sérum et un contour des yeux');
  assert.ok(found.some((g) => g.length === 1 && g[0] === 'serums-visage'));
  assert.ok(found.some((g) => g.length === 1 && g[0] === 'soins-contour-des-yeux'));
});

test('an empty or missing message is not a match', () => {
  assert.deepEqual(handles(''), []);
  assert.deepEqual(careGroupsInText(null, ACTIVE), []);
  assert.deepEqual(careGroupsInText('un sérum', []), []);
});

test('a gommage reaches the collection the shop calls Exfoliants', () => {
  // THE BUG THIS EXISTS FOR (2026-09-20): the token was « gommage », no active
  // title carries that word, and every cue in the entry reached nothing.
  for (const text of ['je cherche un gommage', 'avez-vous un exfoliant ?', 'pour exfolier ma peau']) {
    assert.deepEqual(handles(text, [EXFOLIANTS, SERUMS]), ['exfoliant-lotion-gommage'], text);
  }
});

test('a lotion tonique and an eau micellaire land where the shop put them', () => {
  assert.deepEqual(handles('une lotion tonique', [EXFOLIANTS, NETTOYANTS]), ['exfoliant-lotion-gommage']);
  assert.deepEqual(handles('une eau micellaire', [EXFOLIANTS, NETTOYANTS]), ['nettoyants-et-lotions']);
});

test('« pour les yeux » is both eye collections, « contour » only the contour', () => {
  assert.deepEqual(handles('un soin pour les yeux', [CONTOUR, YEUX_LEVRES]), [
    'soins-contour-des-yeux',
    'soins-yeux-et-levres'
  ]);
  assert.deepEqual(handles('un contour des yeux', [CONTOUR, YEUX_LEVRES]), ['soins-contour-des-yeux']);
});

test('« mes mains » and a bare « corps » are read like the longer phrases', () => {
  const CORPS = { handle: 'soins-corps', title: 'Soins Corps', axis: 'category' };
  assert.deepEqual(handles('une crème pour mes mains', [MAINS]), ['cremes-mains-hydratation']);
  assert.deepEqual(handles('un soin pour le corps', [CORPS]), ['soins-corps']);
});

test('no two entries claim the same token', () => {
  // Two entries with one token are one group written twice: the second is
  // dropped as a duplicate and its cues silently stop mattering.
  const tokens = CARE_CUES.map((entry) => entry.token);
  assert.equal(new Set(tokens).size, tokens.length);
});

test('dry skin is answered with a moisturiser, not read as a concern', () => {
  // Owner's call (2026-09-20): no concern collection describes dryness here, and
  // the answer to « ma peau tiraille » is the hydrating group.
  for (const text of ['ma peau tiraille', "j'ai la peau très sèche", 'peau déshydratée']) {
    assert.deepEqual(handles(text, [HYDRA, SOINS_HYDRA, SERUMS]), ['cremes-hydratantes', 'soins-hydratants'], text);
  }
});
