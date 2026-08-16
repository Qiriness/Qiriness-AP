/**
 * Domain types for the Agent Setup surface.
 *
 * These describe the knowledge-article model the future AI reply agent will be
 * configured from. They are intentionally UI-facing and decoupled from the
 * Shopify sync / Supabase persistence layers (see AGENTS.md architecture rules).
 */

export type ArticleStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "needs_optimization";

/** Sync relationship between an article and its optional Shopify source page. */
export type SyncState = "none" | "syncing" | "synced" | "error";

/**
 * Knowledge category — the *subject* axis of the shared support taxonomy defined
 * in `scripts/lib/support-taxonomy.mjs` (kept in sync by
 * scripts/lib/knowledge-categories.test.mjs). The same 14 subjects are what the
 * ticket categoriser assigns, so a ticket's subject filters straight into the
 * matching knowledge chunks with no mapping in between.
 *
 * "faq" and "brand_story" are knowledge-only: nobody emails support "an FAQ", and
 * brand story is drafting context rather than a request. Tickets carry a separate
 * request_kind (question / problem / complaint / contact) — an article is reference
 * material and has no kind, which is why that axis lives only on tickets.
 */
export type KnowledgeCategory =
  | "order"
  | "delivery"
  | "return_exchange"
  | "product"
  | "product_stock"
  | "payment"
  | "account"
  | "promotions"
  | "cosmetovigilance"
  | "legal_privacy"
  | "b2b"
  | "partner_collaboration"
  | "careers"
  | "other"
  | "faq"
  | "brand_story";

export const CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  order: "Orders",
  delivery: "Delivery",
  return_exchange: "Returns & exchanges",
  product: "Product information & advice",
  product_stock: "Product stock",
  payment: "Payments",
  account: "Accounts",
  promotions: "Promotions",
  cosmetovigilance: "Cosmetovigilance",
  legal_privacy: "Legal & privacy",
  b2b: "B2B",
  partner_collaboration: "Partnerships & collaborations",
  careers: "Careers",
  other: "Other",
  faq: "FAQ",
  brand_story: "Brand story",
};

export const KNOWLEDGE_CATEGORIES: KnowledgeCategory[] = [
  "order",
  "delivery",
  "return_exchange",
  "product",
  "product_stock",
  "payment",
  "account",
  "promotions",
  "cosmetovigilance",
  "legal_privacy",
  "b2b",
  "partner_collaboration",
  "careers",
  "other",
  "faq",
  "brand_story",
];

/**
 * The subjects a *ticket* can carry — the 14 the categoriser assigns, without
 * the two knowledge-only shapes. `faq` and `brand_story` describe reference
 * material, not something anyone emails support about, so they can never be a
 * forwarding target. Mirrors the check constraint in
 * supabase/migrations/04_support.sql.
 */
export const TICKET_CATEGORIES: KnowledgeCategory[] = KNOWLEDGE_CATEGORIES.filter(
  (category) => category !== "faq" && category !== "brand_story"
);

/** category -> the colleague who receives mail of that subject. */
export interface CategoryForwarding {
  category: KnowledgeCategory;
  forwardEmail: string | null;
}

/**
 * The required-knowledge slots every agent needs covered. Mirrors the
 * knowledge_documents_core_topic_check constraint in
 * supabase/migrations/03_knowledge.sql — keep in sync. Five of
 * these ("order_policies" through "faqs") make up the Core setup checklist;
 * "brand" is the Drafting agent setup slot instead (see CORE_TOPICS, which
 * excludes it, and BrandVoiceWorkspace).
 */
export type CoreTopic =
  | "order_policies"
  | "brand"
  | "confidentiality"
  | "delivery_returns"
  | "locations"
  | "faqs";

export const CORE_TOPIC_LABELS: Record<CoreTopic, string> = {
  order_policies: "Order policies",
  brand: "Brand voice",
  confidentiality: "Confidentiality & privacy",
  delivery_returns: "Delivery & returns",
  locations: "Store locations",
  faqs: "FAQs",
};

/** Sensible default category to pre-fill when starting an article from a core-topic slot. */
export const CORE_TOPIC_DEFAULT_CATEGORY: Record<CoreTopic, KnowledgeCategory> = {
  order_policies: "order",
  brand: "brand_story",
  confidentiality: "legal_privacy",
  // The slot combines delivery and returns; "delivery" is the more common half.
  delivery_returns: "delivery",
  locations: "other",
  faqs: "faq",
};

