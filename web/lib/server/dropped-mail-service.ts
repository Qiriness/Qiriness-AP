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
  supabaseDelete,
  supabaseHeaders,
  supabaseSelectAll,
  supabaseUpsert,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { createTicketRecord } from "../../../scripts/lib/ticket-record.mjs";
import { T, V } from "../../../scripts/lib/tables.mjs";
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

/**
 * The list's columns: what `mapDroppedMail` reads, minus the text, which the
 * dialog reads on its own. Not the conversation id or the outcome (always
 * « blocked » here), which nothing in the list shows.
 */
const LIST_COLUMNS =
  "id,graph_message_id,label,decided_by,reason," +
  "from_email,subject,body_captured_at,body_expires_at,failed_open,decided_at";

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

/** Rows per page of the Irrelevant list. */
export const DROPPED_PAGE_SIZE = 200;

export interface DroppedMailPage {
  items: DroppedMail[];
  /** Every row the list holds for this search, not just this page. */
  total: number;
  /** How many blocked emails people have cleared: what « restore » brings back. */
  cleared: number;
}

/**
 * One page of the Irrelevant list, newest first, from `dropped_mail_list`
 * (78_dropped_mail_list.sql). The view leaves out what a person cleared and what
 * was already promoted to a ticket, and carries `has_body` instead of the text,
 * so the page is one request with its count. It read every blocked decision and
 * their text on every /tickets load until 2026-10-06 (1.9 MB).
 *
 * `query` searches subject, sender and reason in the database, since the client
 * only holds the pages it has loaded.
 */
export async function listDroppedMailPage(
  shopId: string,
  { offset = 0, query = "" }: { offset?: number; query?: string } = {}
): Promise<DroppedMailPage> {
  const client = getSupabaseClient();
  const params = new URLSearchParams({
    select: LIST_COLUMNS + ",has_body",
    shop_id: `eq.${shopId}`,
    order: "decided_at.desc,id.asc",
  });
  // PostgREST's own syntax is in the value, so its separators are taken out of
  // what a person typed rather than escaped.
  const term = query.replace(/[,()"*\\]/g, " ").trim();
  if (term) {
    params.set("or", `(subject.ilike."*${term}*",from_email.ilike."*${term}*",reason.ilike."*${term}*")`);
  }
  const from = Math.max(0, Math.floor(offset));
  const [response, cleared] = await Promise.all([
    fetch(`${client.baseUrl}/${V.DROPPED_MAIL_LIST}?${params.toString()}`, {
      // Load-bearing: Next caches Server Component fetches by URL otherwise.
      cache: "no-store",
      headers: supabaseHeaders(client, {
        Prefer: "count=exact",
        "Range-Unit": "items",
        Range: `${from}-${from + DROPPED_PAGE_SIZE - 1}`,
      }),
    }),
    countClearedMail(shopId),
  ]);
  const rows = (await response.json().catch(() => null)) as any[] | null;
  if (!response.ok || !Array.isArray(rows)) {
    throw new Error(`Reading the dropped mail failed: HTTP ${response.status}`);
  }
  const total = Number(response.headers.get("content-range")?.split("/")[1]);
  return {
    items: rows.map((row) => ({ ...mapDroppedMail(row), bodyLoaded: false, hasBody: Boolean(row.has_body) })),
    total: Number.isFinite(total) ? total : rows.length,
    cleared,
  };
}

async function countClearedMail(shopId: string): Promise<number> {
  const client = getSupabaseClient();
  const params = new URLSearchParams({ select: "spam_audit_id", shop_id: `eq.${shopId}` });
  const response = await fetch(`${client.baseUrl}/${T.DROPPED_MAIL_CLEARS}?${params.toString()}`, {
    method: "HEAD",
    cache: "no-store",
    headers: supabaseHeaders(client, { Prefer: "count=exact" }),
  });
  const total = Number(response.headers.get("content-range")?.split("/")[1]);
  return response.ok && Number.isFinite(total) ? total : 0;
}

/**
 * Clears blocked emails out of the Irrelevant list for everyone in the shop.
 * The decision record in `spam_audit` is untouched; `restoreClearedMail` undoes it.
 */
export async function clearDroppedMail(shopId: string, auditIds: string[], clearedBy: string | null): Promise<number> {
  const ids = [...new Set(auditIds.filter((id) => typeof id === "string" && UUID.test(id)))];
  if (ids.length === 0) return 0;
  await supabaseUpsert(
    getSupabaseClient(),
    T.DROPPED_MAIL_CLEARS,
    ids.map((id) => ({ shop_id: shopId, spam_audit_id: id, cleared_by: clearedBy })),
    "shop_id,spam_audit_id",
    { returning: "minimal" }
  );
  return ids.length;
}

/** Brings every cleared email back into the list. */
export async function restoreClearedMail(shopId: string): Promise<void> {
  await supabaseDelete(getSupabaseClient(), T.DROPPED_MAIL_CLEARS, { shop_id: shopId });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One dropped email with its text, for the dialog: the list leaves the text out.
 *
 * The parcel lookup moved here with it. A dropped mail has no ticket and no
 * confirmed order, so the only route to a tracking link is the number in its own
 * text, and that is only worth a query once somebody opens the email.
 */
export async function getDroppedMail(shopId: string, auditId: string): Promise<DroppedMail> {
  const rows = (await supabaseSelectAll(
    getSupabaseClient(),
    T.SPAM_AUDIT,
    { shop_id: shopId, id: auditId, outcome: { operator: "eq", value: "blocked" } },
    AUDIT_COLUMNS
  )) as any[];
  if (!rows[0]) {
    throw new KnowledgeNotFoundError(`Dropped mail not found: ${auditId}`);
  }
  const mail = { ...mapDroppedMail(rows[0]), bodyLoaded: true, hasBody: rows[0].body_text != null };
  const parcels = mail.body ? await parcelsInText(shopId, [mail.body], []) : [];
  return { ...mail, parcels };
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
