/**
 * Server-only ticket reader for the Tickets dashboard, plus the one write an
 * operator can make.
 *
 * Almost everything about a ticket is written by the agent worker (ingestion,
 * categorisation, investigation, forwarding); this module exists so an operator
 * can see the queue those passes produced, and move a ticket between the queue
 * and the closed section. That write is deliberately narrow — see
 * `setTicketStatus`.
 *
 * IT DOES NOT SPEAK TO `tickets` ITSELF. Every read and the write go through
 * `scripts/lib/ticket-record.mjs`, the module that owns the row, so the
 * dashboard and the worker cannot disagree about what a closed ticket looks
 * like. The list reads the `ticket_queue` view, which joins the customer and the
 * message count in Postgres — this file used to read every message id in the
 * shop to count them.
 *
 * Uses the Supabase SERVICE ROLE key for the same reason knowledge-service and
 * forwarding-service do: every table has RLS enabled with no policies, so only
 * the service role can read. Never import this from a client component.
 */

import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import { formatRfmGroup } from "../../../scripts/lib/customer-segments.mjs";
import { loadVipRule, loadVipTicketIds } from "../../../scripts/lib/vip-rule.mjs";
import { priorityBand, scorePriority } from "../../../scripts/lib/ticket-priority.mjs";
import {
  createSupabaseClient,
  supabaseSelect,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { COLUMNS, T } from "../../../scripts/lib/tables.mjs";
import {
  createSenderDirectoryStore,
  emptySenderDirectory
} from "../../../agent/src/ingestion/sender-directory.mjs";
import { createTicketRecord } from "../../../scripts/lib/ticket-record.mjs";
import { parseTrackingCandidates } from "../../../agent/src/resolution/tracking-number-parser.mjs";
import { normaliseTrackingNumber } from "../../../scripts/lib/tracking-number.mjs";
import { createDraftRecord } from "../../../scripts/lib/draft-record.mjs";
import {
  listTicketAttachments,
  toPublicAttachments,
} from "../../../scripts/lib/photo-evidence-rules.mjs";
import { KnowledgeNotFoundError } from "./knowledge-errors";
import { summariseFacts, summariseInvestigation, summariseOrderContext } from "../ticket-detail";
import type {
  InvestigationVerdict,
  KnowledgeCategory,
  ResponsibleTeam,
  TicketAttachments,
  TicketDetail,
  TicketDraft,
  TicketHappiness,
  TicketLevel,
  TicketListItem,
  TicketPriorityBand,
  TicketMessage,
  TicketStatus,
  TicketThread,
  TicketTracking,
} from "../types";

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

/**
 * The shared ticket record, scoped to this shop.
 *
 * The dashboard is the ninth writer of `tickets` and the only one outside the
 * worker; it goes through the same module for the same reason the passes do —
 * `setTicketStatus` moves `status`, `closed_at` and `resolved_at`, which is
 * exactly what auto-close writes. Two implementations of that were two chances
 * to disagree about what a closed ticket looks like.
 */
function getRecord(shopId: string) {
  return createTicketRecord(getSupabaseClient(), { shopId });
}

// The list projection lives in the schema contract now (COLUMNS.ticketQueue),
// beside the `ticket_queue` view it reads, so a column added to one is checked
// against the other by the migration tests.

/**
 * Every live ticket, priority first, with its message count.
 *
 * Soft-deleted rows are excluded at the query rather than in the mapper: a
 * compliance delete must not reach the UI even if a later caller forgets to
 * filter. Archived tickets are kept — archiving drops a ticket out of the
 * active queue, and the list offers that as a filter rather than hiding it.
 *
 * Message counts come from one bulk read of `ticket_messages` rather than a
 * per-ticket count query, which would be 565 round trips on the current corpus.
 *
 * THE CUSTOMER COMES BACK EMBEDDED, not as a second read. PostgREST resolves
 * `customers(...)` over the `tickets.customer_id` foreign key in the same
 * request, so linking a ticket to who wrote it costs nothing extra — whereas
 * fetching the customer table separately would pull every customer in the shop
 * to satisfy the handful actually referenced. `customers` is null on any ticket
 * the resolution pass has not linked, which is most of them until it runs.
 */
/**
 * ONE PARTITION, TWO PAGES. Tickets and Conversations are the two halves of a
 * single split rather than two independent queries, so no thread can appear on
 * both surfaces or — much worse — on neither. `sender_label` is the seam: it is
 * set at ingestion for a thread one of OUR addresses opened, and null for
 * everyone else — and NOT the derived `senderLabel`, which also covers
 * retailers and couriers and would move a Nocibé order off the queue.
 *
 * THIS HIDES WORK, AND THAT IS THE POINT OF THE CALL. An earlier version of this
 * split was built and reverted the same day, because all 14 routed threads were
 * the back office working real customer returns and three were open at L3 behind
 * a nav item nobody opened. The routing is deliberate now; see DECISIONS.md.
 * What mitigates it is `countOpenConversations`, which puts those three on the
 * sidebar so the page announces itself instead of waiting to be found.
 */
function partitionBySender(rows: any[], directory: any, vipTickets: Set<string>) {
  const mapped = rows.map((row) => mapTicketRow(row, directory, vipTickets)).sort(byPriorityThenLastActivityDesc);
  return {
    tickets: mapped.filter((ticket) => !ticket.isOwnSide),
    conversations: mapped.filter((ticket) => ticket.isOwnSide)
  };
}

export async function listTickets(shopId: string): Promise<TicketListItem[]> {
  const [rows, directory, vipTickets] = await Promise.all([
    getRecord(shopId).queue(),
    loadSenderDirectory(shopId),
    loadVipTickets(shopId)
  ]);
  return partitionBySender(rows as any[], directory, vipTickets).tickets;
}

/** The other half: threads one of our own addresses opened. */
export async function listConversations(shopId: string): Promise<TicketListItem[]> {
  const [rows, directory, vipTickets] = await Promise.all([
    getRecord(shopId).queue(),
    loadSenderDirectory(shopId),
    loadVipTickets(shopId)
  ]);
  return partitionBySender(rows as any[], directory, vipTickets).conversations;
}

/**
 * How many routed threads still need somebody, for the sidebar badge.
 *
 * THE WHOLE MITIGATION FOR ROUTING THEM OUT. The failure this exists to prevent
 * is documented and specific: three L3 threads awaiting a human sat unseen
 * behind a nav item last time. A count on the nav means the queue you are not
 * looking at can still ask for you.
 */
export async function countOpenConversations(shopId: string): Promise<number> {
  const conversations = await listConversations(shopId);
  return conversations.filter((ticket) => ticket.status !== "closed" && ticket.status !== "resolved")
    .length;
}

/**
 * Who counts as one of our own, read once per request.
 *
 * A TABLE READ RATHER THAN A CONSTANT, because the answer changes without a
 * deploy: adding a carrier or a new corporate domain is a row, and every ticket
 * already stored is reclassified the next time the page is rendered. That is the
 * same reason VIP is derived at read time — a label baked into a ticket at
 * ingestion would be stale the moment the directory moved.
 *
 * `supportMailbox` is passed so the directory derives our own domain as internal
 * without anyone having to remember to add it.
 *
 * Nine rows today, so this is a full read of a tiny table and not worth caching
 * — and a cache would be the thing that made a directory edit appear not to work.
 */
/**
 * Which tickets belong to a VIP, under the shop's own rule (vip-rule.mjs).
 *
 * ONE CALL PER READ, for every ticket at once — `vip_tickets()` applies the
 * rule in SQL, where the windowed spend and order counts live. Read per request,
 * never cached and never stored: the window rolls forward daily and the rule
 * can be edited at any time on the Customers panel.
 *
 * A failure is an empty set, not an error: the queue must still load, and a
 * missing gold border is a smaller harm than a queue that will not open.
 */
async function loadVipTickets(shopId: string, ticketIds: string[] | null = null): Promise<Set<string>> {
  try {
    const supabase = getSupabaseClient();
    const rule = await loadVipRule(supabase, shopId);
    return (await loadVipTicketIds(supabase, shopId, rule, ticketIds)) as Set<string>;
  } catch {
    return new Set();
  }
}

async function loadSenderDirectory(shopId: string) {
  return createSenderDirectoryStore(getSupabaseClient()).load(shopId, {
    supportMailbox: process.env.SUPPORT_MAILBOX || undefined
  });
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

  // The ticket through the record; the case file directly, because
  // `ticket_investigations` is the investigation's contract and not the ticket
  // record's to own (see agent/src/investigation/case-file.mjs).
  const record = getRecord(shopId);

  const [ticketRow, investigationRows, attachmentRows] = await Promise.all([
    record.findForDetail(ticketId),
    supabaseSelect(
      supabase,
      T.TICKET_INVESTIGATIONS,
      { ticket_id: ticketId, shop_id: shopId },
      COLUMNS.investigationForDetail,
      { order: "investigated_at.desc", limit: 1 }
    ),
    // Alongside the case file rather than behind it: what the customer attached
    // is true of the TICKET, not of the investigation, so it has to be there for
    // the 263 tickets that carry no case file at all — which include every
    // uncategorised one a person is most likely to be opening by hand.
    record.inboundMessages(ticketId, { columns: COLUMNS.messageForAttachments }),
  ]);

  if (!ticketRow) {
    throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);
  }

  // `{}` on every ticket without a confirmed order number, which the projection
  // reads as "no order facts" rather than as a bundle full of nulls.
  const order = summariseOrderContext(ticketRow.resolved_context);

  // `toPublicAttachments` is the boundary that strips the Exchange message id
  // off every entry — see the shared module. It lives there rather than here
  // because it is the security-relevant half and `web/` has no test runner.
  const attachments: TicketAttachments = toPublicAttachments(
    ticketId,
    listTicketAttachments(Array.isArray(attachmentRows) ? attachmentRows : [])
  );

  const row = Array.isArray(investigationRows) ? investigationRows[0] : null;
  if (!row) {
    // No case file: the order facts may still exist, because the resolution pass
    // writes them for tickets the agent never investigated. Facts cannot.
    return { ticketId, results: null, order, facts: [], attachments };
  }

  return {
    ticketId,
    order,
    attachments,
    facts: summariseFacts(row.evidence_gaps),
    results: summariseInvestigation({
      verdict: row.verdict as InvestigationVerdict,
      // The jsonb columns are `not null default '[]'`, so these are arrays in
      // practice; coerced anyway because a mapper that trusts the schema breaks
      // loudly in the UI when the schema is the thing that changed.
      established: Array.isArray(row.established) ? row.established : [],
      unverified: Array.isArray(row.unverified) ? row.unverified : [],
      missing: Array.isArray(row.missing) ? row.missing : [],
      handoff: row.handoff ?? null,
      candidateOrder: row.candidate_order ?? null,
      reactionReport: row.reaction_report ?? null,
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
  const record = getRecord(shopId);

  const [ticketRow, messageRows, draftRow] = await Promise.all([
    record.findForThread(ticketId),
    record.thread(ticketId),
    // Read alongside the thread rather than in the panel: the draft is what an
    // operator is deciding about, and a dialog that renders the conversation
    // first and the draft a moment later reads as the draft being missing.
    getDraftRecord(shopId).forTicket(ticketId),
  ]);

  if (!ticketRow) {
    throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);
  }

  const messages = (messageRows as any[]).map(mapMessageRow).sort(byTimeAsc);
  const draft = draftRow ? mapDraftRow(draftRow) : null;

  // The confirmed order's parcels come through the same projection the detail
  // panel reads, so a number linked in the Order block and the same number
  // linked in a message body cannot disagree about which parcel it is. Anything
  // else quoted in the thread is looked up on top of that.
  const parcels = await parcelsInText(
    shopId,
    [...messages.map((message) => message.body), draft?.body, draft?.approvedBody],
    summariseOrderContext(ticketRow.resolved_context)?.tracking ?? []
  );

  return {
    ticketId,
    subject: ticketRow.subject ?? null,
    // Surfaced beside the draft rather than only in the list: this is the screen
    // where somebody decides to send, and a draft on a linked ticket is one that
    // must not be sent.
    duplicateOf: ticketRow.duplicate_of_ticket_id
      ? {
          ticketId: ticketRow.duplicate_of_ticket_id as string,
          reason: ticketRow.duplicate_reason as string,
        }
      : null,
    // Not a warning. A related ticket means the customer has written before, so
    // the reviewer should read the earlier thread — not that this draft is
    // unsafe to send.
    relatedTo: ticketRow.related_ticket_id
      ? {
          ticketId: ticketRow.related_ticket_id as string,
          score: Number(ticketRow.related_score ?? 0),
        }
      : null,
    draft,
    messages,
    parcels,
  };
}

/**
 * Records a reviewer's decision about the drafted reply.
 *
 * THE EDIT IS THE VALUABLE HALF. `approved` and `rejected` say what happened to
 * one draft; an edit says what the agent got wrong and what a person wrote
 * instead, and `draft-record` writes that pair to `ticket_draft_edits` with the
 * model text snapshotted beside it. That snapshot is why the record is
 * trustworthy later: `ticket_drafts.body_text` is replaced by the next drafting
 * run, so the two columns on the draft row stop being a pair the moment the
 * agent revises something a person had already corrected.
 *
 * Returns the draft as the dialog re-renders it, so the caller replaces the row
 * it was showing rather than refetching the whole thread.
 */
export async function decideOnDraft(
  shopId: string,
  ticketId: string,
  decision: { status: "approved" | "edited" | "rejected"; approvedBody: string | null }
): Promise<TicketDraft> {
  const record = getDraftRecord(shopId);

  // The dialog knows the ticket, not the draft id — and the draft it is showing
  // is by definition the latest reading, which is what `forTicket` returns.
  const current = await record.forTicket(ticketId);
  if (!current) {
    throw new KnowledgeNotFoundError(`No draft to decide on for ticket: ${ticketId}`);
  }

  await record.decide(current.id, {
    status: decision.status,
    approvedBodyText: decision.approvedBody,
    // The dashboard is the only source today. A review copy edited in Outlook is
    // the intended second one, and the column already accepts it.
    source: "dashboard",
  });

  const updated = await record.forTicket(ticketId);
  return mapDraftRow(updated);
}

/** The draft row, scoped to this shop. Owned by scripts/lib/draft-record.mjs. */
function getDraftRecord(shopId: string) {
  return createDraftRecord(getSupabaseClient(), { shopId });
}

/**
 * The stored draft, as the dialog needs it.
 *
 * `body` stays the MODEL's text even when a reviewer has rewritten it. Showing
 * the rewrite in its place would hide the only honest measure of how good the
 * drafting is — see 07_drafting.sql on why the two bodies are separate columns.
 */
function mapDraftRow(row: any): TicketDraft {
  const checks: any[] = Array.isArray(row.checks) ? row.checks : [];
  return {
    id: row.id,
    body: row.body_text ?? "",
    approvedBody: row.approved_body_text ?? null,
    sourceVerdict: DRAFT_VERDICTS.includes(row.source_verdict) ? row.source_verdict : "answerable",
    // Defaults to the safe half of the pair: a draft whose disposition could not
    // be read must not be the one a send closes a ticket on.
    disposition: row.disposition === "terminal" ? "terminal" : "intermediary",
    status: DRAFT_STATUSES.includes(row.status) ? row.status : "pending",
    checksPassed: Boolean(row.checks_passed),
    // Only the failures: a reviewer needs to know what was caught, not to read
    // a list of everything that was fine.
    failedChecks: checks
      .filter((check) => check && check.passed === false)
      .map((check) => String(check.detail ?? check.check ?? "unnamed check")),
    draftedAt: row.drafted_at ?? null,
  };
}

const DRAFT_STATUSES: string[] = ["pending", "approved", "edited", "rejected", "sent"];
const DRAFT_VERDICTS: string[] = ["answerable", "needs_customer_input", "needs_human"];

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
  // The record owns which columns a status change touches, and reads the row
  // back from `ticket_queue` — the SAME projection the list rendered. That is
  // what stops a close from silently stripping the VIP badge or the message
  // count off the row it replaces on screen.
  const [row, vipTickets] = await Promise.all([
    getRecord(shopId).setStatus(ticketId, status),
    loadVipTickets(shopId, [ticketId]),
  ]);
  if (!row) {
    throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);
  }

  return mapTicketRow(row, undefined, vipTickets);
}