// "brand" is intentionally excluded — Brand voice now lives in its own
// "Drafting agent setup" section (see BrandVoiceWorkspace) instead of the
// Core setup checklist, though it remains a valid CoreTopic value and DB slot.
export const CORE_TOPICS: CoreTopic[] = [
  "order_policies",
  "confidentiality",
  "delivery_returns",
  "locations",
  "faqs",
];

/**
 * Every valid CoreTopic value, including "brand" — for validating a raw
 * coreTopic string from the API. Deliberately distinct from CORE_TOPICS
 * (the Core setup checklist subset): using CORE_TOPICS for this check would
 * silently null out "brand" on every article, since it was removed from that
 * list.
 */
export const ALL_CORE_TOPICS: CoreTopic[] = [...CORE_TOPICS, "brand"];

/** A Shopify page or shop policy available to import, from the unified catalog. */
export interface ShopifySource {
  id: string;
  title: string;
  handle: string;
  sourceType: "shopify_page" | "shopify_policy";
}

export interface Article {
  id: string;
  title: string;
  status: ArticleStatus;
  /** Article body as HTML. Optimized/edited by the team, agent-facing. */
  content: string;
  category: KnowledgeCategory;
  /** Required-knowledge slot this article fulfills, if any (see the core topics). */
  coreTopic: CoreTopic | null;
  /** Optional Shopify source (page or policy) this article was initialized from. */
  sourcePageId: string | null;
  syncState: SyncState;
  /** Human label, e.g. "2h ago", derived from the article's updatedAt. */
  updatedLabel: string;
  lastSyncedLabel?: string;
  /** Structured brand-voice fields. Only meaningful when coreTopic === "brand". */
  voiceProfile?: VoiceProfile | null;
}

/**
 * Structured, always-included context for the drafting agent: how it should
 * describe itself and sound, regardless of what the email is about. Distinct
 * from category articles, which are retrieved selectively per email subject.
 * Response Framework and Guidelines and Guardrails are intentionally not
 * part of this shape yet — they render as fixed placeholder content (see
 * RESPONSE_FRAMEWORK_PLACEHOLDER / GUIDELINES_AND_GUARDRAILS_PLACEHOLDER)
 * until that part of the page is designed in more depth.
 */
export interface VoiceProfile {
  roleDescription: string;
  toneAndVoice: string;
}

export const EMPTY_VOICE_PROFILE: VoiceProfile = {
  roleDescription: "",
  toneAndVoice: "",
};

/** Fixed placeholder content for the "Response Framework" section — not yet editable or stored. */
export const RESPONSE_FRAMEWORK_PLACEHOLDER: string[] = [
  "Appropriate greeting",
  "Acknowledge the customer's message",
  "Give the relevant answer or resolution",
  "Explain the next step, where applicable",
  "Close politely",
  "Apply the approved signature",
];

/** Fixed placeholder content for the "Guidelines and Guardrails" section — not yet editable or stored. */
export const GUIDELINES_AND_GUARDRAILS_PLACEHOLDER: string[] = [
  "Never invent facts.",
  "Never claim an action has been completed unless explicitly confirmed.",
  "Never promise a refund, replacement, or delivery date unless approved in the brief.",
  "Never make a medical diagnosis.",
  "Never create product claims that are not supplied.",
  "Never expose internal notes, confidence scores, or internal procedures.",
  "Never request information already marked as available.",
  "Never contradict the approved resolution.",
];

export const STATUS_LABELS: Record<ArticleStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  needs_optimization: "Needs optimization",
};

/** Save lifecycle for the active article editor. */
export type SaveState = "saved" | "unsaved" | "saving";

/* ---------------------------------------------------------------- tickets */

/** Mirrors tickets_status_check in supabase/migrations/04_support.sql. */
export type TicketStatus =
  | "open"
  | "awaiting_customer"
  | "awaiting_human"
  | "forwarded"
  | "resolved"
  | "closed"
  | "spam";

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open",
  awaiting_customer: "Awaiting customer",
  awaiting_human: "Awaiting human",
  forwarded: "Forwarded",
  resolved: "Resolved",
  closed: "Closed",
  spam: "Spam",
};

