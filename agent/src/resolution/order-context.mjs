import { buildCustomerContext } from '../retrieval/customer-context.mjs';

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
      // FOR THE PANEL, NOT THE MODEL. `toOrderContextText` omits it: the agent
      // never needs to know which address placed the order, and the tool layer
      // is where that is withheld. A person reviewing an ownership mismatch does
      // need it, and this is the only readable form of it that exists.
      contactEmailMasked: order.customer_email_masked || null,
      items: buildItems(order.line_items),
      shipTo: buildShipTo(order.shipping_destination),
      delivery: buildDelivery(order, now),
      refunds: buildRefunds(order),
      returns: buildReturns(order)
    },
    // Shared with the standalone customer lookup, so both return one shape.
    customer: buildCustomerContext(customer),
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

// ---------------------------------------------------------------- projections

/**
 * THE BUNDLE IS ONE SOURCE WITH THREE AUDIENCES, and each gets a rendering
 * somebody chose. This is the same split `case-file.mjs` makes between
 * `toDraftingPrompt` and `toHumanBrief`, one layer down:
 *
 *   the DASHBOARD  reads the structured bundle directly (`ticket-detail.ts`),
 *                  because the panel must show order facts for tickets the agent
 *                  never investigated — a case-file-only path would blank them.
 *   the CASE FILE  stores a POINTER (`contextRef`), never a copy.
 *   the MODEL      reads this function.
 *
 * Until now the model had no rendering, so `getOrderContext` fell back to
 * `JSON.stringify(bundle)` — and measured on live data, that fallback was the
 * only path that had ever run: 0 of 44 stored contexts carried a `promptText`.
 * The dump was not a size problem (line items top out at 14 across all 2052
 * orders) and not a leak (the bundle holds no street, name or email). It was the
 * absence of a decision: whatever `context:build` happened to write reached the
 * model, and the next field added would have reached it too.
 *
 * DERIVED, NOT STORED, for the reason `contextRef` is a pointer: a rendered copy
 * in the row freezes a snapshot of a snapshot and goes stale the moment this
 * function changes.
 *
 * WHAT IT WITHHOLDS is as deliberate as what it says. Money is named only when
 * a reply turns on it (a refund, an unpaid balance): quoting a total back at
 * someone who asked where their parcel is invites the drafting model to discuss
 * a number nobody asked about. `productId` and `sku` never appear — they are
 * join keys, not facts a customer recognises.
 */
/**
 * The bundle reduced to the handful of STATES a policy rule may branch on.
 *
 * WHY THIS EXISTS SEPARATELY FROM `signals`. `buildSignals` answers a list of
 * independent yes/no questions — is it paid, is it dispatched, is there tracking
 * — which is what a prompt wants. A rule wants the opposite shape: one closed
 * value per question, total, so a condition can be compared mechanically and an
 * unmatched branch is impossible. `isPaid: false` says nothing about whether the
 * money came back; `payment_state: refunded` does.
 *
 * IT LIVES HERE BECAUSE THE BUNDLE LIVES HERE. Deriving these in the
 * investigation would be a second reading of `fulfillments` and
 * `financial_status`, free to disagree with the first — the exact split this
 * module was written to close (see the header). `evidence-rules.mjs` reads the
 * values off the tool ledger and never touches an order row.
 *
 * EVERY VALUE IS TOTAL, `unknown` included, because a condition must always have
 * something to compare against — the same rule the findings vocabulary follows.
 *
 * @param staleTransitDays how long without movement stops being "in transit" and
 *   starts being "stuck". Passed in rather than imported: the number belongs to
 *   `investigation-rules.mjs`, and importing it here would be the first
 *   `resolution/` → `investigation/` edge in the codebase for one integer.
 */
export function orderStates(
  context,
  { staleTransitDays = null, returnsWindowDays = null, now = new Date() } = {}
) {
  const order = context?.order;
  if (!order) {
    return null;
  }

  const signals = context.signals || {};
  const delivery = order.delivery || {};

  // CANCELLED OUTRANKS EVERYTHING, because it changes what every other state
  // means — a cancelled order that was never dispatched is not awaiting
  // dispatch, and answering it as though it were is the worst reading available.
  const orderState = signals.isCancelled
    ? 'cancelled'
    : delivery.state === 'delivered'
      ? 'delivered'
      : delivery.state === 'in_transit' || delivery.state === 'dispatched'
        ? 'dispatched'
        : delivery.state === 'not_dispatched'
          ? 'not_dispatched'
          : 'unknown';

  return {
    order_state: orderState,
    delivery_state: deliveryState(delivery, signals, staleTransitDays, now),
    // REFUNDS BEFORE PAYMENT, and the order is the decision: a fully refunded
    // order is also `PAID` in Shopify, so testing `isPaid` first would report
    // money we have given back as money we are holding.
    payment_state: signals.isFullyRefunded
      ? 'refunded'
      : signals.isRefunded
        ? 'partially_refunded'
        : signals.isPaid
          ? 'paid'
          : order.status?.payment
            ? 'unpaid'
            : 'unknown',
    return_eligibility: returnEligibility(order, delivery, returnsWindowDays, now)
  };
}

