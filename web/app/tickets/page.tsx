import { AppShell } from "@/components/app-shell/AppShell";
import { TicketsView } from "@/components/tickets/TicketsView";
import { getShopId } from "@/lib/server/knowledge-service";
import { countClosedTickets, getTicketListItem, listTickets } from "@/lib/server/tickets-service";
import { getDroppedMail, listDroppedMailPage } from "@/lib/server/dropped-mail-service";
import type { DroppedMail, TicketListItem } from "@/lib/types";
import { navBadgeCounts } from "@/lib/server/conversation-badge";
import { timed } from "@/lib/server/timing";
import { logDashboardAccess } from "@/lib/server/access-log";
import { readFreshnessItems } from "@/lib/server/insights/context";
import { FreshnessStrip } from "@/components/ui/FreshnessStrip";
import type { FreshnessItem } from "@/lib/types";
import { readSnoozeDelays } from "@/lib/server/snooze-service";
import { NO_DELAYS, type SnoozeDelays } from "@/lib/snooze";

export const dynamic = "force-dynamic";

// The root layout's title is the Agent Setup one; without this the browser tab
// would name the wrong surface.
export const metadata = { title: "Tickets" };

/**
 * Tickets. Four sections over two tables: Queue, Backlog and Closed all come
 * from `tickets`, while "Irrelevant" comes from `spam_audit` — mail the gate
 * dropped is never written to `tickets` at all.
 *
 * Loads server-side for the same reason Agent Setup and Settings do: the list
 * renders with real rows on first paint instead of flashing empty. Filtering,
 * search and sort are client-side over what is loaded.
 *
 * WHAT IS LOADED (2026-10-06): the open threads, and the first page of the
 * Irrelevant list. Closed threads are counted here and read by the Closed tab
 * when it is opened (`/api/tickets/closed`); they were 974 of 1,026 rows. The
 * Irrelevant list is paged and searched in the database (`/api/dropped-mail`).
 * A link straight to a closed ticket or to a mail beyond the first page still
 * opens: that one row is read and added.
 */
export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // Started, not awaited: the badges are read beside this page's own data
  // rather than before it. navBadgeCounts never throws.
  const badgesRead = timed("badges", navBadgeCounts());
  let tickets: TicketListItem[] = [];
  let droppedMail: DroppedMail[] = [];
  let droppedTotal = 0;
  let clearedMailCount = 0;
  let closedCount = 0;
  let loadError: string | null = null;
  let freshness: FreshnessItem[] = [];
  let snoozeDelays: SnoozeDelays = NO_DELAYS;

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
    // How current the mail and the syncs are, the same pills Insights shows:
    // a queue is only as current as the last mail read. Read beside the list.
    let droppedPage;
    [tickets, droppedPage, freshness, snoozeDelays, closedCount] = await timed(
      "tickets list",
      Promise.all([
        listTickets(shopId, { scope: "open" }),
        listDroppedMailPage(shopId),
        readFreshnessItems(shopId),
        readSnoozeDelays(shopId),
        countClosedTickets(shopId),
      ])
    );
    droppedMail = droppedPage.items;
    droppedTotal = droppedPage.total;
    clearedMailCount = droppedPage.cleared;

    // A link to one row this page did not load: read that row on its own.
    const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
    const linkedTicket = first(searchParams.ticket);
    if (linkedTicket && !tickets.some((ticket) => ticket.id === linkedTicket)) {
      const row = await getTicketListItem(shopId, linkedTicket).catch(() => null);
      if (row && !row.isOwnSide) tickets = [...tickets, row];
    }
    const linkedMail = first(searchParams.mail);
    if (linkedMail && !droppedMail.some((mail) => mail.id === linkedMail)) {
      const mail = await getDroppedMail(shopId, linkedMail).catch(() => null);
      if (mail) droppedMail = [mail, ...droppedMail];
    }
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

  const badges = await badgesRead;
  return (
    <AppShell activeHref="/tickets" {...badges}>
      <TicketsView
        initialTickets={tickets}
        droppedMail={droppedMail}
        droppedTotal={droppedTotal}
        clearedMailCount={clearedMailCount}
        closedCount={closedCount}
        loadError={loadError}
        initialParams={searchParams}
        headerAside={<FreshnessStrip items={freshness} />}
        snoozeDelays={snoozeDelays}
      />
    </AppShell>
  );
}
