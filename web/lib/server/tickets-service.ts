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

import { cache } from "react";
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import { formatRfmGroup } from "../../../scripts/lib/customer-segments.mjs";
import { loadVipRule, loadVipTicketIds } from "../../../scripts/lib/vip-rule.mjs";
import { priorityBand, scorePriority } from "../../../scripts/lib/ticket-priority.mjs";
import {
  createSupabaseClient,
  supabaseInsert,
  supabaseSelect,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { COLUMNS, T } from "../../../scripts/lib/tables.mjs";
import {
  createSenderDirectoryStore,
  emptySenderDirectory
} from "../../../agent/src/ingestion/sender-directory.mjs";
import { createTicketRecord } from "../../../scripts/lib/ticket-record.mjs";
import { createCaseRecord } from "../../../scripts/lib/case-record.mjs";
import { parseTrackingCandidates } from "../../../agent/src/resolution/tracking-number-parser.mjs";
import { normaliseTrackingNumber } from "../../../scripts/lib/tracking-number.mjs";
import { parseEmailForDisplay } from "../../../scripts/lib/email-display.mjs";
import { createDraftRecord } from "../../../scripts/lib/draft-record.mjs";
import { OPEN_STATES, actionFromDraft, actionFromManual, createOutboundRecord } from "../../../scripts/lib/outbound-record.mjs";
import { replyHtmlIsEmpty, replyHtmlToText, sanitiseReplyHtml } from "../../../scripts/lib/reply-html.mjs";
import { createMailJobRecord, sendDedupeKey } from "../../../scripts/lib/mail-job-record.mjs";
import {
  listTicketAttachments,
  toPublicAttachments,
} from "../../../scripts/lib/photo-evidence-rules.mjs";
import {
  ORDER_LINK_SOURCES,
  describeOrderMatch,
  manualOrderColumns,
  parseOrderNumber,
  sameOrder,
} from "../../../scripts/lib/order-link.mjs";
import { buildOrderContext } from "../../../agent/src/resolution/order-context.mjs";
import { createOrderContextStore } from "../../../agent/src/resolution/order-context-runner.mjs";
import { isAnonymousMarketplaceBuyer } from "../../../agent/src/resolution/order-verification.mjs";
import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";
import { loadTicketPriority } from "./ticket-priority-service";
import { NO_SNOOZE, readSnoozeFacts } from "./snooze-service";
import { NO_FORWARDING, readForwardingFacts, type ForwardingFacts } from "./forwarding-service";
import type { SnoozeFacts } from "./snooze-service";
import { getCaseState, refoldTicket } from "./case-state-service";
import { isInvestigable } from "../../../agent/src/investigation/investigation-rules.mjs";
import { listSituations } from "./policy-service";
import { OVERRIDE_SOURCES, overrideChange, overridesOf } from "../../../scripts/lib/ticket-overrides.mjs";
import type { PriorityFacts, PriorityRead } from "./ticket-priority-service";
import { loadMarketplaces } from "../../../scripts/lib/marketplaces.mjs";
import { summariseFacts, summariseInvestigation, summariseOrderContext } from "../ticket-detail";
import type {
  InvestigationVerdict,
  KnowledgeCategory,
  ResponsibleTeam,
  TicketAttachments,
  TicketActivityEvent,
  TicketDetail,
  TicketPolicy,
  TicketDraft,
  TicketHappiness,
  TicketLevel,
  TicketListItem,
  TicketPriorityBand,
  TicketMessage,
  TicketOrderChange,
  TicketOrderLinkSource,
  TicketOrderPreview,
  TicketStatus,
  TicketThread,
  TicketTracking,
  TicketOverrideField,
  TicketOverrideResult,
  TicketOverrides,
  TicketManualReply,
  TicketCaseThreads,
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

/** The case above the thread (61_cases.sql): read here, written by the worker. */
function getCaseRecord(shopId: string) {
  return createCaseRecord(getSupabaseClient(), { shopId, tickets: getRecord(shopId) });
}

/**
 * The threads of this ticket's case, and where its reply goes. Null for a
 * thread alone in its case. A case whose target was never computed names no
 * reply thread, which leaves the manual reply as it was before cases.
 */
async function readCaseThreads(
  shopId: string,
  ticketId: string,
  caseId: string | null,
  { withMessages = false, directory = null }: { withMessages?: boolean; directory?: any } = {}
): Promise<TicketCaseThreads | null> {
  if (!caseId) return null;
  const cases = getCaseRecord(shopId);
  const [caseRow, threads] = await Promise.all([cases.find(caseId), cases.threads(caseId)]);
  if (!caseRow || threads.length < 2) return null;
  const record = getRecord(shopId);
  // The other threads' mail, for the « Linked threads » tab. A case is a
  // handful of threads (seven at most today), so one read each is fine.
  const [decisions, otherMessages] = await Promise.all([
    cases.decisionsFor(threads.map((row: any) => row.id)),
    withMessages
      ? Promise.all(
          (threads as any[]).map(async (row) =>
            row.id === ticketId ? [row.id, []] : [row.id, ((await record.thread(row.id)) as any[]).map((m) => mapMessageRow(m, directory)).sort(byTimeAsc)]
          )
        )
      : Promise.resolve([]),
  ]);
  const messagesOf = new Map<string, TicketMessage[]>(otherMessages as Array<[string, TicketMessage[]]>);
  const linkedBy = new Map<string, string>();
  for (const row of decisions as any[]) {
    if (row.decision === "link" && !linkedBy.has(row.ticket_id)) linkedBy.set(row.ticket_id, row.method);
  }
  const replyThreadId = caseRow.target_computed_at ? caseRow.reply_thread_id ?? null : null;
  return {
    caseId,
    replyThreadId,
    threads: (threads as any[]).map((row) => ({
      ticketId: row.id,
      subject: row.subject ?? null,
      firstMessageAt: row.first_message_at ?? null,
      lastMessageAt: row.last_message_at ?? null,
      status: row.status,
      isThisThread: row.id === ticketId,
      isReplyThread: row.id === replyThreadId,
      linkedBy: linkedBy.get(row.id) ?? null,
      messages: messagesOf.get(row.id) ?? [],
    })),
  };
}

/** The other thread a case replies on, or null when it is this one (or unknown). */
function replyElsewhereOf(caseThreads: TicketCaseThreads | null, ticketId: string) {
  if (!caseThreads?.replyThreadId || caseThreads.replyThreadId === ticketId) return null;
  const thread = caseThreads.threads.find((row) => row.ticketId === caseThreads.replyThreadId);
  return { ticketId: caseThreads.replyThreadId, subject: thread?.subject ?? null };
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
 * What mitigates it is `countOpenThreads`, which puts those three on the
 * sidebar so the page announces itself instead of waiting to be found.
 */
function partitionBySender(
  rows: any[],
  directory: any,
  vipTickets: Set<string>,
  priority: PriorityRead,
  snoozes: Map<string, SnoozeFacts> = new Map(),
  forwarding: ForwardingFacts = NO_FORWARDING
) {
  const mapped = rows
    .map((row) => mapTicketRow(row, directory, vipTickets, priority.byTicket.get(row.id), priority.at, snoozes.get(row.id), forwarding))
    .sort(byPriorityThenLastActivityDesc);
  return {
    tickets: mapped.filter((ticket) => !ticket.isOwnSide),
    conversations: mapped.filter((ticket) => ticket.isOwnSide)
  };
}

export async function listTickets(shopId: string): Promise<TicketListItem[]> {
  const rows = await readQueue(shopId) as any[];
  const [directory, vipTickets, priority, snoozes, forwarding] = await Promise.all([
    readSenderDirectory(shopId),
    loadVipTickets(shopId),
    readPriority(shopId),
    readSnoozeFacts(shopId),
    readForwardingFacts(shopId)
  ]);
  return partitionBySender(rows, directory, vipTickets, priority, snoozes, forwarding).tickets;
}

/** The other half: threads one of our own addresses opened. */
export async function listConversations(shopId: string): Promise<TicketListItem[]> {
  const rows = await readQueue(shopId) as any[];
  const [directory, vipTickets, priority] = await Promise.all([
    readSenderDirectory(shopId),
    loadVipTickets(shopId),
    readPriority(shopId)
  ]);
  return partitionBySender(rows, directory, vipTickets, priority).conversations;
}

/**
 * Every ticket confirmed against an order, from BOTH halves of the partition —
 * the Orders page rings an order whoever opened the thread about it.
 *
 * The list's own projection, so `priorityBand` is the exact band the queue
 * shows; the Orders page folds these per order and never re-scores them.
 */
export async function listTicketsWithOrders(shopId: string): Promise<TicketListItem[]> {
  const rows = await readQueue(shopId) as any[];
  const orderRows = rows.filter((row) => row.shopify_order_number);
  const [directory, vipTickets, priority] = await Promise.all([
    readSenderDirectory(shopId),
    loadVipTickets(shopId),
    readPriority(shopId)
  ]);
  const { tickets, conversations } = partitionBySender(
    orderRows,
    directory,
    vipTickets,
    priority
  );
  return [...tickets, ...conversations];
}

/**
 * How many routed threads still need somebody, for the sidebar badge.
 *
 * THE WHOLE MITIGATION FOR ROUTING THEM OUT. The failure this exists to prevent
 * is documented and specific: three L3 threads awaiting a human sat unseen
 * behind a nav item last time. A count on the nav means the queue you are not
 * looking at can still ask for you.
 */
export async function countOpenThreads(
  shopId: string
): Promise<{ openTickets: number; openConversations: number }> {
  // One `queue()` read for both badges, over the same partition the two pages
  // render — two separate counts would double the read on every page load.
  const rows = await readQueue(shopId) as any[];
  const directory = await readSenderDirectory(shopId);
  // Counts need only the sender partition and status. Avoid loading order and
  // investigation facts on every page merely to sort rows nobody will render.
  const noPriorityRead: PriorityRead = { at: new Date(), byTicket: new Map() };
  const snoozes = await readSnoozeFacts(shopId);
  const { tickets, conversations } = partitionBySender(rows, directory, new Set(), noPriorityRead, snoozes);
  // A snoozed ticket needs nobody until it wakes, so it does not light the badge.
  // One per case (61_cases.sql): another thread of a case is behind its lead.
  const open = (ticket: TicketListItem) =>
    ticket.status !== "closed" && ticket.status !== "resolved" && !ticket.snooze && ticket.isCaseLead;
  return {
    openTickets: tickets.filter(open).length,
    openConversations: conversations.filter(open).length
  };
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

/**
 * The queue and the sender directory, read once per request.
 *
 * Tickets and Orders read the queue twice per render — once for the sidebar
 * badges (`countOpenThreads`) and once for their own list — so the two share
 * one read, and a badge can no longer disagree with the list beside it.
 * `cache` is scoped to a single server render: nothing outlives the request,
 * so the queue is exactly as fresh as it was before.
 */
const readQueue = cache((shopId: string) => getRecord(shopId).queue());
const readSenderDirectory = cache((shopId: string) => loadSenderDirectory(shopId));
const readPriority = cache(async (shopId: string) => loadTicketPriority(shopId, await readQueue(shopId) as any[]));

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

  const [ticketRow, investigationRows, attachmentRows, caseState, situationRows] = await Promise.all([
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
    // The case's current state (stage 5). A failure here must not cost the
    // operator the rest of the page, so it degrades to "not folded yet".
    getCaseState(shopId, ticketId).catch(() => null),
    // Names for the situation keys, and the « Edit case » picker. Degrades to
    // raw keys rather than costing the page.
    listSituations(shopId).catch(() => []),
  ]);
  const situations = situationRows.map((row) => ({ key: row.key, question: row.question, category: row.category }));
  const names = new Map(situations.map((row) => [row.key, row.question]));
  const situationOverride = mapOverrides(ticketRow ?? {}).situation ?? null;

  if (!ticketRow) {
    throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);
  }

  // `{}` on every ticket without a confirmed order number, which the projection
  // reads as "no order facts" rather than as a bundle full of nulls.
  const summarised = summariseOrderContext(ticketRow.resolved_context);
  const order = summarised
    ? {
        ...summarised,
        buyerUnverified: ticketRow.metadata?.order_resolution?.verified_by === "marketplace_order_number",
        linkedByPerson: ticketRow.metadata?.order_resolution?.verified_by === "manual",
      }
    : null;
  const orderNumber: string | null = ticketRow.shopify_order_number ?? null;
  // The id behind the number, for the link out to the order page. One small read
  // rather than a join: the bundle stores the order's NAME, and the page is
  // addressed by id.
  const orderId = orderNumber ? await findOrderIdByName(shopId, orderNumber) : null;

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
    return {
      ticketId, orderNumber, orderId, results: null, order, facts: [], attachments, policy: null, activity: [], caseState,
      situationOverride, situations,
    };
  }

  return {
    ticketId,
    orderNumber,
    orderId,
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
    policy: summarisePolicy(row.exemplar_match, names, row.company_policies),
    activity: summariseActivity(row),
    caseState,
    situationOverride,
    situations,
  };
}

function summariseActivity(row: any): TicketActivityEvent[] {
  const at = row.investigated_at ?? null;
  const calls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
  const lookups = calls.map((call: any, index: number) => ({
    id: `lookup-${String(call?.id ?? index)}`,
    at,
    title: `${toolLabel(call?.tool)} completed`,
    detail: call?.outcome ? String(call.outcome).replace(/_/g, " ") : null,
    kind: "lookup" as const,
    tool: call?.tool ? String(call.tool) : null,
    outcome: call?.outcome ? String(call.outcome) : null,
  }));
  return [
    ...lookups,
    {
      id: `investigation-${at ?? "latest"}`,
      at,
      title: "Case analysis completed",
      detail: row.verdict ? VERDICT_ACTIVITY_LABELS[String(row.verdict)] ?? String(row.verdict) : null,
      kind: "investigation" as const,
      verdict: row.verdict ? String(row.verdict) : null,
    },
  ];
}

const VERDICT_ACTIVITY_LABELS: Record<string, string> = {
  answerable: "Ready for a reply",
  needs_customer_input: "Waiting for customer information",
  needs_human: "Human action required",
};

const TOOL_ACTIVITY_LABELS: Record<string, string> = {
  getOrderContext: "Order lookup",
  lookupOrder: "Order lookup",
  lookupShipment: "Shipment lookup",
  lookupTracking: "Shipment lookup",
  lookupCustomer: "Customer lookup",
  lookupPromotion: "Promotion lookup",
  lookupProduct: "Product lookup",
  searchKnowledge: "Knowledge lookup",
  recommendProducts: "Product recommendation lookup",
  lookupAbandonedCheckout: "Checkout lookup",
  checkPhotoEvidence: "Photo evidence check",
};

function toolLabel(value: unknown): string {
  const key = String(value ?? "").trim();
  if (!key) return "Tool lookup";
  return TOOL_ACTIVITY_LABELS[key] ?? key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}

/**
 * The situation and the rule, off `ticket_investigations.exemplar_match`.
 *
 * READ BY NAME, NEVER SPREAD. That column also carries the run's findings, its
 * candidate list and the answer skeleton — diagnostics that belong in the agent
 * and not on a support screen. Naming the eight fields the panel shows is what
 * stops the next field added to the case file appearing here by accident.
 *
 * THE SITUATION COMES FROM `policy.situation_key`, not from `exemplar_key`, and
 * the difference is the near-miss chooser: below the match bar the model picks a
 * situation the embedding did not settle, so `exemplar_key` is null while the
 * run genuinely used one. `match` and `similarity` are shown beside it so the
 * distinction is visible rather than implied.
 */
function summarisePolicy(
  exemplarMatch: unknown,
  names: Map<string, string> = new Map(),
  companyPoliciesRaw: unknown = []
): TicketPolicy | null {
  if (!exemplarMatch || typeof exemplarMatch !== "object") {
    return null;
  }
  // Keys, versions and why each was read. Never the text: that is in the library.
  const companyPolicies = (Array.isArray(companyPoliciesRaw) ? companyPoliciesRaw : [])
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
    .map((p) => ({
      key: String(p.key ?? ""),
      version: Number.isInteger(p.version) ? (p.version as number) : null,
      source: (["situation", "rule", "agent"].includes(String(p.source)) ? p.source : "agent") as "situation" | "rule" | "agent",
    }))
    .filter((p) => p.key);
  const match = exemplarMatch as Record<string, unknown>;
  const policy = (match.policy ?? {}) as Record<string, unknown>;
  const similarity = Number(match.similarity);
  const situation = (policy.situation_key as string) ?? (match.verdict === "human" ? (match.exemplar_key as string) : null) ?? null;
  // The nearest three, stored since 2026-09-29; older runs kept only two keys.
  const stored = Array.isArray(match.top) ? (match.top as Record<string, unknown>[]) : [];
  const nearest = (stored.length > 0
    ? stored.map((row) => ({ key: String(row.key ?? ""), similarity: Number.isFinite(Number(row.similarity)) && row.similarity !== null ? Number(row.similarity) : null }))
    : [match.closest, match.runner_up].filter(Boolean).map((key, index) => ({ key: String(key), similarity: index === 0 && Number.isFinite(similarity) ? similarity : null }))
  )
    .filter((row) => row.key)
    .map((row) => ({ ...row, name: names.get(row.key) ?? null }));

  return {
    situation,
    situationName: situation ? names.get(situation) ?? null : null,
    nearest,
    byPerson: match.verdict === "human",
    companyPolicies,
    match: match.verdict === "human" ? null : ((match.verdict as TicketPolicy["match"]) ?? null),
    closest: (match.closest as string) ?? null,
    similarity: Number.isFinite(similarity) ? similarity : null,
    rule: (policy.answer_key as string) ?? null,
    ruleVerdict: (policy.verdict as string) ?? null,
    changedVerdict: policy.applied === true,
    route: (policy.route as string) ?? null,
    asks: Array.isArray(policy.ask) ? (policy.ask as string[]) : [],
    offerCode: (policy.offer_code as string) ?? null,
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

  const [ticketRow, messageRows, draftRow, directory, actions] = await Promise.all([
    record.findForThread(ticketId),
    record.thread(ticketId),
    // Read alongside the thread rather than in the panel: the draft is what an
    // operator is deciding about, and a dialog that renders the conversation
    // first and the draft a moment later reads as the draft being missing.
    getDraftRecord(shopId).forTicket(ticketId),
    readSenderDirectory(shopId),
    readActions(shopId, ticketId),
  ]);

  if (!ticketRow) {
    throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);
  }

  const messages = (messageRows as any[]).map((row) => mapMessageRow(row, directory)).sort(byTimeAsc);
  const draft = draftRow ? mapDraftRow(draftRow, latestActionFor(actions, draftRow.id)) : null;
  const caseThreads = await readCaseThreads(shopId, ticketId, ticketRow.case_id ?? null, { withMessages: true, directory });
  const replyElsewhere = replyElsewhereOf(caseThreads, ticketId);
  // A case replies on one thread: on any other, there is nothing to reply to.
  const replyTarget = replyElsewhere ? null : replyTargetOf(messageRows as any[]);

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
    case: caseThreads,
    draft,
    messages,
    parcels,
    reply: {
      sendingEnabled: sendOnApprove(),
      holdsInDrafts: process.env.OUTBOUND_STOP_BEFORE_SEND === "true",
      targetMessageId: replyTarget?.id ?? null,
      replyElsewhere,
      manual: (Array.isArray(actions) ? actions : []).filter((action) => action.mode === "manual").map(mapManualReply),
    },
  };
}

