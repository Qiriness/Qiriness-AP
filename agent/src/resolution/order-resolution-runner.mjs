import {
  supabaseRpc,
  supabaseSelectAll
} from '../../../scripts/lib/supabase-rest-client.mjs';
import { RPC, T } from '../../../scripts/lib/tables.mjs';
import { reinvestigationColumns } from '../../../scripts/lib/order-link.mjs';

import { countConfirmationMarkers, messageEmailHashes } from './confirmation-evidence.mjs';
import { shopifyOrderCandidates, parseOrderCandidates, toOrderName } from './order-number-parser.mjs';
import { parseTrackingCandidates } from './tracking-number-parser.mjs';
import {
  BY_MARKETPLACE_ORDER_NUMBER,
  BY_MESSAGE_EMAIL,
  CONFIRMED,
  MISMATCH,
  NAME_MATCH,
  NOT_FOUND,
  NO_CANDIDATE,
  chooseResolution,
  isAnonymousPlaceholder,
  isSafeToWrite,
  verifyOrder
} from './order-verification.mjs';

// Fills `tickets.shopify_order_number` — the prerequisite for every order tool.
//
// 172 of 330 customer-facing tickets (52%) are about an order, a delivery, a
// payment or a return, and not one of them can be answered until the ticket
// knows which order it is about. `shopify_order_number` is currently set on 0.
//
// ONLY A CONFIRMED MATCH IS WRITTEN. A name agreement is recorded for a human
// and left off the column, and a number belonging to somebody else is never
// written at all. The column feeds order context, tracking and eventually refund
// decisions; a wrong value there is worse than a null, because null is visibly
// unknown and wrong is invisibly confident.

