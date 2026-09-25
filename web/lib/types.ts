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
  /**
   * Products this article is about. Lets a retrieved article name the product a
   * question was about when the title matcher cannot — the words customers use
   * about a device are in no product title. Empty on most articles.
   */
  productIds: string[];
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
  /** Shopify's RFM segment, labelled for display — context only, it no longer decides VIP. */
  rfmGroup: string | null;
  /**
   * Under the shop's VIP rule (spend AND orders inside a window, set on the
   * Customers panel), answered at read time by `vip_tickets()`. Never stored.
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
  /**
   * The sales channel, and ONLY when it is not the online store — `Amazon`,
   * `Mirakl Connect`, `Shop`. Null for a web order, which is the ordinary case
   * and needs no mark.
   *
   * A marketplace order behaves differently in ways a reviewer has to know
   * before replying: 402 of 467 Amazon orders carry no tracking number at all,
   * because the marketplace fulfils them and the number never returns through
   * Shopify. Reading "Fulfilled" with no parcel on a web order means something
   * is wrong; on an Amazon order it is normal.
   */
  channel: string | null;
  /** Already labelled — the panel renders it as-is. */
  orderStatus: string | null;
  /** Already labelled. Null when the bundle carries no delivery block. */
  trackingStatus: string | null;
  tracking: TicketTracking[];
  /**
   * Line-item titles. Rendered on BOTH order blocks in the context pane. On the
   * last-order block they answer "is this the order they mean"; on a confirmed
   * order that question is settled, but what was bought is still what a reviewer
   * needs to answer the mail — which product the complaint names, how much is in
   * the parcel that has not arrived.
   */
  items: string[];
  /** When the bundle was assembled; a stale one describes an older order state. */
  resolvedAt: string | null;
  /**
   * True when the order number was accepted on the number alone because the
   * marketplace hid the buyer (`verified_by: marketplace_order_number`). The
   * order is the right one; that it is this sender's was never checked.
   */
  buyerUnverified: boolean;
  /** True when a person linked this order on the dashboard (`verified_by: manual`). */
  linkedByPerson: boolean;
}

/** How an order relates to whoever wrote in. Shown to the person linking it, never enforced. */
export type TicketOrderMatch = "sender_email" | "different_email" | "anonymous_marketplace" | "unknown";

/** Which control a person used: the add button, the edit icon, or confirming the candidate. */
export type TicketOrderLinkSource = "add" | "edit" | "candidate";

/** What `GET /api/tickets/:id/order?number=` returns: the order the popup is about to link. */
export interface TicketOrderPreview {
  orderName: string;
  /** When the order was placed. */
  placedAt: string | null;
  /** The same lines the Order section shows, or null when the bundle carries none. */
  facts: TicketOrderFacts | null;
  match: TicketOrderMatch;
  /** The ticket's order right now, which the change must still match. */
  currentOrder: string | null;
  sameAsCurrent: boolean;
}