/**
 * The message a person's own reply answers: the customer's latest. The
 * outbound worker refuses the reply if the customer writes again after it
 * (`customer_wrote_again`), so it must be the newest one the person could read.
 * `actor` is stamped at arrival; a row from before it falls back to direction.
 */
function replyTargetOf(rows: any[]): any | null {
  const customer = rows.filter(
    (row) => row.direction === "inbound" && (row.actor ?? "customer") === "customer" && row.from_email
  );
  customer.sort((a, b) => (Date.parse(a.received_at ?? a.sent_at ?? "") || 0) - (Date.parse(b.received_at ?? b.sent_at ?? "") || 0));
  return customer[customer.length - 1] ?? null;
}

function mapManualReply(action: any): TicketManualReply {
  return {
    id: action.id,
    state: action.state,
    reason: action.cancel_reason ?? action.failure_reason ?? null,
    bodyHtml: action.body_html ? sanitiseReplyHtml(action.body_html) : null,
    bodyText: action.body_text ?? "",
    at: action.closed_at ?? action.send_requested_at ?? action.draft_created_at ?? action.created_at ?? null,
  };
}

/**
 * A reply a person wrote on the ticket page, typically to add what the
 * agent's reply missed. Queued exactly like an approved draft (an outbound
 * action and a job; the worker sends it), with no draft behind it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: start any agent pass. Once sent it comes
 * back through Sent Items like a reply typed in Outlook: the fold stales any
 * open draft it supersedes, drafting sees the customer already answered, and
 * the next investigation (only on the customer's next message) reads it in the
 * thread. Nothing is re-investigated on the strength of our own reply; a person
 * who has said enough settles the checks and closes the ticket themselves.
 */
