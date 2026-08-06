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
import { summariseInvestigation } from "../ticket-detail";
import type {
  InvestigationVerdict,
  KnowledgeCategory,
  ResponsibleTeam,
  TicketDetail,
  TicketHappiness,
  TicketLevel,
  TicketListItem,
  TicketStatus,
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
 * The ticket is read alongside it so an id that is not this shop's is a 404
 * rather than an indistinguishable "nothing investigated yet".
 */
export async function getTicketDetail(shopId: string, ticketId: string): Promise<TicketDetail> {
  const supabase = getSupabaseClient();

  const [ticketRows, investigationRows] = await Promise.all([
    supabaseSelect(
      supabase,
      "tickets",
      { id: ticketId, shop_id: shopId, deleted_at: { operator: "is", value: null } },
      "id",
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

  const row = Array.isArray(investigationRows) ? investigationRows[0] : null;
  if (!row) {
    return { ticketId, results: null };
  }

  return {
    ticketId,
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
