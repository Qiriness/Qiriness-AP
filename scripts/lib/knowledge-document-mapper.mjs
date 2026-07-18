import { stripUndefined } from './collections.mjs';
import { hashJson } from './hash.mjs';
import { htmlToSections, htmlToText, normalizePlainText } from './html-to-text.mjs';
import { inferKnowledgeCategory } from './knowledge-categories.mjs';
import { resolveNavigationArea } from './knowledge-navigation.mjs';
import { cleanTextValue } from './text-cleaning.mjs';

export function mapResolvedPageToKnowledgeDocument(source, resolvedContent, context) {
  const title = cleanTextValue(source.title);
  const bodyText = normalizePlainText(resolvedContent.text);
  const sections = resolvedContent.sections?.length > 0
    ? resolvedContent.sections
    : [{ heading: title, text: bodyText, order: 0, anchor: source.handle }];
  const contentText = joinContent(title, bodyText);

  if (!bodyText) {
    return null;
  }

  return stripUndefined({
    shop_id: context.shopId,
    source_type: source.sourceType,
    shopify_source_id: source.sourceId,
    handle: source.handle,
    title,
    url_path: source.urlPath,
    navigation_area: source.navigationArea,
    category: inferKnowledgeCategory(title, source.handle, bodyText),
    locale: 'fr',
    status: source.status,
    content_text: contentText,
    sections,
    content_hash: hashJson({ title, contentText, sections }),
    synced_at: context.syncedAt,
    shopify_updated_at: source.shopifyUpdatedAt,
    source_metadata: stripUndefined({
      ...cleanSourceMetadata(source.sourceMetadata),
      content_origin: resolvedContent.origin,
      content_confidence: resolvedContent.confidence,
      content_metadata: resolvedContent.metadata,
      resolver_order: resolvedContent.resolverOrder,
      attempted_resolvers: resolvedContent.attemptedResolvers
    })
  });
}

export function mapPolicyToKnowledgeDocument(policy, context) {
  const title = cleanTextValue(policy.title);
  const sections = htmlToSections(policy.body, title);
  const bodyText = htmlToText(policy.body);
  const contentText = joinContent(title, bodyText);

  if (!bodyText) {
    return null;
  }

  const navigationEntries = context.navigationIndex.get(policy.id) || [];

  return stripUndefined({
    shop_id: context.shopId,
    source_type: 'shopify_policy',
    shopify_source_id: policy.id,
    handle: policy.type ? policy.type.toLowerCase().replace(/_/g, '-') : null,
    title,
    url_path: urlPath(policy.url),
    navigation_area: resolveNavigationArea(navigationEntries, 'footer'),
    category: inferKnowledgeCategory(policy.type, title, bodyText),
    locale: 'fr',
    status: 'published',
    content_text: contentText,
    sections,
    content_hash: hashJson({ title, contentText, sections }),
    synced_at: context.syncedAt,
    shopify_updated_at: policy.updatedAt,
    source_metadata: stripUndefined({
      policy_type: policy.type,
      source_url: policy.url,
      shopify_created_at: policy.createdAt,
      navigation_entries: navigationEntries
    })
  });
}

function joinContent(title, bodyText) {
  return [title, bodyText].filter(Boolean).join('\n\n');
}

function cleanSourceMetadata(metadata = {}) {
  return {
    ...metadata,
    body_summary: cleanTextValue(metadata.body_summary)
  };
}

function urlPath(url) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}
