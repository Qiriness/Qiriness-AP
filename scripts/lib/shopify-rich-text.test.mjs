import assert from 'node:assert/strict';
import test from 'node:test';

import { flattenRichText } from './shopify-rich-text.mjs';

// Verbatim from a real product_faqs[].answer: rich-text JSON stored as a string.
const REAL_FAQ_ANSWER =
  '{"type":"root","children":[{"type":"paragraph","children":[' +
  '{"type":"text","value":"Après l\u2019application, le contour des yeux paraît "},' +
  '{"type":"text","value":"plus hydraté, plus lisse et plus lumineux","bold":true},' +
  '{"type":"text","value":". Le regard semble reposé."}]}]}';

test('a real stored answer becomes readable text, not escaped JSON', () => {
  const text = flattenRichText(REAL_FAQ_ANSWER);
  assert.equal(text, 'Après l’application, le contour des yeux paraît plus hydraté, plus lisse et plus lumineux. Le regard semble reposé.');
  assert.doesNotMatch(text, /[{}]|"type"/);
});

test('bold and italic markers are dropped rather than turned into asterisks', () => {
  // The consumer is a model reading for meaning; ** costs tokens and adds none.
  assert.doesNotMatch(flattenRichText(REAL_FAQ_ANSWER), /\*/);
});

test('lists become readable lines', () => {
  const doc = { type: 'root', children: [
    { type: 'list', children: [
      { type: 'list-item', children: [{ type: 'text', value: 'Aloe vera' }] },
      { type: 'list-item', children: [{ type: 'text', value: 'Niacinamide' }] }
    ] }
  ] };
  assert.equal(flattenRichText(doc), '- Aloe vera\n- Niacinamide');
});

test('paragraphs are separated, so three ingredients do not read as one sentence', () => {
  const doc = { type: 'root', children: [
    { type: 'paragraph', children: [{ type: 'text', value: 'Un.' }] },
    { type: 'paragraph', children: [{ type: 'text', value: 'Deux.' }] }
  ] };
  assert.equal(flattenRichText(doc), 'Un.\n\nDeux.');
});

test('a link keeps its words and drops the URL', () => {
  const doc = { type: 'root', children: [
    { type: 'paragraph', children: [
      { type: 'link', url: 'https://example.test', children: [{ type: 'text', value: 'notre guide' }] }
    ] }
  ] };
  assert.equal(flattenRichText(doc), 'notre guide');
});

test('plain text passes straight through', () => {
  assert.equal(flattenRichText('Appliquer matin et soir.'), 'Appliquer matin et soir.');
});

test('malformed input degrades instead of throwing', () => {
  // This runs over live merchandising data that nobody validates for us.
  assert.equal(flattenRichText('{not json'), '{not json');
  assert.equal(flattenRichText(null), '');
  assert.equal(flattenRichText(undefined), '');
  assert.equal(flattenRichText(''), '');
  assert.equal(flattenRichText({ type: 'unknown-node' }), '');
});

test('an unknown node type still yields its children', () => {
  const doc = { type: 'root', children: [
    { type: 'callout', children: [{ type: 'text', value: 'Attention' }] }
  ] };
  assert.equal(flattenRichText(doc), 'Attention');
});
