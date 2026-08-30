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
 *
 * ALL FIVE FIELDS ARE STORED, and that is what makes this the drafting agent's
 * system prompt rather than a page. The response framework and the guardrails
 * were previously fixed constants rendered read-only, which meant the Node
 * worker could not read them at all — a TypeScript constant in `web/` is not
 * reachable from `agent/`. They are seeded from the defaults below and written
 * into `voice_profile` on the next save, so the database is the single source
 * the drafting stage reads and there is no second copy to drift.
 *
 * The two lists stay read-only in the workspace for now; storing them and
 * editing them are separate steps, and only the first one blocks Phase 5.
 */
export interface VoiceProfile {
  roleDescription: string;
  toneAndVoice: string;
  responseFramework: string[];
  guidelinesAndGuardrails: string[];
  /**
   * The closing courtesy line, immediately above the signature.
   *
   * STORED FOR THE SAME REASON THE SIGNATURE IS, and the reason is a
   * measurement: left to the model, 31 of 81 drafts invented their own closer
   * and wrote it 31 different ways. The line is worth saying — it tells the
   * customer the door is open — so the fix is not to forbid it but to approve
   * one wording and reproduce it. Empty means no closing line at all.
   */
  closingLine: string;
  /**
   * The sign-off appended to every drafted reply. The response framework's last
   * step is "apply the approved signature", and until this existed there was no
   * approved signature anywhere in the system for it to refer to.
   */
  signature: string;
}

/** Seed content for the "Response framework" section. Stored on first save. */
export const DEFAULT_RESPONSE_FRAMEWORK: string[] = [
  "Appropriate greeting",
  "Acknowledge the customer's message",
  "Give the relevant answer or resolution",
  "Explain the next step, where applicable",
  "Close politely",
  "Apply the approved signature",
];

/**
 * Seed wording for the closing line. Stored on first save, editable after.
 *
 * Seeded rather than left blank because the alternative is not "no closing
 * line" — it is the model inventing one per draft, which is the behaviour this
 * field exists to replace.
 */
export const DEFAULT_CLOSING_LINE =
  "N’hésitez pas à revenir vers nous si vous avez d’autres questions.";

/** Seed content for the "Guidelines and guardrails" section. Stored on first save. */
export const DEFAULT_GUIDELINES_AND_GUARDRAILS: string[] = [
  "Never invent facts.",
  "Never claim an action has been completed unless explicitly confirmed.",
  "Never promise a refund, replacement, or delivery date unless approved in the brief.",
  "Never make a medical diagnosis.",
  "Never create product claims that are not supplied.",
  "Never expose internal notes, confidence scores, or internal procedures.",
  "Never request information already marked as available.",
  "Never contradict the approved resolution.",
];

export const EMPTY_VOICE_PROFILE: VoiceProfile = {
  roleDescription: "",
  toneAndVoice: "",
  // The two lists default to their seed content rather than to empty: an empty
  // framework would read as "this shop chose to have no framework", which is a
  // different thing from "nobody has edited it yet".
  responseFramework: DEFAULT_RESPONSE_FRAMEWORK,
  guidelinesAndGuardrails: DEFAULT_GUIDELINES_AND_GUARDRAILS,
  closingLine: DEFAULT_CLOSING_LINE,
  signature: "",
};

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

/**
 * What `sender_directory` can say a sender is. Mirrors the table's own check
 * constraint — adding one is a migration, deliberately, because code branches on
 * these values.
 */
export type SenderLabel =
  | "internal"
  | "contractor"
  | "logistics"
  | "courier"
  | "retailer"
  | "distributor"
  | "supplier"
  | "partner"
  | "other";

