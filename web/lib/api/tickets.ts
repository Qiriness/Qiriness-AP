/**
 * Client-side wrapper around the Tickets API (web/app/api/tickets).
 * Mirrors ./knowledge.ts and ./forwarding.ts: the list is fetched server-side,
 * this is for the status changes a user triggers.
 */

import type {
  TicketDetail,
  TicketDraft,
  TicketListItem,
  TicketOrderChange,
  TicketOrderLinkSource,
  TicketOrderPreview,
  TicketThread,
} from "@/lib/types";
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

/**
 * Records what a reviewer decided about the drafted reply.
 *
 * `edited` carries the rewrite, and that pair — what the agent wrote, what a
 * person sent instead — is appended to `ticket_draft_edits` server-side. It is
 * the only thing in this app written specifically to be learned from later.
 *
 * Returns the updated draft so the dialog can replace what it was showing
 * without refetching the whole thread.
 */
export async function decideOnDraft(
  ticketId: string,
  decision: { status: "approved" | "edited" | "rejected"; approvedBody?: string | null },
): Promise<TicketDraft> {
  const response = await fetch(`/api/tickets/${ticketId}/draft`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(decision),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KnowledgeApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  return body.draft as TicketDraft;
}

/** The order a person typed, before they commit to linking it. */
export async function previewTicketOrder(ticketId: string, number: string): Promise<TicketOrderPreview> {
  const response = await fetch(
    `/api/tickets/${ticketId}/order?number=${encodeURIComponent(number)}`,
    { cache: "no-store" }
  );

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KnowledgeApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  return body.preview as TicketOrderPreview;
}

/**
 * Links the order and queues the investigation again.
 *
 * `expected` is the order the popup was opened on: the server refuses the change
 * if the ticket moved on meanwhile, rather than overwrite what someone else set.
 */
export async function changeTicketOrder(
  ticketId: string,
  change: { number: string; expected: string | null; source: TicketOrderLinkSource },
): Promise<TicketOrderChange> {
  const response = await fetch(`/api/tickets/${ticketId}/order`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KnowledgeApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  return body as TicketOrderChange;
}
