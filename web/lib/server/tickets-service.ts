/**
 * Server-only ticket reader for the Tickets dashboard.
 *
 * Read-only by design. Tickets are written by the agent worker (ingestion,
 * categorisation, forwarding); this module exists so an operator can see the
 * queue those passes produced. Nothing here mutates a ticket — when triage
 * actions arrive they belong behind a Route Handler, not in the list read.
 *
 * Uses the Supabase SERVICE ROLE key for the same reason knowledge-service and
 * forwarding-service do: every table has RLS enabled with no policies, so only
 * the service role can read. Never import this from a client component.
 */

import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseSelect,
  supabaseSelectAll,
  supabaseUpdate,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { KnowledgeNotFoundError } from "./knowledge-errors";
import { summariseInvestigation, summariseOrderContext } from "../ticket-detail";
import type {
  InvestigationVerdict,
  KnowledgeCategory,
  ResponsibleTeam,
  TicketDetail,
  TicketHappiness,
  TicketLevel,
  TicketListItem,
  TicketMessage,
  TicketStatus,
  TicketThread,
} from "../types";

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

/**
 * Every live ticket, newest activity first, with its message count.
 *
 * Soft-deleted rows are excluded at the query rather than in the mapper: a
 * compliance delete must not reach the UI even if a later caller forgets to
 * filter. Archived tickets are kept — archiving drops a ticket out of the
 * active queue, and the list offers that as a filter rather than hiding it.
 *
 * Message counts come from one bulk read of `ticket_messages` rather than a
 * per-ticket count query, which would be 565 round trips on the current corpus.
 */
export async function listTickets(shopId: string): Promise<TicketListItem[]> {
  const supabase = getSupabaseClient();

  const [ticketRows, messageRows] = await Promise.all([
    supabaseSelectAll(
      supabase,
      "tickets",
      { shop_id: shopId, deleted_at: { operator: "is", value: null } },
      "id,subject,status,category,secondary_category,level,happiness,responsible_team,requester_name,shopify_order_number,first_message_at,last_message_at"
    ),
    supabaseSelectAll(
      supabase,
      "ticket_messages",
      { shop_id: shopId },
      "id,ticket_id"
    ),
  ]);

  const messageCounts = new Map<string, number>();
  for (const row of messageRows as { ticket_id: string }[]) {
    messageCounts.set(row.ticket_id, (messageCounts.get(row.ticket_id) ?? 0) + 1);
  }

  return (ticketRows as any[])
    .map((row) => mapTicketRow(row, messageCounts.get(row.id) ?? 0))
    .sort(byLastActivityDesc);
}

/**
 * What the agent made of one ticket — the expanded row under it.
 *
 * Read lazily, per ticket, rather than joined into `listTickets`: the queue is
 * 565 rows and an operator opens one at a time, so shipping every case file with
 * the list would be paying for 564 nobody looked at.
 *
 * THE LATEST RUN ONLY. A ticket is investigated once per inbound message, so a
 * thread holds a row per reading; the panel answers "where does this stand
 * now", which is the newest. The earlier rows stay on the table — the trajectory
 * is why they are rows — and are simply not what this view asks for.
 *
 * The ticket is read alongside it — not only so an id that is not this shop's is
 * a 404 rather than an indistinguishable "nothing investigated yet", but because
 * `resolved_context` is the other half of the panel. The order and tracking
 * lines exist for tickets the agent never investigated, and the case file exists
 * for tickets with no order at all, so neither read can stand in for the other.
 */
export async function getTicketDetail(shopId: string, ticketId: string): Promise<TicketDetail> {
  const supabase = getSupabaseClient();

  const [ticketRows, investigationRows] = await Promise.all([
    supabaseSelect(
      supabase,
      "tickets",
      { id: ticketId, shop_id: shopId, deleted_at: { operator: "is", value: null } },
      "id,resolved_context",
      { limit: 1 }
    ),
    supabaseSelect(
      supabase,
      "ticket_investigations",
      { ticket_id: ticketId, shop_id: shopId },
      "verdict,established,missing,handoff,investigated_at",
      { order: "investigated_at.desc", limit: 1 }
    ),
  ]);

  if (!Array.isArray(ticketRows) || ticketRows.length === 0) {
    throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);
  }

  // `{}` on every ticket without a confirmed order number, which the projection
  // reads as "no order facts" rather than as a bundle full of nulls.
  const order = summariseOrderContext(ticketRows[0]?.resolved_context);

  const row = Array.isArray(investigationRows) ? investigationRows[0] : null;
  if (!row) {
    return { ticketId, results: null, order };
  }

  return {
    ticketId,
    order,
    results: summariseInvestigation({
      verdict: row.verdict as InvestigationVerdict,
      // The jsonb columns are `not null default '[]'`, so these are arrays in
      // practice; coerced anyway because a mapper that trusts the schema breaks
      // loudly in the UI when the schema is the thing that changed.
      established: Array.isArray(row.established) ? row.established : [],
      missing: Array.isArray(row.missing) ? row.missing : [],
      handoff: row.handoff ?? null,
      investigatedAt: row.investigated_at ?? null,
    }),
  };
}