export function createOrderResolutionStore(supabase) {
  return {
    // `findUnresolved` left this store: the tickets are now
    // `record.findAwaitingOrderNumber()` and the customer's opening words are
    // `record.firstInboundByTicket()`, which reads the `ticket_first_inbound`
    // view instead of every inbound body in the shop. What this store keeps is
    // the orders, and the customers behind them.


    /**
     * The store's actual order-number range.
     *
     * The database, not a hardcoded digit count, is what says whether a number
     * could be one of ours. Shopify numbers start around four digits and grow
     * without limit as a store sells, so the only durable answer is to ask what
     * this store has actually issued. Used to tell "that is not one of our order
     * numbers" apart from "we have no record of that order" — different replies,
     * and the first is far more useful to a customer who mistyped or quoted an
     * invoice reference.
     */
    async loadOrderNumberRange(shopId) {
      // One call, not the asc/desc pair this used to be: `order_number_range`
      // answers both from orders_shop_order_number_idx without reading the
      // table, and it excludes soft-deleted orders, which the two reads did not.
      const [range] = await supabaseRpc(supabase, RPC.ORDER_NUMBER_RANGE, { match_shop_id: shopId });
      if (!range || range.min_order_number === null || range.max_order_number === null) {
        return null;
      }
      return { min: range.min_order_number, max: range.max_order_number };
    },

    /** Orders for a set of numbers, plus the customers they belong to. */
    async loadOrders(shopId, orderNumbers) {
      if (orderNumbers.length === 0) {
        return { byNumber: new Map(), customersById: new Map() };
      }
      const orders = await supabaseSelectAll(
        supabase,
        T.ORDERS,
        {
          shop_id: shopId,
          order_number: { operator: 'in', value: `(${orderNumbers.join(',')})` },
          deleted_at: { operator: 'is', value: 'null' }
        },
        'id,name,order_number,customer_id,customer_email_hash,sales_channel_handle'
      );

      const customerIds = [...new Set(orders.map((o) => o.customer_id).filter(Boolean))];
      const customers = customerIds.length
        ? await supabaseSelectAll(
            supabase,
            T.CUSTOMERS,
            { id: { operator: 'in', value: `(${customerIds.join(',')})` } },
            'id,display_name,first_name,last_name,email'
          )
        : [];

      return {
        byNumber: new Map(orders.map((o) => [o.order_number, o])),
        // The address is read only to recognise Amazon's placeholder buyer and is
        // dropped here: what leaves the store is the flag, never the email.
        customersById: new Map(
          customers.map(({ email, ...c }) => [
            c.id,
            { ...c, anonymous: isAnonymousPlaceholder({ ...c, email }) }
          ])
        )
      };
    },

    /**
     * Orders carrying any of these tracking numbers, plus the customers behind
     * them — the parcel-number equivalent of `loadOrders` above.
     *
     * ONE OVERLAP QUERY FOR THE WHOLE PASS. `tracking_numbers` is a text[] with
     * a GIN index, so `ov` (PostgREST's `&&`) answers "which orders carry any of
     * these?" for every ticket at once and uses the index to do it. Reaching
     * into the `fulfillments` jsonb instead would mean scanning the table.
     *
     * Keyed by tracking number rather than by order: two tickets can quote the
     * same parcel, and one order can carry several.
     */
    async loadOrdersByTracking(shopId, trackingNumbers) {
      if (trackingNumbers.length === 0) {
        return { byTracking: new Map(), customersById: new Map() };
      }
      const orders = await supabaseSelectAll(
        supabase,
        T.ORDERS,
        {
          shop_id: shopId,
          tracking_numbers: { operator: 'ov', value: `{${trackingNumbers.join(',')}}` },
          deleted_at: { operator: 'is', value: 'null' }
        },
        'id,name,order_number,customer_id,customer_email_hash,tracking_numbers'
      );

      const byTracking = new Map();
      for (const order of orders) {
        for (const number of order.tracking_numbers || []) {
          // Only the numbers actually asked about: an order matches on one
          // parcel but may carry others, and indexing those would let a later
          // ticket appear to match a number nobody quoted.
          if (trackingNumbers.includes(number)) {
            byTracking.set(number, order);
          }
        }
      }

      const customerIds = [...new Set(orders.map((o) => o.customer_id).filter(Boolean))];
      const customers = customerIds.length
        ? await supabaseSelectAll(
            supabase,
            T.CUSTOMERS,
            { id: { operator: 'in', value: `(${customerIds.join(',')})` } },
            'id,display_name,first_name,last_name'
          )
        : [];

      return { byTracking, customersById: new Map(customers.map((c) => [c.id, c])) };
    },

    /**
     * Writes the resolution.
     *
     * The number goes on the column only when confirmed; the reasoning always
     * goes in `metadata.order_resolution`, so a null column is explained rather
     * than merely empty and a re-run can see what was already tried.
     */
    buildResolutionColumns(ticket, resolution) {
      const columns = {
        metadata: {
          ...(ticket.metadata || {}),
          order_resolution: {
            status: resolution.status,
            verified_by: resolution.verifiedBy,
            // Its own flag rather than read off `verified_by`, because a person
            // linking an Amazon order by hand reaches the same buyer by another path.
            buyer_anonymous: resolution.verifiedBy === BY_MARKETPLACE_ORDER_NUMBER,
            // Which reference found the order. Ownership is still decided by
            // `verified_by`; this says what the customer gave us to go on.
            matched_by: resolution.matchedBy || 'order_number',
            // What a human or a later drafting step should do about it —
            // typically asking which address the purchase was made with.
            suggested_action: resolution.suggestedAction || null,
            email_status: resolution.emailStatus || null,
            confirmation_markers: resolution.confirmationMarkers ?? null,
            detail: resolution.detail,
            candidates: resolution.candidates,
            resolved_at: new Date().toISOString()
          }
        }
      };
      if (isSafeToWrite(resolution.status) && resolution.orderName) {
        columns.shopify_order_number = resolution.orderName;
        Object.assign(columns, reinvestigationColumns(ticket));
      }
      return columns;
    }
  };
}

// What a newly confirmed order does to a ticket that was ALREADY investigated
// — found on `fcf4ca11`, whose case file and draft kept asking for #6669 after
// the number was hers. Shared with the dashboard's manual order link, so the
// rule is in scripts/lib/order-link.mjs; re-exported for this module's callers.
export { reinvestigationColumns };

