import { ORDER_SIGNATURE_COLUMNS, orderSignature } from './order-signature.mjs';
import { createSnoozeRecord } from './snooze-record.mjs';
import { supabaseSelect } from './supabase-rest-client.mjs';
import { T } from './tables.mjs';

/**
 * An order update wakes the tickets snoozed on an operations partner about that
 * order, and only when something a partner or carrier would have told us has
 * changed: a new parcel number, a fulfilment or parcel status moving (in
 * transit, delivered, failed), a cancellation or a refund. A price edit or a
 * tag does not wake anything. DECISIONS.md § Snooze.
 *
 * Shopify's fulfilment display status is updated from the carrier's tracking,
 * so « DELIVERED » arriving here is the carrier's word reaching us before any
 * email does.
 */

/** The columns `materialOrderChange` compares, as the orders table stores them. */
export const ORDER_WAKE_COLUMNS = ORDER_SIGNATURE_COLUMNS;

/** Whether the stored order and the new row differ in anything that could end a wait. */
export function materialOrderChange(stored, next) {
  if (!next) return false;
  // A first sight of an order changes nothing a snoozed ticket could be waiting on.
  if (!stored) return false;
  return orderSignature(stored) !== orderSignature(next);
}

/**
 * Wake every ticket on this order that is snoozed waiting for a partner.
 * Returns the number woken. Never throws: an order webhook must not fail
 * because a snooze could not be read; the deadline is the backstop.
 */
export async function wakeSnoozedForOrder({ supabase, shopId, orderName, logger = console }) {
  if (!orderName) return 0;
  try {
    const tickets = await supabaseSelect(
      supabase,
      T.TICKETS,
      { shop_id: shopId, shopify_order_number: orderName, deleted_at: { operator: 'is', value: 'null' } },
      'id'
    );
    if (tickets.length === 0) return 0;
    const snoozes = createSnoozeRecord(supabase, { shopId });
    let woken = 0;
    for (const ticket of tickets) {
      const open = await snoozes.open(ticket.id);
      if (open?.waiting_for !== 'partner') continue;
      if (await snoozes.wake(ticket.id, 'order_update', { wokenBy: 'shopify' })) woken += 1;
    }
    return woken;
  } catch (error) {
    logger?.warn?.('snooze order wake failed', error?.message ?? String(error));
    return 0;
  }
}
