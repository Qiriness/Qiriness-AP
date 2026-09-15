import { AppShell } from "@/components/app-shell/AppShell";
import { TicketsView } from "@/components/tickets/TicketsView";
import { getShopId } from "@/lib/server/knowledge-service";
import { listTickets } from "@/lib/server/tickets-service";
import { listDroppedMail } from "@/lib/server/dropped-mail-service";
import type { DroppedMail, TicketListItem } from "@/lib/types";
import { navBadgeCounts } from "@/lib/server/conversation-badge";
import { logDashboardAccess } from "@/lib/server/access-log";

export const dynamic = "force-dynamic";

// The root layout's title is the Agent Setup one; without this the browser tab
// would name the wrong surface.
export const metadata = { title: "Tickets · Qiriness Support OS" };

/**
 * Tickets. Four sections over two tables: Queue, Backlog and Closed all come
 * from `tickets`, while "Irrelevant" comes from `spam_audit` — mail the gate
 * dropped is never written to `tickets` at all.
 *
 * Loads server-side for the same reason Agent Setup and Settings do: the list
 * renders with real rows on first paint instead of flashing empty. Filtering,
 * search and sort are client-side over the full set — 565 tickets is small
 * enough that paging it server-side would cost a round trip per keystroke and
 * buy nothing.
 */
export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const badges = await navBadgeCounts();
  let tickets: TicketListItem[] = [];
  let droppedMail: DroppedMail[] = [];
  let loadError: string | null = null;

  try {
    const shopId = await getShopId();
    // CONSUMER THREADS ONLY. Threads one of our own addresses opened live on
    // /conversations — `listTickets` and `listConversations` are two halves of
    // one partition on `tickets.sender_label`, so nothing can fall between them.
    //
    // This routing was tried, reverted, and re-decided: the revert found all 14
    // routed threads were the back office working customer returns, three of
    // them open at L3 behind a nav item nobody opened. The sidebar badge is what
    // answers that now. See DECISIONS.md § Tickets dashboard.
    [tickets, droppedMail] = await Promise.all([listTickets(shopId), listDroppedMail(shopId)]);
    await logDashboardAccess({
      shopId,
      action: "view",
      resourceType: "tickets",
      purpose: "support_queue",
      metadata: { surface: "tickets", tickets: tickets.length, dropped: droppedMail.length },
    });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load tickets.";
  }

  return (
    <AppShell activeHref="/tickets" {...badges}>
      <TicketsView
        initialTickets={tickets}
        droppedMail={droppedMail}
        loadError={loadError}
        initialParams={searchParams}
      />
    </AppShell>
  );
}