export async function runOrderResolution({ store, record, shopId, logger, dryRun = false, onResult } = {}) {
  // The tickets and the customer's opening words come from the ticket record
  // (the words through `ticket_first_inbound`, which picks one message per
  // ticket in Postgres — this used to read every inbound body in the shop and
  // throw all but one per ticket away). `store` keeps what it genuinely owns:
  // the orders and the customers behind them.
  const [tickets, textByTicket] = await Promise.all([
    record.findAwaitingOrderNumber(),
    record.firstInboundByTicket()
  ]);
  const pending = tickets
    .filter((ticket) => textByTicket.has(ticket.id))
    .map((ticket) => ({ ticket, text: textByTicket.get(ticket.id) }));
  const totals = {
    considered: pending.length,
    [CONFIRMED]: 0,
    [NAME_MATCH]: 0,
    [MISMATCH]: 0,
    [NOT_FOUND]: 0,
    [NO_CANDIDATE]: 0,
    written: 0
  };

  // One batched order lookup for the whole pass rather than a query per ticket.
  // Tracking numbers are parsed in the same sweep — the regex is free, and
  // collecting them here is what keeps the lookup to a single extra query for
  // the whole pass instead of one per ticket that quotes a parcel.
  const allNumbers = new Set();
  const allTracking = new Set();
  const parsed = pending.map(({ ticket, text }) => {
    const candidates = shopifyOrderCandidates(text);
    for (const candidate of candidates) {
      allNumbers.add(candidate.orderNumber);
    }
    const tracking = candidates.length === 0 ? parseTrackingCandidates(text) : [];
    for (const candidate of tracking) {
      allTracking.add(candidate.trackingNumber);
    }
    return { ticket, text, candidates, tracking };
  });

  const { byNumber, customersById } = await store.loadOrders(shopId, [...allNumbers]);
  // Only for the tickets that gave us no order number: a message carrying both
  // is answered by the number, which is the reference the rest of the pipeline
  // is built on. Skipped entirely when nothing quoted a parcel.
  const { byTracking, customersById: trackingCustomers } =
    (await store.loadOrdersByTracking?.(shopId, [...allTracking])) ?? {
      byTracking: new Map(),
      customersById: new Map()
    };
  // Asked once per pass, not per ticket. Null on an empty catalogue, in which
  // case nothing is ever called out of range — an empty store has no opinion.
  const range = await store.loadOrderNumberRange?.(shopId);

  for (const { ticket, text, candidates, tracking } of parsed) {
    let resolution;

    if (candidates.length === 0) {
      // THE PARCEL NUMBER IS THE SECOND WAY IN. Somebody chasing a delivery
      // usually has the tracking number and not the order number — it is what
      // our dispatch mail put in front of them and what the carrier's site asks
      // for — and before this the ticket resolved to no order at all, which put
      // every order tool out of reach.
      //
      // IT FINDS THE ORDER; IT DOES NOT VOUCH FOR THE SENDER. The same
      // `verifyOrder` decides ownership, so a tracking match still has to clear
      // the email hash before anything is written. That is not caution for its
      // own sake: measured on this mailbox, 6 of the 8 tickets quoting a real
      // tracking number were staff threads about other people's parcels, and
      // confirming on possession of the number alone would have written six
      // wrong order numbers.
      const trackingResults = tracking
        .map((candidate) => ({ candidate, order: byTracking.get(candidate.trackingNumber) || null }))
        .filter(({ order }) => order !== null)
        .map(({ candidate, order }) => {
          const customer = order.customer_id ? trackingCustomers.get(order.customer_id) : null;
          const verdict = verifyOrder({
            order,
            ticket,
            customer,
            messageEmailHashes: messageEmailHashes(text)
          });
          return {
            ...verdict,
            detail:
              verdict.status === CONFIRMED
                ? `Matched on the tracking number ${candidate.raw}.`
                : `${verdict.detail} Found from the tracking number ${candidate.raw}.`,
            orderNumber: order.order_number,
            orderName: order.name
          };
        });

      if (trackingResults.length > 0) {
        resolution = {
          ...chooseResolution(trackingResults),
          matchedBy: 'tracking_number',
          candidates: tracking.map((c) => c.raw)
        };
      } else {
        // Naming the format matters: an internal `Q00` reference failing to match
        // is not the same as "you gave us no order number", and the reply differs.
        const others = parseOrderCandidates(text).filter((c) => c.format !== 'web');
        const unmatchedTracking = tracking.length > 0;
        resolution = {
          status: NO_CANDIDATE,
          verifiedBy: null,
          detail: unmatchedTracking
            ? `No order number; the tracking number ${tracking[0].raw} matches no order we hold.`
            : others.length
              ? `No Shopify order number; the message quotes ${others[0].raw} (${others[0].format}).`
              : 'No order number in the message.',
          candidates: unmatchedTracking
            ? tracking.map((c) => c.raw)
            : others.map((c) => c.raw),
          orderName: null
        };
      }
    } else {
      // Hashed once per ticket rather than per candidate: the addresses in the
      // message do not change between the numbers quoted in it.
      const emailHashes = messageEmailHashes(text);
      const results = candidates.map((candidate) => {
        const order = byNumber.get(candidate.orderNumber) || null;
        const customer = order?.customer_id ? customersById.get(order.customer_id) : null;
        const verdict = verifyOrder({
          order,
          ticket,
          customer,
          messageEmailHashes: emailHashes,
          // The parser deduplicates by number, so a thread repeating `6059` in
          // every quoted reply is still one order.
          soleOrderNumber: candidates.length === 1
        });
        return {
          ...verdict,
          detail: describeAgainstRange(verdict, candidate.orderNumber, order, range),
          orderNumber: candidate.orderNumber,
          orderName: order?.name || toOrderName(candidate.orderNumber)
        };
      });
      resolution = { ...chooseResolution(results), candidates: candidates.map((c) => c.raw) };

      // Recorded only on the path that needs explaining. The count does not gate
      // anything (see confirmation-evidence.mjs) — it is the discriminator a
      // human needs when reviewing a number written against a sender who does
      // not own the order: a high count is a forwarded confirmation, a zero is a
      // thread that quotes the address for some other reason.
      if (resolution.verifiedBy === BY_MESSAGE_EMAIL) {
        resolution.confirmationMarkers = countConfirmationMarkers(text);
      }
    }

    totals[resolution.status] += 1;
    onResult?.({ ticket, resolution });

    if (!dryRun) {
      await record.linkOrder(ticket.id, store.buildResolutionColumns(ticket, resolution));
      if (isSafeToWrite(resolution.status)) {
        totals.written += 1;
      }
    } else if (isSafeToWrite(resolution.status)) {
      totals.written += 1;
    }
  }

  logger?.info?.('order.resolution', { shopId, ...totals });
  return totals;
}

