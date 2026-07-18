import { resolveNavigationArea } from '../knowledge-navigation.mjs';

export function discoverPageKnowledgeSources(pages, navigationIndex) {
  return pages.map((page) => {
    const navigationEntries = navigationIndex.get(page.id) || [];

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
  });
}
