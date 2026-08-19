import { supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { COLUMNS, T } from '../../../scripts/lib/tables.mjs';

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

// THE FULL BUNDLE PROJECTION, not the three columns the product cross-check
// needs. Widened when the dashboard's "Last order" block started reading this
// same row: a second fetch existed for a while, with its own copy of the
// filters and its own column list, which is two ways to answer one question.
// The cross-check still reads only `name`, `processed_at` and `line_items` — it
// simply no longer owns the narrowest possible read of a row somebody else also
// wants whole.
const ORDER_COLUMNS = COLUMNS.orderForContext;

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
      T.ORDERS,
      { customer_id: customerId, shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } },
      ORDER_COLUMNS,
      { order: 'processed_at.desc', limit: 1 }
    );
    return rows[0] ?? null;
  }

  /** The customer row, or null. Narrow: only what the three-state check reads. */
  async function customerFor(customerId) {
    const rows = await supabaseSelect(
      supabase,
      T.CUSTOMERS,
      { id: customerId, shop_id: shopId },
      CUSTOMER_COLUMNS
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
        const [customer, catalogueIndex] = await Promise.all([
          customerFor(customerId),
          // Lent by the product tool so the order's line items are scored with
          // the catalogue's word weights. Optional: without it the match still
          // works, just more bluntly.
          productLookup?.catalogueIndex?.() ?? null
        ]);

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

    /**
     * The customer's most recent order, as a full bundle row plus the customer.
     *
     * THE SAME FETCH THE CROSS-CHECK USES, exposed rather than copied. It was
     * copied for a while — a second `loadLastOrderForCustomer` in the
     * order-context store, same table, same filters, same ordering, different
     * columns — which is exactly the duplication the shared catalogue index
     * above exists to avoid.
     *
     * NOT A TOOL, and reached from the runner rather than the registry: the
     * model must never see a candidate order (it would quote it), and a
     * `product` ticket has no order tool to hang it on anyway.
     *
     * THE ZERO-ORDERS SHORT-CIRCUIT IS INHERITED, and it is worth more here than
     * in the cross-check: measured on this corpus, 3 of the 4 product tickets
     * eligible for a candidate belong to customers with no orders at all —
     * newsletter signups who wrote in. Asking the database for their last order
     * is a round trip that can only return nothing.
     */
    async lastOrder(customerId) {
      if (!customerId) {
        return null;
      }
      const customer = await customerFor(customerId);
      if (!customer || Number(customer.number_of_orders ?? 0) === 0) {
        return null;
      }
      const order = await lastOrderFor(customerId);
      return order ? { order, customer } : null;
    },

    toPromptText
  };
}
