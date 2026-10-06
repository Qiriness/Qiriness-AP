/**
 * The storefront advisor's tools: read-only product lookups.
 *
 *   resolve_products({ mentions })                   WHICH products the customer named (ids)
 *   search_products({ query, collection, limit })   DISCOVER products matching criteria
 *   get_product({ id })                              one product, in detail
 *
 * Resolution and discovery are separate on purpose: « la crème Source d'Eau »
 * is a reference to resolve, « quels sérums anti-âge ? » a search. Products are
 * identified by `id` (products.id), which every later tool takes.
 *
 * Pure functions over a `Catalogue` (product-repository.mjs). No database, no
 * SQL, no network: the model chooses a tool and its arguments, this file
 * validates them and answers from memory. Every field returned is named below;
 * nothing else of a product reaches the model.
 *
 * `collection` is an enum of the team's ACTIVE advice collections, so the model
 * filters on a curated list instead of guessing search words — one round trip
 * instead of two when the customer names a category or a concern.
 */

import { resolveProducts } from './product-resolver.mjs';
import { matchFaqs } from './faq-matcher.mjs';

export const RESOLVE_PRODUCTS = 'resolve_products';
export const SEARCH_PRODUCTS = 'search_products';
export const GET_PRODUCT = 'get_product';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;
const MAX_QUERY_CHARS = 120;
const HANDLE = /^[\p{Ll}\p{Lo}\p{N}_-]{1,255}$/u;

/** Words that carry no product meaning in a French or English skincare query. */
const STOPWORDS = new Set([
  'les', 'des', 'une', 'pour', 'avec', 'sans', 'dans', 'sur', 'par', 'est', 'que', 'qui', 'mon', 'mes', 'votre', 'vos',
  'peau', 'soin', 'soins', 'produit', 'produits', 'the', 'and', 'for', 'with', 'skin', 'product', 'products', 'care'
]);

