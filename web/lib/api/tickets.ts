/**
 * Client-side wrapper around the Tickets API (web/app/api/tickets).
 * Mirrors ./knowledge.ts and ./forwarding.ts: the list is fetched server-side,
 * this is for the status changes a user triggers.
 */

import type { TicketDetail, TicketListItem, TicketThread } from "@/lib/types";
import { KnowledgeApiError } from "./knowledge";

/**
 * The agent's reading of one ticket, fetched when its row is expanded.
 *
 * Not cached here: the worker rewrites a case file whenever the customer
 * replies, so re-opening a row asks again rather than showing what was true the
 * first time it was opened.
 */
export async function fetchTicketDetail(ticketId: string): Promise<TicketDetail> {
  const response = await fetch(`/api/tickets/${ticketId}`, { cache: "no-store" });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KnowledgeApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  return body.detail as TicketDetail;
}

/**
 * The whole conversation on one ticket, fetched when the thread dialog opens.
 *
 * Same no-store reasoning as the case file, and one more: the worker is still
 * ingesting while the dashboard is open, so a cached thread would be missing
 * the reply that arrived a minute ago — the exact thing somebody opens this to
 * check.
 */
export async function fetchTicketThread(ticketId: string): Promise<TicketThread> {
  const response = await fetch(`/api/tickets/${ticketId}/thread`, { cache: "no-store" });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KnowledgeApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  return body.thread as TicketThread;
}

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