/** How each label reads on a chip. */
export const SENDER_LABELS: Record<SenderLabel, string> = {
  internal: "Internal",
  contractor: "Contractor",
  logistics: "Logistics",
  courier: "Carrier",
  retailer: "Retailer",
  distributor: "Distributor",
  supplier: "Supplier",
  partner: "Partner",
  other: "Business"
};

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
   * What `sender_directory` says the thread's opener is, or null for the
   * ordinary case — an unlisted sender is a consumer.
   *
   * DERIVED SERVER-SIDE FROM AN ADDRESS THE BROWSER NEVER RECEIVES. The queue is
   * every person who has written in, and shipping their addresses into the page
   * to render a chip would be the widest disclosure on the dashboard for the
   * smallest reason.
   */
  senderLabel: SenderLabel | null;
  /** The directory's free-text note, shown as the chip's tooltip. */
  senderNote: string | null;
  /**
   * True when this ticket was linked as a duplicate of another.
   *
   * A boolean on the row rather than the linked id: the list needs to MARK it,
   * and which ticket it duplicates is a question answered by opening it. The
   * drafting queue already skips these — the chip is so a person working the
   * queue knows before they read one.
   */
  isDuplicate: boolean;
  /**
   * True when the opener is `internal`, `contractor`, `logistics` or `courier` —
   * the labels that mean "this is not customer demand". Such threads leave the
   * Tickets queue for Conversations.
   *
   * False for a thread with no stored inbound message: eleven tickets are in
   * that state, and treating a missing join as "not a customer" would hide real
   * mail.
   */
  isNonDemand: boolean;
  /**
   * True when one of OUR OWN addresses opened the thread — `tickets.sender_label`,
   * stamped at ingestion and narrower than `senderLabel` above.
   *
   * THE TWO ARE NOT INTERCHANGEABLE, which is why both exist. `senderLabel` is
   * derived per request and covers every directory kind, so a Nocibé order
   * carries `retailer`; this covers only `internal` and `contractor`, the labels
   * that mean the sender is us. Partitioning on the wrong one moves a retailer's
   * genuine B2B demand off the Tickets queue — 30 threads instead of 14.
   */
  isOwnSide: boolean;
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
  | "account_email"
  | "product_name"
  | "purchase_channel"
  | "promotion_code"
  | "order_date_or_amount"
  | "photo"
  | "reaction_product_name"
  | "lot_number";

/**
 * Reads after "Ask the customer for …", so each label is a noun phrase.
 *
 * `purchase_channel` WAS MISSING UNTIL 2026-08-30, and the failure was silent by
 * construction: `deriveAction` keeps only fields present in this record, so a
 * ticket whose one question was "did you buy this in a shop?" rendered « Ask the
 * customer for . » — the list it was building came out empty. Adding a key to
 * the agent and not here does not break a build, which is why
 * `case-file.test.mjs` now reads this file and compares both the union and the
 * record against the keys the agent owns.
 */
export const MISSING_FIELD_LABELS: Record<MissingField, string> = {
  shopify_order_number: "the order number",
  purchase_email: "the email address the order was placed with",
  account_email: "which email address their account is under",
  product_name: "which product this is about",
  purchase_channel: "whether they bought it online or in a shop",
  promotion_code: "the promotion code",
  order_date_or_amount: "the order date or amount",
  photo: "a photo of the product",
  reaction_product_name: "which product they were using",
  lot_number: "the batch number on the packaging",
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
  /**
   * Line-item titles. Read for the LAST-ORDER block, where "is this the order
   * they mean" is the question a reviewer is actually answering and the items
   * are what answers it. The confirmed block does not render them — there the
   * order is already known to be the right one.
   */
  items: string[];
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
  /**
   * The customer's most recent order, when they named none.
   *
   * SAME SHAPE AS THE CONFIRMED BLOCK, so the panel renders it with the
   * component it already has under different headings. A CANDIDATE, not a
   * finding: it answers "which order did they most recently place", never
   * "which order do they mean". Never reaches the drafting agent, and never
   * appears beside a confirmed order — the tool fetches it only in the branch
   * where nothing was confirmed.
   */
  candidateOrder: TicketOrderFacts | null;
  /**
   * What the customer blames for a skin reaction, on a cosmetovigilance ticket.
   *
   * Null everywhere else, and null on a reaction ticket the tool never ran on —
   * the panel shows the block only when there is a record, rather than an empty
   * one saying nothing was found.
   */
  reactionReport: TicketReactionReport | null;
  investigatedAt: string | null;
}

/**
 * A reported reaction, as `ticket_investigations.reaction_report` stores it.
 *
 * ATTRIBUTION, NOT CAUSATION, and the panel's job is to render it that way.
 * `product` is what the customer's own words resolved to in the catalogue and
 * `claimed` is those words — both are shown, because a resolution is a match
 * rather than a fact, and an operator deciding what to do about a reaction needs
 * to see whether we matched « ma crème de nuit » to something or read a name.
 */
