// Assembles the order/customer bundle a drafting agent (or the next tool) reads
// instead of querying fields one at a time.
//
// Pure: an `orders` row, its `customers` row, and a clock. No database.
//
// WHY ASSEMBLE RATHER THAN HAND OVER THE ROWS. The raw order carries four
// separate status columns, a fulfillments array, a refunds array and twenty
// monetary fields. Answering "where is my parcel?" from that means the model
// reasoning that `fulfillment_status = FULFILLED` with `delivered_at = null` and
// `in_transit_at = null` means "dispatched, no scan yet" — a deduction it will
// sometimes get wrong, differently each time. Deriving it here makes the answer
// deterministic and reviewable, and it is the same derivation every ticket gets.
//
// PERSONAL DATA. The bundle deliberately carries the buyer's name and email:
// support cannot answer without knowing who the order belongs to, and the
// schema sanctions it for exactly this. It carries NO street address — the sync
// stores only a coarse city/country, and nothing here reaches for more. Phone is
// excluded too: this is an email desk and it is not needed to answer.

/**
 * @param order    an `orders` row
 * @param customer the `customers` row it points at, or null
 */
export function buildOrderContext(order, customer = null, { now = new Date() } = {}) {
  if (!order) {
    return null;
  }

  return {
    resolvedAt: new Date(now).toISOString(),
    order: {
      name: order.name,
      number: order.order_number ?? null,
      placedAt: order.processed_at || order.shopify_created_at || null,
      ageDays: daysBetween(order.processed_at || order.shopify_created_at, now),
      status: {
        overall: order.order_status || null,
        payment: order.financial_status || null,
        fulfillment: order.fulfillment_status || null,
        return: order.return_status || null
      },
      cancelledAt: order.cancelled_at || null,
      cancelReason: order.cancel_reason || null,
      channel: order.sales_channel || order.source_name || null,
      totals: buildTotals(order),
      items: buildItems(order.line_items),
      shipTo: buildShipTo(order.shipping_destination),
      delivery: buildDelivery(order, now),
      refunds: buildRefunds(order),
      returns: buildReturns(order)
    },
    customer: buildCustomer(customer),
    // Derived answers to the questions the corpus actually asks, so a drafting
    // step reads a fact rather than inferring one. See the cluster report: "not
    // received", "missing item", "marked delivered but absent" are the top
    // three delivery topics.
    signals: buildSignals(order, now)
  };
}

function buildTotals(order) {
  return {
    currency: order.currency_code || null,
    subtotal: num(order.subtotal_price),
    discounts: num(order.total_discounts),
    shipping: num(order.total_shipping_price),
    tax: num(order.total_tax),
    total: num(order.total_price),
    refunded: num(order.total_refunded),
    outstanding: num(order.total_outstanding)
  };
}

/** Title, sku and quantity only — enough to discuss the order, nothing more. */
function buildItems(lineItems) {
  if (!Array.isArray(lineItems)) {
    return [];
  }
  return lineItems.map((item) => ({
    title: item.title || item.name || null,
    sku: item.sku || null,
    quantity: item.quantity ?? null,
    productId: item.product_id || null
  }));
}

/** Coarse by design: the sync never stores a street address. */
function buildShipTo(destination) {
  if (!destination || typeof destination !== 'object') {
    return null;
  }
  return {
    city: destination.city || null,
    province: destination.province || null,
    country: destination.country || null,
    countryCode: destination.country_code || null
  };
}

/**
 * The single most-asked-about thing in the corpus, reduced to one state plus the
 * tracking numbers.
 *
 * `state` is derived rather than copied because no single column holds it:
 * Shopify's `fulfillment_status` says whether the warehouse dispatched, and only
 * the fulfillment's own timestamps say whether the carrier has moved or
 * delivered it. Those are different answers to "where is my parcel?".
 */