/**
 * How far past the newest synced order a number can be and still plausibly be
 * real rather than mistyped.
 *
 * `max` is always somewhat stale — orders are created continuously and the sync
 * runs on a schedule — so a number a little above it is routinely genuine and
 * must not be called a typo. A number far above it is a different thing: an
 * extra digit, a transposition, or an invoice reference. The margin is
 * proportional rather than fixed because a store issuing 50 orders a day drifts
 * further between syncs than one issuing five, and the absolute floor keeps the
 * proportion sane on a small or freshly-seeded catalogue.
 */
const SYNC_LAG_FACTOR = 1.25;
const SYNC_LAG_FLOOR = 500;

/**
 * Explains a "not found" using what the orders table actually holds.
 *
 * The bounds are used for what they can support and no more. A live test caught
 * an earlier version asserting that anything outside the synced span was "likely
 * not an order number at all", which it said about `#4009` — a real order absent
 * only because the store synced at the time held twelve rows. `not_found` was the right
 * status; the explanation was a claim the data could not back.
 *
 * Retention below the low end is not treated as a worry: orders older than about
 * six months are outside what this desk handles, so "older than our records" is
 * both true and sufficient there.
 */
function describeAgainstRange(verdict, orderNumber, order, range) {
  if (order || !range || verdict.status !== NOT_FOUND) {
    return verdict.detail;
  }

  if (orderNumber < range.min) {
    return (
      `No record of order ${orderNumber}. It is below the oldest order we hold ` +
      `(${range.min}), so it is likely older than the ~6 months of orders we keep.`
    );
  }

  if (orderNumber > range.max) {
    const plausibleCeiling = Math.max(range.max * SYNC_LAG_FACTOR, range.max + SYNC_LAG_FLOOR);
    if (orderNumber > plausibleCeiling) {
      return (
        `No record of order ${orderNumber}, and it is far above our newest order ` +
        `(${range.max}) — most likely a typo or a reference that is not an order number.`
      );
    }
    return (
      `No record of order ${orderNumber}. It is just above our newest order ` +
      `(${range.max}), so it may simply be too recent to have synced.`
    );
  }

  return `No record of order ${orderNumber}, though it falls within the orders we hold.`;
}
