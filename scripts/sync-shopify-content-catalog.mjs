import { pathToFileURL } from 'node:url';

import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createShopifyClient, fetchShop } from './lib/shopify-admin-client.mjs';
import { fetchKnowledgePages, fetchShopPolicies } from './lib/shopify-knowledge-client.mjs';
import {
  createSupabaseClient,
  supabaseDeleteWhereIn,
  supabaseSelect,
  supabaseUpsert
} from './lib/supabase-rest-client.mjs';
import { syncShop } from './lib/shop-sync-service.mjs';

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(loadEnv());
  const shopify = await createShopifyClient(config);
  const supabase = createSupabaseClient(config);
  const syncedAt = new Date().toISOString();

  const shop = await fetchShop(shopify);
  const shopRow = await syncShop({ args, config, supabase, shop });

  await runShopifyContentCatalogSync({ args, shopify, supabase, shopRow, syncedAt });
}

/**
 * Syncs a lightweight, content-free catalog of every live Shopify page and
 * shop policy, for the Agent Setup source dropdown. Neither ever gets its
 * content stored here — that only happens on demand, when a team member
 * explicitly imports one (see web/app/api/knowledge/articles).
 */
export async function runShopifyContentCatalogSync({ args, shopify, supabase, shopRow, syncedAt }) {
  const [pages, policies] = await Promise.all([
    fetchKnowledgePages(shopify, args),
    fetchOptional('shop policies', () => fetchShopPolicies(shopify), [])
  ]);

  const rows = [
    ...pages.map((page) => mapPageToCatalogRow(page, shopRow.id, syncedAt)),
    ...policies.map((policy) => mapPolicyToCatalogRow(policy, shopRow.id, syncedAt))
  ];

  if (args.dryRun) {
    console.log(`Dry run: would upsert ${rows.length} content source rows (${pages.length} pages, ${policies.length} policies).`);
    return { sources: rows.length, deletedSources: 0 };
  }

  if (rows.length > 0) {
    await supabaseUpsert(supabase, 'shopify_content_sources', rows, 'shop_id,source_type,shopify_source_id');
  }

  let deletedSources = 0;
  if (!args.limit) {
    deletedSources = await deleteSourcesMissingFromShopify({
      supabase,
      shopId: shopRow.id,
      seenSourceKeys: new Set(rows.map((row) => sourceKey(row)))
    });
  }

  console.log(`Content catalog sync complete: ${rows.length} sources synced (${pages.length} pages, ${policies.length} policies).`);
  if (deletedSources > 0) {
    console.log(`Deleted ${deletedSources} sources no longer returned by Shopify.`);
  }

  return { sources: rows.length, deletedSources };
}

function mapPageToCatalogRow(page, shopId, syncedAt) {
  return {
    shop_id: shopId,
    source_type: 'shopify_page',
    shopify_source_id: page.id,
    handle: page.handle,
    title: page.title,
    status: page.publishedAt ? 'published' : 'unpublished',
    shopify_updated_at: page.updatedAt,
    synced_at: syncedAt
  };
}

function mapPolicyToCatalogRow(policy, shopId, syncedAt) {
  return {
    shop_id: shopId,
    source_type: 'shopify_policy',
    shopify_source_id: policy.id,
    handle: policy.type ? policy.type.toLowerCase().replace(/_/g, '-') : policy.id,
    title: policy.title,
    status: 'published',
    shopify_updated_at: policy.updatedAt,
    synced_at: syncedAt
  };
}

function sourceKey(row) {
  return `${row.source_type}:${row.shopify_source_id}`;
}

async function deleteSourcesMissingFromShopify({ supabase, shopId, seenSourceKeys }) {
  const existingRows = await supabaseSelect(
    supabase,
    'shopify_content_sources',
    { shop_id: shopId },
    'id,source_type,shopify_source_id'
  );
  const staleIds = existingRows
    .filter((row) => !seenSourceKeys.has(sourceKey(row)))
    .map((row) => row.id);

  if (staleIds.length === 0) {
    return 0;
  }

  await supabaseDeleteWhereIn(supabase, 'shopify_content_sources', 'id', staleIds);
  return staleIds.length;
}

async function fetchOptional(label, fetcher, fallback) {
  try {
    return await fetcher();
  } catch (error) {
    console.warn(`Skipping ${label}: ${error.message}`);
    return fallback;
  }
}

function isDirectRun() {
  return import.meta.url === pathToFileURL(process.argv[1] || '').href;
}