export async function sendManualReply(
  shopId: string,
  ticketId: string,
  input: { bodyHtml: string; replyToMessageId: string; clientKey: string },
  requestedBy: string | null = null
): Promise<TicketManualReply> {
  if (!sendOnApprove()) {
    throw new KnowledgeValidationError("Sending is switched off on this server.");
  }
  const html = sanitiseReplyHtml(input.bodyHtml);
  if (replyHtmlIsEmpty(html)) {
    throw new KnowledgeValidationError("The reply is empty.");
  }

  const record = getRecord(shopId);
  const [ticketRow, messageRows, caseRows] = await Promise.all([
    record.findForThread(ticketId),
    record.thread(ticketId),
    supabaseSelect(getSupabaseClient(), T.CASE_CURRENT, { ticket_id: ticketId, shop_id: shopId }, "version", { limit: 1 }),
  ]);
  if (!ticketRow) throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);

  // The page names the message it showed as the latest. If the customer has
  // written since, the person has not read it: refused now, rather than
  // cancelled by the worker a minute later.
  // THE CASE REPLIES ON ONE THREAD (61_cases.sql). A reply typed on another
  // thread of the same case would be the customer's second answer, on a
  // conversation they have moved on from.
  const elsewhere = replyElsewhereOf(await readCaseThreads(shopId, ticketId, ticketRow.case_id ?? null), ticketId);
  if (elsewhere) {
    throw new KnowledgeValidationError(
      `This customer's case is answered on another thread${elsewhere.subject ? ` (« ${elsewhere.subject} »)` : ""}. Reply from there.`
    );
  }
  const target = replyTargetOf(messageRows as any[]);
  if (!target) {
    throw new KnowledgeValidationError("There is no customer message on this ticket to reply to.");
  }
  if (target.id !== input.replyToMessageId) {
    throw new KnowledgeValidationError(
      "The customer has written again since this page was loaded. Reload the conversation before sending."
    );
  }

  // Recorded, not checked at send: what the case was when the person wrote.
  // A ticket the fold has not reached yet is version 1, the fold's first.
  const version = Number((caseRows as any[])?.[0]?.version ?? 1);
  const built = actionFromManual({
    ticketId,
    replyToMessageId: target.id,
    caseVersion: Number.isInteger(version) && version >= 1 ? version : 1,
    bodyHtml: html,
    clientKey: input.clientKey,
    requestedBy,
  });
  if (built.error || !built.row) {
    throw new KnowledgeValidationError(`This reply cannot be sent (${built.error}).`);
  }

  const { created, action } = await getOutboundRecord(shopId).create(built.row);
  if (!action) throw new Error("The reply was not recorded.");
  if (created) {
    await getMailJobRecord(shopId).enqueue({
      kind: "send_outbound",
      dedupeKey: sendDedupeKey(action.id),
      payload: { outboundActionId: action.id },
    });
  }
  return mapManualReply(action);
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
  decision: { status: "approved" | "edited" | "rejected"; approvedBody: string | null; approvedBodyHtml?: string | null },
  requestedBy: string | null = null
): Promise<TicketDraft> {
  const record = getDraftRecord(shopId);
  const outbound = getOutboundRecord(shopId);

  // The dialog knows the ticket, not the draft id — and the draft it is showing
  // is by definition the latest reading, which is what `forTicket` returns.
  const current = await record.forTicket(ticketId);
  if (!current) {
    throw new KnowledgeNotFoundError(`No draft to decide on for ticket: ${ticketId}`);
  }
  // A stale draft answers a case that has moved on (stage 6). Refused here as a
  // sentence; the record refuses it too.
  if (current.status === "stale") {
    throw new KnowledgeValidationError("This draft is out of date: the case has moved on since it was written.");
  }
  if (current.status === "sent") {
    throw new KnowledgeValidationError("This reply has already been sent.");
  }

  // A REPLY ALREADY ON ITS WAY. Once the send call may have been made, the
  // decision can no longer change what the customer gets. Before that, a new
  // decision withdraws the queued one: the worker would otherwise send the text
  // as it was approved, not as it now reads.
  const live = latestActionFor(await readActions(shopId, ticketId), current.id);
  if (live && ["send_requested", "sent_confirmed"].includes(live.state)) {
    throw new KnowledgeValidationError("This reply is already being sent.");
  }
  const sending = decision.status !== "rejected" && sendOnApprove();
  if (sending && !Number.isInteger(current.case_version)) {
    throw new KnowledgeValidationError(
      "This draft was written before case versions existed and cannot be sent from here. Re-draft the ticket first."
    );
  }
  if (live && OPEN_STATES.includes(live.state)) {
    await outbound.cancel(live.id, "draft_withdrawn");
  }

  // A formatted rewrite arrives as HTML. It is sanitised here, and its text
  // (with the draft's own link folded back to its [[marker]]) is what the edit
  // log compares, so a draft opened and saved unchanged is not an edit.
  let approvedBody = decision.approvedBody;
  let approvedBodyHtml: string | null = null;
  if (decision.status === "edited" && typeof decision.approvedBodyHtml === "string") {
    approvedBodyHtml = sanitiseReplyHtml(decision.approvedBodyHtml);
    approvedBody = replyHtmlToText(approvedBodyHtml, { link: current.reply_link ?? null });
    if (!approvedBody) throw new KnowledgeValidationError("The reply is empty.");
  }

  await record.decide(current.id, {
    status: decision.status,
    approvedBodyText: approvedBody,
    approvedBodyHtml,
    // The dashboard is the only source today. A review copy edited in Outlook is
    // the intended second one, and the column already accepts it.
    source: "dashboard",
  });

  const updated = await record.forTicket(ticketId);

  // APPROVING SENDS, when OUTBOUND_SEND_ENABLED is on: an outbound action and
  // a job for the worker, which checks the case again right before it sends.
  // The key allows one live action per case version, so a double click cannot
  // produce two emails.
  if (sending && updated) {
    const built = actionFromDraft(updated, { mode: "human_approved", requestedBy });
    if (built.error || !built.row) {
      throw new KnowledgeValidationError(`This reply cannot be sent (${built.error}).`);
    }
    const { created, action } = await outbound.create(built.row);
    if (created && action) {
      await getMailJobRecord(shopId).enqueue({
        kind: "send_outbound",
        dedupeKey: sendDedupeKey(action.id),
        payload: { outboundActionId: action.id },
      });
    }
  }

  return mapDraftRow(updated, latestActionFor(await readActions(shopId, ticketId), updated.id));
}