/** What `PUT /api/tickets/:id/order` returns. */
export interface TicketOrderChange {
  ticket: TicketListItem;
  detail: TicketDetail;
  /** `not_queued` on a resolved or closed ticket: the order is linked, nothing is re-run. */
  reinvestigation: "queued" | "not_queued";
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
/**
 * How the run reached its situation, and which rule its findings selected.
 *
 * TWO STEPS AND THEY CAN DISAGREE. `situation` is what the customer WANTS,
 * settled by an embedding match or — below the bar — by the near-miss chooser.
 * `rule` is what the evidence then selected inside that situation's set, and a
 * rule naming no situation is a general one that applies across the set. Either
 * can be absent: a ticket can match a situation no rule answers, and a general
 * rule can fire on a ticket whose situation matched nothing.
 *
 * `changedVerdict` is the honest measure of whether the rule DID anything: a
 * rule whose route agrees with the verdict the investigation already reached
 * shaped the reply without moving it, which is the ordinary case.
 */
export interface TicketPolicy {
  /** The situation the run used, or null when none was settled. */
  situation: string | null;
  /** `matched` · `near` · `ambiguous` · `none` — how the situation was reached. */
  match: "matched" | "near" | "ambiguous" | "none" | null;
  /** The closest exemplar and its score, whether or not it cleared the bar. */
  closest: string | null;
  similarity: number | null;
  /** The rule the findings selected, or null when none matched. */
  rule: string | null;
  /** `selected` · `ambiguous` · `fallback` · `none`. */
  ruleVerdict: string | null;
  /** True when the rule's route tightened the verdict the investigation reached. */
  changedVerdict: boolean;
  /** What the rule asked the reply to do. Empty or null when it asked for nothing. */
  route: string | null;
  asks: string[];
  offerCode: string | null;
}

export interface TicketDetail {
  ticketId: string;
  /**
   * `tickets.shopify_order_number` as stored, even when its bundle is not built
   * yet: the value an order change has to match.
   */
  orderNumber: string | null;
  /**
   * The `orders` row behind `orderNumber`, when we hold it — what the Order
   * block links to. Null when the number is confirmed but the order has since
   * been deleted by retention.
   */
  orderId: string | null;
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
  /**
   * What the customer attached, and whether they said they were attaching
   * something. Never null — a ticket with no attachments and no mention is a
   * valid answer, and the panel decides from the contents whether to render a
   * block at all.
   */
  attachments: TicketAttachments;
  /**
   * The situation and rule behind the case file — null when no investigation
   * ran, and present with null fields when one ran and settled on neither.
   */
  policy: TicketPolicy | null;
  /** Latest investigation and its persisted tool-call ledger, newest first. */
  activity: TicketActivityEvent[];
}

/** One attached file, as Graph described it. Metadata only — never the bytes. */
export interface TicketAttachmentFile {
  name: string | null;
  contentType: string | null;
  /** Bytes, as Graph reports them. 0 where the size was not recorded. */
  size: number;
  /**
   * Where to ask for the image, for entries in `images` only.
   *
   * A PATH UNDER THIS ORIGIN, not a Graph URL and not an Exchange id: the
   * server proxies the bytes and the browser never learns how the mailbox
   * addresses them. null on `others`, which are listed by name and never
   * served — see `web/lib/server/attachment-service.ts`.
   */
  src: string | null;
}

/**
 * The attachment picture for one ticket, from `scripts/lib/photo-evidence-rules.mjs`.
 *
 * TWO SIGNALS, NOT ONE, for the reason the shared module documents at length:
 * over the corpus, 74 tickets mention a photo and attach nothing against 16 that
 * actually carry one, and those need different things from a human.
 */
export interface TicketAttachments {
  /** Image parts the customer sent, in arrival order. Furniture excluded. */
  images: TicketAttachmentFile[];
  /** Everything else they attached — CVs, catalogues, invoices, a PDF. */
  others: TicketAttachmentFile[];
  /** Signature logos and inline placeholders: counted so the panel can say so. */
  furniture: number;
  /**
   * false when a message flags an attachment whose metadata was never fetched.
   * The panel must say "not recorded" rather than "nothing attached" — the
   * distinction the `attachments` column's null was created to keep.
   */
  known: boolean;
  /** Did the customer's own words say a photo was coming? */
  mentioned: boolean;
  /** The French term that matched, shown to explain why we think one is missing. */
  matchedTerm: string | null;
  outcome: "attached" | "mentioned_not_attached" | "attachment_type_unknown" | "not_checked" | "none";
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
  /** The stored plain-text body (`ticket_messages.body_text`), kept for original view. */
  body: string | null;
  /** New content before deterministic quote and signature boundaries. */
  bodyClean: string | null;
  /** Previous replies carried under this message, hidden by default. */
  quotedBody: string | null;
  /** Conventional sign-off / boilerplate, hidden by default. */
  signature: string | null;
  /** Transported email thread for a forward, hidden by default. */
  forwardedContent: string | null;
  quotedMessageCount: number;
  isForward: boolean;
  /** Participant class derived from direction + sender directory, never an address. */
  role: "customer" | "qiriness" | "internal" | "logistics" | "partner";
  /** Human-readable recipient classes, with addresses discarded server-side. */
  routeTo: string[];
  hasAttachments: boolean;
  at: string | null;
}

/** A persisted agent action projected for the middle panel's Activity tab. */
export interface TicketActivityEvent {
  id: string;
  at: string | null;
  title: string;
  detail: string | null;
  kind: "investigation" | "lookup";
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
  /** The link the draft's `[[marker]]` was written about, copied at drafting time. */
  replyLink: { url: string; label: string } | null;
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
// The analytics panels, read over a date range. Every figure is the mapped form
// of one row from a ranged function in `supabase/migrations/06_analytics.sql`
// (RANGED READS) — the panels never aggregate rows in the browser or the
// server, because PostgREST caps a response at 1,000 rows and pages an
// unordered query in overlapping slices. What IS decided in TypeScript is
// judgement: who counts as a VIP (`customer-segments.mjs`), which channels make
// a platform, and which empty bucket is a zero (`insights-range.mjs`).
//
// `null` means "not measurable", never zero. A day with no synced mail and a day
// with no tickets look identical on a chart unless that difference survives all
// the way to the component — which is what `BucketState` carries.

/** Which panel is on screen. Real routes, so a panel can be linked to. */
export type InsightsPanel = "overview" | "sales" | "marketing" | "fulfilment" | "support" | "customers" | "agent";

export const INSIGHTS_PANELS: { id: InsightsPanel; label: string; href: string }[] = [
  { id: "overview", label: "Overview", href: "/insights/overview" },
  { id: "sales", label: "Sales", href: "/insights/sales" },
  { id: "customers", label: "Customers", href: "/insights/customers" },
  { id: "marketing", label: "Marketing & funnel", href: "/insights/marketing" },
  { id: "fulfilment", label: "Fulfilment", href: "/insights/fulfilment" },
  { id: "support", label: "Support", href: "/insights/support" },
  { id: "agent", label: "AI agent", href: "/insights/agent" },
];

export type Grain = "hour" | "day" | "week" | "month";

/**
 * A bucket's standing against what its source holds: `measured` (an empty one
 * is a real zero), `partial` (the source's edge or "now" falls inside it), or
 * `missing` (before the source begins, or after it was last synced).
 */
export type BucketState = "measured" | "partial" | "missing";

/** How a chart or tile formats its values. Components format; services don't. */
export type ValueUnit = "count" | "euro" | "hours" | "percent" | "usd" | "tokens";

export type PlatformId = "all" | "shopify" | "amazon" | "yves_rocher";

/** The resolved range, as `resolveRange` in scripts/lib/insights-range.mjs returns it. */
export interface InsightsRange {
  preset: string;
  tz: string;
  grain: Grain;
  label: string;
  compareLabel: string;
  from: string;
  to: string;
  now: string;
  previous: { from: string; to: string };
  keys: string[];
  currentKey: string | null;
  query: Record<string, string>;
}

/** What scopes a panel: which filters apply to it at all. */
export interface InsightsScope {
  /** False on a snapshot panel, where a date range would be a pretence. */
  range: boolean;
  /** False where the rows are tickets, which belong to no sales channel. */
  platform: boolean;
  /** The tooltip on a disabled control: why this filter does not apply here. */
  rangeReason?: string;
  platformReason?: string;
}

export interface SeriesPoint {
  key: string;
  label: string;
  title: string;
  value: number | null;
  state: BucketState;
}

export type FreshnessTone = "ok" | "info" | "warn" | "error";

export interface FreshnessItem {
  id: "orders" | "mail" | "sync" | "topics";
  label: string;
  text: string;
  tone: FreshnessTone;
  /** The instant behind the text, for the tooltip. */
  at: string | null;
}

/** When each source last moved: the edges every coverage decision is made against. */
export interface Freshness {
  items: FreshnessItem[];
  ordersFrom: string | null;
  ordersThrough: string | null;
  mailFrom: string | null;
  mailThrough: string | null;
  topicMapBuiltAt: string | null;
}

/** A figure beside the same figure one period earlier. */
export interface Compared<T = number | null> {
  current: T;
  /** Null when the previous period is outside what the source covers. */
  previous: T | null;
}

// --- Orders (Sales + Fulfilment) --------------------------------------------

export interface OrdersSummary {
  orders: number;
  cancelledOrders: number;
  /** Net of refunds, cancelled orders excluded. */
  revenue: number;
  grossRevenue: number;
  measured: number;
  p50Hours: number | null;
  p90Hours: number | null;
  meanHours: number | null;
  over72h: number;
  shippedWithoutTracking: number;
  withDeliveryEvent: number;
  refundedOrders: number;
  fullyRefundedOrders: number;
  returnsOpened: number;
  refundedAmount: number;
}

export interface FulfilmentBucket {
  bucket: string;
  order: number;
  orders: number;
  /** Past the three-day line. */
  late: boolean;
  /** Not a duration at all: orders placed in the range that have not shipped. */
  waiting: boolean;
}

export interface FulfilmentCarrier {
  carrier: string;
  shipments: number;
  p50Hours: number | null;
  over72h: number;
  withoutTracking: number;
  /** Shipments that produced at least one ticket — orders, not threads. */
  ordersWithTicket: number;
  tickets: number;
  /**
   * Lost / damaged / late. **Deliberately null**: nothing separates them yet —
   * no carrier scan events, and a ticket's subject is only `delivery`. Typed
   * so that wiring a source is a change in the mapper and nowhere else, and so
   * nothing can default them to a confident 0. See DECISIONS.md § Insights.
   */
  lost: number | null;
  damaged: number | null;
  late: number | null;
}

/**
 * One order still waiting to ship, for the Fulfilment list. Names and emails:
 * this is personal data on screen, like the Customers call list.
 */
export interface OpenOrder {
  orderId: string;
  name: string;
  /** Shopify admin link for the order, or null without its legacy id. */
  adminUrl: string | null;
  placedAt: string;
  /** The day it was placed, on the shop clock (`4 Sep 2026`). */
  placedLabel: string;
  /** Whole days since the order was placed. */
  daysWaiting: number;
  /** Three days or more — past the line the dispatch figures are held to. */
  late: boolean;
  platform: PlatformId;
  platformLabel: string;
  channelLabel: string | null;
  status: string;
  total: number;
  units: number;
  customerName: string | null;
  /** Null for marketplace buyers, whose record carries a placeholder address. */
  email: string | null;
  isVip: boolean;
}

// --- Orders page ---------------------------------------------------------------

/** An order's open tickets, as the ring around its destination. */
export interface OrderTicketMark {
  /** The most urgent open ticket's queue band. */
  band: TicketPriorityBand;
  openTickets: number;
}

/** One filter option and how many orders it selects. */
export interface OrderFacet {
  value: string;
  label: string;
  orders: number;
}

/** The filters, as `parseOrderListQuery` reads them from the URL. */
export interface OrderListQuery {
  status: string | null;
  /** A country code, `??` for no destination, or null for Global. */
  country: string | null;
  vip: boolean;
  /** Order name, buyer name or email, or tracking number; null for none. */
  search: string | null;
  page: number;
}

export interface OrderListRow {
  orderId: string;
  name: string;
  /** Shop clock: `14 Sep 2026, 10:22`. */
  placedLabel: string;
  cancelled: boolean;
  customerName: string | null;
  isVip: boolean;
  totalLabel: string;
  /**
   * Shopify's fulfilment status, or `CANCELLED` / `REFUNDED` when nothing is
   * left to ship (`fulfillmentDisplay`). The key the pill is styled on.
   */
  fulfillmentStatus: string;
  fulfillmentLabel: string;
  /** Whole days waiting to ship; null when the order is not waiting. */
  delayDays: number | null;
  /** Waiting three days or more — the line the dispatch figures use. */
  late: boolean;
  units: number;
  carrier: string | null;
  countryCode: string | null;
  country: string | null;
  city: string | null;
  /** Null when no open ticket is confirmed against this order. */
  ticket: OrderTicketMark | null;
}

export interface OrderListPage {
  rows: OrderListRow[];
  /** Orders matching the filters, across every page. */
  total: number;
  pageSize: number;
  /** The query actually served — the page falls back to 1 past the end. */
  query: OrderListQuery;
  facets: { statuses: OrderFacet[]; countries: OrderFacet[] };
  vipRuleSet: boolean;
}

export interface OrderLineItem {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  /** After removals and refunds; below `quantity` when something came off. */
  currentQuantity: number;
  totalLabel: string | null;
  /** Set only when a discount moved the price. */
  originalTotalLabel: string | null;
}

export interface OrderFulfilment {
  id: string;
  name: string | null;
  statusLabel: string;
  createdLabel: string | null;
  deliveredLabel: string | null;
  tracking: { company: string | null; number: string | null; url: string | null }[];
}

export interface OrderLinkedTicket {
  id: string;
  subject: string | null;
  statusLabel: string;
  open: boolean;
  band: TicketPriorityBand;
  score: number;
  level: TicketLevel | null;
}

export interface OrderDetail {
  orderId: string;
  name: string;
  adminUrl: string | null;
  placedLabel: string;
  cancelledLabel: string | null;
  cancelReason: string | null;
  platformLabel: string;
  channelLabel: string | null;
  financialLabel: string | null;
  /** As on `OrderListRow`: Shopify's status, or `CANCELLED` / `REFUNDED`. */
  fulfillmentStatus: string;
  fulfillmentLabel: string;
  returnLabel: string | null;
  tags: string[];
  units: number;
  lineItems: OrderLineItem[];
  fulfilments: OrderFulfilment[];
  returns: { id: string; name: string | null; statusLabel: string; createdLabel: string | null }[];
  refunds: { id: string; createdLabel: string | null; amountLabel: string | null }[];
  money: { label: string; value: string; strong?: boolean }[];
  /**
   * What was applied to this order. A GIFT is a line whose price went to zero
   * because of a named promotion; a SAMPLE was never priced and is listed apart,
   * because a customer asking "was my gift applied?" must not be shown one.
   */
  promotions: {
    applied: { name: string | null; kind: string | null; valueLabel: string | null }[];
    gifts: { title: string; valueLabel: string | null; promotion: string | null }[];
    reductions: { title: string; offLabel: string | null; promotion: string | null }[];
    samples: string[];
    codes: string[];
    totalLabel: string | null;
  };
  destination: { city: string | null; province: string | null; country: string | null; countryCode: string | null } | null;
  customer: {
    name: string | null;
    /** Null for a marketplace buyer, whose record holds a placeholder address. */
    email: string | null;
    isVip: boolean;
    ordersCount: number | null;
    spentLabel: string | null;
  } | null;
  /** `j***l@orange.fr` — shown where no customer record is linked. */
  maskedEmail: string | null;
  tickets: OrderLinkedTicket[];
}

export interface FulfilmentPanel {
  summary: Compared<OrdersSummary>;
  openOrders: OpenOrder[];
  /** False while no VIP rule is set — the VIP view then says so rather than showing an empty list. */
  vipRuleSet: boolean;
  orders: SeriesPoint[];
  medianHours: SeriesPoint[];
  lateShare: SeriesPoint[];
  buckets: FulfilmentBucket[];
  carriers: FulfilmentCarrier[];
  /** False while no carrier feeds delivery events back — the state today. */
  hasDeliveryData: boolean;
  /** Stock at risk, now — not cut by the range. */
  inventory: InventoryExceptions;
}

// --- Storefront analytics (live from Shopify, never stored) ------------------

/** The sessions dataset for one window. Null where unmeasured, never zero. */
export interface StorefrontTotals {
  sessions: number | null;
  visitors: number | null;
  /** Shopify's own: completed-checkout sessions over sessions, as a percentage. */
  conversionRate: number | null;
  pageviews: number | null;
  bounceRate: number | null;
  cartSessions: number | null;
  checkoutSessions: number | null;
  convertedSessions: number | null;
}

/** One step of the storefront funnel, with its share of the step above. */
export interface FunnelStep {
  key: string;
  label: string;
  value: number | null;
  /**
   * False for a step that is measured but does not nest with its neighbours —
   * product page ENTRIES. The chain's percentages skip it.
   */
  chained: boolean;
  /** Share of the first step. */
  ofEntry: number | null;
  /** Share of the step above; null on the first and on an unchained step. */
  ofPrevious: number | null;
}

/**
 * Shopify's money ladder for one window, as the admin's Sales report prints it.
 * `netSales` and `averageOrderValue` cannot be derived from our own columns —
 * see scripts/lib/storefront-analytics.mjs.
 */
export interface StorefrontSales {
  grossSales: number;
  /** A positive magnitude, though ShopifyQL returns it negative. */
  discounts: number;
  returns: number;
  netSales: number;
  taxes: number;
  shipping: number;
  totalSales: number;
  orders: number;
  /** (gross − discounts) ÷ orders: Shopify's formula, net-based. */
  averageOrderValue: number | null;
}

export interface StorefrontChannel {
  /** The traffic source, lowercased: `direct`, `google`, `klaviyo`. */
  channel: string;
  sessions: number | null;
  /** Shopify-attributed revenue for that channel, its own figure, not ours. */
  revenue: number | null;
  orders: number | null;
  conversionRate: number | null;
  revenuePerSession: number | null;
}

/** Where sessions came in: one row per kind of landing page. */
export interface LandingType {
  /** `Product`, `Homepage`, `Collection`, … as Shopify types them. */
  type: string;
  sessions: number | null;
  visitors: number | null;
  cartSessions: number | null;
  convertedSessions: number | null;
  cartRate: number | null;
  conversionRate: number | null;
}

/**
 * One product page sessions ARRIVED on. Entries, not views: Shopify keeps no
 * product-view metric, so a session that landed elsewhere and then browsed to
 * this product is not counted. A floor per page, and not a funnel stage.
 */
export interface ProductPage {
  path: string;
  /** The Shopify handle out of the path, for naming it from our catalogue. */
  handle: string | null;
  /** The product's title once matched on handle; the path is shown when it is not. */
  title: string | null;
  sessions: number | null;
  visitors: number | null;
  cartSessions: number | null;
  cartRate: number | null;
}

/**
 * One Shopify-backed part of a panel, resolved on its own so a card waiting on
 * the rate limit holds up nothing else. `value` is always present — empty when
 * blocked — and `blockedReason` is what the card prints instead of a figure.
 */
export interface LivePart<T> {
  blockedReason: string | null;
  value: T;
}

/**
 * The Overview's Shopify cards, each a promise of its own. Server components
 * await them inside Suspense, so the page renders at once and each card
 * streams in when its queries answer.
 */
export interface OverviewLive {
  /** Net sales, orders, AOV, refunds, the bridge and the platform mix — always live, first in the queue. */
  sales: Promise<LivePart<StorefrontMoney>>;
  /** Net sales, orders and AOV per bucket, on the same basis. Null when Shopify could not be read. */
  series: Promise<LivePart<SalesSeries | null>>;
  totals: Promise<LivePart<Compared<StorefrontTotals>>>;
  sessions: Promise<LivePart<SeriesPoint[] | null>>;
  /** Built from Shopify's money when it answered, from our orders when it did not. */
  signals: Promise<{ signals: ManagementSignal[]; basis: "shopify" | "orders" }>;
}

/**
 * Every money figure the Overview prints, from ONE live ShopifyQL ladder per
 * window, so the cards cannot disagree: net sales, orders, AOV, refunds, the
 * bridge and the platform mix are all Shopify's for the exact range.
 */
export interface StorefrontMoney extends Compared<StorefrontSales | null> {
  /** The Shopify platform alone — the numerator revenue per session needs. */
  storefront: Compared<StorefrontSales | null>;
  /** Net sales per platform over the current window, every platform. */
  platforms: { platform: PlatformId; label: string; netSales: number; orders: number }[];
}

export interface SalesSeries {
  netSales: SeriesPoint[];
  orders: SeriesPoint[];
  aov: SeriesPoint[];
}

/** The Marketing panel's Shopify cards, each a promise of its own. */
export interface MarketingLive {
  totals: Promise<LivePart<Compared<StorefrontTotals>>>;
  funnel: Promise<LivePart<FunnelStep[]>>;
  channels: Promise<LivePart<StorefrontChannel[]>>;
  landingTypes: Promise<LivePart<LandingType[]>>;
  /** Busiest first, named from our catalogue by handle. */
  productPages: Promise<LivePart<ProductPage[]>>;
}

// --- Overview, Marketing & funnel, the monthly report ------------------------

export type InventoryStatus = "out" | "critical" | "low" | "watch";

export interface InventoryException {
  productId: string;
  title: string;
  productType: string | null;
  stock: number;
  /** Units that left over the window, free lines included. */
  unitsOut: number;
  /** Days of stock at that rate; null when nothing left in the window. */
  coverDays: number | null;
  status: InventoryStatus;
}

export interface InventoryExceptions {
  items: InventoryException[];
  /** The window the rate is read over, in days. */
  windowDays: number;
  /** When the products were last synced — how current "stock" is. */
  syncedAt: string | null;
}

/** insights_sales_overview: the basket beside the orders summary. */
export interface SalesOverviewFigures {
  paidOrders: number;
  units: number;
  /** Shopify total_discounts: gifts and free shipping included. */
  discounts: number;
  discountedOrders: number;
  discountedRevenue: number;
  fullPriceRevenue: number;
}

export interface ManagementSignal {
  tone: "good" | "warn" | "neutral";
  title: string;
  detail: string;
}

export interface OverviewPanel {
  summary: Compared<OrdersSummary>;
  /** Live from Shopify Analytics, card by card; see OverviewLive. */
  live: OverviewLive;
  figures: Compared<SalesOverviewFigures>;
  revenue: SeriesPoint[];
  orders: SeriesPoint[];
  aov: SeriesPoint[];
  platforms: PlatformSplit[];
  topProducts: ProductSale[];
  /** Paid revenue across every product, the share's denominator. */
  productRevenue: number;
  inventory: InventoryExceptions;
  signals: ManagementSignal[];
  /** The months the report can be downloaded for, newest first, and the default one. */
  reportMonths: { id: string; label: string }[];
  reportMonth: string;
}

export interface PromotionRow {
  /** Null for the orders that carried no promotion: full price. */
  name: string | null;
  kind: string | null;
  /** LINE_ITEM or SHIPPING_LINE; a shipping promotion takes nothing off a line. */
  target: string | null;
  orders: number;
  revenue: number;
  discount: number;
  /** Null on a marketplace, where every buyer is a new customer record. */
  newCustomerOrders: number | null;
}

export interface MarketingPanel {
  summary: Compared<OrdersSummary>;
  live: MarketingLive;
  figures: Compared<SalesOverviewFigures>;
  promotions: PromotionRow[];
  /** The list's movement and what it captured — moved here from Customers. */
  newsletter: NewsletterActivity;
  /** Klaviyo flows and campaigns in the range, from the nightly sync. */
  klaviyo: KlaviyoPerformance;
}

/** One flow or campaign on the Marketing card. Rates are null when their denominator is 0. */
export interface KlaviyoMessageRow {
  kind: "flow" | "campaign";
  id: string;
  name: string | null;
  /** A campaign's send date (YYYY-MM-DD, shop clock); null for a flow. */
  sentAt: string | null;
  recipients: number;
  opens: number;
  clicks: number;
  conversions: number;
  revenue: number;
  /** Unique opens over delivered, as Klaviyo computes it. */
  openRate: number | null;
  clickRate: number | null;
  conversionRate: number | null;
  revenuePerRecipient: number | null;
}

/**
 * The Klaviyo side of Marketing performance. `blockedReason` is set when there
 * is nothing to show and why: not connected, a marketplace platform, or a read
 * that failed.
 */
export interface KlaviyoPerformance {
  blockedReason: string | null;
  /** The last sync's date (YYYY-MM-DD, shop clock). */
  lastSyncAt: string | null;
  summary: {
    revenue: number;
    recipients: number;
    openRate: number | null;
    clickRate: number | null;
    revenuePerRecipient: number | null;
  } | null;
  /** Only flows and campaigns with at least one click, by open rate. */
  rows: KlaviyoMessageRow[];
  /** Flows and campaigns in the range with no click, counted in the summary but not listed. */
  hiddenWithoutClicks: number;
}

export interface PlatformSplit {
  platform: PlatformId;
  label: string;
  orders: number;
  revenue: number;
}

export interface ProductSale {
  productId: string;
  title: string;
  orders: number;
  units: number;
  revenue: number;
  /**
   * The same product's revenue one period earlier, for growth and declines.
   * Null when the previous period is outside the order history (no honest
   * comparison) — 0 means it genuinely sold nothing then.
   */
  previousRevenue: number | null;
}

/**
 * One collection's sales in the range. `collectionId` is null on the row for
 * products in no synced collection.
 *
 * COLLECTIONS OVERLAP: a product counts in every collection that carries it, so
 * these never sum to the range's revenue and `share` can exceed 100% in total.
 */
export interface CollectionSale {
  collectionId: string | null;
  title: string;
  handle: string | null;
  products: number;
  orders: number;
  units: number;
  revenue: number;
  previousRevenue: number | null;
}

export interface ProductGroup {
  /** Country code, or `all`. */
  key: string;
  label: string;
  orders: number;
  revenue: number;
  products: ProductSale[];
}

export interface CustomerMix {
  newCustomers: number;
  returningCustomers: number;
  newCustomerOrders: number;
  returningCustomerOrders: number;
}

/**
 * The Sales panel's product card: one product, and how the range's Shopify
 * customers split around it. `onlyCustomers + withOtherCustomers +
 * withoutCustomers === customers`.
 */
export interface ProductCustomerMix {
  /** Every product with a paid line in the range, A–Z — what the selector offers. */
  options: { productId: string; title: string }[];
  /** The product the figures describe; null when nothing sold in the range. */
  selected: { productId: string; title: string } | null;
  /** Distinct Shopify customers who ordered in the range, marketplaces excluded. */
  customers: number;
  onlyCustomers: number;
  withOtherCustomers: number;
  withoutCustomers: number;
  /** Top 7 other paid products its buyers bought in the range, by distinct customer. */
  alsoBought: { productId: string; title: string; customers: number }[];
  /**
   * Its buyers by how many orders carried it, the Customers panel's chart for
   * one product. Buyers only — "never bought it" is `withoutCustomers` above —
   * so the columns start at 1 and sum to `onlyCustomers + withOtherCustomers`.
   */
  ordersPerBuyer: { orders: number; orMore: boolean; customers: number }[];
  /** Set when the split cannot be measured (a marketplace platform is selected). */
  blockedReason: string | null;
  /** Countries the range's orders went to, for the card's country filter. */
  countries: { code: string; label: string }[];
  /** The delivery country the figures are limited to (`?mixCountry=`), or null for all. */
  country: string | null;
  /** Limited to VIP customers under the shop's rule (`?mixVip=1`). */
  vipOnly: boolean;
  /** False while the shop has no VIP rule — "VIP only" then has nobody to count. */
  vipRuleSet: boolean;
  /** Shown instead of the figures when the filters cannot apply (VIP only, no rule). */
  notice: string | null;
}

// --- Segment Finder (Customers panel) -------------------------------------------

export type SegmentMetric = "orders" | "spend" | "lifetime_spend";
export type SegmentOperator = "gt" | "lt";
export type SegmentConnector = "and" | "or";

export interface SegmentCondition {
  metric: SegmentMetric;
  op: SegmentOperator;
  value: number;
}

/** A checked segment, as `validateSegment` in scripts/lib/segment-finder.mjs returns it. */
export interface SegmentDefinition {
  windowMonths: number;
  conditions: SegmentCondition[];
  /** One fewer than the conditions: what sits in each gap. AND binds tighter than OR. */
  connectors: SegmentConnector[];
}

export interface SegmentMember {
  customerId: string;
  name: string | null;
  /** Orders and spend inside the window; lifetime spend over every order. */
  orders: number;
  spend: number;
  lifetimeSpend: number;
  lastOrderAt: string | null;
  onMarketingList: boolean;
}

export interface SegmentFinderResult {
  /** The segment as one bracketed line, e.g. `(Orders … > 2 AND Spent … > €100) OR …`. */
  description: string;
  windowMonths: number;
  matched: number;
  matchedOnMarketingList: number;
  matchedSpend: number;
  matchedLifetimeSpend: number;
  /** Every Shopify customer on file, marketplace-synthetic records excluded. */
  baseCustomers: number;
  /** Of those, who ever placed a Shopify order. */
  baseBuyers: number;
  /** The highest lifetime spenders among the matches, capped at `memberLimit`. */
  members: SegmentMember[];
  memberLimit: number;
}

export interface SalesPanel {
  summary: Compared<OrdersSummary>;
  /** Days of the range elapsed so far — the divisor behind "per day". */
  days: number;
  revenue: SeriesPoint[];
  orders: SeriesPoint[];
  /** Null on a marketplace platform, which mints one customer per order. */
  customerMix: CustomerMix | null;
  platforms: PlatformSplit[];
  /** Best products. With `?bestVip=1`, every list counts VIP customers' orders only. */
  products: {
    global: ProductGroup;
    byCountry: { revenue: ProductGroup[]; orders: ProductGroup[] };
    vipOnly: boolean;
    /** False while the shop has no VIP rule. */
    vipRuleSet: boolean;
    /** Shown instead of the lists when VIP only cannot apply (no rule, or a marketplace). */
    notice: string | null;
  };
  countries: CountrySale[];
  /** Collection mix for the range, busiest first, with the uncollected row last. */
  collections: CollectionSale[];
  /** Paid product revenue in the range — the denominator a collection's share uses. */
  productRevenue: number;
  pairs: PairGroup[];
  /** The "Who buys this product" card, for the product in `?product=`. */
  productCustomerMix: ProductCustomerMix;
}

export interface CountrySale {
  code: string;
  label: string;
  orders: number;
  revenue: number;
}

/** Two products bought in the same order, whatever else the order held. */
export interface ProductPair {
  a: { id: string; title: string };
  b: { id: string; title: string };
  orders: number;
  /** What the two lines brought in together, across those orders. */
  revenue: number;
  rankByOrders: number;
  rankByRevenue: number;
}

export interface PairGroup {
  /** `all`, or a country code. */
  key: string;
  label: string;
  pairs: ProductPair[];
}

// --- Support -----------------------------------------------------------------

export interface SupportSummary {
  tickets: number;
  categorised: number;
  stillOpen: number;
  unhappy: number;
  veryUnhappy: number;
  levelThree: number;
  repliesMeasured: number;
  p50ReplyHours: number | null;
  p90ReplyHours: number | null;
  repliedWithin24h: number;
  buyerTickets: number;
  noOrderTickets: number;
  unknownTickets: number;
  noOrderCustomers: number;
  noOrderDeliverable: number;
  noOrderMarketable: number;
}

export interface SupportCategoryRow {
  category: KnowledgeCategory | null;
  tickets: number;
  stillOpen: number;
  unhappy: number;
  levelThree: number;
  meanHappiness: number | null;
  buyerTickets: number;
  noOrderTickets: number;
  unknownTickets: number;
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
 * The topic map's provenance. Rebuilt by hand on purpose — clustering is an
 * all-pairs comparison whose threshold is hand-tuned — so the panel says how
 * old the map is and whether the corpus has moved on since.
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
  liveMessageCount: number | null;
  stale: boolean;
}

export interface SupportPanel {
  summary: Compared<SupportSummary>;
  /** Orders in the same range, every platform — the contact-rate denominator. */
  orders: Compared<number | null>;
  tickets: SeriesPoint[];
  medianReply: SeriesPoint[];
  categories: SupportCategoryRow[];
  topicMap: TopicMap | null;
  /** All-time category mood, for the topic map's colour ramp. */
  topicCategories: SupportCategoryRow[];
  /** The newest synced message, and whether that is too old to trust the range's end. */
  mailThrough: string | null;
  mailBehind: boolean;
  /**
   * How many people the CSV export holds. The export is all-time, so its count
   * is named on its own rather than borrowed from a ranged tile beside it.
   */
  allTimeMarketable: number;
}

// --- Customers ---------------------------------------------------------------

/** One of Shopify's RFM segments, shown as Shopify's. It does not decide VIP status. */
export interface SegmentTotal {
  rfmGroup: string | null;
  label: string | null;
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

/**
 * Who counts as a VIP: net spend MORE THAN minSpend AND more than minOrders
 * orders, both inside the last windowMonths. Set on the Customers panel, stored
 * on `shops`, applied by `vip_customers()`.
 */
export interface VipRule {
  minSpend: number;
  minOrders: number;
  windowMonths: number;
}

export interface CustomerPanel {
  segments: SegmentTotal[];
  /** Both denominators, always: most customers on file have never ordered. */
  base: { customers: number; buyers: number; repeatBuyers: number; marketingOptedIn: number } | null;
  /** The shop's VIP rule, or null while nobody has set one (then nobody is a VIP). */
  vipRule: (VipRule & { description: string }) | null;
  vip: {
    customers: number;
    /** Customers who ordered at all inside the rule's window — the VIP share's denominator. */
    buyersInWindow: number;
    ticketsLinked: number;
    vipTickets: number;
    contactRate: number | null;
  } | null;
  vipByCategory: { category: KnowledgeCategory | null; tickets: number }[];
  atRisk: CustomerAtRisk[];
  spendExposed: number;
}

/**
 * What customers DID inside the selected range — the ranged half of the
 * Customers panel, beside the snapshot above. People, so marketplace orders are
 * left out throughout (they mint one customer per order).
 */
export interface CustomerActivity {
  /** Customers by how many orders they placed in the range; the last bucket is "N or more". */
  ordersPerCustomer: { orders: number; orMore: boolean; customers: number }[];
}

/**
 * The newsletter, in the selected range. It lives on Marketing & funnel rather
 * than Customers (2026-09-23): the list is a marketing channel, and the reader
 * asking about it is the one reading acquisition and promotions.
 */
export interface NewsletterActivity {
  marketing: {
    current: MarketingSummary;
    previous: MarketingSummary | null;
    subscribed: SeriesPoint[];
    unsubscribed: SeriesPoint[];
    /** The earliest unsubscribe the snapshot holds; before it churn is unmeasured, not low. */
    unsubscribesFrom: string | null;
    /** False when the range starts before that edge — the churn figure is then withheld. */
    covered: boolean;
  };
  capture: CapturePoint[];
}

/** Newsletter movement in a range, read off the consent snapshot — floors throughout. */
export interface MarketingSummary {
  subscribed: number;
  unsubscribed: number;
  /** Reconstructed from the snapshot: an estimate, and labelled as one. */
  listAtStart: number;
  subscribersNow: number;
  /** Days of the range, for turning a range total into a daily or monthly rate. */
  days: number;
}

export interface CapturePoint {
  key: string;
  label: string;
  title: string;
  state: BucketState;
  firstOrders: number;
  subscribedBefore: number;
  subscribedAtCheckout: number;
}

// --- Agent -------------------------------------------------------------------

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

export interface UsageSummary {
  calls: number;
  totalTokens: number;
  failedCalls: number;
  /** Summed per model, so an unpriced model does not quietly read as free. */
  costUsd: number | null;
  hasUnpricedModels: boolean;
  ticketsTouched: number;
  meanTokensPerTicket: number | null;
  maxTokensOnATicket: number | null;
  byModel: { model: string; calls: number; totalTokens: number; costUsd: number | null }[];
}

/**
 * How each ticket investigated in the range got its situation — latest run per
 * ticket. The counts partition `tickets`.
 */
export interface SituationPicking {
  tickets: number;
  matched: number;
  tieByRules: number;
  chosenByModel: number;
  nearChooserNone: number;
  nearNotSettled: number;
  noMatch: number;
  notRecorded: number;
}

export interface AgentPanel {
  usage: Compared<UsageSummary>;
  spend: SeriesPoint[];
  funnel: PipelineFunnel;
  situations: SituationPicking;
  verdicts: VerdictRow[];
  automationCeiling: number | null;
  /** Unsatisfied needs only, ranked. */
  blockers: EvidenceGapRow[];
}

/**
 * A sellable product, with what the catalogue says and what a person decided.
 *
 * `compatibleWith` COMES FROM THE TAGS AND IS ONLY A HINT. The merchandising is
 * generous — most products are tagged as suiting most skin — which is right on a
 * product page and useless in a reply. `concerns` is what support will actually
 * put forward, and it is empty until somebody says otherwise.
 */
export interface RecommendableProduct {
  id: string;
  title: string;
  summary: string | null;
  productType: string | null;
  /** Curated: the concerns this product may be recommended for. */
  concerns: string[];
  /** From the catalogue tags. Where to start curating, never the answer. */
  compatibleWith: string[];
}

/** A concern a rule can branch on, with how many products are curated for it. */
export interface ConcernOption {
  key: string;
  label: string;
  curated: number;
  /**
   * Which vocabulary the key belongs to.
   *
   * `concern` is one of the five closed cue lists the agent reads out of a
   * message itself; `collection` is one the team switched on. Both live in the
   * same column because both say "support should put this product forward for
   * X" — but they behave differently, and the screen says so: a concern's ticks
   * ARE the answer, where a collection's only reorder an answer the intersection
   * already found.
   */
  kind: "concern" | "collection";
}

/**
 * An active code promotion, as the curation screen shows it.
 *
 * `offerable` IS THE ONLY FIELD A PERSON SETS. Everything else is Shopify's and
 * is overwritten on every sync — which is exactly why the flag is not derived
 * from any of it: no combination of discount type, size or title reliably
 * separates "the welcome code" from "a partner's 50% rate", and guessing wrong
 * means a support reply hands out the second.
 */
export interface PromotionChoice {
  promotionKey: string;
  code: string;
  title: string;
  /** Shopify's own one-liner, e.g. "20% off 94 products". */
  summary: string | null;
  endsAt: string | null;
  oncePerCustomer: boolean;
  /**
   * What this code CANNOT be combined with, or null when it stacks with
   * everything. Phrased as the blocked list because that is the sentence support
   * needs — "cannot be combined with a product discount" is the commonest reason
   * a code appears not to work. From Shopify's `combines_with`, never inferred.
   */
  stacksWith: string[] | null;
  usage: { used: number; limit: number | null };
  offerable: boolean;
}

/**
 * Which kind of thing a collection names.
 *
 * `concern` is what is wrong (rides, taches, cernes et poches); `category` is
 * what form the answer takes (sérum, crème de jour, contour des yeux). The two
 * are relaxed differently when nothing sits in both — a concern is given up
 * before a category, because the customer named the form they want and swapping
 * it hands them a different product.
 */
export type CollectionAxis = "concern" | "category";

/**
 * One Shopify collection, and what the team has decided about it.
 *
 * The shop has 175 of these and a product sits in 18 to 30, most of them
 * seasonal merchandising or the output of the site's diagnostic quiz — so
 * `active` is the gate that makes the whole thing mean anything. Nothing is
 * active until somebody switches it on.
 */
export interface AdviceCollection {
  id: string;
  handle: string;
  title: string;
  /** Shopify's count, INCLUDING products that are not live. Judge-by-eye only. */
  productsCount: number | null;
  /**
   * What the agent can actually put forward — null, never zero, until the
   * membership has been fetched, which happens for active collections only.
   * Printing 0 for "never asked" would read as "this collection is empty".
   */
  liveProducts: number | null;
  active: boolean;
  axis: CollectionAxis | null;
  note: string | null;
  syncedAt: string | null;
}

/** The curated subset, as the reply screen sees it. Same shape, minus the flag. */
export type OfferableCode = Omit<PromotionChoice, "offerable" | "promotionKey">;

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
  /**
   * A live discount code this rule hands the customer, or null.
   *
   * THE ONE PLACE A RULE CARRIES A VALUE RATHER THAN A CONDITION. Which code to
   * give somebody who never received theirs is a commercial decision that
   * changes with the season and cannot be derived from the ticket — so an
   * operator picks it once here, from the codes cleared on the promotions
   * screen, and the same situation always gets the same offer.
   */
  offerCode: string | null;
  /** The approved article an operator pinned to this rule, or null. */
  knowledgeDocumentId: string | null;
  /** Tone keys from `scripts/lib/reply-tones.mjs`. Empty means the Brand voice alone. */
  tones: string[];
  /** A page the reply offers, and what it opens. The model is only ever given the label. */
  link: { url: string; label: string } | null;
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
   * `poweredBy` names the parameters a state is computed from, when there are
   * any. Not offered as conditions — you pick the state, not the numbers behind
   * it — but shown so the editor can say a rule will never fire while one is
   * unset. A LIST rather than a single key: `delivery_delay_state` is computed
   * from two windows, one for France and one for everywhere else, and a state
   * that can fire for half its destinations is not the same as a dead one.
   */
  needs: { need: string; findings: string[]; poweredBy: string[]; requires: string[] }[];
  routes: string[];
  asks: string[];
  /** Codes an operator has cleared for customers, for the rule editor's picker. */
  offerableCodes: OfferableCode[];
  /** Approved articles a rule may answer from, for the same kind of picker. */
  articles: { id: string; title: string; category: string | null }[];
  /** The tones a rule may set, in catalogue order, from `scripts/lib/reply-tones.mjs`. */
  tones: { key: string; label: string; hint: string }[];
  /** For the skeleton box: the one place a rule names a parameter directly. */
  parameters: { key: string; label: string; set: boolean }[];
}

/** A situation a rule can be keyed to. */
export interface PolicySituation {
  key: string;
  question: string;
  category: string | null;
  answerSet: string | null;
  /** 'model' (today's behaviour) or 'rule_directed' (the rules may collect). */
  collectionMode: string;
  /**
   * The needs this situation's answer rests on (`support_exemplars.requirement_needs`).
   * The rule editor opens its conditions on these, so a situation with no rules
   * yet still shows the evidence it branches on rather than every need there is.
   */
  requirementNeeds: string[];
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
