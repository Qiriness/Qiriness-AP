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

export interface ShopifyPage {
  id: string;
  title: string;
  handle: string;
}

export interface Article {
  id: string;
  title: string;
  status: ArticleStatus;
  /** Article body as HTML. Optimized/edited by the team, agent-facing. */
  content: string;
  category: KnowledgeCategory;
  /** Optional Shopify page this article was initialized from. */
  sourcePageId: string | null;
  syncState: SyncState;
  /** Human label, e.g. "2h ago". Demo-only until backend timestamps exist. */
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