/**
 * The ticket's outbound actions, for showing and for withdrawing a queued one.
 *
 * WITH SENDING OFF, AN UNREADABLE TABLE IS NOT AN ERROR. Nothing can be queued
 * then, so the draft block and the three decisions must keep working on a
 * database without migration 47 — found on 2026-09-28, when the dialog and
 * Approve both failed on the missing table while sending was off. With sending
 * ON it throws: deciding without knowing what is already on its way is exactly
 * the question the actions table exists to answer.
 */
async function readActions(shopId: string, ticketId: string): Promise<any[]> {
  try {
    return await getOutboundRecord(shopId).forTicket(ticketId);
  } catch (error) {
    if (sendOnApprove()) throw error;
    console.warn("outbound actions unreadable while sending is off", (error as Error).message);
    return [];
  }
}

/**
 * Whether approving a draft sends it. OUTBOUND_SEND_ENABLED, off unless set to
 * `true`; the worker reads the same switch and claims no send job without it.
 */
function sendOnApprove(): boolean {
  return process.env.OUTBOUND_SEND_ENABLED === "true";
}

/** The newest action for this draft, whatever its state. */
function latestActionFor(actions: any[], draftId: string): any | null {
  return (Array.isArray(actions) ? actions : []).find((action) => action.draft_id === draftId) ?? null;
}

