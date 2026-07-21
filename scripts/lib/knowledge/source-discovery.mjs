import { resolveNavigationArea } from '../knowledge-navigation.mjs';

export function discoverPageKnowledgeSources(pages, navigationIndex) {
  return pages.map((page) => discoverPageKnowledgeSource(page, navigationIndex.get(page.id) || []));
}

/**
 * Shapes a single raw Shopify page node into a resolver-ready source object.
 * Shared by the batch discovery above and the on-demand single-page import
 * flow (web/lib/server/knowledge-service.ts), which fetches one page by id
 * and has no navigation menu context, hence the empty-array default.
 */
export function discoverPageKnowledgeSource(page, navigationEntries = []) {
  return {
    sourceType: 'shopify_page',
    sourceId: page.id,
    page,
    handle: page.handle,
    title: page.title,
    urlPath: page.handle ? `/pages/${page.handle}` : null,
    navigationArea: resolveNavigationArea(navigationEntries),
    navigationEntries,
    categoryHints: [page.title, page.handle],
    status: page.publishedAt ? 'published' : 'unpublished',
    shopifyUpdatedAt: page.updatedAt,
    sourceMetadata: {
      shopify_created_at: page.createdAt,
      published_at: page.publishedAt,
      body_summary: page.bodySummary,
      template_suffix: page.templateSuffix,
      navigation_entries: navigationEntries
    }
  };
}