/**
 * One ticket in the list's own projection, for a caller that has just made one
 * appear.
 *
 * Promoting a dropped email is the only such caller: the row it produces has to
 * join the queue on screen without a page reload, and it must be the SAME shape
 * the list rendered or it would arrive missing its VIP badge, its message count
 * and its priority score. Reads `ticket_queue` for exactly that reason, and the
 * sender directory with it, since `isOwnSide` is what decides whether a thread
 * belongs on /tickets or /conversations at all.
 */
export async function getTicketListItem(
  shopId: string,
  ticketId: string
): Promise<TicketListItem> {
  const [row, directory, vipTickets] = await Promise.all([
    getRecord(shopId).queueRow(ticketId),
    loadSenderDirectory(shopId),
    loadVipTickets(shopId, [ticketId]),
  ]);
  if (!row) {
    throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);
  }

  return mapTicketRow(row, directory, vipTickets);
}

/** Highest priority first, newest activity breaking ties. */
function byPriorityThenLastActivityDesc(a: TicketListItem, b: TicketListItem): number {
  if (a.priorityScore !== b.priorityScore) {
    return b.priorityScore - a.priorityScore;
  }
  const at = Date.parse(a.lastMessageAt ?? a.firstMessageAt ?? "") || 0;
  const bt = Date.parse(b.lastMessageAt ?? b.firstMessageAt ?? "") || 0;
  return bt - at;
}

