/**
 * The storefront advisor's window onto the catalogue: the ONLY code that reads
 * `products` and `advice_collections` for it, and what it reads is named here,
 * column by column. The tools above it (product-tools.mjs) never see a row,
 * only `ProductRecord`s, so a schema change is absorbed in this file.
 *
 * READ-ONLY, WHITELISTED, LIVE PRODUCTS ONLY: active, published, not deleted.
 * Never the raw Shopify payload, never unrestricted metafields (the review badge HTML lives
 * there), never stock counts — only whether something is in stock.
 *
 * LOADED WHOLE, ONCE. The catalogue is about 100 products; holding it in memory
 * (the caller keeps it a few minutes) means a tool call costs no database round
 * trip, and the advisor's reply time is the model's alone.
 */

import { isCustomerFacing } from '../../../agent/src/retrieval/product-matching.mjs';
import { htmlToText } from '../html-to-text.mjs';
import { keywords } from './faq-matcher.mjs';

export const PRODUCT_COLUMNS = [
  'id',
  'shopify_product_id',
  'handle',
  'title',
  'product_type',
  'tags',
  'short_description',
  'description',
  'active_ingredients',
  'usage_instructions',
  'product_faqs',
  'variants',
  'available_stock'
].join(',');

export const COLLECTION_COLUMNS = 'handle,title,axis,product_ids';

const LIVE_PRODUCT = {
  status: 'active',
  published_at: { operator: 'not.is', value: 'null' },
  deleted_at: { operator: 'is', value: 'null' }
};
const ACTIVE_COLLECTION = { is_active: true, deleted_at: { operator: 'is', value: 'null' } };

/**
 * @typedef {object} ProductRecord
 * @property {string} id            products.id — the stable id later tools take
 * @property {string | null} shopifyId
 * @property {string} handle
 * @property {string} name
 * @property {string | null} type
 * @property {string[]} tags
 * @property {string | null} short
 * @property {string | null} description
 * @property {string | null} keyIngredients
 * @property {string | null} usage
 * @property {object[]} faqs        published Shopify question/answer pairs, selected per question
 * @property {{ title: string | null, price: number, sku: string | null }[]} variants
 * @property {string[]} skus
 * @property {number | null} priceFrom
 * @property {boolean} inStock
 * @property {string[]} collections  handles of the active collections it is in
 *
 * @typedef {object} CollectionRecord
 * @property {string} handle
 * @property {string} title
 * @property {'category' | 'concern' | null} axis
 *
 * @typedef {{ products: ProductRecord[], collections: CollectionRecord[] }} Catalogue
 */

/**
 * @param {{ selectAll: (table: string, filters: object, columns: string) => Promise<object[]> }} db
 * @returns {Promise<Catalogue>}
 */
export async function loadCatalogue(db, shopId) {
  const [productRows, collectionRows] = await Promise.all([
    db.selectAll('products', { shop_id: shopId, ...LIVE_PRODUCT }, PRODUCT_COLUMNS),
    db.selectAll('advice_collections', { shop_id: shopId, ...ACTIVE_COLLECTION }, COLLECTION_COLUMNS)
  ]);
  return buildCatalogue(productRows, collectionRows);
}

export function buildCatalogue(productRows, collectionRows) {
  const collectionsOf = new Map();
  const collections = [];
  for (const row of collectionRows) {
    if (!row.handle || !row.title) continue;
    collections.push({ handle: row.handle, title: row.title, axis: row.axis ?? null });
    for (const id of row.product_ids ?? []) {
      collectionsOf.set(id, [...(collectionsOf.get(id) ?? []), row.handle]);
    }
  }
  // SAMPLES ARE NOT PRODUCTS A CUSTOMER CAN CHOOSE. The support matcher learned
  // this first (product-matching.mjs `isCustomerFacing`): « Caresse Source d'Eau
  // - échantillon » is active and published, and outranked the real product.
  const products = productRows
    .filter((row) => row.handle && row.title && isCustomerFacing(row))
    .map((row) => mapProduct(row, collectionsOf.get(row.shopify_product_id) ?? []));
  return { products, collections };
}

/** @returns {ProductRecord} */
export function mapProduct(row, collections = []) {
  const variants = (Array.isArray(row.variants) ? row.variants : [])
    .map((v) => ({ title: cleanVariantTitle(v?.title), price: Number(v?.price), sku: typeof v?.sku === 'string' && v.sku.trim() ? v.sku.trim() : null }))
    .filter((v) => Number.isFinite(v.price) && v.price > 0);
  return {
    id: row.id ?? row.handle,
    shopifyId: row.shopify_product_id ?? null,
    handle: row.handle,
    name: row.title,
    type: text(row.product_type),
    tags: Array.isArray(row.tags) ? row.tags.filter((t) => typeof t === 'string') : [],
    short: text(row.short_description),
    description: text(row.description),
    keyIngredients: text(row.active_ingredients),
    usage: text(row.usage_instructions),
    faqs: (Array.isArray(row.product_faqs) ? row.product_faqs : [])
      .filter((faq) => faq?.published !== false && text(faq?.question) && text(faq?.answer) && text(faq.answer).length <= 1800)
      .map((faq, i) => ({ id: faq.faq_id ?? `${row.id}:faq:${i}`, canonical_question: text(faq.question), answer: text(faq.answer), aliases: [], keywords: keywords(text(faq.question)), topic: 'product', locale: 'fr', active: true, updated_at: faq.updated_at ?? null })),
    variants,
    skus: [...new Set(variants.map((v) => v.sku).filter(Boolean))],
    priceFrom: variants.length ? Math.min(...variants.map((v) => v.price)) : null,
    inStock: Number(row.available_stock) > 0,
    collections
  };
}

/** Plain text or null. The sync stores the literal string 'null' for some empty metafields. */
function text(value) {
  if (typeof value !== 'string') return null;
  const plain = (/[<&]/.test(value) ? htmlToText(value) : value)
    .replace(/\s+\n/g, '\n')
    // htmlToText spaces inline tags apart (« fondante , »). Only before , . ) —
    // French keeps its space before ; : ! ?
    .replace(/ +([,.)])/g, '$1')
    .trim();
  return plain && plain !== 'null' ? plain : null;
}

function cleanVariantTitle(title) {
  return typeof title === 'string' && title && title !== 'Default Title' ? title.trim() : null;
}
