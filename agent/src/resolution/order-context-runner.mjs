import { supabaseSelect, supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';

import { buildOrderContext } from './order-context.mjs';

// Fills `tickets.resolved_context` for every ticket whose order number is known.
//
// Runs after the order-number resolver and consumes its output: a ticket only
// becomes eligible once `shopify_order_number` has been CONFIRMED, so nothing
// here can assemble a bundle for the wrong customer's order.
//
// A SNAPSHOT, AND RE-RESOLVABLE. `context_resolved_at` records when the bundle
// was built. An order moves — dispatched, delivered, refunded — so a bundle from
// last week is a fact about last week, and `--refresh` rebuilds any ticket whose
// order has been updated since. Storing it rather than querying live is what
// stops a drafting agent making five queries per reply, and what makes the reply
// reviewable afterwards: you can see exactly what it was told.

const ORDER_COLUMNS = [
  'id', 'name', 'order_number', 'customer_id',
  'financial_status', 'fulfillment_status', 'return_status', 'order_status',
  'cancel_reason', 'cancelled_at', 'sales_channel', 'source_name',
  'currency_code', 'subtotal_price', 'total_discounts', 'total_shipping_price',
  'total_tax', 'total_price', 'total_refunded', 'total_outstanding',
  'line_items', 'fulfillments', 'refunds', 'returns', 'shipping_destination',
  // Read for the dashboard's benefit, not the agent's — `toOrderContextText`
  // leaves it out of what the model is shown.
  'customer_email_masked',
  'delivered_at', 'return_refund_opened_at', 'return_refund_completed_at',
  'processed_at', 'shopify_created_at', 'shopify_updated_at'
].join(',');

const CUSTOMER_COLUMNS = [
  'id', 'display_name', 'first_name', 'last_name', 'email', 'locale',
  'number_of_orders', 'amount_spent', 'amount_spent_currency', 'rfm_group',
  'on_email_marketing_list', 'default_address_city', 'default_address_country',
  'last_order_name', 'last_order_at', 'last_order_total', 'tags'
].join(',');

export function createOrderContextStore(supabase) {
  return {
    // `findPending` left this store: it is `record.findAwaitingContext({ refresh })`
    // now, with the same `refresh` widening. What this store keeps is the orders
    // and the customers behind them.


    /** Orders by display name (`#1006`), plus the customers they belong to. */
    async loadOrders(shopId, orderNames) {
      if (orderNames.length === 0) {
        return { byName: new Map(), customersById: new Map() };
      }
      const orders = await supabaseSelectAll(
        supabase,
        T.ORDERS,
        {
          shop_id: shopId,
          name: { operator: 'in', value: `(${orderNames.map(quote).join(',')})` },
          deleted_at: { operator: 'is', value: 'null' }
        },
        ORDER_COLUMNS
      );

      const customerIds = [...new Set(orders.map((o) => o.customer_id).filter(Boolean))];
      const customers = customerIds.length
        ? await supabaseSelectAll(
            supabase,
            T.CUSTOMERS,
            { id: { operator: 'in', value: `(${customerIds.join(',')})` } },
            CUSTOMER_COLUMNS
          )
        : [];

      return {
        byName: new Map(orders.map((o) => [o.name, o])),
        customersById: new Map(customers.map((c) => [c.id, c]))
      };
    },

    /**
     * The customer's most recent order, as a full bundle.
     *
     * SAME COLUMNS, SAME BUILDER as a confirmed order, and that is the point:
     * the dashboard renders it through the projection it already has, under
     * different headings. A narrower shape would have meant a second renderer
     * and a second set of decisions about what a reader is shown.
     *
     * ONLY EVER A CANDIDATE. It is fetched when the customer named no order, so
     * it answers "which order did they most recently place", never "which order
     * do they mean". The caller keeps it out of everything the model reads.
     */
    async loadLastOrderForCustomer(shopId, customerId) {
      if (!customerId) {
        return null;
      }
      const orders = await supabaseSelect(
        supabase,
        T.ORDERS,
        {
          shop_id: shopId,
          customer_id: customerId,
          deleted_at: { operator: 'is', value: 'null' }
        },
        ORDER_COLUMNS,
        { order: 'processed_at.desc', limit: 1 }
      );
      const order = orders[0] || null;
      if (!order) {
        return null;
      }
      const customers = await supabaseSelect(
        supabase,
        T.CUSTOMERS,
        { id: customerId },
        CUSTOMER_COLUMNS,
        { limit: 1 }
      );
      return { order, customer: customers[0] || null };
    },

    // `saveContext` left this store too: `record.setResolvedContext(ticket,
    // context, customerId)` writes the bundle, stamps `context_resolved_at` and
    // backfills `customer_id` where the ticket had none.
  };
}

export async function runOrderContext({
  store,
  record,
  shopId,
  logger,
  refresh = false,
  dryRun = false,
  now = new Date(),
  onResult
} = {}) {
  const tickets = await record.findAwaitingContext({ refresh });
  const totals = { considered: tickets.length, resolved: 0, order_missing: 0 };

  // One batched order+customer load for the whole pass.
  const names = [...new Set(tickets.map((t) => t.shopify_order_number).filter(Boolean))];
  const { byName, customersById } = await store.loadOrders(shopId, names);

  for (const ticket of tickets) {
    const order = byName.get(ticket.shopify_order_number) || null;
    if (!order) {
      // The order number is confirmed but the row is gone — retention deleted it,
      // or the sync has not caught up. Counted, never written as an empty bundle:
      // an empty `resolved_context` would read as "this order has nothing in it".
      totals.order_missing += 1;
      onResult?.({ ticket, context: null, reason: 'order_missing' });
      continue;
    }

    const customer = order.customer_id ? customersById.get(order.customer_id) || null : null;
    const context = buildOrderContext(order, customer, { now });
    totals.resolved += 1;
    onResult?.({ ticket, context });

    if (!dryRun) {
      await record.setResolvedContext(ticket, context, order.customer_id);
    }
  }

  logger?.info?.('order.context', { shopId, ...totals });
  return totals;
}

/** PostgREST `in.()` needs quoting for values carrying a `#`. */
function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}
