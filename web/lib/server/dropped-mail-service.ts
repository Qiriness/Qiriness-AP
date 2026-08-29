/**
 * Server-only reader for mail the spam gate DROPPED, and the one write that
 * overturns a drop.
 *
 * This is deliberately not a ticket reader. Dropped mail is never written to
 * `tickets` — the gate runs before the ticket write (see
 * agent/src/ingestion/delta-poller.mjs: "spam is dropped here — never written
 * to the database"), so the only trace is one `spam_audit` row per decision.
 * That row carries the sender, subject, a one-line reason and — since
 * 04_support.sql — the cleaned body, because the one question a reviewer
 * has is "should this have become a ticket?" and a subject line does not answer
 * it. The body has a bounded life (the worker nulls it past `body_expires_at`)
 * while the decision row is kept, so an older row legitimately has none.
 *
 * `promoteDroppedMail` is the answer to that question when it turns out to be
 * yes. It used to be impossible — promoting meant the agent re-fetching the
 * message from Graph, which the mailbox-id mismatch blocks — and the stored body
 * is what removed the need: everything `ticket_messages` wants is already in the
 * row. The write itself belongs to ingestion and is ingestion's
 * (`agent/src/ingestion/promote-dropped-mail.mjs`); what lives here is reading
 * the row, building the two collaborators, and mapping the failures onto HTTP.
 *
 * NOTHING HERE EVER EDITS AN AUDIT ROW. The gate's decision stands as it was
 * made — that is what the table is for — so "promoted" is derived, not stored:
 * a blocked row whose `graph_message_id` now exists in `ticket_messages` became
 * a ticket, and drops out of the list on that basis.
 *
 * Service-role key, same reason as the sibling services. Never import from a
 * client component.
 */

import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseSelectAll,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { createTicketRecord } from "../../../scripts/lib/ticket-record.mjs";
import { T } from "../../../scripts/lib/tables.mjs";
import {
  OWN_SIDE_LABELS,
  createSenderDirectoryStore,
} from "../../../agent/src/ingestion/sender-directory.mjs";
import { createSupabaseMessageStore } from "../../../agent/src/ingestion/ticket-writer.mjs";
import {
  DroppedMailPromotionError,
  promoteDroppedMail as writePromotedMail,
} from "../../../agent/src/ingestion/promote-dropped-mail.mjs";
import type { DroppedMail, TicketListItem } from "../types";
import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";
import { getTicketListItem, parcelsInText } from "./tickets-service";

/** What the list and the promotion both read off `spam_audit`. */
const AUDIT_COLUMNS =
  "id,graph_message_id,graph_conversation_id,outcome,label,decided_by,reason," +
  "from_email,subject,body_text,body_captured_at,body_expires_at,failed_open,decided_at";

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

/**
 * Every blocked decision that is still a drop, most recent first.
 *
 * Filtered on `outcome = 'blocked'` rather than on `label = 'irrelevant'`: the
 * blocklist pass writes no label at all, and the `irrelevant` label predates the
 * change that made it drop, so every row currently carrying it was in fact kept.
 * Blocked is the only field that reliably means "this never became a ticket".
 *
 * MINUS THE ONES SOMEBODY PROMOTED, and that subtraction is how a promotion is
 * recorded at all. There is no `promoted_at` column, deliberately: adding one
 * means an `alter table … add column` by hand on a populated table, which the
 * baseline forbids for the same reason the drafting queue is derived rather than
 * flagged. The existence of a `ticket_messages` row with that
 * `graph_message_id` IS the record, it cannot disagree with itself, and it is
 * one query over 49 rows.
 */
export async function listDroppedMail(shopId: string): Promise<DroppedMail[]> {
  const supabase = getSupabaseClient();

  const rows = (await supabaseSelectAll(
    supabase,
    T.SPAM_AUDIT,
    { shop_id: shopId, outcome: { operator: "eq", value: "blocked" } },
    AUDIT_COLUMNS
  )) as any[];

  const promoted = await promotedMessageIds(
    supabase,
    shopId,
    rows.map((row) => row.graph_message_id)
  );

  const mail = rows
    .filter((row) => !promoted.has(row.graph_message_id))
    .map(mapDroppedMail)
    .sort((a, b) => (Date.parse(b.decidedAt ?? "") || 0) - (Date.parse(a.decidedAt ?? "") || 0));

  // ONE LOOKUP FOR THE WHOLE SECTION, not one per dialog opened. A dropped mail
  // has no ticket and no confirmed order, so the only route to a tracking link
  // is the number in its own text — and a message the gate refused is exactly
  // where "should this have become a ticket?" is the question, which a parcel we
  // recognise helps answer. Shared across rows deliberately: `splitTrackingText`
  // links only numbers a given text actually contains, so one list cannot put
  // another mail's parcel into this one.
  const parcels = await parcelsInText(shopId, mail.map((item) => item.body), []);
  return parcels.length === 0 ? mail : mail.map((item) => ({ ...item, parcels }));
}

