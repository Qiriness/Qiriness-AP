/**
 * Sale prices: the Shopify READS. Shared by the CLI (scripts/sale-prices.mjs)
 * and the app's admin page (extensions/sale-prices).
 *
 * TRANSPORT-FREE. Every function takes `graphql(query, variables) -> data`
 * (throwing on errors) instead of a client, because the two callers reach
 * Shopify differently: the CLI with the app's client-credentials token
 * (shopify-admin-client.mjs), the admin page through Shopify's direct API
 * access (`shopify.query`). No Node APIs here: this module is bundled into the
 * admin extension.
 *
 * SMALL PAGES ON PURPOSE. Shopify prices a query by the product of its `first`
 * values and refuses anything over 1000 points: 5 products x 50 variants x
 * (variant + marker) stays near 500. A product with more than 50 variants is
 * refused rather than half-read.
 */
import { SALE_MARKER } from './pricing.mjs';

export const SALE_PRODUCT_PAGE_SIZE = 5;
export const SALE_VARIANTS_PER_PRODUCT = 50;
export const SALE_VARIANT_SCAN_PAGE_SIZE = 100;
export const SALE_COLLECTION_LIST_PAGE_SIZE = 250;

const MARKER_FIELD = `metafield(namespace: "${SALE_MARKER.namespace}", key: "${SALE_MARKER.key}") { id value }`;

const ACCESS_SCOPES_QUERY = `#graphql
  query SaleAccessScopes {
    currentAppInstallation { accessScopes { handle } }
    shop { myshopifyDomain }
  }
`;

const COLLECTION_LIST_QUERY = `#graphql
  query SaleCollectionList($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: TITLE) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle title productsCount { count } }
    }
  }
`;

const COLLECTION_VARIANTS_QUERY = `#graphql
  query SaleCollectionVariants($handle: String!, $first: Int!, $after: String, $variantFirst: Int!) {
    collectionByIdentifier(identifier: { handle: $handle }) {
      id
      handle
      title
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          status
          variants(first: $variantFirst) {
            pageInfo { hasNextPage }
            nodes { id title price compareAtPrice ${MARKER_FIELD} }
          }
        }
      }
    }
  }
`;

const VARIANT_SCAN_QUERY = `#graphql
  query SaleMarkedVariants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        price
        compareAtPrice
        product { id title status }
        ${MARKER_FIELD}
      }
    }
  }
`;

/** The scopes the current token carries, and the shop. -> { scopes: string[], shopDomain } */
export async function fetchAccessScopes(graphql) {
  const data = await graphql(ACCESS_SCOPES_QUERY, {});
  return {
    scopes: (data?.currentAppInstallation?.accessScopes || []).map((scope) => scope.handle),
    shopDomain: data?.shop?.myshopifyDomain || null
  };
}

/** Every collection, by title. -> [{ id, handle, title, productsCount }] */
export async function fetchCollectionList(graphql) {
  const collections = [];
  let cursor = null;
  do {
    const data = await graphql(COLLECTION_LIST_QUERY, { first: SALE_COLLECTION_LIST_PAGE_SIZE, after: cursor });
    for (const node of data?.collections?.nodes || []) {
      collections.push({
        id: node.id,
        handle: node.handle,
        title: node.title,
        productsCount: node.productsCount?.count ?? null
      });
    }
    const pageInfo = data?.collections?.pageInfo;
    cursor = pageInfo?.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);
  return collections;
}

/**
 * A collection's products with their variants' price, compare-at and marker.
 * -> { collection: { id, handle, title }, products: [{ id, title, status, variants }] } | null
 */
export async function fetchSaleCollection(graphql, handle) {
  const products = [];
  let collection = null;
  let cursor = null;

  do {
    const data = await graphql(COLLECTION_VARIANTS_QUERY, {
      handle,
      first: SALE_PRODUCT_PAGE_SIZE,
      after: cursor,
      variantFirst: SALE_VARIANTS_PER_PRODUCT
    });
    const node = data?.collectionByIdentifier;
    if (!node) return null;
    collection = { id: node.id, handle: node.handle, title: node.title };

    for (const product of node.products.nodes) {
      if (product.variants.pageInfo.hasNextPage) {
        throw new Error(`"${product.title}" has more than ${SALE_VARIANTS_PER_PRODUCT} variants; refusing to half-read it.`);
      }
      products.push({ id: product.id, title: product.title, status: product.status, variants: product.variants.nodes });
    }
    cursor = node.products.pageInfo.hasNextPage ? node.products.pageInfo.endCursor : null;
  } while (cursor);

  return { collection, products };
}

/**
 * Every variant in the shop carrying a sale marker, as products (marked variants
 * only). Scans all variants: the marker has no metafield definition, so it
 * cannot be a search filter; the shop has a few hundred variants.
 */
export async function fetchSaleMarkedProducts(graphql) {
  const byProduct = new Map();
  let cursor = null;

  do {
    const data = await graphql(VARIANT_SCAN_QUERY, { first: SALE_VARIANT_SCAN_PAGE_SIZE, after: cursor });
    const connection = data?.productVariants;
    for (const variant of connection?.nodes || []) {
      if (!variant.metafield) continue;
      const { product } = variant;
      if (!byProduct.has(product.id)) {
        byProduct.set(product.id, { id: product.id, title: product.title, status: product.status, variants: [] });
      }
      byProduct.get(product.id).variants.push({
        id: variant.id,
        title: variant.title,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        metafield: variant.metafield
      });
    }
    cursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);

  return [...byProduct.values()];
}