/**
 * The whole conversation on one ticket, oldest first — what the thread dialog
 * shows so an operator can read a case without opening Outlook.
 *
 * SEPARATE FROM `getTicketDetail`, and not folded into it: the bodies are the
 * largest thing this table holds and the panel under a row never shows them.
 * A dialog is opened deliberately, on one ticket, so the bodies are fetched
 * then and not on every row expansion.
 *
 * BOTH DIRECTIONS. The Inbox holds the desk's own replies too (measured: 123 of
 * 348 messages), and a thread showing only what the customer wrote is exactly
 * the half that makes flicking to Outlook necessary.
 *
 * Soft-deleted messages are excluded at the query, like the ticket list: a
 * compliance delete must not reach the UI through a caller that forgot.
 */
export async function getTicketThread(shopId: string, ticketId: string): Promise<TicketThread> {
  const supabase = getSupabaseClient();

  const [ticketRows, messageRows] = await Promise.all([
    supabaseSelect(
      supabase,
      "tickets",
      { id: ticketId, shop_id: shopId, deleted_at: { operator: "is", value: null } },
      "id,subject",
      { limit: 1 }
    ),
    supabaseSelectAll(
      supabase,
      "ticket_messages",
      { ticket_id: ticketId, shop_id: shopId, deleted_at: { operator: "is", value: null } },
      "id,direction,from_name,from_email,subject,body_text,has_attachments,received_at,sent_at"
    ),
  ]);

  if (!Array.isArray(ticketRows) || ticketRows.length === 0) {
    throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);
  }

  const messages = (messageRows as any[]).map(mapMessageRow).sort(byTimeAsc);

  return {
    ticketId,
    subject: ticketRows[0]?.subject ?? null,
    // Phase 5. Nothing writes a draft yet — see the type's note.
    draft: null,
    messages,
  };
}

/** Oldest first: a conversation reads downwards, unlike the queue. */
function byTimeAsc(a: TicketMessage, b: TicketMessage): number {
  return (Date.parse(a.at ?? "") || 0) - (Date.parse(b.at ?? "") || 0);
}

function mapMessageRow(row: any): TicketMessage {
  return {
    id: row.id,
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    fromName: row.from_name ?? null,
    fromEmail: row.from_email ?? null,
    subject: row.subject ?? null,
    body: row.body_text ?? null,
    hasAttachments: Boolean(row.has_attachments),
    // Our own replies carry `sent_at` and nothing else; inbound carries
    // `received_at`. One column would leave half the thread undated.
    at: row.received_at ?? row.sent_at ?? null,
  };
}

/**
 * Moves a ticket between the queue and the closed section.
 *
 * Only these three statuses are reachable from the dashboard. The rest
 * (`awaiting_customer`, `forwarded`, `spam`…) are the worker's to set from what
 * it observed; letting an operator assert them by hand would put the UI and the
 * pipeline in disagreement about what actually happened.
 *
 * The lifecycle timestamps are maintained alongside the status rather than left
 * to drift: `closed_at` and `resolved_at` are what retention reads.
 */
export async function setTicketStatus(
  shopId: string,
  ticketId: string,
  status: "open" | "resolved" | "closed"
): Promise<TicketListItem> {
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  const patch: Record<string, unknown> = { status, updated_at: now };
  if (status === "closed") {
    patch.closed_at = now;
  } else if (status === "resolved") {
    patch.resolved_at = now;
  } else {
    // Reopening clears both, or a reopened ticket would still look finished to
    // anything reading the timestamps rather than the status.
    patch.closed_at = null;
    patch.resolved_at = null;
  }

  // Scoped by shop as well as id: an id alone would let one shop's request
  // touch another's row.
  const updated = await supabaseUpdate(supabase, "tickets", { id: ticketId, shop_id: shopId }, patch);
  const row = Array.isArray(updated) ? updated[0] : updated;
  if (!row) {
    throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);
  }

  // Message count is not re-read: the caller already has it, and a status flip
  // cannot change it.
  return mapTicketRow(row, 0);
}

/** Newest activity first, falling back to arrival for a ticket with neither. */
function byLastActivityDesc(a: TicketListItem, b: TicketListItem): number {
  const at = Date.parse(a.lastMessageAt ?? a.firstMessageAt ?? "") || 0;
  const bt = Date.parse(b.lastMessageAt ?? b.firstMessageAt ?? "") || 0;
  return bt - at;
}

function mapTicketRow(row: any, messageCount: number): TicketListItem {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status as TicketStatus,
    category: (row.category as KnowledgeCategory) ?? null,
    secondaryCategory: (row.secondary_category as KnowledgeCategory) ?? null,
    // level is a smallint and nullable until the categoriser has run.
    level: row.level === null || row.level === undefined ? null : (Number(row.level) as TicketLevel),
    // Same shape as level: a smallint that stays null until the categoriser has
    // read the mail. Null is "not scored yet", not "neutral".
    happiness:
      row.happiness === null || row.happiness === undefined
        ? null
        : (Number(row.happiness) as TicketHappiness),
    responsibleTeam: (row.responsible_team as ResponsibleTeam) ?? null,
    requesterName: row.requester_name,
    orderNumber: row.shopify_order_number,
    messageCount,
    firstMessageAt: row.first_message_at,
    lastMessageAt: row.last_message_at,
  };
}
