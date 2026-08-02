import {
  supabaseSelectAll,
  supabaseUpdateById
} from '../../../scripts/lib/supabase-rest-client.mjs';

import { shopifyOrderCandidates, parseOrderCandidates, toOrderName } from './order-number-parser.mjs';
import {
  CONFIRMED,
  MISMATCH,
  NAME_MATCH,
  NOT_FOUND,
  NO_CANDIDATE,
  chooseResolution,
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
    /**
     * Tickets with no order number yet.
     *
     * Bounded per pass rather than unbounded: like the categoriser, this selects
     * on ticket state instead of on what the current poll wrote, so anything
     * missed is caught up next time and a single pass never has to be complete.
     */
    async findUnresolved(shopId, { limit = 500 } = {}) {
      const tickets = await supabaseSelectAll(
        supabase,
        'tickets',
        {
          shop_id: shopId,
          shopify_order_number: { operator: 'is', value: 'null' },
          deleted_at: { operator: 'is', value: 'null' }
        },
        'id,subject,category,request_kind,requester_email_hash,requester_name,metadata',
        { limit }
      );
      if (tickets.length === 0) {
        return [];
      }

      // First inbound message per ticket: the customer's own words, already
      // stripped of quoted reply chains upstream. Quoted history is exactly
      // where stale order numbers from previous threads live.
      const messages = await supabaseSelectAll(
        supabase,
        'ticket_messages',
        { shop_id: shopId, direction: 'inbound', deleted_at: { operator: 'is', value: 'null' } },
        'ticket_id,subject,body_text,received_at',
        { order: 'received_at.asc' }
      );
      const textByTicket = new Map();
      for (const message of messages) {
        if (!textByTicket.has(message.ticket_id)) {
          textByTicket.set(message.ticket_id, `${message.subject || ''}\n${message.body_text || ''}`);
        }
      }

      return tickets
        .filter((ticket) => textByTicket.has(ticket.id))
        .map((ticket) => ({ ticket, text: textByTicket.get(ticket.id) }));
    },

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
      const [lowest] = await supabaseSelectAll(
        supabase,
        'orders',
        { shop_id: shopId, order_number: { operator: 'not.is', value: 'null' } },
        'order_number',
        { order: 'order_number.asc', limit: 1 }
      );
      const [highest] = await supabaseSelectAll(
        supabase,
        'orders',
        { shop_id: shopId, order_number: { operator: 'not.is', value: 'null' } },
        'order_number',
        { order: 'order_number.desc', limit: 1 }
      );
      if (!lowest || !highest) {
        return null;
      }
      return { min: lowest.order_number, max: highest.order_number };
    },

    /** Orders for a set of numbers, plus the customers they belong to. */
    async loadOrders(shopId, orderNumbers) {
      if (orderNumbers.length === 0) {
        return { byNumber: new Map(), customersById: new Map() };
      }
      const orders = await supabaseSelectAll(
        supabase,
        'orders',
        {
          shop_id: shopId,
          order_number: { operator: 'in', value: `(${orderNumbers.join(',')})` },
          deleted_at: { operator: 'is', value: 'null' }
        },
        'id,name,order_number,customer_id,customer_email_hash'
      );

      const customerIds = [...new Set(orders.map((o) => o.customer_id).filter(Boolean))];
      const customers = customerIds.length
        ? await supabaseSelectAll(
            supabase,
            'customers',
            { id: { operator: 'in', value: `(${customerIds.join(',')})` } },
            'id,display_name,first_name,last_name'
          )
        : [];

      return {
        byNumber: new Map(orders.map((o) => [o.order_number, o])),
        customersById: new Map(customers.map((c) => [c.id, c]))
      };
    },

    /**
     * Writes the resolution.
     *
     * The number goes on the column only when confirmed; the reasoning always
     * goes in `metadata.order_resolution`, so a null column is explained rather
     * than merely empty and a re-run can see what was already tried.
     */
    async recordResolution(ticket, resolution) {
      const patch = {
        metadata: {
          ...(ticket.metadata || {}),
          order_resolution: {
            status: resolution.status,
            verified_by: resolution.verifiedBy,
            // What a human or a later drafting step should do about it —
            // typically asking which address the purchase was made with.
            suggested_action: resolution.suggestedAction || null,
            email_status: resolution.emailStatus || null,
            detail: resolution.detail,
            candidates: resolution.candidates,
            resolved_at: new Date().toISOString()
          }
        }
      };
      if (isSafeToWrite(resolution.status) && resolution.orderName) {
        patch.shopify_order_number = resolution.orderName;
      }
      await supabaseUpdateById(supabase, 'tickets', ticket.id, patch);
    }
  };
}

export async function runOrderResolution({ store, shopId, logger, dryRun = false, onResult } = {}) {
  const pending = await store.findUnresolved(shopId);
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
  const allNumbers = new Set();
  const parsed = pending.map(({ ticket, text }) => {
    const candidates = shopifyOrderCandidates(text);
    for (const candidate of candidates) {
      allNumbers.add(candidate.orderNumber);
    }
    return { ticket, text, candidates };
  });

  const { byNumber, customersById } = await store.loadOrders(shopId, [...allNumbers]);
  // Asked once per pass, not per ticket. Null on an empty catalogue, in which
  // case nothing is ever called out of range — an empty store has no opinion.
  const range = await store.loadOrderNumberRange?.(shopId);

  for (const { ticket, text, candidates } of parsed) {
    let resolution;

    if (candidates.length === 0) {
      // Naming the format matters: an internal `Q00` reference failing to match
      // is not the same as "you gave us no order number", and the reply differs.
      const others = parseOrderCandidates(text).filter((c) => c.format !== 'web');
      resolution = {
        status: NO_CANDIDATE,
        verifiedBy: null,
        detail: others.length
          ? `No Shopify order number; the message quotes ${others[0].raw} (${others[0].format}).`
          : 'No order number in the message.',
        candidates: others.map((c) => c.raw),
        orderName: null
      };
    } else {
      const results = candidates.map((candidate) => {
        const order = byNumber.get(candidate.orderNumber) || null;
        const customer = order?.customer_id ? customersById.get(order.customer_id) : null;
        const verdict = verifyOrder({ order, ticket, customer });
        return {
          ...verdict,
          detail: describeAgainstRange(verdict, candidate.orderNumber, order, range),
          orderNumber: candidate.orderNumber,
          orderName: order?.name || toOrderName(candidate.orderNumber)
        };
      });
      resolution = { ...chooseResolution(results), candidates: candidates.map((c) => c.raw) };
    }

    totals[resolution.status] += 1;
    onResult?.({ ticket, resolution });

    if (!dryRun) {
      await store.recordResolution(ticket, resolution);
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
 * only because the dev store holds twelve rows. `not_found` was the right
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