/**
 * Severity, 1-4, derived from (subject, kind) with the categoriser allowed to
 * escalate but never to lower. Level 4 is severity, not a subject: an explicit
 * threat of legal action or public exposure, hospitalisation, or grave danger.
 * It can only arrive as an escalation read from the email itself.
 */
export type TicketLevel = 1 | 2 | 3 | 4;

export const TICKET_LEVEL_LABELS: Record<TicketLevel, string> = {
  1: "Level 1",
  2: "Level 2",
  3: "Level 3",
  4: "Level 4",
};

/** The one-line gloss under each level, so the number is not the only cue. */
export const TICKET_LEVEL_MEANINGS: Record<TicketLevel, string> = {
  1: "Routine",
  2: "Standard",
  3: "Needs a human",
  4: "Severe",
};

/**
 * How the customer FEELS, 1-4 — mirrors tickets_happiness_check in
 * 04_support.sql. Deliberately independent of `level`: level is the work
 * a ticket needs, happiness is the mood it arrived in. An angry customer with a
 * routine tracking question is happiness 4, level 2 — both true.
 */
export type TicketHappiness = 1 | 2 | 3 | 4;

/** Visual priority tier for the ticket row border. */
export type TicketPriorityBand = "high" | "medium" | "low";

/** The gloss behind each score, used as the face's tooltip. */
export const TICKET_HAPPINESS_MEANINGS: Record<TicketHappiness, string> = {
  1: "Happy",
  2: "Neutral",
  3: "Discontent",
  4: "Really unhappy",
};

/** Mirrors tickets_responsible_team_check in 04_support.sql. */
export type ResponsibleTeam = "finance" | "marketing" | "sales" | "logistics" | "contact";

export const RESPONSIBLE_TEAM_LABELS: Record<ResponsibleTeam, string> = {
  finance: "Finance",
  marketing: "Marketing",
  sales: "Sales",
  logistics: "Logistics",
  contact: "Contact",
};

/** One row of the ticket list. */
export interface TicketListItem {
  id: string;
  subject: string | null;
  status: TicketStatus;
  category: KnowledgeCategory | null;
  secondaryCategory: KnowledgeCategory | null;
  level: TicketLevel | null;
  happiness: TicketHappiness | null;
  responsibleTeam: ResponsibleTeam | null;
  /** The name on the email itself — what the sender typed, not who they are. */
  requesterName: string | null;
  /**
   * The matched Shopify customer's name, from `tickets.customer_id`.
   *
   * Null whenever the customer-resolution pass has not linked the ticket: the
   * sender has no Shopify account, the pass has not run, or the address never
   * matched. That is the normal state for a stranger writing in, and it is why
   * `requesterName` stays the fallback rather than being replaced.
   */
  customerName: string | null;
  /** Raw Shopify RFM segment, already labelled for display. */
  rfmGroup: string | null;
  /**
   * Derived from the RFM group at read time, never stored — Shopify recomputes
   * the segment as a customer buys, so a flag copied onto the ticket would go
   * stale on any open thread. See scripts/lib/customer-segments.mjs.
   */
  isVip: boolean;
  /**
   * Read-time queue score from `scripts/lib/ticket-priority.mjs`.
   *
   * Not stored: wait time changes continuously and the weights are business
   * judgement, so the dashboard receives the current derived value with each
   * list read.
   */
  priorityScore: number;
  priorityBand: TicketPriorityBand;
  orderNumber: string | null;
  messageCount: number;
  /**
   * When the customer has been waiting since, supplied by the `ticket_queue`
   * view. Falls back to the first message timestamp only where the view cannot
   * establish an inbound wait.
   */
  waitingSince: string | null;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

/* ------------------------------------------------------- ticket detail */

/** Mirrors ticket_investigations_verdict_check in 04_support.sql. */
export type InvestigationVerdict = "answerable" | "needs_customer_input" | "needs_human";

/**
 * The facts only a customer can supply — the keys of MISSING_FIELDS in
 * `agent/src/investigation/case-file.mjs`.
 *
 * The agent stores the key and owns the French sentence that asks the customer
 * for it; these are the English fragments the dashboard shows an operator, so
 * the two renderings can never drift into contradicting each other.
 */
export type MissingField =
  | "shopify_order_number"
  | "purchase_email"
  | "product_name"
  | "promotion_code"
  | "order_date_or_amount"
  | "photo";

/** Reads after "Ask the customer for …", so each label is a noun phrase. */
export const MISSING_FIELD_LABELS: Record<MissingField, string> = {
  shopify_order_number: "the order number",
  purchase_email: "the email address the order was placed with",
  product_name: "which product this is about",
  promotion_code: "the promotion code",
  order_date_or_amount: "the order date or amount",
  photo: "a photo of the product",
};

/**
 * Shopify's own status for the order, as `deriveOrderStatus` in
 * `scripts/lib/shopify-order-mapper.mjs` writes it to `orders.order_status`.
 * Mirrored here so the panel labels the stored value rather than re-deriving it.
 */
export type OrderStatus =
  | "cancelled"
  | "return_refund_in_progress"
  | "return_refund_completed"
  | "delivered"
  | "in_transit"
  | "partially_fulfilled"
  | "fulfilled"
  | "unfulfilled"
  | "closed"
  | "open";

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  cancelled: "Cancelled",
  return_refund_in_progress: "Return or refund in progress",
  return_refund_completed: "Return or refund completed",
  delivered: "Delivered",
  in_transit: "In transit",
  partially_fulfilled: "Partially fulfilled",
  fulfilled: "Fulfilled",
  unfulfilled: "Unfulfilled",
  closed: "Closed",
  open: "Open",
};

