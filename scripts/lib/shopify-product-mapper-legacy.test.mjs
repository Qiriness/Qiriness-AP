import assert from 'node:assert/strict';
import test from 'node:test';

import { mapProduct } from './shopify-product-mapper.mjs';

const SHOP = '11111111-1111-1111-1111-111111111111';
const AT = '2026-08-08T00:00:00.000Z';

const metafield = (namespace, key, value, definitionName = null) => ({
  id: `gid://shopify/Metafield/${namespace}-${key}`,
  namespace,
  key,
  type: 'string',
  value,
  definition: definitionName ? { name: definitionName } : null
});

const build = (metafields) =>
  mapProduct(
    { id: 'gid://shopify/Product/1', title: 'Test', metafields: { nodes: metafields } },
    SHOP,
    AT
  ).productRow;

test('a legacy-only product gets its ingredients and usage instructions', () => {
  // The case that made a third of the catalogue look unmerchandised: the data
  // was in Shopify the whole time, under the old Accentuate app's namespace.
  const row = build([
    metafield('accentuate', 'ingredients', '<p>Lys de Mer : corrige les taches.</p>'),
    metafield('accentuate', 'how_to_tuse', '<p>Appliquez chaque matin.</p>')
  ]);

  assert.match(row.active_ingredients, /Lys de Mer/);
  assert.match(row.usage_instructions, /Appliquez chaque matin/);
});

test('a definition-backed value always beats the legacy one', () => {
  // Precedence must not depend on Shopify's array order, which is why this runs
  // as a second pass rather than as extra aliases.
  const modern = metafield('custom', 'usage_instructions', '<p>MODERN</p>', 'Usage Instructions');
  const legacy = metafield('accentuate', 'how_to_tuse', '<p>LEGACY</p>');

  for (const order of [[modern, legacy], [legacy, modern]]) {
    const row = build(order);
    assert.match(row.usage_instructions, /MODERN/, 'the definition-backed value must win either way');
    assert.doesNotMatch(row.usage_instructions, /LEGACY/);
  }
});

test('the legacy ingredients prose never lands in product_ingredients', () => {
  // That column holds metaobject snapshots. A rich-text string in it would be
  // the wrong shape for every consumer downstream.
  const row = build([metafield('accentuate', 'ingredients', '<p>prose, not a metaobject</p>')]);

  assert.deepEqual(row.product_ingredients, []);
  assert.deepEqual(row.product_ingredient_metaobject_ids, []);
  assert.match(row.active_ingredients, /prose/);
});

test('the corrected spelling works too, so fixing the typo in Shopify is safe', () => {
  const row = build([metafield('accentuate', 'how_to_use', '<p>Corrected key.</p>')]);
  assert.match(row.usage_instructions, /Corrected key/);
});

test('only the accentuate namespace is caught, not any field named ingredients', () => {
  // Matched on the full namespace.key precisely so an unrelated app's
  // "ingredients" field cannot silently become the active ingredients.
  const row = build([metafield('someotherapp', 'ingredients', '<p>unrelated</p>')]);
  assert.equal(row.active_ingredients, null);
});

test('everything is archived to structured_facts regardless of recognition', () => {
  // The safety net that let the legacy data be recovered at all.
  const row = build([
    metafield('accentuate', 'ingredients', '<p>x</p>'),
    metafield('reelUpProductReels', 'reels', 'whatever')
  ]);
  const keys = Object.keys(row.structured_facts.metafields);
  assert.ok(keys.includes('accentuate.ingredients'));
  assert.ok(keys.includes('reelUpProductReels.reels'), 'unrecognised fields are archived too');
});

// --- one column, one format ------------------------------------------------

