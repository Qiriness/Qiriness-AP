import { pathToFileURL } from 'node:url';
import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createShopifyClient, fetchShop } from './lib/shopify-admin-client.mjs';
import { createShopifyThemeClient } from './lib/shopify-theme-client.mjs';
import {
  fetchKnowledgePages,
  fetchNavigationMenus,
  fetchShopPolicies
} from './lib/shopify-knowledge-client.mjs';
import { createSupabaseClient, supabaseDeleteWhereIn, supabaseUpsert } from './lib/supabase-rest-client.mjs';
import { mergeKnowledgeDocuments } from './lib/knowledge-document-repository.mjs';
import { syncShop } from './lib/shop-sync-service.mjs';
import { buildKnowledgeChunks } from './lib/knowledge-chunker.mjs';
import { mapResolvedPageToKnowledgeDocument, mapPolicyToKnowledgeDocument } from './lib/knowledge-document-mapper.mjs';
import { buildNavigationIndex } from './lib/knowledge-navigation.mjs';
import { discoverPageKnowledgeSources } from './lib/knowledge/source-discovery.mjs';
import { createKnowledgeSourceResolver } from './lib/knowledge/knowledge-source-resolver.mjs';

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
  await runShopifyKnowledgeSync({ args, config, shopify, supabase, shopRow, syncedAt });
}

export async function runShopifyKnowledgeSync({ args, config, shopify, supabase, shopRow, syncedAt }) {
  const themeClient = createShopifyThemeClient(config, shopify);
  const result = await buildKnowledgeDocuments({ args, shopify, themeClient, config, shopId: shopRow.id, syncedAt });
  const { documents, unresolvedSources } = result;

  if (args.dryRun) {
    reportDryRun(documents, unresolvedSources);
    return {
      documents: documents.length,
      chunks: documents.flatMap((document, index) => buildKnowledgeChunks({ ...document, id: `dry-run-${index}` })).length,
      unresolvedSources: unresolvedSources.length
    };
  }

  if (documents.length === 0) {
    console.log('Knowledge sync complete: 0 documents, 0 chunks.');
    return {
      documents: 0,
      chunks: 0,
      unresolvedSources: unresolvedSources.length
    };
  }

  const documentRows = await mergeKnowledgeDocuments(supabase, documents);

  const chunks = documentRows.flatMap((documentRow) => buildKnowledgeChunks(documentRow));
  await supabaseDeleteWhereIn(
    supabase,
    'knowledge_chunks',
    'knowledge_document_id',
    documentRows.map((documentRow) => documentRow.id)
  );

  if (chunks.length > 0) {
    await supabaseUpsert(
      supabase,
      'knowledge_chunks',
      chunks,
      'knowledge_document_id,chunk_index'
    );
  }

  reportUnresolvedSources(unresolvedSources);
  console.log(`Knowledge sync complete: ${documentRows.length} documents, ${chunks.length} chunks.`);
  return {
    documents: documentRows.length,
    chunks: chunks.length,
    unresolvedSources: unresolvedSources.length
  };
}

async function buildKnowledgeDocuments({ args, shopify, themeClient, config, shopId, syncedAt }) {
  const [menus, pages, policies] = await Promise.all([
    fetchOptional('navigation menus', () => fetchNavigationMenus(shopify), []),
    fetchOptional('pages', () => fetchKnowledgePages(shopify, args), []),
    fetchOptional('shop policies', () => fetchShopPolicies(shopify), [])
  ]);

  const navigationIndex = buildNavigationIndex(menus);
  const context = { shopId, syncedAt, navigationIndex };
  const resolver = createKnowledgeSourceResolver({ config, themeClient });
  const pageSources = discoverPageKnowledgeSources(pages, navigationIndex);
  const resolvedPages = await Promise.all(
    pageSources.map(async (source) => ({ source, content: await resolver.resolve(source) }))
  );
  const unresolvedSources = resolvedPages
    .filter((item) => !item.content.found)
    .map(({ source, content }) => ({ source, content }));
  const pageDocuments = resolvedPages.map(({ source, content }) => {
    if (!content.found) {
      return null;
    }
    return mapResolvedPageToKnowledgeDocument(source, content, context);
  });
  const policyDocuments = policies.map((policy) => mapPolicyToKnowledgeDocument(policy, context));

  return {
    documents: [...pageDocuments, ...policyDocuments].filter(Boolean),
    unresolvedSources
  };
}

async function fetchOptional(label, fetcher, fallback) {
  try {
    return await fetcher();
  } catch (error) {
    console.warn(`Skipping ${label}: ${error.message}`);
    return fallback;
  }
}

function reportDryRun(documents, unresolvedSources) {
  const chunks = documents.flatMap((document, index) => buildKnowledgeChunks({ ...document, id: `dry-run-${index}` }));
  const pages = documents.filter((document) => document.source_type === 'shopify_page').length;
  const policies = documents.filter((document) => document.source_type === 'shopify_policy').length;

  console.log(
    `Dry run complete: would upsert ${documents.length} knowledge documents (${pages} pages, ${policies} policies) and ${chunks.length} chunks.`
  );
  reportUnresolvedSources(unresolvedSources);
}

function reportUnresolvedSources(unresolvedSources) {
  if (unresolvedSources.length === 0) {
    return;
  }

  console.warn('Unresolved knowledge page content:');
  for (const { source, content } of unresolvedSources) {
    const lastAttempt = content.attemptedResolvers.at(-1);
    console.warn(`- ${source.title} (${source.handle}): ${lastAttempt?.reason || 'no resolver found content'}`);
  }
}

function isDirectRun() {
  return import.meta.url === pathToFileURL(process.argv[1] || '').href;
}
