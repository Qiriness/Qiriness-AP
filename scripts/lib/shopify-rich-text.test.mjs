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

const linkTo = (url, label) => ({
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'link', url, children: [{ type: 'text', value: label }] }] }]
});

test('a link to a PAGE keeps its words and drops the URL', () => {
  // Two of the three links in the catalogue are storefront cross-sell, one of
  // them carrying `?_pos=4&_sid=…` tracking. Navigation is not something a reply
  // should paste, and `crossSellFor` already owns recommending products.
  assert.equal(flattenRichText(linkTo('https://example.test', 'notre guide')), 'notre guide');
  assert.equal(
    flattenRichText(linkTo('https://qiriness.com/products/caresse-eclat-parfait-1?_pos=4&_sid=a4aa68afa', 'Caresse Éclat Parfait')),
    'Caresse Éclat Parfait'
  );
});

test('a link to a DOCUMENT keeps the URL, because the link IS the answer', () => {
  // The real one: the LED mask's user manual, which answers battery life, the
  // remote and what to do when it will not switch on. Flattened to five words
  // with nothing behind them, the sheet told the agent a guide existed and gave
  // it no way to hand it over.
  assert.equal(
    flattenRichText(
      linkTo(
        'https://cdn.shopify.com/s/files/1/0854/6995/4330/files/10_led_mask_user_manual_BD.pdf?v=1760451724',
        "Guide d'utilisation et fiche technique"
      )
    ),
    "Guide d'utilisation et fiche technique (https://cdn.shopify.com/s/files/1/0854/6995/4330/files/10_led_mask_user_manual_BD.pdf?v=1760451724)"
  );
});

test('the extension is read from the path, never from the query string', () => {
  // Shopify appends `?v=1760451724`, and a page can carry `?file=x.pdf` without
  // being one.
  assert.match(flattenRichText(linkTo('https://c.test/a/manual.pdf?v=17604', 'notice')), /\(https:\/\/c\.test/);
  assert.equal(flattenRichText(linkTo('https://c.test/search?file=manual.pdf', 'notice')), 'notice');
});

test('only http(s) documents carry a URL', () => {
  // A mailto: or a relative path is not a thing to paste into a reply.
  assert.equal(flattenRichText(linkTo('mailto:contact@example.test', 'écrivez-nous')), 'écrivez-nous');
  assert.equal(flattenRichText(linkTo('/files/manual.pdf', 'notice')), 'notice');
  assert.equal(flattenRichText(linkTo(undefined, 'notice')), 'notice');
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