test('HTML entities are decoded, not stored raw', () => {
  // 81 of 92 products carried `&eacute;`/`&rsquo;` straight through to the
  // drafting model before this.
  const row = build([
    metafield('accentuate', 'ingredients', "<p>Un cocktail d&rsquo;actifs s&eacute;lectionn&eacute;s apr&egrave;s l&#39;essai.</p>")
  ]);
  assert.match(row.active_ingredients, /d’actifs/);
  assert.match(row.active_ingredients, /sélectionnés/);
  assert.match(row.active_ingredients, /après l'essai/);
  assert.doesNotMatch(row.active_ingredients, /&[a-z]+;|&#\d+;/i);
});

test('HTML tags are stripped', () => {
  const row = build([
    metafield('accentuate', 'how_to_tuse', '<p data-start="2855" id="isPasted">Matin et soir :</p><ol><li>Appliquer.</li></ol>')
  ]);
  assert.doesNotMatch(row.usage_instructions, /<[a-z]/i);
  assert.doesNotMatch(row.usage_instructions, /data-start|isPasted/);
  assert.match(row.usage_instructions, /Matin et soir/);
  assert.match(row.usage_instructions, /Appliquer/);
});

test('a rich-text JSON document is rendered, never stringified', () => {
  // Half the catalogue stored a raw JSON document in this column.
  const doc = {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: 'Matin et soir.' }] }]
  };
  const mf = metafield('custom', 'usage_instructions', JSON.stringify(doc), 'Usage Instructions');
  mf.jsonValue = doc;

  const row = build([mf]);
  assert.equal(row.usage_instructions, 'Matin et soir.');
  assert.doesNotMatch(row.usage_instructions, /[{}]|"type"/);
});

test('plain text passes through unharmed', () => {
  const row = build([metafield('accentuate', 'ingredients', 'Acide hyaluronique & rétinol')]);
  assert.equal(row.active_ingredients, 'Acide hyaluronique & rétinol');
});

test('French guillemets decode, and soft hyphens are removed not decoded', () => {
  // « » is the normal quotation mark in French copy. The soft hyphen is a line-
  // break hint that sits INSIDE a word — decoding it to U+00AD leaves an
  // invisible character that defeats title matching and embedding alike.
  const row = build([
    metafield('accentuate', 'ingredients', '<p>un effet &laquo; sleeping mask &raquo; ASIA&shy;TICA</p>')
  ]);
  assert.match(row.active_ingredients, /« sleeping mask »/);
  assert.match(row.active_ingredients, /ASIATICA/);
  assert.doesNotMatch(row.active_ingredients, /\u00AD/);
});

test('a literal invisible character in a title is stripped', () => {
  // Product matching is TITLE-only, so one of these silently breaks the lookup.
  const row = mapProduct(
    { id: 'gid://shopify/Product/1', title: 'CENTELLA ASIA\u00ADTICA\u200B', metafields: { nodes: [] } },
    SHOP,
    AT
  ).productRow;
  assert.equal(row.title, 'CENTELLA ASIATICA');
});

test('a visually-empty descriptionHtml becomes null, not "<p><br></p>"', () => {
  // Shopify returns '' for description and '<p><br></p>' for descriptionHtml on
  // a product with no description. Stored raw, that markup reads as content.
  const row = mapProduct(
    { id: 'gid://shopify/Product/1', title: 'Sample', description: '', descriptionHtml: '<p><br></p>', metafields: { nodes: [] } },
    SHOP,
    AT
  ).productRow;
  assert.equal(row.description, null);
});

test('the descriptionHtml fallback is converted to text, not stored as markup', () => {
  const row = mapProduct(
    { id: 'gid://shopify/Product/1', title: 'Sample', description: '', descriptionHtml: '<p>Cr&egrave;me riche.</p><ul><li>Hydrate</li></ul>', metafields: { nodes: [] } },
    SHOP,
    AT
  ).productRow;
  assert.match(row.description, /Crème riche/);
  assert.match(row.description, /Hydrate/);
  assert.doesNotMatch(row.description, /<[a-z]|&[a-z]+;/i);
});