function buildDelivery(order, now) {
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  const tracking = [];
  let deliveredAt = order.delivered_at || null;
  let inTransitAt = null;
  let estimatedDeliveryAt = null;

  for (const fulfillment of fulfillments) {
    deliveredAt = deliveredAt || fulfillment.delivered_at || null;
    inTransitAt = inTransitAt || fulfillment.in_transit_at || null;
    estimatedDeliveryAt = estimatedDeliveryAt || fulfillment.estimated_delivery_at || null;
    for (const info of fulfillment.tracking_info || []) {
      if (info?.number) {
        tracking.push({
          number: info.number,
          carrier: info.company || null,
          url: info.url || null,
          fulfillmentStatus: fulfillment.display_status || fulfillment.status || null
        });
      }
    }
  }

  const state = deliveredAt
    ? 'delivered'
    : inTransitAt
      ? 'in_transit'
      : fulfillments.length > 0
        ? 'dispatched'
        : 'not_dispatched';

  return {
    state,
    deliveredAt,
    inTransitAt,
    estimatedDeliveryAt,
    // Days since dispatch is what turns "dispatched" into "dispatched and late".
    daysSinceDispatch: daysBetween(firstFulfilledAt(fulfillments), now),
    tracking
  };
}

function buildRefunds(order) {
  const refunds = Array.isArray(order.refunds) ? order.refunds : [];
  return {
    count: refunds.length,
    total: num(order.total_refunded),
    lastAt: refunds.length ? refunds[refunds.length - 1]?.processed_at || null : null,
    // Partial matters: "you were refunded" reads very differently at 12 € of 89 €.
    isFull: num(order.total_refunded) > 0 && num(order.total_refunded) >= num(order.total_price)
  };
}

function buildReturns(order) {
  const returns = Array.isArray(order.returns) ? order.returns : [];
  return {
    count: returns.length,
    status: order.return_status || null,
    openedAt: order.return_refund_opened_at || null,
    completedAt: order.return_refund_completed_at || null
  };
}

/**
 * Customer facts that change how a reply is written, and nothing else.
 *
 * No phone, no street address, no order history beyond the aggregate — a first
 * order and a fortieth are answered differently, but the list of the other
 * thirty-nine is not needed to answer this one.
 */
function buildCustomer(customer) {
  if (!customer) {
    return null;
  }
  return {
    name: customer.display_name || [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null,
    email: customer.email || null,
    locale: customer.locale || null,
    ordersCount: customer.number_of_orders ?? null,
    amountSpent: num(customer.amount_spent),
    amountSpentCurrency: customer.amount_spent_currency || null,
    rfmGroup: customer.rfm_group || null,
    subscribedToNewsletter: customer.on_email_marketing_list ?? null,
    location: {
      city: customer.default_address_city || null,
      country: customer.default_address_country || null
    },
    lastOrder: {
      name: customer.last_order_name || null,
      at: customer.last_order_at || null,
      total: num(customer.last_order_total)
    },
    tags: Array.isArray(customer.tags) ? customer.tags : []
  };
}

/**
 * Booleans a reply actually turns on.
 *
 * Deliberately few. Each one exists because a real cluster in the corpus needs
 * it, and every extra flag is another thing that can be wrong.
 */
function buildSignals(order, now) {
  const delivery = buildDelivery(order, now);
  const refunds = buildRefunds(order);
  return {
    isCancelled: Boolean(order.cancelled_at),
    isPaid: String(order.financial_status || '').toUpperCase() === 'PAID',
    isRefunded: refunds.total > 0,
    isFullyRefunded: refunds.isFull,
    isDispatched: delivery.state !== 'not_dispatched',
    isDelivered: delivery.state === 'delivered',
    hasTracking: delivery.tracking.length > 0,
    // "Dispatched, no carrier scan, and it has been a while" is the shape of the
    // largest delivery cluster — 27 messages of "je n'ai toujours pas reçu".
    awaitingCarrierScan: delivery.state === 'dispatched' && !delivery.inTransitAt,
    hasOpenReturn: ['OPEN', 'REQUESTED'].includes(String(order.return_status || '').toUpperCase())
  };
}

function firstFulfilledAt(fulfillments) {
  for (const fulfillment of fulfillments) {
    if (fulfillment?.created_at) {
      return fulfillment.created_at;
    }
  }
  return null;
}

function daysBetween(from, now) {
  if (!from) {
    return null;
  }
  const start = new Date(from).getTime();
  if (!Number.isFinite(start)) {
    return null;
  }
  return Math.max(0, Math.floor((new Date(now).getTime() - start) / 86400000));
}

function num(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
