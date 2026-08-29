import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normaliseTrackingNumber,
  splitTrackingText,
  trackingNumbersFromFulfillments
} from './tracking-number.mjs';

const COLISSIMO = { number: '6C20723002488', carrier: 'COLISSIMO', url: 'https://laposte.fr/6C20723002488' };
const GLS = { number: 'ZWLGF5DA', carrier: 'GLS', url: 'https://gls.fr/ZWLGF5DA' };

/** The linked spans only, which is what every caller of this actually renders. */
const links = (segments) => segments.filter((s) => s.url);

test('the normaliser strips exactly what the linker allows between characters', () => {
  // These two must agree or a number stored one way never matches the same
  // number typed the other way — a lookup that silently returns nothing.
  assert.equal(normaliseTrackingNumber(' 6c-2072.3002 488 '), '6C20723002488');
  assert.deepEqual(
    links(splitTrackingText('Colis 6c-2072.3002 488 parti', [COLISSIMO])).map((s) => s.number),
    ['6C20723002488']
  );
});

test('a number printed in groups is one link, keeping the spelling it was written in', () => {
  // Colissimo prints `6C 2072 3002 488`; Shopify stores it compact. The link
  // must survive the difference and still show the customer their own text.
  const segments = splitTrackingText('Suivi : 6C 2072 3002 488 (COLISSIMO).', [COLISSIMO]);
  assert.deepEqual(segments.map((s) => s.text), ['Suivi : ', '6C 2072 3002 488', ' (COLISSIMO).']);
  assert.equal(segments[1].url, COLISSIMO.url);
  assert.equal(segments[1].number, '6C20723002488');
  assert.equal(segments[1].carrier, 'COLISSIMO');
});

test('a non-breaking space between groups still links', () => {
  // Mail bodies arrive via htmlToText, which leaves U+00A0 where the HTML had
  // `&nbsp;`. A literal-space class would silently stop matching there.
  const segments = splitTrackingText('Suivi : 6C 2072 3002 488', [COLISSIMO]);
  assert.equal(links(segments).length, 1);
});

test('a parcel with no URL is left as plain text, never guessed at', () => {
  const segments = splitTrackingText('Votre colis ZWLGF5DA est parti.', [{ ...GLS, url: null }]);
  assert.deepEqual(segments, [{ text: 'Votre colis ZWLGF5DA est parti.' }]);
});

test('only the parcels this ticket holds are linked', () => {
  // The whole safety property: a tracking-number-shaped string we hold no URL
  // for is text. Nothing infers a carrier from the number's shape.
  const segments = splitTrackingText('Colis 6A06497617561 et 6C20723002488.', [COLISSIMO]);
  assert.deepEqual(links(segments).map((s) => s.text), ['6C20723002488']);
});

test('two parcels in one sentence each get their own link', () => {
  const segments = splitTrackingText('Colis 6C20723002488 puis ZWLGF5DA.', [COLISSIMO, GLS]);
  assert.deepEqual(links(segments).map((s) => s.text), ['6C20723002488', 'ZWLGF5DA']);
});

test('the same number twice is linked twice', () => {
  const segments = splitTrackingText('6C20723002488 — oui, 6C20723002488.', [COLISSIMO]);
  assert.equal(links(segments).length, 2);
});

test('a number glued inside a longer token is not a match', () => {
  // `\b` is what stops this. A filename or a longer reference that happens to
  // contain the digits is not the parcel.
  const segments = splitTrackingText('ref X6C20723002488Y', [COLISSIMO]);
  assert.deepEqual(segments, [{ text: 'ref X6C20723002488Y' }]);
});

test('matching is case-insensitive, because customers type in lower case', () => {
  const segments = splitTrackingText('suivi 6c20723002488', [COLISSIMO]);
  assert.equal(links(segments).length, 1);
});

test('a trailing full stop is not swallowed into the link', () => {
  // Shopify hands back `6A06497617561.` and customers end sentences. The link
  // must cover the number and stop there.
  const segments = splitTrackingText('Colis 6C20723002488.', [COLISSIMO]);
  assert.equal(links(segments)[0].text, '6C20723002488');
  assert.equal(segments[segments.length - 1].text, '.');
});

test('no parcels, no text, and rubbish input all return something renderable', () => {
  assert.deepEqual(splitTrackingText('Bonjour', []), [{ text: 'Bonjour' }]);
  assert.deepEqual(splitTrackingText('', [COLISSIMO]), []);
  assert.deepEqual(splitTrackingText(null, null), []);
  assert.deepEqual(splitTrackingText('x', [{ number: null, url: null }]), [{ text: 'x' }]);
});

test('duplicate parcels do not produce duplicate spans', () => {
  const segments = splitTrackingText('Colis 6C20723002488.', [COLISSIMO, { ...COLISSIMO }]);
  assert.equal(links(segments).length, 1);
});

test('the segments always rebuild the original text exactly', () => {
  // The property that matters for a renderer: splitting must not lose or move a
  // character, or a body would render subtly different from what was stored.
  const source = 'Bonjour,\n\nSuivi : 6C 2072 3002 488 et ZWLGF5DA.\n\nMerci';
  const segments = splitTrackingText(source, [COLISSIMO, GLS]);
  assert.equal(segments.map((s) => s.text).join(''), source);
});

test('fulfilment extraction is unchanged by any of this', () => {
  assert.deepEqual(
    trackingNumbersFromFulfillments([{ tracking_info: [{ number: '6c 2072 3002 488' }] }]),
    ['6C20723002488']
  );
});