/**
 * Is a return still possible?
 *
 * THE ONE STATE THAT NEEDS A NUMBER NOBODY WROTE IN CODE. Every other state here
 * is read off the order: shipped or not, paid or not. "Still returnable" is the
 * order's delivery date compared against a window that is a MERCHANT DECISION,
 * and this shop's two approved articles disagree about it — 30 days in one, 14
 * in the other. Hardcoding either would have made this deriver a third answer.
 *
 * SO IT COMES IN AS A PARAMETER, and `null` — nobody has decided yet — resolves
 * `unknown` rather than to a default. A default here is a policy: 30 would tell
 * customers a window nobody approved, and 0 would refuse every return. `unknown`
 * is what the rules already handle, and it routes to a person, which is the
 * correct behaviour for a shop that has not written its returns window down.
 *
 * COUNTED FROM DELIVERY, not from the order date, because that is what both
 * articles say — « après réception ». An order that has not been delivered has
 * no clock running yet, so it is `unknown` too rather than `possible`: the
 * window has not started, and saying "yes you can return it" about a parcel
 * nobody has received is answering a different question.
 */
function returnEligibility(order, delivery, windowDays, now) {
  if (!Number.isInteger(windowDays) || windowDays < 0) {
    return 'unknown';
  }
  const deliveredAt = delivery?.deliveredAt || null;
  if (!deliveredAt) {
    return 'unknown';
  }
  const since = daysBetween(deliveredAt, now);
  if (!Number.isFinite(since)) {
    return 'unknown';
  }
  return since <= windowDays ? 'possible' : 'out_of_window';
}

/**
 * Where the parcel is, in the states a reply actually differs on.
 *
 * `dispatched_no_scan` IS ITS OWN STATE and not a flavour of `in_transit`.
 * Folding it into `in_transit` would claim movement nothing has evidenced — the
 * same claim `delivery_unscanned` already forbids the model from making in
 * prose.
 *
 * MEASURED OVER EVERY BUILT BUNDLE (78 tickets, 2026-08-29):
 *
 *     dispatched_no_scan   73     delivered            4
 *     not_dispatched        1     in_transit           0
 *                                 stale_in_transit     0
 *
 * Two things to read out of that, both of which change how this is used:
 *
 * `in_transit` AND `stale_in_transit` ARE UNREACHABLE TODAY, at zero of 78. Not
 * a bug: no carrier feeds scan events into Shopify for this store, which is the
 * same gap `delivery_unscanned` exists to stop the model talking about. They are
 * declared rather than dropped, on the `checkout_state` principle — listed and
 * unwired, so the count argues for the carrier integration instead of hiding the
 * need for it. **A rule branching on either can never fire until that exists.**
 * `escalationTriggers`' 10-day rule is dormant for exactly the same reason.
 *
 * `not_dispatched` IS RARE HERE FOR A REASON THAT WILL NOT HOLD. It looks
 * unreachable at 1 of 78, and the age distribution says otherwise: no bundle in
 * the corpus was built for an order under 7 days old (p25 35 days, median 60).
 * These are historical tickets whose orders had long since shipped. On live
 * mail a cancellation arrives hours after the order, which is precisely when
 * this state is true — so it is the corpus that is unrepresentative, not the
 * state that is unused.
 */
function deliveryState(delivery, signals, staleTransitDays, now) {
  if (delivery.state === 'delivered') {
    return 'delivered';
  }
  if (delivery.state === 'not_dispatched') {
    return 'not_dispatched';
  }
  if (signals.awaitingCarrierScan) {
    return 'dispatched_no_scan';
  }
  if (delivery.state === 'in_transit') {
    const since = daysBetween(delivery.inTransitAt || delivery.deliveredAt, now);
    return Number.isFinite(staleTransitDays) && Number.isFinite(since) && since >= staleTransitDays
      ? 'stale_in_transit'
      : 'in_transit';
  }
  return 'unknown';
}