/**
 * Where the parcel is, as `buildDelivery` in
 * `agent/src/resolution/order-context.mjs` derives it.
 *
 * Deliberately not the same axis as OrderStatus: Shopify's status says whether
 * the warehouse dispatched, the delivery state says whether the carrier has
 * moved it. "Fulfilled" with no carrier scan is both, and they are different
 * answers to "where is my parcel?".
 */
export type DeliveryState = "delivered" | "in_transit" | "dispatched" | "not_dispatched";

export const DELIVERY_STATE_LABELS: Record<DeliveryState, string> = {
  delivered: "Delivered",
  in_transit: "In transit",
  // The largest delivery cluster in the corpus: dispatched, and the carrier has
  // not scanned it yet. Saying only "dispatched" hides the half that matters.
  dispatched: "Dispatched, no carrier scan yet",
  not_dispatched: "Not dispatched",
};

/** One parcel on the order. */
export interface TicketTracking {
  number: string;
  carrier: string | null;
  url: string | null;
}

/**
 * The order facts an operator reads off the expanded row, projected from
 * `tickets.resolved_context` (built by `buildOrderContext`).
 *
 * Every field is nullable and every one is omitted from the panel when empty:
 * an unresolved ticket should show no order lines at all rather than a column
 * of dashes.
 */
export interface TicketOrderFacts {
  /** Shopify order name, e.g. "#1234". */
  orderName: string | null;
  /**
   * Who the order belongs to, from the Shopify account it is attached to — the
   * name to read against the requester's. Not a field on `orders`: that table
   * stores no name, so this comes through `resolved_context.customer`.
   */
  customerName: string | null;
  /**
   * The address the order was placed with, masked (`j***l@orange.fr`). Stored
   * for exactly this reading: when the two names disagree, the address is what
   * says whether it is a gift, a partner's account, or something worth a look.
   */
  contactEmail: string | null;
  /** Already labelled — the panel renders it as-is. */
  orderStatus: string | null;
  /** Already labelled. Null when the bundle carries no delivery block. */
  trackingStatus: string | null;
  tracking: TicketTracking[];
  /** When the bundle was assembled; a stale one describes an older order state. */
  resolvedAt: string | null;
}

/**
 * The agent's reading of one ticket, as the expanded row shows it.
 *
 * A projection of the latest `ticket_investigations` row, not the row itself:
 * the case file's four evidence lists exist for the drafting stage, and dropping
 * them all into a queue panel would bury the two things an operator opens a
 * ticket to learn — what came of it, and what to do next.
 */