export interface TicketReactionReport {
  /**
   * `identified` — one catalogue product, named.
   * `ambiguous` — the words matched several; `alternatives` holds them.
   * `not_in_catalogue` — a product we do not sell, or a name we could not place.
   * `not_attributed` — a reaction described with no product blamed at all.
   */
  outcome: "identified" | "ambiguous" | "not_in_catalogue" | "not_attributed" | "unknown";
  /** The catalogue title, only when exactly one product resolved. */
  product: string | null;
  /** The customer's own words for the product. The only unmatched field here. */
  claimed: string | null;
  /** The symptoms, in the customer's words. */
  reaction: string | null;
  /** The candidates behind an `ambiguous` outcome, for whoever resolves it. */
  alternatives: string[];
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
 * `draft` is null whenever the ticket has no case file, or its verdict was
 * `needs_human` — both normal states rather than errors. What a human must do
 * with a needs_human ticket is the case file's handoff, which the detail panel
 * already shows.
 */
export interface TicketThread {
  ticketId: string;
  subject: string | null;
  /**
   * Set when this ticket was linked as a duplicate of another.
   *
   * Shown beside the draft because that is where somebody decides to send, and
   * the drafting queue already refuses to write a new draft here — a draft on a
   * linked ticket is one that must not go out.
   */
  duplicateOf: { ticketId: string; reason: string } | null;
  /**
   * An earlier ticket from the same sender that this one continues. Unlike
   * `duplicateOf` this never blocks the draft — it is context, and when the
   * customer was never answered it is why the reply opens with an apology.
   */
  relatedTo: { ticketId: string; score: number } | null;
  draft: TicketDraft | null;
  messages: TicketMessage[];
  /**
   * The parcels this ticket's confirmed order carries, for linking a tracking
   * number wherever one appears in the text — the customer's own message or the
   * draft. Only parcels holding a real fulfilment URL can be linked, which is
   * why the whole entry travels rather than a list of numbers.
   *
   * Empty for a ticket with no confirmed order, which is most of them.
   */
  parcels: TicketTracking[];
}

/**
 * What the agent would send, and what has been decided about it.
 *
 * `body` is the MODEL's text and never changes; `approvedBody` is a reviewer's
 * rewrite, when there is one. The dialog shows the model's text — the distance
 * between the two is the drafting quality signal, and rendering only the
 * corrected version would hide it (see 07_drafting.sql).
 */
export interface TicketDraft {
  id: string;
  body: string;
  approvedBody: string | null;
  /** Which kind of reply this is; decided by the case file, never by wording. */
  sourceVerdict: "answerable" | "needs_customer_input" | "needs_human";
  /**
   * Whether sending this ends the thread.
   *
   * `terminal` is the only one a send may close the ticket on. `intermediary`
   * means somebody still owes somebody an answer — the customer owes us one, or
   * a colleague owes them one — so it moves the ticket rather than finishing it.
   */
  disposition: "terminal" | "intermediary";
  status: TicketDraftStatus;
  /**
   * Whether every mechanical check passed: the case file's prohibitions, the
   * withheld identifiers, the reply language, the signature. False means the
   * draft is readable but must not be treated as sendable.
   */
  checksPassed: boolean;
  /** One entry per failed check, for the reviewer to see what was caught. */
  failedChecks: string[];
  /** ISO timestamp of when it was written. */
  draftedAt: string | null;
}

/**
 * Mirrors ticket_drafts_status_check in supabase/migrations/07_drafting.sql.
 * `sent` is written by nothing today: there is no send path.
 */
export type TicketDraftStatus = "pending" | "approved" | "edited" | "rejected" | "sent";

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
  /**
   * Parcels matching a tracking number quoted in this email, so the number is a
   * link to the carrier. Computed for the whole list in one lookup and shared by
   * every row: a mail can only ever link a number its own text contains, so a
   * shared list cannot put another mail's parcel into this one.
   *
   * Usually empty — a dropped mail is one the gate refused, and most hold no
   * parcel number at all.
   */
  parcels: TicketTracking[];
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
  { id: "fulfilment", label: "Fulfilment", href: "/insights/fulfilment" },
  { id: "support", label: "Support", href: "/insights/support" },
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
  /**
   * Orders that came back, counted per order rather than per refund — an order
   * refunded twice is one unhappy order. `returnsOpened` is deliberately a
   * separate figure and not folded in: this store records 3 refunds and 0
   * returns, and one combined number would hide that.
   *
   * Null where the view has not been re-applied and the column is absent, so a
   * stale database renders a blocked tile rather than a confident zero.
   */
  refundedOrders: number | null;
  fullyRefundedOrders: number | null;
  returnsOpened: number | null;
  /** Euros refunded across those orders, for whoever wants the money not the count. */
  refundedAmount: number | null;
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
  /**
   * Shipments that produced at least one ticket — the numerator of the contact
   * rate. Orders rather than threads: one order chased four times is one
   * contact, and on a small carrier the other arithmetic exceeds 100%.
   */
  ordersWithTicket: number;
  /** The raw thread count behind those orders, shown beside the rate. */
  tickets: number;
  /**
   * How each carrier's shipments actually end: shipments lost, arriving damaged,
   * or arriving late.
   *
   * **Deliberately null, and there is no source for them yet.** Nothing in the
   * schema separates a lost parcel from a damaged one from a late one — a ticket
   * carries a `delivery` subject and a `request_kind`, and that is the finest
   * grain there is. No carrier scan events reach Shopify either, so the delivery
   * side cannot supply them.
   *
   * They are typed `number | null` rather than `number` so that the day a source
   * exists, wiring it is a change in `mapCarrier` and nowhere else — and so that
   * nothing can quietly default them to 0, which on this panel is a claim that
   * no parcel was ever lost. See `DECISIONS.md § Insights`.
   */
  lost: number | null;
  damaged: number | null;
  late: number | null;
}

