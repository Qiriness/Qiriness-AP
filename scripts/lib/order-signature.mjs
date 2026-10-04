import { createHash } from 'node:crypto';

/**
 * What a carrier, a partner or the customer would notice about an order: a new
 * parcel number, a fulfilment or parcel status moving (in transit, delivered,
 * failed), a cancellation, a payment or refund. A price edit, a note or a tag
 * changes none of it.
 *
 * Shared by the snooze wake (snooze-order-wake.mjs), which wakes a partner's
 * snooze when it moves, and the order bundle (order-context.mjs), which records
 * it so the pre-send check can tell an order that moved under an approved reply
 * from one that was merely edited (DECISIONS § Change router).
 */

/** The columns `orderSignature` reads, as the orders table stores them. */
export const ORDER_SIGNATURE_COLUMNS = 'name,fulfillment_status,financial_status,cancelled_at,tracking_numbers,fulfillments';

export function orderSignature(order) {
  if (!order) return null;
  const parcels = (Array.isArray(order.fulfillments) ? order.fulfillments : [])
    .map((f) => `${f?.id ?? ''}:${f?.status ?? ''}:${f?.display_status ?? ''}:${f?.delivered_at ?? ''}`)
    .sort();
  return JSON.stringify({
    fulfillment: order.fulfillment_status ?? null,
    financial: order.financial_status ?? null,
    cancelled: order.cancelled_at ?? null,
    tracking: [...(order.tracking_numbers ?? [])].sort(),
    parcels
  });
}

/** The signature as a short digest, for storing: the parcel numbers stay out of the row. */
export function orderSignatureHash(order) {
  const signature = orderSignature(order);
  return signature === null ? null : createHash('sha256').update(signature).digest('hex').slice(0, 16);
}