export interface TicketResults {
  verdict: InvestigationVerdict;
  /** One line placing the verdict, so the badge is not the only cue. */
  headline: string;
  /** The established facts. Each rests on a tool call that actually ran. */
  findings: string[];
  /**
   * What could NOT be established, and why — the customer's assertions and the
   * questions no tool could settle. Shown because an empty answer is a decision
   * a person may need to make differently, and because a recurring entry here is
   * usually a missing knowledge article rather than a missing tool.
   */
  unresolved: { claim: string; why: string }[];
  /** One short sentence: what needs to happen next. */
  action: string;
  /** Why a human was asked for. Internal — never customer-facing. */
  actionReason: string | null;
  investigatedAt: string | null;
}

/**
 * One thing the investigation established, structured rather than in prose.
 *
 * The findings on `TicketResults` are the model's sentences; these are the facts
 * underneath them, so a person can see WHICH product, WHICH code and why it was
 * refused without opening Shopify. Everything here is derived in the agent from
 * a tool call that actually ran — the dashboard labels and never re-derives.
 */
export interface TicketFact {
  /** The need this answers, e.g. "promotion_validity". Stable, from a closed list. */
  need: string;
  /** The French label the agent already wrote for it. */
  label: string;
  /** What it turned out to be, already labelled. Null when nothing branches on it. */
  outcome: string | null;
  /**
   * The specifics, as short lines the panel renders in order. Never empty — a
   * fact with nothing to say is dropped rather than shown as a bare heading.
   */
  lines: string[];
}

/** What `GET /api/tickets/:id` returns for the expanded row. */
export interface TicketDetail {
  ticketId: string;
  /**
   * null when no case file exists: the ticket is uncategorised, its subject is
   * outside `ENABLED_SUBJECTS`, or the investigation pass has not reached it.
   */
  results: TicketResults | null;
  /**
   * null when `tickets.resolved_context` is still empty — no order number was
   * confirmed, or the context pass has not run. Separate from `results`: the
   * order facts come from Shopify via the resolution pass, the results come
   * from the investigation, and either can exist without the other.
   */
  order: TicketOrderFacts | null;
  /**
   * The structured facts behind the findings, for every family — empty when the
   * investigation established nothing specific, which is the normal state for a
   * ticket whose tools all came back empty-handed.
   *
   * Separate from `order` on purpose: order facts are ambient (the resolution
   * pass writes them, and they exist for tickets the agent never investigated),
   * while these exist only because an investigation ran.
   */
  facts: TicketFact[];
}

/* ------------------------------------------------------- ticket thread */

/** One email in a ticket's conversation, as the thread dialog shows it. */
export interface TicketMessage {
  id: string;
  /** "outbound" is the desk's own reply — the Inbox holds both. */
  direction: "inbound" | "outbound";
  fromName: string | null;
  fromEmail: string | null;
  subject: string | null;
  /** The cleaned plain-text body (`ticket_messages.body_text`). */
  body: string | null;
  hasAttachments: boolean;
  at: string | null;
}

/**
 * A ticket's conversation, plus the reply that would be sent for it.
 *
 * `draft` is ALWAYS null today and that is not a bug: the drafting agent is
 * Phase 5 and nothing writes a draft yet (there is no column and no table for
 * one). The field exists so the dialog renders the section it belongs in and
 * the wiring point is a single named thing rather than a redesign later.
 */
export interface TicketThread {
  ticketId: string;
  subject: string | null;
  draft: TicketDraft | null;
  messages: TicketMessage[];
}

/** What the agent would send, once drafting exists. */
export interface TicketDraft {
  body: string;
  /** ISO timestamp of when it was written. */
  draftedAt: string | null;
}

/**
 * One spam-gate decision that dropped an email.
 *
 * NOT a ticket: dropped mail never reaches the `tickets` table, so this is a
 * `spam_audit` row. There is no body — only what the gate recorded.
 */
export interface DroppedMail {
  id: string;
  graphMessageId: string;
  /** null when the deterministic blocklist decided, which writes no label. */
  label: "keep" | "spam" | "irrelevant" | null;
  decidedBy: "blocklist" | "llm";
  reason: string;
  fromEmail: string | null;
  subject: string | null;
  /**
   * The dropped email's text (04_support.sql) — what makes the decision
   * reviewable at all, since a subject line cannot tell a newsletter from a
   * customer whose parcel is lost.
   *
   * Null in three distinguishable states, which is why `bodyExpiresAt` is here
   * too: never captured (the row predates the body columns and the backfill
   * has not reached it, or the message had left the mailbox), captured and
   * since expired, or a genuinely empty email.
   */
  body: string | null;
  /** When the body was stored. Null means it never was. */
  bodyCapturedAt: string | null;
  /** When the worker's purge clears the body. Past = already purged. */
  bodyExpiresAt: string | null;
  failedOpen: boolean;
  decidedAt: string | null;
}

