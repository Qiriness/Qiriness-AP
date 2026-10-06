import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCatalogue, loadCatalogue, mapProduct, PRODUCT_COLUMNS } from './product-repository.mjs';
import { GET_PRODUCT, SEARCH_PRODUCTS, priceFormatter, runTool, searchProducts, tokens, toolDefinitions } from './product-tools.mjs';

const ROWS = [
  {
    shopify_product_id: 'gid://shopify/Product/1',
    handle: 'creme-nuit-reparatrice',
    title: 'Crème de Nuit Réparatrice',
    product_type: 'Soin Visage',
    tags: ['peaux sèches', 'nuit', 'hydratation'],
    short_description: 'Une crème riche qui nourrit les peaux sèches pendant la nuit.',
    description: '<p>Texture <strong>fondante</strong>, karité.</p>',
    active_ingredients: 'Beurre de karité',
    usage_instructions: 'Le soir, sur peau propre.',
    variants: [{ title: '50 ml', price: '49.90' }, { title: '15 ml', price: '19.90' }],
    available_stock: 12,
    raw_shopify_payload: { secret: 'never read' }
  },
  {
    shopify_product_id: 'gid://shopify/Product/2',
    handle: 'serum-eclat',
    title: 'Sérum Éclat Vitamine C',
    product_type: 'Soin Visage',
    tags: ['éclat', 'teint terne'],
    short_description: 'Un sérum à la vitamine C pour un teint lumineux.',
    description: null,
    active_ingredients: 'Vitamine C',
    usage_instructions: 'null',
    variants: [{ title: 'Default Title', price: '39.00' }],
    available_stock: 0
  },
  {
    shopify_product_id: 'gid://shopify/Product/3',
    handle: 'gel-douche',
    title: 'Gel Douche Doux',
    product_type: 'Soin corps',
    tags: ['corps'],
    short_description: 'Lave en douceur.',
    variants: [{ title: '200 ml', price: '12.00' }],
    available_stock: 40
  }
];
const COLLECTIONS = [
  { handle: 'cremes-de-nuit', title: 'Crèmes de Nuit', axis: 'category', product_ids: ['gid://shopify/Product/1'] },
  { handle: 'eclat-et-bonne-mine', title: 'Soins Éclat & Bonne Mine', axis: 'concern', product_ids: ['gid://shopify/Product/2'] }
];
const CATALOGUE = buildCatalogue(ROWS, COLLECTIONS);

test('the repository reads named columns of live products only, never the raw payload', async () => {
  const calls = [];
  const db = { selectAll: async (table, filters, columns) => (calls.push({ table, filters, columns }), table === 'products' ? ROWS : COLLECTIONS) };
  const catalogue = await loadCatalogue(db, 'shop-1');
  assert.equal(catalogue.products.length, 3);
  const products = calls.find((c) => c.table === 'products');
  assert.equal(products.columns, PRODUCT_COLUMNS);
  assert.doesNotMatch(PRODUCT_COLUMNS, /raw_shopify_payload|structured_facts|\*/);
  assert.equal(products.filters.status, 'active');
  assert.deepEqual(products.filters.published_at, { operator: 'not.is', value: 'null' });
  assert.deepEqual(products.filters.deleted_at, { operator: 'is', value: 'null' });
  assert.equal(calls.find((c) => c.table === 'advice_collections').filters.is_active, true);
});

test('a row becomes a record: plain text, prices, stock as a yes/no, its collections', () => {
  const record = CATALOGUE.products[0];
  assert.equal(record.description, 'Texture fondante, karité.');
  assert.equal(record.priceFrom, 19.9);
  assert.equal(record.inStock, true);
  assert.deepEqual(record.collections, ['cremes-de-nuit']);
  assert.equal(mapProduct(ROWS[1]).usage, null, "the sync's literal 'null' is no usage text");
  assert.equal(mapProduct(ROWS[1]).variants[0].title, null, 'Default Title is not a size');
  assert.equal('raw_shopify_payload' in record, false);
});

test('search ranks by meaning words, folds accents and plurals, and needs no exact title', () => {
  assert.deepEqual(tokens('Une crème pour peaux sèches'), ['creme', 'seche']);
  assert.equal(searchProducts(CATALOGUE, { query: 'crème peaux sèches' })[0].handle, 'creme-nuit-reparatrice');
  assert.equal(searchProducts(CATALOGUE, { query: 'vitamine c eclat' })[0].handle, 'serum-eclat');
  assert.deepEqual(searchProducts(CATALOGUE, { query: 'parfum voiture' }), []);
});

