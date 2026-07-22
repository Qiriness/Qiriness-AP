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
 * Knowledge category. Mirrors the taxonomy inferred by
 * `scripts/lib/knowledge-categories.mjs` for synced Shopify pages/policies, so
 * manually authored and Shopify-sourced articles share one vocabulary. Stored
 * as loose text on `knowledge_documents` (see APP_SCHEMA.md); this fixed list
 * is the UI's controlled subset of that free-text field.
 */
export type KnowledgeCategory =
  | "faq"
  | "shipping_delivery"
  | "returns_refunds"
  | "privacy"
  | "product_information"
  | "brand_story"
  | "legal"
  | "payments"
  | "promotions"
  | "b2b_partnerships"
  | "stock"
  | "general";

export const CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  faq: "FAQ",
  shipping_delivery: "Shipping & delivery",
  returns_refunds: "Returns & refunds",
  privacy: "Privacy",
  product_information: "Product information",
  brand_story: "Brand story",
  legal: "Legal",
  payments: "Payments",
  promotions: "Promotions",
  b2b_partnerships: "B2B & partnerships",
  stock: "Stock",
  general: "General",
};

export const KNOWLEDGE_CATEGORIES: KnowledgeCategory[] = [
  "faq",
  "shipping_delivery",
  "returns_refunds",
  "privacy",
  "product_information",
  "brand_story",
  "legal",
  "payments",
  "promotions",
  "b2b_partnerships",
  "stock",
  "general",
];

/**
 * The 6 required-knowledge slots every agent needs covered. Mirrors the
 * knowledge_documents_core_topic_check constraint in
 * supabase/migrations/003_knowledge_page_catalog.sql — keep in sync.
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
  order_policies: "legal",
  brand: "brand_story",
  confidentiality: "privacy",
  delivery_returns: "shipping_delivery",
  locations: "general",
  faqs: "faq",
};

export const CORE_TOPICS: CoreTopic[] = [
  "order_policies",
  "brand",
  "confidentiality",
  "delivery_returns",
  "locations",
  "faqs",
];

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
  /** Required-knowledge slot this article fulfills, if any (see the 6 core topics). */
  coreTopic: CoreTopic | null;
  /** Optional Shopify source (page or policy) this article was initialized from. */
  sourcePageId: string | null;
  syncState: SyncState;
  /** Human label, e.g. "2h ago", derived from the article's updatedAt. */
  updatedLabel: string;
  lastSyncedLabel?: string;
}

/** Brand tone descriptors shown in the workspace context summary. */
export interface AgentContext {
  brandVoiceArticleId: string;
  tone: string[];
}

export const STATUS_LABELS: Record<ArticleStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  needs_optimization: "Needs optimization",
};

/** Save lifecycle for the active article editor. */
export type SaveState = "saved" | "unsaved" | "saving";