/**
 * The joined customer columns -> the three fields a ticket row shows.
 *
 * `ticket_queue` LEFT JOINs `customers`, so every one of these is null on an
 * unlinked ticket — which is most of them until the customer-resolution pass
 * runs. VIP comes from the shop's rule, answered for the whole list by
 * `vip_tickets()` and passed in as a set: nothing stores it (see vip-rule.mjs).
 * The Shopify segment is still carried, as Shopify's, for the context pane.
 *
 * `display_name` is Shopify's own composition and wins where it exists; the
 * first/last fallback covers rows synced before it was populated.
 */
function mapCustomer(row: any, vipTickets: Set<string>) {
  const name =
    row.customer_display_name ||
    [row.customer_first_name, row.customer_last_name].filter(Boolean).join(" ") ||
    null;

  return {
    customerName: name,
    rfmGroup: formatRfmGroup(row.customer_rfm_group),
    isVip: vipTickets.has(row.id),
  };
}

function mapTicketRow(
  row: any,
  directory: any = emptySenderDirectory,
  vipTickets: Set<string> = new Set()
): TicketListItem {
  const customer = mapCustomer(row, vipTickets);
  // THE ADDRESS STOPS HERE. `requester_email` is read from the view so this
  // question can be asked, and only the resulting label continues to the
  // browser — the queue is a list of everyone who has written in, and shipping
  // their addresses into the page to render a chip would be the widest
  // disclosure on the dashboard for the least reason.
  const senderEntry = directory.lookup(row.requester_email ?? null);
  // A boolean, not the linked id: the list marks the row, and which ticket it
  // duplicates is answered by opening it.
  const isDuplicate = Boolean(row.duplicate_of_ticket_id);
  const level = row.level === null || row.level === undefined ? null : (Number(row.level) as TicketLevel);
  const priorityScore = scorePriority({
    level,
    waitingSince: row.waiting_since ?? null,
    inboundCount: Number(row.inbound_count ?? 0),
    status: row.status,
    isVip: customer.isVip,
  });

  return {
    id: row.id,
    subject: row.subject,
    status: row.status as TicketStatus,
    category: (row.category as KnowledgeCategory) ?? null,
    secondaryCategory: (row.secondary_category as KnowledgeCategory) ?? null,
    // level is a smallint and nullable until the categoriser has run.
    level,
    // Same shape as level: a smallint that stays null until the categoriser has
    // read the mail. Null is "not scored yet", not "neutral".
    happiness:
      row.happiness === null || row.happiness === undefined
        ? null
        : (Number(row.happiness) as TicketHappiness),
    responsibleTeam: (row.responsible_team as ResponsibleTeam) ?? null,
    requesterName: row.requester_name,
    senderLabel: (senderEntry?.label as TicketListItem["senderLabel"]) ?? null,
    senderNote: senderEntry?.note ?? null,
    isDuplicate,
    // Null requester_email — a ticket with no stored inbound message — is NOT
    // non-demand. Eleven tickets are in that state, and defaulting them out of
    // the queue would hide customer mail on the strength of a missing join.
    isNonDemand: directory.isNonDemand(row.requester_email ?? null),
    // The stored column, not the derived label: see TicketListItem.isOwnSide.
    isOwnSide: Boolean(row.sender_label),
    ...customer,
    priorityScore,
    priorityBand: priorityBand(priorityScore) as TicketPriorityBand,
    orderNumber: row.shopify_order_number,
    // Counted by the `ticket_message_counts` view the queue joins, and
    // `coalesce`d to 0 there — a ticket with no stored message is a row with a
    // zero, not a row that dropped out of the join.
    messageCount: Number(row.message_count ?? 0),
    waitingSince: row.waiting_since ?? null,
    firstMessageAt: row.first_message_at,
    lastMessageAt: row.last_message_at,
  };
}

