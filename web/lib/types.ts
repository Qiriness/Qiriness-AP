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
 * supabase/migrations/04_forwarding.sql.
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
 * supabase/migrations/01_core_schema.sql — keep in sync. Five of
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

/** Mirrors tickets_status_check in supabase/migrations/01_core_schema.sql. */
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

/** Mirrors tickets_responsible_team_check in 01_core_schema.sql. */
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
  responsibleTeam: ResponsibleTeam | null;
  requesterName: string | null;
  orderNumber: string | null;
  messageCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
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
  failedOpen: boolean;
  decidedAt: string | null;
}

/**
 * The header cards.
 *
 * `highPriority` is level 3 + 4 rather than the `priority` column: nothing in
 * the pipeline writes `priority` today, so every ticket sits at its default 3
 * and a card reading it would show zero for ever. Level is what the categoriser
 * actually assigns. Swap the source here when priority starts being written.
 */
export interface TicketStats {
  total: number;
  open: number;
  highPriority: number;
  levelThree: number;
  uncategorised: number;
  /** Rolling windows, not calendar periods — see summariseTickets. */
  last24h: number;
  last30d: number;
}
