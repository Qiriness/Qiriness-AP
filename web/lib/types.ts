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
  | "support"
  | "shipping_delivery"
  | "returns_refunds"
  | "privacy"
  | "product_advice"
  | "brand_story"
  | "legal"
  | "payments"
  | "general";

export const CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  support: "Support",
  shipping_delivery: "Shipping & delivery",
  returns_refunds: "Returns & refunds",
  privacy: "Privacy",
  product_advice: "Product advice",
  brand_story: "Brand story",
  legal: "Legal",
  payments: "Payments",
  general: "General",
};

export const KNOWLEDGE_CATEGORIES: KnowledgeCategory[] = [
  "support",
  "shipping_delivery",
  "returns_refunds",
  "privacy",
  "product_advice",
  "brand_story",
  "legal",
  "payments",
  "general",
];

/** A Shopify page or shop policy available to import, from the unified catalog. */
export interface ShopifySource {
  id: string;
  title: string;
  handle: string;
  sourceType: "shopify_page" | "shopify_policy";
}

export type CoreTopic =
  | "order_policies"
  | "brand"
  | "confidentiality"
  | "delivery"
  | "returns_exchanges"
  | "locations"
  | "faqs";

export const CORE_TOPIC_LABELS: Record<CoreTopic, string> = {
  order_policies: "Order policies",
  brand: "Brand voice & identity",
  confidentiality: "Confidentiality & privacy",
  delivery: "Delivery & shipping",
  returns_exchanges: "Returns & exchanges",
  locations: "Shop locations",
  faqs: "Common FAQs",
};

export const CORE_TOPICS: CoreTopic[] = [
  "order_policies",
  "brand",
  "confidentiality",
  "delivery",
  "returns_exchanges",
  "locations",
  "faqs",
];

export interface Article {
  id: string;
  title: string;
  status: ArticleStatus;
  /** Article body as HTML. Optimized/edited by the team, agent-facing. */
  content: string;
  category: KnowledgeCategory;
  /** Required-knowledge slot this article fulfills, if any. */
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
