import { getShopId } from "@/lib/server/knowledge-service";
import { countOpenThreads } from "@/lib/server/tickets-service";

export interface NavBadgeCounts {
  openTickets: number;
  openConversations: number;
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
  try {
    return await countOpenThreads(await getShopId());
  } catch {
    return { openTickets: 0, openConversations: 0 };
  }
}
