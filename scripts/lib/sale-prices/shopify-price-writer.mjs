/**
 * THE ONLY MODULE THAT WRITES PRICES TO SHOPIFY. Needs the `write_products`
 * scope. Shared by the CLI and the admin page (extensions/sale-prices), so it
 * takes `graphql(query, variables) -> data` instead of a client and uses no
 * Node APIs (see shopify-sale-reads.mjs).
 *
 * ONE CALL PER PRODUCT, ALL OR NOTHING. `productVariantsBulkUpdate` takes one
 * product's variants, and `allowPartialUpdates: false` makes Shopify apply all
 * of them or none: a product never ends up half on sale.
 *
 * THE PRICE AND ITS MARKER TRAVEL TOGETHER. On apply, the marker metafield
 * (original price + compare-at) is part of the same variant input as the new
 * price, so no variant can be reduced without its way back.
 *
 * Retries are safe: every value written is absolute ("91.92"), never relative.
 */
import { SALE_MARKER, fromCents } from './pricing.mjs';

const BULK_UPDATE_MUTATION = `#graphql
  mutation SalePricesUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
      productVariants { id price compareAtPrice }
      userErrors { field message code }
    }
  }
`;

const MARKERS_DELETE_MUTATION = `#graphql
  mutation SaleMarkersDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { ownerId namespace key }
      userErrors { field message }
    }
  }
`;

/**
 * Puts one product's variants on sale (planApply()'s rows for that product).
 * -> { ok, error }; `ok` only when Shopify confirms every variant at the sale price.
 */
export async function applySalePrices(graphql, productId, changes) {
  const variants = changes.map((change) => ({
    id: change.variantId,
    price: fromCents(change.saleCents),
    compareAtPrice: fromCents(change.priceCents),
    metafields: [
      { namespace: SALE_MARKER.namespace, key: SALE_MARKER.key, type: SALE_MARKER.type, value: change.marker }
    ]
  }));
  const expected = new Map(changes.map((change) => [change.variantId, change.saleCents]));
  return bulkUpdate(graphql, productId, variants, expected);
}

/**
 * Puts one product's variants back to their original price and compare-at
 * (null clears it). Does NOT remove the markers: call deleteSaleMarkers once
 * this succeeded, so a failure in between leaves a variant restorable rather
 * than reduced and unmarked.
 */
export async function restoreOriginalPrices(graphql, productId, restores) {
  const variants = restores.map((item) => ({
    id: item.variantId,
    price: fromCents(item.targetCents),
    compareAtPrice: fromCents(item.targetCompareCents)
  }));
  const expected = new Map(restores.map((item) => [item.variantId, item.targetCents]));
  return bulkUpdate(graphql, productId, variants, expected);
}

/** Removes the sale marker from the given variants. -> { ok, error } */
export async function deleteSaleMarkers(graphql, variantIds) {
  if (variantIds.length === 0) return { ok: true, error: null };
  try {
    const data = await graphql(MARKERS_DELETE_MUTATION, {
      metafields: variantIds.map((ownerId) => ({ ownerId, namespace: SALE_MARKER.namespace, key: SALE_MARKER.key }))
    });
    const errors = data?.metafieldsDelete?.userErrors || [];
    if (errors.length > 0) return { ok: false, error: formatUserErrors(errors) };
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function bulkUpdate(graphql, productId, variants, expectedCents) {
  let data;
  try {
    data = await graphql(BULK_UPDATE_MUTATION, { productId, variants });
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const result = data?.productVariantsBulkUpdate;
  const errors = result?.userErrors || [];
  if (errors.length > 0) return { ok: false, error: formatUserErrors(errors) };

  // Trust, then verify: no error is not the same as every price being what we sent.
  const returned = new Map((result?.productVariants || []).map((variant) => [variant.id, variant.price]));
  for (const [variantId, cents] of expectedCents) {
    const price = returned.get(variantId);
    if (price === undefined || Math.round(Number(price) * 100) !== cents) {
      return {
        ok: false,
        error: `Shopify answered without error but variant ${variantId} is at ${price ?? 'unknown'}, expected ${fromCents(cents)}.`
      };
    }
  }
  return { ok: true, error: null };
}

function formatUserErrors(errors) {
  return errors
    .map((error) => `${error.message}${error.field ? ` (${[].concat(error.field).join('.')})` : ''}`)
    .join('; ');
}
