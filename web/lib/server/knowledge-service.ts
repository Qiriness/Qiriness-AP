/**
 * Server-only knowledge-article service for the Agent Setup dashboard.
 *
 * Reuses the existing Shopify/Supabase sync logic directly from ../../../scripts/lib
 * (see AGENTS.md's modularity rule: no duplicated Shopify-resolution or Supabase
 * logic) rather than re-implementing it. This module is the only place in web/
 * that imports across into scripts/lib; every API route calls through here.
 *
 * Uses the Supabase SERVICE ROLE key (SUPABASE_SECRET_KEY) because every table
 * has row level security enabled with no policies defined (see
 * supabase/migrations/001_initial_schema.sql) — only the service role can read
 * or write today. Never import this module from client components; it must
 * only run in Route Handlers (server-only, Node runtime).
 *
 * Nothing auto-syncs into knowledge_documents. A row is only ever created by
 * an explicit import (createArticle with a sourceId) or a manually written
 * article. Editing an imported article converts its source_type to 'manual'
 * (see updateArticle) — that conversion IS the "stop syncing this" signal;
 * there is no separate locally-modified flag.
 */

import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import { createShopifyClient } from "../../../scripts/lib/shopify-admin-client.mjs";
import { fetchKnowledgePageById, fetchShopPolicies } from "../../../scripts/lib/shopify-knowledge-client.mjs";
import { createShopifyThemeClient } from "../../../scripts/lib/shopify-theme-client.mjs";
import { createKnowledgeSourceResolver } from "../../../scripts/lib/knowledge/knowledge-source-resolver.mjs";
import { discoverPageKnowledgeSource } from "../../../scripts/lib/knowledge/source-discovery.mjs";
import {
  mapPolicyToKnowledgeDocument,
  mapResolvedPageToKnowledgeDocument,
} from "../../../scripts/lib/knowledge-document-mapper.mjs";
import { buildKnowledgeChunks } from "../../../scripts/lib/knowledge-chunker.mjs";
import { htmlToText, htmlToSections, sectionsToHtml } from "../../../scripts/lib/html-to-text.mjs";
import { hashJson } from "../../../scripts/lib/hash.mjs";
import { stripUndefined } from "../../../scripts/lib/collections.mjs";
import {
  createSupabaseClient,
  supabaseSelect,
  supabaseInsert,
  supabaseUpdateById,
  supabaseDelete,
  supabaseDeleteWhereIn,
  supabaseUpsert,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { KnowledgeImportError, KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";
import type { VoiceProfile } from "../types";

// The imported .mjs modules have no type declarations (allowJs, no JSDoc), so
// their exports resolve to `any`. Local shapes below keep this file itself
// type-safe at the boundary; `any` is confined to the raw Supabase rows.

export type ShopifySourceType = "shopify_page" | "shopify_policy";

export interface ShopifySourceOption {
  id: string;
  sourceType: ShopifySourceType;
  title: string;
  handle: string;
  status: "published" | "unpublished";
  updatedAt: string | null;
  isImported: boolean;
}

export interface KnowledgeArticleResponse {
  id: string;
  title: string;
  status: "draft" | "in_review" | "approved" | "needs_optimization";
  content: string;
  category: string | null;
  coreTopic: string | null;
  sourceType: ShopifySourceType | "manual";
  sourceId: string | null;
  syncState: "none" | "syncing" | "synced" | "error";
  updatedAt: string;
  syncedAt: string | null;
  /** Structured brand-voice fields. Only non-null on the core_topic = 'brand' row. */
  voiceProfile: VoiceProfile | null;
}

export interface CreateArticleInput {
  title?: string;
  category?: string;
  coreTopic?: string | null;
  /** shopify_content_sources.id (catalog row id). Omit for a standalone article. */
  sourceId?: string | null;
}

export interface UpdateArticleInput {
  title?: string;
  /** Rich-text HTML from the editor. */
  content?: string;
  category?: string;
  coreTopic?: string | null;
  approvalStatus?: "draft" | "in_review" | "approved" | "needs_optimization";
  /**
   * shopify_content_sources.id. Only valid on an article that has never had a
   * Shopify source (a fresh manual article) — attaches and imports it,
   * exactly like creating with a source, but reusing this article's id. This
   * is what lets the dashboard's single workspace dropdown pick a source
   * right after creating an empty article, without a second POST creating a
   * duplicate row.
   */
  sourceId?: string;
  /** Full replacement of the structured brand-voice fields (see UpdateArticleInput.content for the analogous convention). Only meaningful on the core_topic = 'brand' row. */
  voiceProfile?: VoiceProfile;
}

let cachedConfig: any = null;
function getConfig() {
  if (!cachedConfig) {
    cachedConfig = loadConfig(process.env as Record<string, string | undefined>);
  }
  return cachedConfig;
}

function getSupabaseClient() {
  return createSupabaseClient(getConfig());
}

/** Resolves the single shop row this dashboard operates against, by domain. */
export async function getShopId(): Promise<string> {
  const config = getConfig();
  const supabase = getSupabaseClient();
  const rows = await supabaseSelect(supabase, "shops", { shop_domain: config.shopDomain }, "id");
  const id = rows?.[0]?.id;
  if (!id) {
    throw new KnowledgeNotFoundError(
      `No shop record found for ${config.shopDomain}. Run a Shopify sync script (e.g. "npm run sync:shopify:products") at least once before using the Agent Setup API.`
    );
  }
  return id;
}

export async function listShopifySources(shopId: string): Promise<ShopifySourceOption[]> {
  const supabase = getSupabaseClient();
  const [sourceRows, articleRows] = await Promise.all([
    supabaseSelect(
      supabase,
      "shopify_content_sources",
      { shop_id: shopId },
      "id,source_type,shopify_source_id,handle,title,status,shopify_updated_at"
    ),
    supabaseSelect(
      supabase,
      "knowledge_documents",
      { shop_id: shopId },
      "source_type,shopify_source_id"
    ),
  ]);

  const importedKeys = new Set(
    articleRows
      .filter((row: any) => row.shopify_source_id)
      .map((row: any) => `${row.source_type}:${row.shopify_source_id}`)
  );

  return sourceRows
    .map((row: any) => ({
      id: row.id,
      sourceType: row.source_type,
      title: row.title,
      handle: row.handle,
      status: row.status,
      updatedAt: row.shopify_updated_at,
      isImported: importedKeys.has(`${row.source_type}:${row.shopify_source_id}`),
    }))
    .sort((a: ShopifySourceOption, b: ShopifySourceOption) => a.title.localeCompare(b.title));
}

export async function listArticles(shopId: string): Promise<KnowledgeArticleResponse[]> {
  const supabase = getSupabaseClient();
  const [articleRows, catalogIdByKey] = await Promise.all([
    supabaseSelect(supabase, "knowledge_documents", { shop_id: shopId }, "*"),
    buildCatalogIdMap(shopId),
  ]);

  return articleRows.map((row: any) => mapArticleRow(row, catalogIdByKey));
}

export async function createArticle(
  shopId: string,
  input: CreateArticleInput
): Promise<KnowledgeArticleResponse> {
  const supabase = getSupabaseClient();

  if (!input.sourceId) {
    const now = new Date().toISOString();
    const title = input.title || "Untitled article";
    const row = stripUndefined({
      shop_id: shopId,
      source_type: "manual",
      shopify_source_id: null,
      handle: null,
      title,
      category: input.category || "general",
      core_topic: input.coreTopic || null,
      locale: "fr",
      status: null,
      content_html: "",
      content_text: "",
      sections: [],
      content_hash: hashJson({ title, content: "" }),
      approval_status: "draft",
      synced_at: now,
    });
    const inserted = await supabaseInsert(supabase, "knowledge_documents", [row]);
    return mapArticleRow(inserted[0], new Map());
  }

  const catalogRows = await supabaseSelect(
    supabase,
    "shopify_content_sources",
    { id: input.sourceId, shop_id: shopId },
    "*"
  );
  const catalogRow = catalogRows[0];
  if (!catalogRow) {
    throw new KnowledgeNotFoundError(`Shopify source not found in catalog: ${input.sourceId}`);
  }

  const overrides = { category: input.category, core_topic: input.coreTopic ?? undefined };
  const saved =
    catalogRow.source_type === "shopify_policy"
      ? await resolveAndUpsertArticleFromShopifyPolicy({
          shopId,
          shopifyPolicyId: catalogRow.shopify_source_id,
          approvalStatus: "draft",
          overrides,
        })
      : await resolveAndUpsertArticleFromShopifyPage({
          shopId,
          shopifyPageId: catalogRow.shopify_source_id,
          approvalStatus: "draft",
          overrides,
        });

  const catalogIdByKey = new Map([[`${catalogRow.source_type}:${catalogRow.shopify_source_id}`, catalogRow.id]]);
  return mapArticleRow(saved, catalogIdByKey);
}

export async function updateArticle(
  shopId: string,
  articleId: string,
  input: UpdateArticleInput
): Promise<KnowledgeArticleResponse> {
  const supabase = getSupabaseClient();
  const existing = await getArticleRow(supabase, shopId, articleId);

  if (input.sourceId) {
    if (existing.shopify_source_id) {
      throw new KnowledgeValidationError(
        "This article already has a Shopify source; use resync to refresh it, or create a new article to import a different one."
      );
    }

    const catalogRows = await supabaseSelect(
      supabase,
      "shopify_content_sources",
      { id: input.sourceId, shop_id: shopId },
      "*"
    );
    const catalogRow = catalogRows[0];
    if (!catalogRow) {
      throw new KnowledgeNotFoundError(`Shopify source not found in catalog: ${input.sourceId}`);
    }

    const overrides = { category: input.category, core_topic: input.coreTopic ?? undefined };
    const saved =
      catalogRow.source_type === "shopify_policy"
        ? await resolveAndUpsertArticleFromShopifyPolicy({
            shopId,
            shopifyPolicyId: catalogRow.shopify_source_id,
            existingDocumentId: articleId,
            approvalStatus: "draft",
            overrides,
          })
        : await resolveAndUpsertArticleFromShopifyPage({
            shopId,
            shopifyPageId: catalogRow.shopify_source_id,
            existingDocumentId: articleId,
            approvalStatus: "draft",
            overrides,
          });

    const catalogIdByKey = new Map([[`${catalogRow.source_type}:${catalogRow.shopify_source_id}`, catalogRow.id]]);
    return mapArticleRow(saved, catalogIdByKey);
  }

  const title = input.title ?? existing.title;
  const contentHtml = input.content ?? existing.content_html ?? "";
  const bodyText = htmlToText(contentHtml);
  const sections = htmlToSections(contentHtml, title);
  const contentText = [title, bodyText].filter(Boolean).join("\n\n");

  const patch = stripUndefined({
    title: input.title,
    category: input.category,
    core_topic: input.coreTopic,
    approval_status: input.approvalStatus,
    content_html: contentHtml,
    content_text: contentText,
    sections,
    content_hash: hashJson({ title, contentText, sections }),
    voice_profile: input.voiceProfile,
    // A save from the editor is the "I now own this content" signal. Once an
    // imported article is edited it becomes a manual article — shopify_source_id
    // and handle are kept for provenance, but nothing will resync it again.
    source_type: existing.source_type !== "manual" ? "manual" : undefined,
  });

  const saved = await supabaseUpdateById(supabase, "knowledge_documents", articleId, patch);
  // The brand-voice row is always-included drafting-agent context, never
  // retrieved via similarity search, so it has no business in knowledge_chunks
  // (and chunking its tone/voice fields would only pollute retrieval).
  if (saved.core_topic !== "brand") {
    await regenerateChunks(supabase, saved);
  }

  const catalogIdByKey = await buildCatalogIdMap(shopId);
  return mapArticleRow(saved, catalogIdByKey);
}

export async function resyncArticle(shopId: string, articleId: string): Promise<KnowledgeArticleResponse> {
  const supabase = getSupabaseClient();
  const existing = await getArticleRow(supabase, shopId, articleId);

  if (existing.source_type === "manual" || !existing.shopify_source_id) {
    throw new KnowledgeValidationError(
      "This article has no linked Shopify source to resync from (it's a manual article, either written from scratch or edited from an import)."
    );
  }

  // Content just changed underneath the team; flag it for another look
  // rather than silently leaving whatever approval state it had.
  const saved =
    existing.source_type === "shopify_policy"
      ? await resolveAndUpsertArticleFromShopifyPolicy({
          shopId,
          shopifyPolicyId: existing.shopify_source_id,
          existingDocumentId: articleId,
          approvalStatus: "needs_optimization",
        })
      : await resolveAndUpsertArticleFromShopifyPage({
          shopId,
          shopifyPageId: existing.shopify_source_id,
          existingDocumentId: articleId,
          approvalStatus: "needs_optimization",
        });

  const catalogIdByKey = await buildCatalogIdMap(shopId);
  return mapArticleRow(saved, catalogIdByKey);
}

export async function deleteArticle(shopId: string, articleId: string): Promise<void> {
  const supabase = getSupabaseClient();
  // knowledge_chunks cascades automatically via its ON DELETE CASCADE FK.
  // The shopify_content_sources catalog row (if any) is untouched: the page
  // or policy still exists in Shopify and stays importable again later.
  await supabaseDelete(supabase, "knowledge_documents", { id: articleId, shop_id: shopId });
}

// --- internals -------------------------------------------------------------

async function getArticleRow(supabase: any, shopId: string, articleId: string): Promise<any> {
  const rows = await supabaseSelect(
    supabase,
    "knowledge_documents",
    { id: articleId, shop_id: shopId },
    "*"
  );
  const row = rows[0];
  if (!row) {
    throw new KnowledgeNotFoundError(`Article not found: ${articleId}`);
  }
  return row;
}

/** Maps shopify_content_sources rows to a `${source_type}:${shopify_source_id}` -> catalog id lookup. */
async function buildCatalogIdMap(shopId: string): Promise<Map<string, string>> {
  const supabase = getSupabaseClient();
  const rows = await supabaseSelect(
    supabase,
    "shopify_content_sources",
    { shop_id: shopId },
    "id,source_type,shopify_source_id"
  );
  return new Map(rows.map((row: any) => [`${row.source_type}:${row.shopify_source_id}`, row.id]));
}

/**
 * Shared by createArticle (import) and resyncArticle: resolves a Shopify
 * page's live content through the existing resolver pipeline (same
 * manual-override -> page-metafield -> page-body -> theme-template order the
 * old nightly sync used to run for every page) and upserts it as a
 * knowledge_documents row.
 */
async function resolveAndUpsertArticleFromShopifyPage({
  shopId,
  shopifyPageId,
  existingDocumentId,
  approvalStatus,
  overrides = {},
}: {
  shopId: string;
  shopifyPageId: string;
  existingDocumentId?: string;
  approvalStatus: "draft" | "needs_optimization";
  overrides?: { category?: string; core_topic?: string | null };
}): Promise<any> {
  const config = getConfig();
  const supabase = getSupabaseClient();
  const shopify = await createShopifyClient(config);

  const page = await fetchKnowledgePageById(shopify, shopifyPageId);
  const source = discoverPageKnowledgeSource(page, []);
  const themeClient = createShopifyThemeClient(config, shopify);
  const resolver = createKnowledgeSourceResolver({ config, themeClient });
  const content = await resolver.resolve(source);

  if (!content.found) {
    const reason = content.attemptedResolvers?.at(-1)?.reason || "no resolver found content";
    throw new KnowledgeImportError(`Could not resolve content for "${source.title}": ${reason}`);
  }

  const syncedAt = new Date().toISOString();
  const mapped = mapResolvedPageToKnowledgeDocument(source, content, {
    shopId,
    syncedAt,
    navigationIndex: new Map(),
  });
  if (!mapped) {
    throw new KnowledgeImportError(`Resolved content for "${source.title}" was empty.`);
  }

  const documentRow = stripUndefined({
    ...mapped,
    category: overrides.category ?? mapped.category,
    core_topic: overrides.core_topic,
    content_html: sectionsToHtml(mapped.sections, mapped.title),
    approval_status: approvalStatus,
  });

  const saved = existingDocumentId
    ? await supabaseUpdateById(supabase, "knowledge_documents", existingDocumentId, documentRow)
    : (await supabaseInsert(supabase, "knowledge_documents", [documentRow]))[0];

  await regenerateChunks(supabase, saved);
  return saved;
}

/**
 * Policy counterpart to resolveAndUpsertArticleFromShopifyPage. Shopify has
 * no "fetch one policy by id" query, only the full shop.shopPolicies list —
 * but that list is always small (at most a handful of policy types), so
 * re-fetching all of them to resync one is cheap.
 */
async function resolveAndUpsertArticleFromShopifyPolicy({
  shopId,
  shopifyPolicyId,
  existingDocumentId,
  approvalStatus,
  overrides = {},
}: {
  shopId: string;
  shopifyPolicyId: string;
  existingDocumentId?: string;
  approvalStatus: "draft" | "needs_optimization";
  overrides?: { category?: string; core_topic?: string | null };
}): Promise<any> {
  const config = getConfig();
  const supabase = getSupabaseClient();
  const shopify = await createShopifyClient(config);

  const policies = await fetchShopPolicies(shopify);
  const policy = policies.find((item: any) => item.id === shopifyPolicyId);
  if (!policy) {
    throw new KnowledgeImportError(`Shopify policy not found (it may have been removed or cleared): ${shopifyPolicyId}`);
  }

  const syncedAt = new Date().toISOString();
  const mapped = mapPolicyToKnowledgeDocument(policy, { shopId, syncedAt, navigationIndex: new Map() });
  if (!mapped) {
    throw new KnowledgeImportError(`Policy "${policy.title}" has no content to import.`);
  }

  const documentRow = stripUndefined({
    ...mapped,
    category: overrides.category ?? mapped.category,
    core_topic: overrides.core_topic,
    content_html: sectionsToHtml(mapped.sections, mapped.title),
    approval_status: approvalStatus,
  });

  const saved = existingDocumentId
    ? await supabaseUpdateById(supabase, "knowledge_documents", existingDocumentId, documentRow)
    : (await supabaseInsert(supabase, "knowledge_documents", [documentRow]))[0];

  await regenerateChunks(supabase, saved);
  return saved;
}

async function regenerateChunks(supabase: any, documentRow: any): Promise<void> {
  const chunks = buildKnowledgeChunks(documentRow);
  await supabaseDeleteWhereIn(supabase, "knowledge_chunks", "knowledge_document_id", [documentRow.id]);
  if (chunks.length > 0) {
    await supabaseUpsert(supabase, "knowledge_chunks", chunks, "knowledge_document_id,chunk_index");
  }
}

function mapArticleRow(row: any, catalogIdByKey: Map<string, string>): KnowledgeArticleResponse {
  const isShopifySourced = row.source_type === "shopify_page" || row.source_type === "shopify_policy";
  const sourceId = isShopifySourced
    ? catalogIdByKey.get(`${row.source_type}:${row.shopify_source_id}`) ?? null
    : null;

  return {
    id: row.id,
    title: row.title,
    status: row.approval_status,
    content: row.content_html || "",
    category: row.category,
    coreTopic: row.core_topic,
    sourceType: row.source_type,
    sourceId,
    // If this article was imported from a page/policy but that source has
    // since been pruned from the catalog (removed in Shopify), there's
    // nothing left to resync from — surface that as an error state.
    syncState: isShopifySourced ? (sourceId ? "synced" : "error") : "none",
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
    voiceProfile: row.core_topic === "brand" ? normalizeVoiceProfile(row.voice_profile) : null,
  };
}

/** Defends against a missing/partial voice_profile JSONB value (e.g. the column default `{}`, or fields added after a row already existed). */
function normalizeVoiceProfile(raw: any): VoiceProfile {
  const v = raw || {};
  return {
    tone: Array.isArray(v.tone) ? v.tone : [],
    voice: typeof v.voice === "string" ? v.voice : "",
    dos: Array.isArray(v.dos) ? v.dos : [],
    donts: Array.isArray(v.donts) ? v.donts : [],
  };
}