// --- linking an order by hand ---------------------------------------------------

/**
 * The order a person typed, with the bundle the Order section would show for it.
 *
 * Built with the worker's own `buildOrderContext`, so what the popup previews and
 * what the ticket stores after the change are the same projection.
 */
async function loadOrderForLink(shopId: string, orderNumber: number) {
  const supabase = getSupabaseClient();
  const [order] = await supabaseSelect(
    supabase,
    T.ORDERS,
    { shop_id: shopId, order_number: orderNumber, deleted_at: { operator: "is", value: "null" } },
    COLUMNS.orderForLink,
    { limit: 1 }
  );
  if (!order) return null;

  const { byName, customersById } = await createOrderContextStore(supabase).loadOrders(shopId, [order.name]);
  const full = byName.get(order.name) ?? null;
  const customer = full?.customer_id ? customersById.get(full.customer_id) ?? null : null;
  return {
    order,
    context: full ? buildOrderContext(full, customer) : null,
    // The shop's marketplace handles (`sales_channels`): with none, no buyer is a marketplace placeholder.
    anonymous: isAnonymousMarketplaceBuyer(order, customer, [...(await loadMarketplaces(supabase, shopId)).handles]),
  };
}

function requireOrderNumber(raw: unknown): number {
  const orderNumber = parseOrderNumber(raw);
  if (orderNumber === null) {
    throw new KnowledgeValidationError("Enter an order number, for example 6669 or #6669.");
  }
  return orderNumber;
}

