/**
 * Client-side wrapper around the Tickets API (web/app/api/tickets).
 * Mirrors ./knowledge.ts and ./forwarding.ts: the list is fetched server-side,
 * this is for the status changes a user triggers.
 */

import type { TicketListItem } from "@/lib/types";
import { KnowledgeApiError } from "./knowledge";

export async function setTicketStatus(
  ticketId: string,
  status: "open" | "resolved" | "closed"
): Promise<TicketListItem> {
  const response = await fetch(`/api/tickets/${ticketId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KnowledgeApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  return body.ticket as TicketListItem;
}