/**
 * Every parcel a tracking number in this thread could be linked to.
 *
 * TWO SOURCES, AND THE SECOND IS THE ONE THAT MATTERS. The confirmed order's
 * parcels come free with the bundle — but the case worth linking is the customer
 * who writes « mon colis 6C20723002488 n'est pas arrivé » on a ticket where no
 * order was ever confirmed, which is exactly the ticket where a reviewer most
 * wants one click to the carrier. Those numbers are in the text and nowhere
 * else, so they are parsed out of it and looked up.
 *
 * ONE OVERLAP QUERY, and only when the text actually holds a candidate the
 * bundle did not already cover. `orders.tracking_numbers` is a text[] with a GIN
 * index and `ov` is PostgREST's `&&`, so this is the same index the order
 * resolver uses rather than a scan of the `fulfillments` jsonb.
 *
 * THE PARSER IS THE AGENT'S OWN, not a second pattern list. What a tracking
 * number looks like was measured over 815 of this store's parcels and the
 * reasoning is written down beside the patterns; a copy here would drift from
 * the one the resolver matches on, and a linkifier that disagrees with the
 * resolver about what a number is would be a puzzle rather than a bug.
 *
 * A number that matches no order is simply not linked — the whole rule for this
 * feature. Nothing is guessed from a number's shape.
 */