/** What the popup shows before a person commits to linking an order. */
export async function previewTicketOrder(
  shopId: string,
  ticketId: string,
  rawNumber: unknown
): Promise<TicketOrderPreview> {
  const orderNumber = requireOrderNumber(rawNumber);
  const ticket = await getRecord(shopId).findForOrderLink(ticketId);
  if (!ticket) throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);

  const loaded = await loadOrderForLink(shopId, orderNumber);
  if (!loaded) throw new KnowledgeNotFoundError(`There is no order #${orderNumber} in this shop.`);

  return {
    orderName: loaded.order.name,
    placedAt: loaded.order.processed_at ?? null,
    facts: summariseOrderContext(loaded.context),
    match: describeOrderMatch({
      orderEmailHash: loaded.order.customer_email_hash,
      ticketEmailHash: ticket.requester_email_hash,
      anonymous: loaded.anonymous,
    }),
    currentOrder: ticket.shopify_order_number ?? null,
    sameAsCurrent: sameOrder(ticket.shopify_order_number, loaded.order.name),
  };
}

/**
 * A person adds, changes or confirms this ticket's order.
 *
 * THE PERSON IS THE PROOF. None of the resolver's ownership checks apply: the
 * three cases this exists for are an order the resolver could not find, one it
 * found wrongly, and the candidate it offered, all of which a person settles by
 * knowing. The popup shows how the order relates to the sender; it never blocks.
 *
 * `expected` is the order the popup was opened on. A change made meanwhile
 * (another person, or the worker confirming one) is refused rather than
 * overwritten, here and again in the write itself.
 */
export async function changeTicketOrder(
  shopId: string,
  ticketId: string,
  input: { number: unknown; expected: unknown; source: unknown },
  actorId: string | null
): Promise<TicketOrderChange> {
  const orderNumber = requireOrderNumber(input.number);
  const source = String(input.source ?? "");
  if (!(ORDER_LINK_SOURCES as readonly string[]).includes(source)) {
    throw new KnowledgeValidationError(`source must be one of ${ORDER_LINK_SOURCES.join(", ")}.`);
  }
  const expected = typeof input.expected === "string" && input.expected.trim() ? input.expected : null;

  const record = getRecord(shopId);
  const ticket = await record.findForOrderLink(ticketId);
  if (!ticket) throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);

  const changedMeanwhile = new KnowledgeValidationError(
    "This ticket's order changed since you opened it. Reload the ticket and try again."
  );
  if (!sameOrder(ticket.shopify_order_number, expected)) throw changedMeanwhile;

  const loaded = await loadOrderForLink(shopId, orderNumber);
  if (!loaded) throw new KnowledgeNotFoundError(`There is no order #${orderNumber} in this shop.`);
  if (sameOrder(ticket.shopify_order_number, loaded.order.name)) {
    throw new KnowledgeValidationError(`${loaded.order.name} is already this ticket's order.`);
  }

  const columns = manualOrderColumns({
    ticket,
    order: loaded.order,
    context: loaded.context,
    source: source as TicketOrderLinkSource,
    actorId,
    anonymous: loaded.anonymous,
  });
  const row = await record.linkOrderManually(ticketId, {
    expectedOrderNumber: ticket.shopify_order_number ?? null,
    columns,
  });
  if (!row) throw changedMeanwhile;

  const [vipTickets, detail, priority, snoozes, forwarding] = await Promise.all([
    loadVipTickets(shopId, [ticketId]),
    getTicketDetail(shopId, ticketId),
    loadTicketPriority(shopId, [row]),
    readSnoozeFacts(shopId),
    readForwardingFacts(shopId),
  ]);
  return {
    ticket: mapTicketRow(row, undefined, vipTickets, priority.byTicket.get(ticketId), priority.at, snoozes.get(ticketId), forwarding),
    detail,
    reinvestigation: "needs_investigation" in columns ? "queued" : "not_queued",
  };
}

/**
 * A person corrects a ticket from « Edit case »: one Save, any number of fields.
 *
 * WHAT A SAVE TRIGGERS is `overrideChange`'s to decide (scripts/lib/ticket-overrides.mjs):
 * a new situation or subject queues the investigation once, unless the ticket is
 * now outside what the agent investigates (a forwarded `contact`, b2b, level 4,
 * a subject not enabled — the investigation's own `isInvestigable`); a new
 * situation, subject or level raises the case version, which stales every open
 * draft so the pre-send check refuses it. Team, priority and status move nothing.
 * Nothing is sent, and no model runs here: the worker picks the ticket up next poll.
 *
 * `expected` is what the page showed. A change made meanwhile (another person,
 * the fold, the categoriser) is refused rather than overwritten.
 */