/** OpenAI function tools, built per catalogue so the collection enum is the live list. */
export function toolDefinitions(catalogue) {
  const handles = catalogue.collections.map((c) => c.handle);
  const listed = catalogue.collections.map((c) => `${c.handle} (${c.title})`).join('; ');
  return [
    {
      type: 'function',
      function: {
        name: RESOLVE_PRODUCTS,
        description:
          'Identify the specific products the customer refers to, by name or reference, when they are not already resolved in VISIT CONTEXT. Returns resolved products with ids, ambiguous mentions with candidates and a clarification to ask, and mentions that match nothing. Not for discovery questions — use search_products for those.',
        strict: true,
        parameters: {
          type: 'object',
          properties: {
            mentions: {
              type: 'array',
              items: { type: 'string' },
              description: 'Each product reference as the customer wrote it, one per product (« la crème Source d’Eau », « le sérum »).'
            }
          },
          required: ['mentions'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: SEARCH_PRODUCTS,
        description:
          'Discover products matching criteria (a need, a skin type, a product type). Returns up to `limit` products, best match first: id, name, type, a short description, the starting price and whether it is in stock. ' +
          `Use \`collection\` when the need matches one of these curated collections: ${listed || 'none'}.`,
        strict: true,
        parameters: {
          type: 'object',
          properties: {
            query: { type: ['string', 'null'], description: 'Key words in the catalogue language (French): need, texture, ingredient, product type. Null to list a collection.' },
            collection: { type: ['string', 'null'], enum: [...handles, null], description: 'A collection handle from the list, or null.' },
            limit: { type: ['integer', 'null'], description: `1 to ${MAX_LIMIT}; ${DEFAULT_LIMIT} when null.` }
          },
          required: ['query', 'collection', 'limit'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: GET_PRODUCT,
        description: 'One product in detail: description, key ingredients, how to use it, every size with its price, and whether it is in stock.',
        strict: true,
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'The product id, as returned by resolve_products or search_products.' } },
          required: ['id'],
          additionalProperties: false
        }
      }
    }
  ];
}

/**
 * Run one tool call. Never throws for a bad call: the model gets `{ error }` and
 * can correct itself in the next round.
 *
 * @returns {{ result: object, handles: string[] }} handles = products the model may now name
 */
export function runTool(name, args, catalogue, { currency = 'EUR', locale = 'fr', resolution = null, query = '' } = {}) {
  const money = priceFormatter(currency, locale);
  if (name === RESOLVE_PRODUCTS) {
    if (!resolution?.index) return { result: { error: 'resolution is not available' }, handles: [] };
    const mentions = (Array.isArray(args?.mentions) ? args.mentions : []).filter((m) => typeof m === 'string').slice(0, 6).map((m) => m.slice(0, MAX_QUERY_CHARS));
    if (!mentions.length) return { result: { error: 'no mentions given' }, handles: [] };
    const r = resolveProducts(mentions.join(', '), { index: resolution.index, refs: resolution.refs, pageProductId: resolution.pageProductId });
    const { pending, ...contract } = r;
    const handleOf = (id) => catalogue.products.find((p) => p.id === id)?.handle;
    return {
      result: contract,
      handles: [...r.products.map((p) => p.handle), ...r.candidates.flatMap((c) => c.options.map((o) => o.handle))],
      resolution: r,
      ids: r.products.map((p) => p.id).filter(handleOf)
    };
  }
  if (name === SEARCH_PRODUCTS) {
    const query = typeof args?.query === 'string' ? args.query.slice(0, MAX_QUERY_CHARS) : '';
    const collection = typeof args?.collection === 'string' ? args.collection : null;
    if (collection && !catalogue.collections.some((c) => c.handle === collection)) {
      return { result: { error: `unknown collection ${collection}` }, handles: [] };
    }
    const limit = clampLimit(args?.limit);
    const found = searchProducts(catalogue, { query, collection }).slice(0, limit);
    return {
      result: {
        products: found.map((p) => ({
          id: p.id,
          handle: p.handle,
          name: p.name,
          type: p.type,
          short: clip(p.short, 220),
          price_from: p.priceFrom === null ? null : money(p.priceFrom),
          in_stock: p.inStock
        }))
      },
      handles: found.map((p) => p.handle)
    };
  }
  if (name === GET_PRODUCT) {
    // By id; a handle is still accepted, for a model that kept one from earlier.
    const key = typeof args?.id === 'string' ? args.id : typeof args?.handle === 'string' ? args.handle : '';
    const product = key && HANDLE.test(key) ? catalogue.products.find((p) => p.id === key || p.handle === key) : null;
    if (!product) return { result: { error: `no live product with id ${key}` }, handles: [] };
    return { result: productDetail(product, money, query), handles: [product.handle] };
  }
  return { result: { error: `unknown tool ${name}` }, handles: [] };
}

/** The detail block, shared with the "current product" section of the prompt. */
export function productDetail(product, money, query = '') {
  const faqs = query ? matchFaqs(product.faqs ?? [], { query, limit: 1 }) : null;
  return {
    id: product.id,
    handle: product.handle,
    name: product.name,
    type: product.type,
    description: clip(product.description ?? product.short, 900),
    key_ingredients: clip(product.keyIngredients, 700),
    how_to_use: clip(product.usage, 400),
    sizes: product.variants.slice(0, 6).map((v) => ({ size: v.title, price: money(v.price) })),
    in_stock: product.inStock,
    ...(faqs?.status === 'found' ? { faq_answers: faqs.matches } : {})
  };
}

/** Ranked, live products. Exported for tests and for Phase 4's recommendation service. */
export function searchProducts(catalogue, { query = '', collection = null } = {}) {
  const pool = collection ? catalogue.products.filter((p) => p.collections.includes(collection)) : catalogue.products;
  const terms = tokens(query);
  if (!terms.length) return [...pool].sort(byStockThenName);

  const titleOf = new Map(catalogue.collections.map((c) => [c.handle, c.title]));
  return pool
    .map((product) => ({ product, score: score(product, terms, titleOf) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || byStockThenName(a.product, b.product))
    .map((x) => x.product);
}

function score(product, terms, titleOf) {
  const fields = [
    [normalise(product.name), 4],
    [normalise(product.tags.join(' ')), 3],
    [normalise(product.type ?? ''), 2],
    [normalise(product.collections.map((h) => titleOf.get(h) ?? '').join(' ')), 2],
    [normalise(product.short ?? ''), 1],
    [normalise(product.keyIngredients ?? ''), 1]
  ];
  let total = 0;
  for (const term of terms) {
    for (const [haystack, weight] of fields) {
      if (haystack.includes(term)) total += weight;
    }
  }
  return total;
}

/** Lower case, no accents, crude plural folding: « crèmes » finds « crème », « peaux » finds « peau ». */
export function tokens(query) {
  return [
    ...new Set(
      normalise(query)
        .split(/[^a-z0-9]+/)
        .map((t) => (t.length > 4 && /[sx]$/.test(t) ? t.slice(0, -1) : t))
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    )
  ];
}

function normalise(value) {
  return String(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function byStockThenName(a, b) {
  return Number(b.inStock) - Number(a.inStock) || a.name.localeCompare(b.name, 'fr');
}

function clampLimit(value) {
  const n = Number.isInteger(value) ? value : DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

function clip(value, max) {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** « 27,93 € » in French, « €27.93 » in English. The currency is the shop's, from config. */
export function priceFormatter(currency = 'EUR', locale = 'fr') {
  let format;
  try {
    format = new Intl.NumberFormat(locale || 'fr', { style: 'currency', currency });
  } catch {
    format = new Intl.NumberFormat('fr', { style: 'currency', currency: 'EUR' });
  }
  return (amount) => format.format(amount).replace(/ | /g, ' ');
}
