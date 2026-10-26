/**
 * Each order's open tickets, as the ring around the customer's name — on the
 * Orders page and on the Fulfilment panel's orders waiting to ship.
 *
 * THE BAND IS THE QUEUE'S, not a second judgement: each ticket arrives from
 * `listTicketsWithOrders` carrying the `priorityBand` /tickets shows, and
 * `ticketMarksByOrder` only folds them per order, so the two pages cannot ring
 * one order in two colours.
 *
 * Server-only.
 */

import { unstable_cache } from "next/cache";
import { ticketMarksByOrder } from "../../../scripts/lib/order-list-query.mjs";
import { isClosed } from "../ticket-stats";
import type { OrderTicketMark, TicketListItem } from "../types";
import { CACHE_TAGS } from "./cache-tags";
import { listTicketsWithOrders } from "./tickets-service";

/**
 * THE MARKS ARE SHARED FOR A MINUTE, like the sidebar badges. Building them
 * reads the whole ticket queue (several reads in sequence), which was 3.4–6 s of
 * every Fulfilment render, cached or not (measured 2026-10-26), and the panel is
 * prefetched behind every other tab. A mark holds an order number, a band and a
 * count, nothing about a person. A ticket changed in the dashboard clears it
 * (`ticketsChanged`); mail the worker stores shows within the minute.
 */
const cachedMarks = unstable_cache(
  async (shopId: string): Promise<[string, OrderTicketMark][]> => {
    const tickets = await listTicketsWithOrders(shopId);
    return [...(ticketMarksByOrder(tickets.map(ticketFacts)) as Map<string, OrderTicketMark>)];
  },
  ["order-ticket-marks"],
  { revalidate: 60, tags: [CACHE_TAGS.tickets] }
);

/** Keyed by `orderNumberKey` of the order's number or name. */
export async function loadOrderTicketMarks(shopId: string): Promise<Map<string, OrderTicketMark>> {
  return new Map(await cachedMarks(shopId));
}

function ticketFacts(ticket: TicketListItem) {
  return {
    orderNumber: ticket.orderNumber,
    open: !isClosed(ticket),
    band: ticket.priorityBand,
  };
}