export async function saveTicketOverrides(
  shopId: string,
  ticketId: string,
  input: { changes: unknown; expected: unknown; source: unknown },
  actorId: string | null
): Promise<TicketOverrideResult> {
  const changes = input.changes && typeof input.changes === "object" && !Array.isArray(input.changes)
    ? (input.changes as Record<string, unknown>)
    : null;
  if (!changes || Object.keys(changes).length === 0) throw new KnowledgeValidationError("Nothing to save.");
  const source = OVERRIDE_SOURCES.includes(String(input.source)) ? String(input.source) : "edit_case";
  const expected = (input.expected ?? {}) as { status?: unknown; overrides?: unknown };

  const record = getRecord(shopId);
  const ticket = await record.findForOverrides(ticketId);
  if (!ticket) throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);
  const changedMeanwhile = new KnowledgeValidationError(
    "This ticket changed since you opened it. Reload the ticket and try again."
  );
  if (expected.status !== ticket.status) throw changedMeanwhile;

  const supabase = getSupabaseClient();
  let aiSituation: string | null = null;
  if ("situation" in changes) {
    const [latest] = await supabaseSelect(
      supabase,
      T.TICKET_INVESTIGATIONS,
      { ticket_id: ticketId, shop_id: shopId },
      "exemplar_match",
      { order: "investigated_at.desc", limit: 1 }
    );
    const match = (latest?.exemplar_match ?? {}) as Record<string, any>;
    aiSituation = match.verdict === "human"
      ? match.ai_situation ?? null
      : match.policy?.situation_key ?? match.exemplar_key ?? null;
    if (changes.situation !== null) {
      const known = (await listSituations(shopId)).some((row) => row.key === changes.situation);
      if (!known) throw new KnowledgeValidationError(`${String(changes.situation)} is not a situation in the rulebook.`);
    }
  }

  let change;
  try {
    // Loosely typed: TypeScript reads the JS defaults (`null`) as the only allowed type.
    const build = overrideChange as unknown as (args: Record<string, unknown>) => ReturnType<typeof overrideChange>;
    change = build({ ticket, changes, actorId, source, aiSituation, isInvestigable });
  } catch (error) {
    throw new KnowledgeValidationError((error as Error).message);
  }
  if (change.changed.length === 0) throw new KnowledgeValidationError("Nothing changed.");

  const row = await record.applyOverrides(ticketId, {
    expectedStatus: ticket.status,
    expectedOverrides: overridesOf(ticket),
    columns: change.columns,
  });
  if (!row) throw changedMeanwhile;
  await supabaseInsert(
    supabase,
    T.TICKET_OVERRIDES,
    change.audit.map((entry: Record<string, unknown>) => ({ shop_id: shopId, ticket_id: ticketId, ...entry }))
  );

  // Re-fold now: a raised version stales the open drafts before anything can
  // send them, rather than one poll later.
  const folded = await refoldTicket(shopId, ticketId).catch(() => ({ versionsRaised: 0, draftsStaled: 0 }));

  const [ticketItem, detail] = await Promise.all([getTicketListItem(shopId, ticketId), getTicketDetail(shopId, ticketId)]);
  return {
    ticket: ticketItem,
    detail,
    requeued: change.requeued,
    notInvestigable: change.notInvestigable,
    versionChanged: change.versionChanged,
    draftsStaled: folded.draftsStaled ?? 0,
  };
}

/** The order behind a confirmed number, by id — null once retention has deleted it. */
async function findOrderIdByName(shopId: string, orderName: string): Promise<string | null> {
  const [row] = await supabaseSelect(
    getSupabaseClient(),
    T.ORDERS,
    { shop_id: shopId, name: orderName, deleted_at: { operator: "is", value: "null" } },
    "id",
    { limit: 1 }
  );
  return row ? String(row.id) : null;
}

/** The draft row, scoped to this shop. Owned by scripts/lib/draft-record.mjs. */
function getDraftRecord(shopId: string) {
  return createDraftRecord(getSupabaseClient(), { shopId });
}

function getOutboundRecord(shopId: string) {
  return createOutboundRecord(getSupabaseClient(), { shopId });
}

function getMailJobRecord(shopId: string) {
  return createMailJobRecord(getSupabaseClient(), { shopId });
}

/**
 * The stored draft, as the dialog needs it.
 *
 * `body` stays the MODEL's text even when a reviewer has rewritten it. Showing
 * the rewrite in its place would hide the only honest measure of how good the
 * drafting is — see 07_drafting.sql on why the two bodies are separate columns.
 */
function mapDraftRow(row: any, action: any | null = null): TicketDraft {
  const checks: any[] = Array.isArray(row.checks) ? row.checks : [];
  return {
    id: row.id,
    body: row.body_text ?? "",
    approvedBody: row.approved_body_text ?? null,
    approvedBodyHtml: row.approved_body_html ? sanitiseReplyHtml(row.approved_body_html) : null,
    // The link the draft's [[marker]] was written about, copied at drafting time.
    replyLink:
      row.reply_link && typeof row.reply_link.url === "string" && typeof row.reply_link.label === "string"
        ? { url: row.reply_link.url, label: row.reply_link.label }
        : null,
    sourceVerdict: DRAFT_VERDICTS.includes(row.source_verdict) ? row.source_verdict : "answerable",
    // Defaults to the safe half of the pair: a draft whose disposition could not
    // be read must not be the one a send closes a ticket on.
    disposition: row.disposition === "terminal" ? "terminal" : "intermediary",
    status: DRAFT_STATUSES.includes(row.status) ? row.status : "pending",
    staleReason:
      row.stale_reason === "case_changed" || row.stale_reason === "superseded_by_outbound" ? row.stale_reason : null,
    checksPassed: Boolean(row.checks_passed),
    // Only the failures: a reviewer needs to know what was caught, not to read
    // a list of everything that was fine.
    failedChecks: checks
      .filter((check) => check && check.passed === false && check.severity !== "warning")
      .map((check) => String(check.detail ?? check.check ?? "unnamed check")),
    // Shown, never blocking: a check marked `severity: 'warning'` does not fail
    // the draft (draft-checks.mjs `checksPassed`).
    warnings: checks
      .filter((check) => check && check.passed === false && check.severity === "warning")
      .map((check) => String(check.detail ?? check.check ?? "unnamed check")),
    // Only the subject holds: level, mood and failed checks are shown elsewhere
    // or are not the reviewer's to act on.
    autoSendHolds: (Array.isArray(row.auto_send_blockers) ? row.auto_send_blockers : [])
      .filter(
        (b: any) =>
          b && (b.reason === "health_topic" || b.reason === "situation" || b.reason === "cosmetovigilance" || b.reason === "refund_notice"),
      )
      .map((b: any) => ({ reason: b.reason, detail: b.detail == null ? null : String(b.detail) })),
    draftedAt: row.drafted_at ?? null,
    sendsOnApprove: sendOnApprove(),
    holdsInDrafts: process.env.OUTBOUND_STOP_BEFORE_SEND === "true",
    outbound: action
      ? {
          state: action.state,
          reason: action.cancel_reason ?? action.failure_reason ?? null,
          at: action.closed_at ?? action.send_requested_at ?? action.created_at ?? null,
        }
      : null,
  };
}

const DRAFT_STATUSES: string[] = ["pending", "approved", "edited", "rejected", "sent", "stale"];
const DRAFT_VERDICTS: string[] = ["answerable", "needs_customer_input", "needs_human"];

/** Oldest first: a conversation reads downwards, unlike the queue. */
function byTimeAsc(a: TicketMessage, b: TicketMessage): number {
  return (Date.parse(a.at ?? "") || 0) - (Date.parse(b.at ?? "") || 0);
}