/**
 * Which of these dropped messages are already stored as ticket messages.
 *
 * One `in.()` query, not one per row. The candidate set is bounded by the
 * blocked decisions (49 on this corpus) rather than by the mailbox, which is
 * what makes the derived approach affordable — the same reasoning as
 * `withoutDrafts()`.
 */
async function promotedMessageIds(
  supabase: unknown,
  shopId: string,
  graphMessageIds: string[]
): Promise<Set<string>> {
  const ids = graphMessageIds.filter(Boolean);
  if (ids.length === 0) {
    return new Set();
  }

  const rows = (await supabaseSelectAll(
    supabase,
    T.TICKET_MESSAGES,
    {
      shop_id: shopId,
      graph_message_id: { operator: "in", value: `(${ids.map((id) => `"${id}"`).join(",")})` },
    },
    "graph_message_id"
  )) as any[];

  return new Set(rows.map((row) => row.graph_message_id));
}

/**
 * Overturns one drop: the email becomes a ticket, and the agent picks it up.
 *
 * WHAT MAKES THE WORKFLOW RUN is the ticket's own state, not a call from here.
 * Every pass in the poll drains a queue defined by ticket state rather than by
 * what the poll just wrote — `needs_categorisation` is set true on the write, so
 * the next poll (60s by default) categorises it, resolves its customer, then
 * investigates, resolves an order number and builds its context bundle, exactly
 * as it would have done had the gate never dropped it. Drafting is its own pass
 * (`npm run draft`) and is not part of the poll.
 *
 * The spam label is dropped in the only sense that means anything: the audit row
 * stands, and the email stops being a dropped email and becomes a ticket. What
 * this does NOT do is change the gate's future behaviour — if a blocklist rule
 * or the classifier dropped this sender, the next email from them is dropped
 * too. That is a blocklist edit or a `sender_directory` row, both of which are
 * decisions about a sender rather than about this email.
 */
export async function promoteDroppedMail(
  shopId: string,
  auditId: string
): Promise<{ ticket: TicketListItem; ticketCreated: boolean }> {
  const supabase = getSupabaseClient();

  const rows = (await supabaseSelectAll(
    supabase,
    T.SPAM_AUDIT,
    { shop_id: shopId, id: auditId },
    AUDIT_COLUMNS
  )) as any[];
  const auditRow = rows[0];
  if (!auditRow) {
    throw new KnowledgeNotFoundError(`Dropped mail not found: ${auditId}`);
  }

  // The sender directory decides whether this thread is ours or a customer's,
  // and it is stamped once at creation — the same lookup the worker does, so a
  // promoted internal thread lands on /conversations rather than in the queue.
  const directory = await createSenderDirectoryStore(supabase).load(shopId, {
    supportMailbox: process.env.SUPPORT_MAILBOX || undefined,
  });

  try {
    const { ticketId, ticketCreated } = await writePromotedMail({
      store: createSupabaseMessageStore(supabase),
      record: createTicketRecord(supabase, { shopId }),
      shopId,
      auditRow,
      senderLabel: (fromEmail: string | null) => {
        const label = directory.lookup(fromEmail)?.label ?? null;
        return OWN_SIDE_LABELS.includes(label) ? label : null;
      },
    });

    return { ticket: await getTicketListItem(shopId, ticketId), ticketCreated };
  } catch (error) {
    // A refusal is about the row, not about the request being malformed twice
    // over — a 400 with the module's own sentence is what the dashboard shows.
    if (error instanceof DroppedMailPromotionError) {
      throw new KnowledgeValidationError(error.message);
    }
    throw error;
  }
}

function mapDroppedMail(row: any): DroppedMail {
  return {
    id: row.id,
    graphMessageId: row.graph_message_id,
    label: row.label ?? null,
    decidedBy: row.decided_by,
    reason: row.reason,
    fromEmail: row.from_email,
    subject: row.subject,
    body: row.body_text ?? null,
    bodyCapturedAt: row.body_captured_at ?? null,
    bodyExpiresAt: row.body_expires_at ?? null,
    failedOpen: Boolean(row.failed_open),
    decidedAt: row.decided_at,
    // Filled in for the whole list at once below; a row on its own has no way
    // to look one up and no business making a query to do it.
    parcels: [],
  };
}
