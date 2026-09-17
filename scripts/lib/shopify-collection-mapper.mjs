// One Shopify collection node into an `advice_collections` row.
//
// THE COLUMNS IT DOES NOT RETURN ARE THE POINT. `is_active`, `axis`, `note`,
// `product_ids` and `products_synced_at` are never in the returned object, so
// the upsert — which merges on (shop_id, shopify_collection_id) and leaves any
// column absent from the payload alone — cannot overwrite them. A nightly sync
// that silently un-activated every curated collection would be the worst kind of
// bug: nothing fails, and the agent quietly stops recommending anything.
//
// Same mechanism as `shopify-product-mapper.mjs` and `recommended_for_concerns`,
// and asserted the same way, in this module's own test.

/**
 * @param node      a `collections.nodes[]` entry from COLLECTIONS_QUERY
 * @param shopId    the local shop row id
 * @param syncedAt  one timestamp for the whole pass
 */
export function mapCollectionRow(node, shopId, syncedAt) {
  return {
    shop_id: shopId,
    shopify_collection_id: node.id,
    handle: node.handle,
    title: node.title,
    // Shopify's own count, INCLUDING products that are not live — it is what the
    // curation screen shows beside a collection so somebody can judge whether it
    // is worth switching on, not a number any reply quotes. The live count comes
    // from `product_ids`, which the membership pass filters on status.
    products_count: node.productsCount?.count ?? null,
    synced_at: syncedAt,
    // A collection that came back is not deleted. Set explicitly rather than
    // left out, so a collection restored in Shopify comes back here too.
    deleted_at: null
  };
}
