// The one definition of what a tracking number looks like once it is comparable.
//
// IT LIVES HERE, IN THE SHARED LAYER, BECAUSE BOTH SIDES MUST AGREE. The order
// sync writes `orders.tracking_numbers` through this function and the resolver
// normalises the customer's typing through the same one; two copies that drift
// by a hyphen would produce a lookup that silently never matches — the worst
// failure shape available, because it reads as "we have no record of that
// parcel". `agent/` already imports from `scripts/lib`, never the reverse.
//
// WHAT NEEDS REMOVING, measured on this store's data:
//   - trailing punctuation Shopify hands back: `6A06497617561.` is stored today
//   - the groups carriers print: `6C 2072 3002 488`
//   - hyphens, which some carriers and most customers add
//   - case, since customers type in lower case and Shopify stores upper

/** Uppercase, stripped of spaces, dots and hyphens. Empty string for nothing. */
export function normaliseTrackingNumber(value) {
  return String(value ?? '')
    .replace(/[\s.\-]/g, '')
    .toUpperCase();
}

/**
 * Every distinct tracking number on a mapped `fulfillments` array, normalised.
 *
 * Takes the STORED shape (`tracking_info[].number`), not Shopify's GraphQL
 * shape, so the sync and any backfill over existing rows produce the same array
 * from the same input.
 */
export function trackingNumbersFromFulfillments(fulfillments) {
  const seen = new Set();
  for (const fulfillment of Array.isArray(fulfillments) ? fulfillments : []) {
    for (const tracking of fulfillment?.tracking_info || []) {
      const number = normaliseTrackingNumber(tracking?.number);
      // A fulfillment with no carrier reference yet is normal — the warehouse
      // has picked it and nothing has been scanned. It contributes nothing.
      if (number) {
        seen.add(number);
      }
    }
  }
  return [...seen];
}
