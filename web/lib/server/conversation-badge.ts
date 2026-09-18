import { getShopId } from "@/lib/server/knowledge-service";
import { countOrdersAwaitingFulfilment } from "@/lib/server/orders-service";
import { countOpenThreads } from "@/lib/server/tickets-service";

export interface NavBadgeCounts {
  openTickets: number;
  openConversations: number;
  /** Orders waiting to ship, by `open_orders()`'s rule. */
  unfulfilledOrders: number;
}

/**
 * The open Tickets and Conversations counts for the sidebar, for any page that
 * renders the shell.
 *
 * EVERY PAGE, NOT JUST THE TWO THAT CARE. The Conversations badge exists because
 * those threads left the Tickets queue, and the documented way that fails is
 * silently — three L3 threads awaiting a human behind a nav item nobody opened.
 * A badge visible only from Conversations would be a sign hung inside the room
 * it points to.
 *
 * NEVER THROWS. A page must not fail to render because a decorative count could
 * not be read; a missing badge degrades to the arrangement we already had.
 */
export async function navBadgeCounts(): Promise<NavBadgeCounts> {
  let shopId: string;
  try {
    shopId = await getShopId();
  } catch {
    return { openTickets: 0, openConversations: 0, unfulfilledOrders: 0 };
  }
  // Side by side, and each failing on its own: an orders count that could not
  // be read must not hide the ticket badges, or the other way round.
  const [threads, unfulfilledOrders] = await Promise.all([
    countOpenThreads(shopId).catch(() => ({ openTickets: 0, openConversations: 0 })),
    countOrdersAwaitingFulfilment(shopId).catch(() => 0),
  ]);
  return { ...threads, unfulfilledOrders };
}
