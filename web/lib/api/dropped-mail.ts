/**
 * Client-side wrapper around the dropped-mail API
 * (web/app/api/dropped-mail). Mirrors ./tickets.ts: the list is fetched
 * server-side, this is for the one action a user triggers on it.
 */

import type { TicketListItem } from "@/lib/types";
import { KnowledgeApiError } from "./knowledge";

/**
 * Overturns the gate: this dropped email becomes a ticket.
 *
 * Returns the ticket in the list's own projection so the caller can drop the row
 * out of the Irrelevant section and put it in the queue in one gesture, plus
 * whether a ticket was created — a blocked reply joins the thread it belongs to
 * instead, and saying "added to the queue" about that would be wrong.
 */
export async function promoteDroppedMail(
  droppedMailId: string
): Promise<{ ticket: TicketListItem; ticketCreated: boolean }> {
  const response = await fetch(`/api/dropped-mail/${droppedMailId}/promote`, {
    method: "POST",
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KnowledgeApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  return { ticket: body.ticket as TicketListItem, ticketCreated: Boolean(body.ticketCreated) };
}
