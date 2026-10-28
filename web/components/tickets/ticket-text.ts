/** How a ticket is named on screen, shared by the queue, the rail and the header. */
import { formatRelativeTime } from "@/lib/relative-time";
import type { Translate } from "@/lib/i18n/translate";
import type { TicketListItem, TicketThread } from "@/lib/types";

export function ticketTitle(ticket: TicketListItem, t: Translate): string {
  return ticket.subject?.trim() || t("tickets.view.noSubject");
}

export function requesterName(ticket: TicketListItem, t: Translate): string {
  return ticket.customerName?.trim() || ticket.requesterName?.trim() || t("tickets.view.unknownRequester");
}

export function ticketAge(ticket: TicketListItem, t: Translate): string {
  return formatRelativeTime(ticket.lastMessageAt ?? ticket.firstMessageAt, t) || "-";
}

/** Two letters for the compact rail: first and last word of the requester's name. */
export function requesterInitials(ticket: TicketListItem, t: Translate): string {
  const parts = requesterName(ticket, t).replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : parts[0]?.slice(0, 2) || "?").toUpperCase();
}

/**
 * The address the requester is writing from: their latest inbound message's, so
 * someone who switched mailboxes mid-thread shows the one a reply goes to. Any
 * outside sender counts — a retailer or partner is the requester on its own
 * threads — and only a colleague's inbound note is skipped. The thread route
 * already ships (and audits) every sender address; the ticket list never
 * carries one, which is why this reads the thread and not the ticket.
 */
export function contactingAddress(thread: TicketThread): string | null {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const message = thread.messages[i];
    if (message.direction === "inbound" && message.role !== "internal" && message.fromEmail?.trim()) {
      return message.fromEmail.trim();
    }
  }
  return null;
}