/**
 * Why the contact rate is a floor: a ticket reaches a parcel only through a
 * resolved `shopify_order_number`, and most threads never quote one.
 */
export interface FulfilmentTicketCoverage {
  tickets: number;
  withOrderNumber: number;
}

export interface FulfilmentBucket {
  bucket: string;
  order: number;
  orders: number;
  /** Past the three-day line: the two buckets the business argues about. */
  late: boolean;
}

/**
 * One sales channel measured on its own — the same summary, monthly trend and
 * histogram as the store-wide panel, over that channel's orders only.
 *
 * The month series is the channel's own and is usually shorter than the
 * store-wide one: a channel that sold nothing in a month has no row for it, so
 * the two series must not be read side by side as if the indexes lined up.
 */
export interface FulfilmentChannelPanel {
  /** Shopify's stable handle, e.g. `amazon`. What the view is filtered on. */
  channel: string;
  /** The display name Shopify shows in Admin, e.g. `Amazon`. */
  label: string;
  summary: FulfilmentSummary;
  byMonth: FulfilmentMonth[];
  byBucket: FulfilmentBucket[];
}

export interface FulfilmentPanel {
  summary: FulfilmentSummary | null;
  byMonth: FulfilmentMonth[];
  byCarrier: FulfilmentCarrier[];
  byBucket: FulfilmentBucket[];
  /**
   * Amazon on its own, or null if the store has no Amazon orders. A marketplace
   * dispatches against someone else's promise, so its delay is only meaningful
   * read against the store's own figures — which is why it renders directly
   * below them rather than on a page of its own.
   */
  amazon: FulfilmentChannelPanel | null;
  /**
   * Null only if the desk has no tickets at all. When it is present the carrier
   * table must state it: without it the contact-rate column reads as the whole
   * truth rather than as the share the resolver can actually see.
   */
  ticketCoverage: FulfilmentTicketCoverage | null;
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
  /**
   * Orders placed in the same calendar month, from `fulfilment_by_month` — the
   * denominator behind the contact rate. Null where that month has no order row
   * at all, which is not the same as a month that sold nothing.
   */
  orders: number | null;
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

/**
 * Who is writing in, split by whether we can see them buy online.
 *
 * The middle group is the reason this exists. `noOrderTickets` are threads from
 * an address that IS a Shopify customer with zero orders — a newsletter signup,
 * a Shop login, or an address captured at a till. **It is not a non-customer:**
 * a physical-shop sale never reaches Shopify, and three of these people have
 * written a product review, which nobody does for a product they never had.
 *
 * Two reachability figures because "reachable" has two meanings and they differ
 * here: `deliverable` is a working address, `marketable` is consent to be sent
 * marketing. Both are counts of DISTINCT PEOPLE, not threads.
 */
export interface SupportPurchaseStates {
  tickets: number;
  buyerTickets: number;
  noOrderTickets: number;
  unknownTickets: number;
  noOrderCustomers: number;
  noOrderDeliverable: number;
  noOrderMarketable: number;
}

export interface SupportPurchaseCategory {
  category: KnowledgeCategory | null;
  tickets: number;
  buyerTickets: number;
  noOrderTickets: number;
  unknownTickets: number;
}

export interface SupportPanel {
  byMonth: SupportMonth[];
  byCategory: SupportCategoryRow[];
  replies: SupportReplyStats | null;
  topicMap: TopicMap | null;
  totals: { tickets: number; open: number; unhappy: number; veryUnhappy: number } | null;
  /**
   * The earliest month that has orders, which is not the earliest month that has
   * mail. Where it is earlier, the first month of the ticket series is a partial
   * mailbox over a whole month of trading and its contact rate reads low for a
   * reason that has nothing to do with customers.
   */
  ordersFromMonth: string | null;
  /** Null when no ticket has been ingested at all, never a row of zeros. */
  purchaseStates: SupportPurchaseStates | null;
  purchaseByCategory: SupportPurchaseCategory[];
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

/**
 * One policy rule — a row of `support_answers`.
 *
 * Two axes, and they answer different questions: `situationKey` is what the
 * customer WANTS (null = any situation in the set) and `conditions` is what is
 * TRUE about the order. A rule may name either or both.
 *
 * `route` can only ever tighten — the schema forbids `answerable` — so a rule
 * can hand a ticket to a person and can never declare one safe.
 */
export interface PolicyRule {
  id: string;
  answerSet: string;
  answerKey: string;
  situationKey: string | null;
  /** `{ need: [findings] }` — a conjunction across needs, a disjunction within one. */
  conditions: Record<string, string[]>;
  answerSkeleton: string | null;
  route: string | null;
  /**
   * MISSING_FIELDS keys. The agent owns the sentences; these name which ones.
   *
   * A LIST because one reply can need two facts — a reaction reported with no
   * product named wants the product AND the batch number, and a single slot made
   * that two round trips. Empty means the rule asks for nothing.
   */
  ask: string[];
  priority: number;
  isFallback: boolean;
  approvalStatus: string;
  updatedAt: string | null;
}

/**
 * What the rule editor may offer, derived from the agent's own vocabulary at
 * request time rather than restated here — a second list would let the dashboard
 * offer a state the agent cannot score.
 *
 * `needs` excludes any that carry no findings: a rule cannot branch on one, so
 * offering it would be offering a branch that never fires.
 */
export interface PolicyVocabulary {
  /**
   * `poweredBy` names the parameter a state is computed from, when there is one.
   * Not offered as a condition — you pick the state, not the number behind it —
   * but shown so the editor can say a rule will never fire while it is unset.
   */
  needs: { need: string; findings: string[]; poweredBy: string | null }[];
  routes: string[];
  asks: string[];
  /** For the skeleton box: the one place a rule names a parameter directly. */
  parameters: { key: string; label: string; set: boolean }[];
}

/** A situation a rule can be keyed to. */
export interface PolicySituation {
  key: string;
  question: string;
  category: string | null;
  answerSet: string | null;
}

/**
 * One number the desk runs on — a row of `support_parameters`, joined to its
 * definition in `scripts/lib/parameters.mjs`.
 *
 * `value` is null when nobody has decided it yet. That is a real state and not a
 * missing setting: every reader handles it, and it is what every parameter
 * starts in, because seeding a guess would put a third answer into circulation
 * wearing the authority of a setting.
 */
export interface SupportParameter {
  key: string;
  /** `days` | `amount` | `text` — how the value is parsed. */
  kind: string;
  label: string;
  description: string;
  /** What changes when this changes, in prose, for whoever is deciding. */
  usedBy: string;
  value: string | null;
  updatedAt: string | null;
}