export async function parcelsInText(
  shopId: string,
  texts: (string | null | undefined)[],
  confirmed: TicketTracking[]
): Promise<TicketTracking[]> {
  const parcels: TicketTracking[] = [...confirmed];
  const covered = new Set(parcels.map((parcel) => normaliseTrackingNumber(parcel.number)));

  const candidates = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const candidate of parseTrackingCandidates(text)) {
      if (!covered.has(candidate.trackingNumber)) {
        candidates.add(candidate.trackingNumber);
      }
    }
  }
  if (candidates.size === 0) {
    return parcels;
  }

  const wanted = [...candidates];
  let rows: any[] = [];
  try {
    rows = await supabaseSelect(
      getSupabaseClient(),
      T.ORDERS,
      {
        shop_id: shopId,
        tracking_numbers: { operator: "ov", value: `{${wanted.join(",")}}` },
        deleted_at: { operator: "is", value: "null" },
      },
      "id,fulfillments"
    );
  } catch {
    // A link is an enhancement to a dialog whose job is showing the email. If
    // the lookup fails the numbers stay text, which is what they were before.
    return parcels;
  }

  for (const row of rows) {
    for (const fulfillment of (row?.fulfillments as any[]) ?? []) {
      for (const info of (fulfillment?.tracking_info as any[]) ?? []) {
        const number = normaliseTrackingNumber(info?.number);
        const url = String(info?.url ?? "").trim();
        // Only the numbers this thread actually quoted: an order matches on one
        // parcel and may carry others, and linking those would put a parcel
        // nobody mentioned into the map for the next number to collide with.
        if (!number || !url || covered.has(number) || !candidates.has(number)) {
          continue;
        }
        covered.add(number);
        parcels.push({ number, carrier: info?.company ?? null, url });
      }
    }
  }

  return parcels;
}
