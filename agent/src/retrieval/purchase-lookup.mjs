import { supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';

import { toPromptText, verifyPurchase } from './purchase-verification.mjs';

// The database half of purchase verification: fetch the customer and their most
// recent order, then hand both to the pure verifier.
//
// IT ENTERS FROM `tickets.customer_id`, NOT FROM THE ADDRESS. The
// customer-resolution pass already did the hash lookup — it runs on every
// ticket, before any LLM stage, and has linked 145 of 214 — so re-resolving here
// would be a second answer to a question already answered, and a second
// `data_access_events` row for the same access. A ticket with no `customer_id`
// is `unknown`, which is precisely what that column not being set means.
//
// THE RETAIL CASE IS WHY THIS IS THREE-VALUED. A sale made at a till never
// reaches Shopify, so an address that matches nothing here is not evidence that
// the person did not buy the product. Everything this module returns is phrased
// as what we can and cannot show, and `purchase-verification.toPromptText` is
// the one place that wording lives.
//
// ONE ORDER, NOT A HISTORY. `customer-context.mjs` deliberately carries no order
// history beyond the aggregate, and this stays as close to that line as the job
// allows: the single most recent order, its line items only, fetched for one
// question — does what they are describing match what they last bought.

const CUSTOMER_COLUMNS = 'id,number_of_orders,last_order_name,last_order_at';
const ORDER_COLUMNS = 'name,processed_at,line_items';

export function createPurchaseLookup({ supabase, shopId, productLookup = null, logger = null }) {
  /**
   * The customer's most recent order, or null.
   *
   * Ordered by `processed_at` descending rather than read from
   * `customers.last_order_id`: that column names the order but this needs its
   * line items, so the join has to happen anyway — and an explicit order-by is
   * one query rather than two, and cannot disagree with itself if the snapshot
   * lags.
   *
   * Cancelled orders are not excluded. Someone writing about a product from an
   * order that was later cancelled still bought it, briefly, and hiding that
   * would make the cross-check say "not in your last order" about a product the
   * customer plainly remembers ordering.
   */
  async function lastOrderFor(customerId) {
    const rows = await supabaseSelect(
      supabase,
      'orders',
      { customer_id: customerId, shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } },
      ORDER_COLUMNS,
      { order: 'processed_at.desc', limit: 1 }
    );
    return rows[0] ?? null;
  }

  return {
    /**
     * Verify the sender and cross-check the product they describe.
     *
     * Never throws for a missing customer or a missing order — both are ordinary
     * states with their own verdicts. A genuine database failure is logged and
     * degrades to `unknown`, because an investigation that dies because one
     * lookup failed is worse than one that reports it could not check.
     */
    async verify({ ticket }) {
      const customerId = ticket?.customer_id ?? null;

      if (!customerId) {
        return verifyPurchase({ customer: null, question: ticket?.text ?? '' });
      }

      try {
        const [customerRows, catalogueIndex] = await Promise.all([
          supabaseSelect(supabase, 'customers', { id: customerId, shop_id: shopId }, CUSTOMER_COLUMNS),
          // Lent by the product tool so the order's line items are scored with
          // the catalogue's word weights. Optional: without it the match still
          // works, just more bluntly.
          productLookup?.catalogueIndex?.() ?? null
        ]);

        const customer = customerRows[0] ?? null;
        // A linked customer with no orders is `known_no_orders` and needs no
        // order fetched — there is none, and asking for one is a wasted round
        // trip on every newsletter signup who writes in.
        const lastOrder =
          customer && Number(customer.number_of_orders ?? 0) > 0
            ? await lastOrderFor(customerId)
            : null;

        return verifyPurchase({
          customer,
          lastOrder,
          question: ticket?.text ?? '',
          catalogueIndex
        });
      } catch (error) {
        logger?.warn?.('purchase.verify_failed', { ticketId: ticket?.id, message: error.message });
        return verifyPurchase({ customer: null, question: ticket?.text ?? '' });
      }
    },

    toPromptText
  };
}
