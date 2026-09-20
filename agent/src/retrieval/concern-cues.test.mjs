import assert from 'node:assert/strict';
import test from 'node:test';

import { CONCERN_CUES, concernsFromText } from './concern-cues.mjs';

// The shop's real active concern collections, abbreviated.
const SENSIBLES = { handle: 'peaux-sensibles', title: 'Soins Peaux Sensibles', axis: 'concern', productIds: ['s1', 's2'] };
const ROUGEURS = { handle: 'anti-taches-et-anti-rougeurs', title: 'Soins Anti-Taches & Anti-Rougeurs', axis: 'concern', productIds: ['r1'] };
const RIDULES = { handle: 'diag-rides-et-ridules', title: 'Diag - Rides et ridules', axis: 'concern', productIds: ['w1', 'w2'] };
const RIDES_VIS = { handle: 'diag-rides-visibles', title: 'Diag - Rides visibles', axis: 'concern', productIds: ['w2'] };
const ANTI_AGE = { handle: 'diag-anti-age', title: 'Diag - Anti-âge', axis: 'concern', productIds: ['w3'] };
const CERNES = { handle: 'diag-cernes-et-poches', title: 'Diag - Cernes et poches', axis: 'concern', productIds: ['c1'] };
const FATIGUE = { handle: 'anti-fatigue', title: 'Soins Anti-Fatigue', axis: 'concern', productIds: ['f1'] };
const SERUMS = { handle: 'serums-visage', title: 'Sérums Visage', axis: 'category', productIds: ['s1'] };

const ACTIVE = [SENSIBLES, ROUGEURS, RIDULES, RIDES_VIS, ANTI_AGE, CERNES, FATIGUE, SERUMS];

const keys = (text, collections = ACTIVE) => concernsFromText(text, collections).map((c) => c.handle);

test('the words a customer uses for sensitive skin all land', () => {
  // THE TICKET THIS EXISTS FOR (05c1b539): « peau très réactive et sujette aux
  // allergies », where the model named no concern at all and the reply offered
  // a retinol cream.
  for (const text of [
    'ma peau est très réactive',
    'j’ai la peau sensible',
    'je suis sujette aux allergies',
    'ma peau est intolérante à tout'
  ]) {
    assert.deepEqual(keys(text), ['sensitive'], text);
  }
});

test('« insensible » is not « sensible »', () => {
  assert.deepEqual(keys('ma peau est insensible au froid'), []);
});

test('one entry is one concern however many collections it covers', () => {
  // « rides » is three collections here. Counting them separately would make a
  // product in all three outrank one meeting both sensitive skin AND wrinkles,
  // which is the ranking upside down.
  const found = concernsFromText('j’ai des rides et des ridules', ACTIVE);
  assert.equal(found.length, 1);
  assert.equal(found[0].handle, 'ageing');
  assert.deepEqual(found[0].collections, ['diag-rides-et-ridules', 'diag-rides-visibles', 'diag-anti-age']);
  // The products of every collection in the entry, deduplicated.
  assert.deepEqual(found[0].productIds, ['w1', 'w2', 'w3']);
});

test('a multi-collection entry carries its own label, a single one the title', () => {
  // The label is what a product line prints in brackets, and five collection
  // names on one line is noise.
  assert.equal(concernsFromText('des rides', ACTIVE)[0].title, 'rides et anti-âge');
  assert.equal(concernsFromText('peau sensible', ACTIVE)[0].title, 'Soins Peaux Sensibles');
});

test('« anti-âge » reaches a title the bare token could not', () => {
  // « age » is three letters and would match « agenda », so the token is the
  // phrase « anti age » — matched whole against the folded title.
  assert.deepEqual(keys('je cherche un soin anti-âge', [ANTI_AGE]), ['ageing']);
});

test('several concerns in one message are all read', () => {
  const found = keys('j’ai la peau sensible, des cernes et le teint terne');
  assert.deepEqual(found, ['sensitive', 'eye_bags', 'tired']);
});

test('redness is read, because this list is never consulted on a reaction ticket', () => {
  // `recommendProducts` is not in cosmetovigilance's tool list, so a reaction
  // report cannot reach this. Measured before adding it: « rougeur » and
  // « couperose » appear in 0 tickets of the corpus.
  assert.deepEqual(keys('j’ai des rougeurs et de la couperose'), ['redness']);
});

test('a category collection is never a concern', () => {
  assert.deepEqual(keys('je voudrais un sérum', [SERUMS]), []);
});

test('a concern nobody activated is not read', () => {
  // Activating a collection is what makes a word reachable — not an edit here.
  assert.deepEqual(keys('j’ai des taches brunes', [SENSIBLES, CERNES]), []);
  // …and is read as soon as somebody switches a matching collection on.
  assert.deepEqual(keys('j’ai des taches brunes', [ROUGEURS]), ['spots']);
});

test('an empty message reads nothing', () => {
  assert.deepEqual(concernsFromText('', ACTIVE), []);
  assert.deepEqual(concernsFromText(null, ACTIVE), []);
  assert.deepEqual(concernsFromText('peau sensible', []), []);
});

test('no two entries claim the same key', () => {
  const found = CONCERN_CUES.map((entry) => entry.key);
  assert.equal(new Set(found).size, found.length);
});
