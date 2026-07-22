/**
 * Maps raw Knowledge API JSON (matching web/lib/server/knowledge-service.ts's
 * KnowledgeArticleResponse / ShopifySourceOption shapes) to the frontend's
 * display types. Deliberately plain/isomorphic (no "use client" or
 * server-only imports) so it can run both in the agent-setup Server
 * Component's initial fetch and in the client-side mutation wrapper
 * (web/lib/api/knowledge.ts) without duplicating this logic.
 */

import type { Article, ArticleStatus, CoreTopic, KnowledgeCategory, ShopifySource, SyncState, VoiceProfile } from "./types";
import { ALL_CORE_TOPICS, KNOWLEDGE_CATEGORIES } from "./types";
import { formatRelativeTime } from "./relative-time";

interface RawArticle {
  id: string;
  title: string;
  status: string;
  content: string;
  category: string | null;
  coreTopic: string | null;
  sourceId: string | null;
  syncState: string;
  updatedAt: string;
  syncedAt: string | null;
  voiceProfile: VoiceProfile | null;
}

interface RawSource {
  id: string;
  sourceType: string;
  title: string;
  handle: string;
}

export function mapArticleResponse(raw: RawArticle): Article {
  const category = KNOWLEDGE_CATEGORIES.includes(raw.category as KnowledgeCategory)
    ? (raw.category as KnowledgeCategory)
    : "general";
  const coreTopic = ALL_CORE_TOPICS.includes(raw.coreTopic as CoreTopic)
    ? (raw.coreTopic as CoreTopic)
    : null;

  return {
    id: raw.id,
    title: raw.title,
    status: raw.status as ArticleStatus,
    content: raw.content,
    category,
    coreTopic,
    sourcePageId: raw.sourceId,
    syncState: raw.syncState as SyncState,
    updatedLabel: formatRelativeTime(raw.updatedAt),
    lastSyncedLabel: raw.syncedAt ? formatRelativeTime(raw.syncedAt) : undefined,
    voiceProfile: raw.voiceProfile ?? null,
  };
}

export function mapSourceResponse(raw: RawSource): ShopifySource {
  return {
    id: raw.id,
    title: raw.title,
    handle: raw.handle,
    sourceType: raw.sourceType === "shopify_policy" ? "shopify_policy" : "shopify_page",
  };
}
