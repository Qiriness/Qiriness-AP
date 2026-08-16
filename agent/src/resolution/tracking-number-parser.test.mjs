import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseTrackingNumber,
  parseTrackingCandidates
} from './tracking-number-parser.mjs';

// --- the formats this store actually issues ----------------------------------
// Every number below is a real shape from the corpus (values altered).

test('a Colissimo number is found in ordinary French mail', () => {
  const [candidate] = parseTrackingCandidates(
    "Bonjour, mon colis 6C20723002488 n'est jamais arrivé. Pouvez-vous m'aider ?"
  );
  assert.equal(candidate.trackingNumber, '6C20723002488');
  assert.equal(candidate.carrier, 'colissimo');
});

test('a GLS number is found', () => {
  const [candidate] = parseTrackingCandidates('Le suivi ZWLGF5DA ne bouge plus depuis lundi.');
  assert.equal(candidate.trackingNumber, 'ZWLGF5DA');
  assert.equal(candidate.carrier, 'gls');
});

test('a UPU international number is found', () => {
  const [candidate] = parseTrackingCandidates('Tracking CJ123456789FR please advise');
  assert.equal(candidate.trackingNumber, 'CJ123456789FR');
  assert.equal(candidate.carrier, 'upu');
});

test('a customer typing in lower case is still understood', () => {
  const [candidate] = parseTrackingCandidates('suivi 6c20723002488');
  assert.equal(candidate.trackingNumber, '6C20723002488');
});

// --- what must NOT be proposed -----------------------------------------------

test('an eight-letter French word is not a GLS number', () => {
  // The reason the GLS pattern demands a digit in sixth position: without it,
  // `COMMANDE` is exactly the right shape and every shouted subject line would
  // propose a parcel.
  assert.deepEqual(parseTrackingCandidates('COMMANDE URGENTE'), []);
  assert.deepEqual(parseTrackingCandidates('LIVRAISON'), []);
});

test('the image in an Outlook signature is not a parcel', () => {
  // `image001.png` is embedded in a large share of business mail and `IMAGE001`
  // is exactly the GLS shape. Measured over the inbound corpus, it was the only
  // false candidate the parser produced.
  assert.deepEqual(parseTrackingCandidates('<img src="cid:image001.png@01D9">'), []);
  assert.deepEqual(parseTrackingCandidates('Voir image002.jpg en pièce jointe'), []);
});

test('a sentence ending right after a number is still a number', () => {
  // The file-extension guard must not eat ordinary punctuation.
  const [candidate] = parseTrackingCandidates('Le suivi 6A06497617561. Pouvez-vous vérifier ?');
  assert.equal(candidate.trackingNumber, '6A06497617561');
});

test('an order number is not a tracking number', () => {
  assert.deepEqual(parseTrackingCandidates('Ma commande #6216 est en retard'), []);
});

test('a phone number and a date are not tracking numbers', () => {
  assert.deepEqual(parseTrackingCandidates('Rappelez-moi au 06 12 34 56 78 avant le 12/05/2026'), []);
});

// --- normalisation, which is what makes the lookup match ---------------------

test('punctuation Shopify attaches to a stored number is ignored on both sides', () => {
  // `6A06497617561.` is in this store's data today, trailing dot and all.
  assert.equal(normaliseTrackingNumber('6A06497617561.'), '6A06497617561');
  assert.equal(normaliseTrackingNumber(' 6a06497617561 '), '6A06497617561');
  assert.equal(normaliseTrackingNumber(null), '');
});

test('a number the carrier printed in groups is read as one number', () => {
  const [candidate] = parseTrackingCandidates('Suivi : 6C 2072 3002 488');
  assert.equal(candidate.trackingNumber, '6C20723002488');
});

// --- shape of the output ------------------------------------------------------

test('candidates are distinct and in the order the customer wrote them', () => {
  const candidates = parseTrackingCandidates(
    'Deux colis : ZWLGF5DA et 6C20723002488, et encore ZWLGF5DA.'
  );
  assert.deepEqual(
    candidates.map((c) => c.trackingNumber),
    ['ZWLGF5DA', '6C20723002488']
  );
});

test('the customer’s own spelling is kept for quoting back', () => {
  const [candidate] = parseTrackingCandidates('suivi 6c20723002488');
  assert.equal(candidate.raw, '6c20723002488');
});

test('no text, no candidates', () => {
  assert.deepEqual(parseTrackingCandidates(''), []);
  assert.deepEqual(parseTrackingCandidates(null), []);
});