function mapMessageRow(row: any, directory: any): TicketMessage {
  const display = parseEmailForDisplay(row.body_text ?? null);
  const role = messageRole(row, directory);
  const recipients = [
    ...(Array.isArray(row.to_emails) ? row.to_emails : []),
    ...(Array.isArray(row.cc_emails) ? row.cc_emails : []),
  ];
  return {
    id: row.id,
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    fromName: row.from_name ?? null,
    fromEmail: row.from_email ?? null,
    subject: row.subject ?? null,
    body: row.body_text ?? null,
    bodyClean: display.bodyClean,
    quotedBody: display.quotedBody,
    signature: display.signature,
    forwardedContent: display.forwardedContent,
    quotedMessageCount: display.quotedMessageCount,
    isForward: display.isForward,
    role,
    routeTo: [
      ...new Set(
        recipients
          .map((email) => recipientRole(String(email ?? ""), directory))
          .filter((label): label is string => Boolean(label))
      ),
    ].filter((label) => !(role === "qiriness" && label === ownMailboxLabel(directory))),
    hasAttachments: Boolean(row.has_attachments),
    // Our own replies carry `sent_at` and nothing else; inbound carries
    // `received_at`. One column would leave half the thread undated.
    at: row.received_at ?? row.sent_at ?? null,
  };
}

function messageRole(row: any, directory: any): TicketMessage["role"] {
  if (row.direction === "outbound") return "qiriness";
  const label = directory.lookup(row.from_email ?? null)?.label ?? null;
  if (label === "internal" || label === "contractor") return "internal";
  if (label === "logistics" || label === "courier") return "logistics";
  if (["retailer", "distributor", "supplier", "partner"].includes(label)) return "partner";
  return "customer";
}

/** Our support mailbox as a recipient: the shop's name (`shops.shop_name`, on the directory). */
function ownMailboxLabel(directory: any): string {
  return directory?.companyName || "Support";
}

function recipientRole(email: string, directory: any): string | null {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return null;
  const mailbox = String(process.env.SUPPORT_MAILBOX ?? "").trim().toLowerCase();
  if (mailbox && normalised === mailbox) return ownMailboxLabel(directory);
  const label = directory.lookup(normalised)?.label ?? null;
  if (label === "internal" || label === "contractor") return "Internal";
  if (label === "logistics" || label === "courier") return "Logistics";
  if (["retailer", "distributor", "supplier", "partner"].includes(label)) return "Partner";
  return "Customer";
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

  const [priority, snoozes, forwarding] = await Promise.all([loadTicketPriority(shopId, [row]), readSnoozeFacts(shopId), readForwardingFacts(shopId)]);
  return mapTicketRow(row, undefined, vipTickets, priority.byTicket.get(ticketId), priority.at, snoozes.get(ticketId), forwarding);
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

  const [priority, snoozes, forwarding] = await Promise.all([loadTicketPriority(shopId, [row]), readSnoozeFacts(shopId), readForwardingFacts(shopId)]);
  return mapTicketRow(row, directory, vipTickets, priority.byTicket.get(ticketId), priority.at, snoozes.get(ticketId), forwarding);
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
  vipTickets: Set<string> = new Set(),
  priorityFacts?: PriorityFacts,
  priorityAt: Date = new Date(),
  snoozeFacts: SnoozeFacts = NO_SNOOZE,
  forwarding: ForwardingFacts = NO_FORWARDING
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
  // THE CASE'S FACTS RANK THE ROW (61_cases.sql). A customer who wrote twice on
  // two threads has written four times, the case waits since its own oldest
  // unanswered message, and is as serious as its most serious thread. A row
  // from before the view carried them falls back to the thread's.
  const caseLevel = row.case_level === null || row.case_level === undefined ? level : (Number(row.case_level) as TicketLevel);
  const priorityScore = scorePriority({
    level: caseLevel,
    waitingSince: row.case_id ? row.case_waiting_since ?? null : row.waiting_since ?? null,
    inboundCount: Number((row.case_id ? row.case_inbound_count : row.inbound_count) ?? 0),
    status: row.case_status ?? row.status,
    // A band a person pinned in « Edit case ». The score still climbs inside it.
    pinnedBand: overridesOf(row).priority?.value ?? null,
    ...priorityFacts,
    // Display-only customer status is intentionally absent from the evaluator:
    // VIP can never manufacture urgency for a routine enquiry.
    isVip: customer.isVip,
  }, priorityAt);

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
    caseId: row.case_id ?? null,
    caseThreadCount: Number(row.case_thread_count ?? 1),
    // A row with no case facts (an older view) is its own lead.
    isCaseLead: row.is_case_lead !== false,
    // Null requester_email — a ticket with no stored inbound message — is NOT
    // non-demand. Eleven tickets are in that state, and defaulting them out of
    // the queue would hide customer mail on the strength of a missing join.
    isNonDemand: directory.isNonDemand(row.requester_email ?? null),
    // The stored column, not the derived label: see TicketListItem.isOwnSide.
    isOwnSide: Boolean(row.sender_label),
    ...customer,
    priorityScore,
    priorityBand: priorityBand(priorityScore) as TicketPriorityBand,
    overrides: mapOverrides(row),
    orderNumber: row.shopify_order_number,
    // Counted by the `ticket_message_counts` view the queue joins, and
    // `coalesce`d to 0 there — a ticket with no stored message is a row with a
    // zero, not a row that dropped out of the join.
    messageCount: Number(row.message_count ?? 0),
    waitingSince: row.waiting_since ?? null,
    firstMessageAt: row.first_message_at,
    lastMessageAt: row.last_message_at,
    snooze: snoozeFacts.snooze,
    lastWake: snoozeFacts.lastWake,
    forwarding: forwarding(row.id, row.category ?? null),
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

/** `tickets.overrides` as the page reads it: value, the pipeline's value, when. Never who: an id means nothing on screen. */
function mapOverrides(row: any): TicketOverrides {
  const out: TicketOverrides = {};
  for (const [field, entry] of Object.entries(overridesOf(row) as Record<string, any>)) {
    if (!entry || entry.value === undefined || entry.value === null) continue;
    out[field as TicketOverrideField] = {
      value: entry.value,
      aiValue: entry.ai_value ?? null,
      setAt: entry.set_at ?? null,
    };
  }
  return out;
}