test('a collection filters to the team\'s curated list, and a query is optional', () => {
  assert.deepEqual(searchProducts(CATALOGUE, { collection: 'cremes-de-nuit' }).map((p) => p.handle), ['creme-nuit-reparatrice']);
});

test('search_products returns only the whitelisted summary, formatted for the shop', () => {
  const { result, handles } = runTool(SEARCH_PRODUCTS, { query: 'creme seche', collection: null, limit: null }, CATALOGUE);
  assert.deepEqual(handles, ['creme-nuit-reparatrice']);
  assert.deepEqual(Object.keys(result.products[0]).sort(), ['handle', 'id', 'in_stock', 'name', 'price_from', 'short', 'type']);
  assert.equal(result.products[0].price_from, '19,90 €');
});

test('get_product gives the detail, every size priced, and stock only as yes/no', () => {
  const { result, handles } = runTool(GET_PRODUCT, { id: 'creme-nuit-reparatrice' }, CATALOGUE, { locale: 'en' });
  assert.deepEqual(handles, ['creme-nuit-reparatrice']);
  assert.deepEqual(result.sizes, [{ size: '50 ml', price: '€49.90' }, { size: '15 ml', price: '€19.90' }]);
  assert.equal(result.in_stock, true);
  assert.equal('available_stock' in result, false);
});

test('a bad call is an error the model can read, never a throw', () => {
  assert.match(runTool(GET_PRODUCT, { id: 'nope' }, CATALOGUE).result.error, /no live product/);
  assert.match(runTool(GET_PRODUCT, { id: "x'; drop table products" }, CATALOGUE).result.error, /no live product/);
  assert.match(runTool(SEARCH_PRODUCTS, { query: 'x', collection: 'invented' }, CATALOGUE).result.error, /unknown collection/);
  assert.match(runTool('run_sql', {}, CATALOGUE).result.error, /unknown tool/);
});

test('limits are clamped', () => {
  const many = buildCatalogue(Array.from({ length: 20 }, (_, i) => ({ ...ROWS[2], handle: `gel-${i}`, title: `Gel ${i}` })), []);
  assert.equal(runTool(SEARCH_PRODUCTS, { query: 'gel', collection: null, limit: 50 }, many).result.products.length, 8);
  assert.equal(runTool(SEARCH_PRODUCTS, { query: 'gel', collection: null, limit: null }, many).result.products.length, 5);
});

test('the tool definitions are strict, and the collection enum is the live list', () => {
  const [resolveTool, search, get] = toolDefinitions(CATALOGUE);
  assert.equal(resolveTool.function.name, 'resolve_products');
  assert.equal(search.function.strict, true);
  assert.deepEqual(search.function.parameters.properties.collection.enum, ['cremes-de-nuit', 'eclat-et-bonne-mine', null]);
  assert.deepEqual(get.function.parameters.required, ['id']);
});

test('prices follow the storefront locale', () => {
  assert.equal(priceFormatter('EUR', 'fr')(1234.5), '1 234,50 €');
  assert.equal(priceFormatter('EUR', 'not-a-locale!!')(10), '10,00 €');
});

test('samples never enter the catalogue, and every record carries its stable id and SKUs', () => {
  const catalogue = buildCatalogue(
    [
      { id: 'uuid-1', handle: 'real', title: 'Crème Réelle', product_type: 'Soin Visage', variants: [{ price: '10', sku: 'E001' }], available_stock: 1 },
      { id: 'uuid-2', handle: 'sample', title: 'Crème Réelle - échantillon', product_type: 'SAMPLE PRODUCT', variants: [{ price: '1', sku: 'E001S' }], available_stock: 1 }
    ],
    []
  );
  assert.deepEqual(catalogue.products.map((p) => p.handle), ['real']);
  assert.equal(catalogue.products[0].id, 'uuid-1');
  assert.deepEqual(catalogue.products[0].skus, ['E001']);
});

test('resolve_products returns the contract without the internal memory field', async () => {
  const { buildResolutionIndex } = await import('./product-resolver.mjs');
  const index = buildResolutionIndex(CATALOGUE);
  const { result, handles } = runTool('resolve_products', { mentions: ['la crème de nuit réparatrice'] }, CATALOGUE, { resolution: { index } });
  assert.equal('pending' in result, false);
  assert.ok(['resolved', 'ambiguous', 'partial', 'unresolved'].includes(result.status));
  assert.ok(Array.isArray(handles));
  assert.match(runTool('resolve_products', { mentions: [] }, CATALOGUE, { resolution: { index } }).result.error, /no mentions/);
});