export function toOrderContextText(context) {
  const order = context?.order;
  if (!order) {
    return null;
  }
  const signals = context.signals || {};
  const lines = [];

  const placed = order.placedAt ? order.placedAt.slice(0, 10) : 'date inconnue';
  lines.push(
    `Commande ${order.name || ''} passée le ${placed}` +
      (order.ageDays !== null && order.ageDays !== undefined ? ` (il y a ${order.ageDays} jours)` : '') +
      '.'
  );

  // Cancellation first: everything below reads differently once it is true.
  if (signals.isCancelled) {
    lines.push(
      `ANNULÉE${order.cancelReason ? ` — motif : ${order.cancelReason}` : ''}.`
    );
  }

  lines.push(`Paiement : ${signals.isPaid ? 'réglée' : describePayment(order.status?.payment)}.`);
  lines.push(describeDeliveryLine(order.delivery, signals));

  // THE NUMBER, NEVER THE URL, and this was tried the other way round first.
  // Putting the fulfilment URL in the prompt does get a link into the reply —
  // pasted in full, « https://www.laposte.fr/outils/suivre-vos-envois?code=… »,
  // sitting in the middle of the sentence. That is not what a customer should
  // receive, and it is not what the dashboard shows either: `TrackingText` turns
  // the NUMBER into the link on every surface, which is the same information
  // without a 70-character string in the prose.
  //
  // So the URL stays out of the model's reach entirely and the linking happens
  // at render time, where it belongs. `no_web_link` in draft-checks.mjs is the
  // guard: nothing in the dossier is a URL, so any URL in a reply is invented.
  const tracking = order.delivery?.tracking || [];
  if (tracking.length > 0) {
    lines.push(
      `Suivi : ${tracking
        .map((t) => `${t.number}${t.carrier ? ` (${t.carrier})` : ''}`)
        .join(', ')}.`
    );
  }

  if (order.shipTo?.country) {
    lines.push(
      `Destination : ${[order.shipTo.city, order.shipTo.country].filter(Boolean).join(', ')}.`
    );
  }

  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length > 0) {
    lines.push(
      `Articles (${items.length}) : ${items
        .map((i) => `${i.quantity ?? '?'} × ${i.title || 'article sans titre'}`)
        .join(' · ')}.`
    );
  }

  // Money only where a reply turns on it.
  if (signals.isRefunded) {
    lines.push(
      `Remboursement : ${signals.isFullyRefunded ? 'total' : 'partiel'} de ` +
        `${money(order.refunds?.total, order.totals?.currency)}` +
        `${order.refunds?.lastAt ? ` le ${order.refunds.lastAt.slice(0, 10)}` : ''}.`
    );
  }
  if (order.totals?.outstanding) {
    lines.push(`Reste à payer : ${money(order.totals.outstanding, order.totals.currency)}.`);
  }
  if (signals.hasOpenReturn) {
    lines.push('Un retour est ouvert sur cette commande.');
  }

  return lines.filter(Boolean).join('\n');
}

/** The one state the corpus asks about, said in words rather than an enum. */
function describeDeliveryLine(delivery, signals) {
  const state = delivery?.state || 'unknown';
  if (state === 'delivered') {
    const on = delivery.deliveredAt ? ` le ${delivery.deliveredAt.slice(0, 10)}` : '';
    return `Livraison : le transporteur déclare le colis livré${on}.`;
  }
  if (state === 'in_transit') {
    const since = delivery.daysSinceDispatch;
    return (
      'Livraison : en transit' +
      (Number.isFinite(since) ? `, expédiée il y a ${since} jours` : '') +
      '.'
    );
  }
  if (state === 'dispatched') {
    // THE ABSENCE OF A SCAN IS A FACT ABOUT US, NOT ABOUT THE PARCEL, and this
    // line used to tell the model otherwise: « expédiée, mais aucun scan
    // transporteur pour le moment ». The model believed it — 17 case files
    // recorded it as an ESTABLISHED fact — and 8 drafts passed it to customers,
    // several naming the carrier: « pas encore de scan de suivi de la part de
    // Colissimo », « aucun scan transporteur » for GLS.
    //
    // No carrier feeds scan events into Shopify for this store at all
    // (`delivered_at` on 1 order in 2 006, `in_transit_at` on none), so that
    // sentence blamed the carrier for a gap in our own integration, and implied
    // a stuck parcel where there is only an absent feed.
    //
    // The model is now told what is true and customer-safe: it was dispatched,
    // and when. What we cannot see reaches it as a PROHIBITION instead
    // (`delivery_unscanned` in case-file.mjs), because a prohibition cannot be
    // repeated to a customer as a fact. `signals.awaitingCarrierScan` still
    // carries it for the dashboard and the human brief, which are internal.
    const since = delivery.daysSinceDispatch;
    return (
      'Livraison : expédiée' +
      (Number.isFinite(since) ? ` il y a ${since} jours` : '') +
      '.'
    );
  }
  if (state === 'not_dispatched') {
    return "Livraison : pas encore expédiée.";
  }
  return 'Livraison : état inconnu.';
}

function describePayment(status) {
  const map = {
    PENDING: 'en attente',
    AUTHORIZED: 'autorisée, non capturée',
    PARTIALLY_PAID: 'partiellement réglée',
    REFUNDED: 'remboursée',
    PARTIALLY_REFUNDED: 'partiellement remboursée',
    VOIDED: 'annulée'
  };
  const key = String(status || '').toUpperCase();
  return map[key] || (status ? String(status) : 'état inconnu');
}

function money(value, currency) {
  if (value === null || value === undefined) {
    return 'montant inconnu';
  }
  return `${value}${currency ? ` ${currency}` : ''}`;
}