/**
 * The header cards.
 *
 * `open`, `highPriority` and `levelThree` all count the LIVE set — everything
 * not resolved or closed, which is the rows Queue and Backlog render between
 * them. See summariseTickets for what each one used to count instead and how
 * far the cards drifted from the tables as a result.
 */
export interface TicketStats {
  total: number;
  /** Not `status === "open"`: anything not resolved or closed, including `awaiting_human`. */
  open: number;
  /** The red band — `priorityBand === "high"` — among live tickets. */
  highPriority: number;
  /** Level 3 among live tickets. */
  levelThree: number;
  /** Rolling windows, not calendar periods — see summariseTickets. */
  last24h: number;
  last30d: number;
}

// ---------------------------------------------------------------- Insights
//
// The four analytics panels. Every shape here is the mapped form of one view in
// `supabase/migrations/06_analytics.sql` — the panels never aggregate rows in
// the browser or the server, because PostgREST caps a response at 1,000 rows
// and pages an unordered query in overlapping slices. The one thing that IS
// derived in TypeScript is who counts as a VIP, which is a business rule owned
// by `scripts/lib/customer-segments.mjs`.
//
// `null` means "not measurable", never zero. A month with no ingested mail and
// a month with no tickets look identical on a chart unless that difference
// survives all the way to the component.

/** Which panel is on screen. Real routes, so a panel can be linked to. */
export type InsightsPanel = "support" | "fulfilment" | "customers" | "agent";

export const INSIGHTS_PANELS: { id: InsightsPanel; label: string; href: string }[] = [
  { id: "support", label: "Support", href: "/insights/support" },
  { id: "fulfilment", label: "Fulfilment", href: "/insights/fulfilment" },
  { id: "customers", label: "Customers", href: "/insights/customers" },
  { id: "agent", label: "Agent", href: "/insights/agent" },
];

// --- Fulfilment ------------------------------------------------------------

export interface FulfilmentSummary {
  orders: number;
  measured: number;
  p50Hours: number | null;
  p90Hours: number | null;
  meanHours: number | null;
  over48h: number;
  over72h: number;
  shippedWithoutTracking: number;
  /** Coverage check on delivery data: 1 of 2,006 today. */
  withDeliveryEvent: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
}

export interface FulfilmentMonth {
  month: string;
  orders: number;
  p50Hours: number | null;
  p90Hours: number | null;
  over72h: number;
  measured: number;
  /** The month being read: half a month of data, and labelled as such. */
  partial: boolean;
}

export interface FulfilmentCarrier {
  carrier: string;
  shipments: number;
  p50Hours: number | null;
  over72h: number;
  withoutTracking: number;
}

export interface FulfilmentBucket {
  bucket: string;
  order: number;
  orders: number;
  /** Past the three-day line: the two buckets the business argues about. */
  late: boolean;
}

export interface FulfilmentPanel {
  summary: FulfilmentSummary | null;
  byMonth: FulfilmentMonth[];
  byCarrier: FulfilmentCarrier[];
  byBucket: FulfilmentBucket[];
  /**
   * False while no carrier feeds scan events back to Shopify, which is the
   * state today. The delivery tiles then render as explicitly blocked rather
   * than as zeros — a zero would read as "nothing is late".
   */
  hasDeliveryData: boolean;
}

// --- Support ---------------------------------------------------------------

export interface SupportMonth {
  month: string;
  tickets: number;
  unhappy: number;
  veryUnhappy: number;
  levelThree: number;
  stillOpen: number;
  meanHappiness: number | null;
  p50ReplyHours: number | null;
  repliedWithin24h: number;
  repliesMeasured: number;
}

export interface SupportCategoryRow {
  category: KnowledgeCategory | null;
  tickets: number;
  stillOpen: number;
  unhappy: number;
  levelThree: number;
  meanHappiness: number | null;
}

