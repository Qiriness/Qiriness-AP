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

import { ticketMarksByOrder } from "../../../scripts/lib/order-list-query.mjs";
import { isClosed } from "../ticket-stats";
import type { OrderTicketMark, TicketListItem } from "../types";
import { listTicketsWithOrders } from "./tickets-service";

/** Keyed by `orderNumberKey` of the order's number or name. */
export async function loadOrderTicketMarks(shopId: string): Promise<Map<string, OrderTicketMark>> {
  const tickets = await listTicketsWithOrders(shopId);
  return ticketMarksByOrder(tickets.map(ticketFacts)) as Map<string, OrderTicketMark>;
}

function ticketFacts(ticket: TicketListItem) {
  return {
    orderNumber: ticket.orderNumber,
    open: !isClosed(ticket),
    band: ticket.priorityBand,
  };
}
