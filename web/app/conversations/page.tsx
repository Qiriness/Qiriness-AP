import { AppShell } from "@/components/app-shell/AppShell";
import { ConversationsView } from "@/components/tickets/ConversationsView";
import { getShopId } from "@/lib/server/knowledge-service";
import { listConversations } from "@/lib/server/tickets-service";
import { navBadgeCounts, type NavBadgeCounts } from "@/lib/server/conversation-badge";
import { logDashboardAccess } from "@/lib/server/access-log";
import type { TicketListItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata = { title: "Conversations · Qiriness Support OS" };

/**
 * Conversations — threads one of OUR OWN addresses opened: a colleague
 * forwarding a customer's problem in, the back office coordinating a return,
 * somebody logging a phone call.
 *
 * THE OTHER HALF OF THE TICKETS QUEUE, not a filter over it. `listConversations`
 * and `listTickets` come from one partition on `tickets.sender_label`, so a
 * thread is on exactly one of the two pages and can never be on neither.
 *
 * ROUTING THESE OUT WAS TRIED, REVERTED, AND RE-DECIDED. The revert was measured:
 * every routed thread was real customer work and three were open at L3 behind a
 * nav item nobody opened. That cost is accepted this time, and the sidebar badge
 * is what pays it down — the open count travels to the nav so this page asks for
 * attention rather than waiting to be found. See DECISIONS.md § Tickets dashboard.
 */
export default async function ConversationsPage() {
  let conversations: TicketListItem[] = [];
  let badges: NavBadgeCounts = { openTickets: 0, openConversations: 0 };
  let loadError: string | null = null;

  try {
    const shopId = await getShopId();
    conversations = await listConversations(shopId);
    await logDashboardAccess({
      shopId,
      action: "view",
      resourceType: "tickets",
      purpose: "support_queue",
      metadata: { surface: "conversations", tickets: conversations.length },
    });
    badges = await navBadgeCounts();
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load conversations.";
  }

  return (
    <AppShell activeHref="/conversations" {...badges}>
      <ConversationsView conversations={conversations} loadError={loadError} />
    </AppShell>
  );
}