export interface SupportReplyStats {
  /** Tickets the desk answered from the synced mailbox — the honest denominator. */
  measured: number;
  total: number;
  p50Hours: number | null;
  p90Hours: number | null;
  within24h: number;
}

export interface TopicCluster {
  id: string;
  subject: string;
  clusterIndex: number;
  size: number;
  cohesion: number | null;
  excerpt: string | null;
}

/**
 * The topic map's provenance. It is rebuilt by hand on purpose — clustering is
 * an all-pairs comparison whose threshold is hand-tuned — so the panel has to
 * say how old the map is and whether the corpus has moved on since.
 */
export interface TopicMap {
  runId: string;
  builtAt: string;
  threshold: number;
  minSize: number;
  messageCount: number;
  internalExcluded: number;
  subjectCount: number;
  topicCount: number;
  clusters: TopicCluster[];
  /** Live embedded customer messages now, against `messageCount` when built. */
  liveMessageCount: number | null;
  /** True once the corpus has drifted far enough that the map describes a different inbox. */
  stale: boolean;
}

export interface SupportPanel {
  byMonth: SupportMonth[];
  byCategory: SupportCategoryRow[];
  replies: SupportReplyStats | null;
  topicMap: TopicMap | null;
  totals: { tickets: number; open: number; unhappy: number; veryUnhappy: number } | null;
}

// --- Customers -------------------------------------------------------------

export interface SegmentTotal {
  rfmGroup: string | null;
  label: string | null;
  isVip: boolean;
  customers: number;
  buyers: number;
  repeatBuyers: number;
  marketingOptedIn: number;
  totalSpent: number;
}

export interface CustomerAtRisk {
  ticketId: string;
  customerName: string | null;
  rfmGroup: string | null;
  label: string | null;
  category: KnowledgeCategory | null;
  level: TicketLevel | null;
  happiness: TicketHappiness | null;
  status: TicketStatus;
  amountSpent: number;
  numberOfOrders: number;
  firstMessageAt: string | null;
}

export interface CustomerPanel {
  segments: SegmentTotal[];
  /**
   * Both denominators, always. 53,942 of 58,201 customers have never ordered,
   * so a percentage quoted against the wrong one is meaningless.
   */
  base: { customers: number; buyers: number; repeatBuyers: number; marketingOptedIn: number } | null;
  vip: { customers: number; ticketsLinked: number; vipTickets: number; contactRate: number | null } | null;
  vipByCategory: { category: KnowledgeCategory | null; tickets: number }[];
  atRisk: CustomerAtRisk[];
  spendExposed: number;
}

// --- Agent -----------------------------------------------------------------

export interface PipelineFunnel {
  tickets: number;
  categorised: number;
  customerLinked: number;
  orderLinked: number;
  contextBuilt: number;
  investigated: number;
  lowConfidence: number;
  awaitingCategorisation: number;
  awaitingInvestigation: number;
}

export interface EvidenceGapRow {
  need: string;
  label: string;
  state: string | null;
  finding: string | null;
  occurrences: number;
  tickets: number;
}

export interface VerdictRow {
  verdict: InvestigationVerdict;
  investigations: number;
  tickets: number;
  withHandoff: number;
}

export interface UsageMonth {
  month: string;
  model: string;
  pass: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  failedCalls: number;
  /** Null when the model has no configured rate — never silently 0. */
  costUsd: number | null;
}

export interface UsageSummary {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  ticketsTouched: number;
  meanTokensPerTicket: number | null;
  maxTokensOnATicket: number | null;
  firstRecordedAt: string | null;
  lastRecordedAt: string | null;
  /** Summed per model, so an unpriced model does not quietly read as free. */
  costUsd: number | null;
  /** True when at least one model in the window has no configured rate. */
  hasUnpricedModels: boolean;
  monthToDateUsd: number | null;
  monthToDateTokens: number;
}

export interface AgentPanel {
  funnel: PipelineFunnel | null;
  /** Unsatisfied needs only, ranked — a satisfied need is not a blocker. */
  blockers: EvidenceGapRow[];
  verdicts: VerdictRow[];
  automationCeiling: number | null;
  usage: UsageSummary | null;
  usageByMonth: UsageMonth[];
  /** False until the worker has run since token capture was wired. */
  hasUsageData: boolean;
}
