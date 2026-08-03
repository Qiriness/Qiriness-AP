import { AppShell } from "@/components/app-shell/AppShell";
import { TicketsView } from "@/components/tickets/TicketsView";
import { getShopId } from "@/lib/server/knowledge-service";
import { listTickets } from "@/lib/server/tickets-service";
import { listDroppedMail } from "@/lib/server/dropped-mail-service";
import type { DroppedMail, TicketListItem } from "@/lib/types";

export const dynamic = "force-dynamic";

// The root layout's title is the Agent Setup one; without this the browser tab
// would name the wrong surface.
export const metadata = { title: "Tickets · Qiriness Support OS" };

/**
 * Tickets. Three sections over two tables: the live queue and everything closed
 * both come from `tickets`, while the middle "irrelevant" section comes from
 * `spam_audit` — mail the gate dropped is never written to `tickets` at all.
 *
 * Loads server-side for the same reason Agent Setup and Settings do: the list
 * renders with real rows on first paint instead of flashing empty. Filtering,
 * search and sort are client-side over the full set — 565 tickets is small
 * enough that paging it server-side would cost a round trip per keystroke and
 * buy nothing.
 */
export default async function TicketsPage() {
  let tickets: TicketListItem[] = [];
  let droppedMail: DroppedMail[] = [];
  let loadError: string | null = null;

  try {
    const shopId = await getShopId();
    [tickets, droppedMail] = await Promise.all([listTickets(shopId), listDroppedMail(shopId)]);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load tickets.";
  }

  return (
    <AppShell activeHref="/tickets">
      <TicketsView initialTickets={tickets} droppedMail={droppedMail} loadError={loadError} />
    </AppShell>
  );
}
