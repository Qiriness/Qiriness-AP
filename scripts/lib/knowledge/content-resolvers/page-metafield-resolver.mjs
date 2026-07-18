import { htmlToSections, htmlToText, normalizePlainText } from '../../html-to-text.mjs';
import { cleanJsonValue, cleanTextValue } from '../../text-cleaning.mjs';

const DEFAULT_METAFIELD_KEYS = [
  'custom.ai_knowledge_text',
  'custom.knowledge_text',
  'custom.support_knowledge',
  'custom.canonical_knowledge_text'
];

export function createPageMetafieldResolver(config) {
  const allowedKeys = new Set(
    (config.knowledgePageMetafieldKeys.length > 0
      ? config.knowledgePageMetafieldKeys
      : DEFAULT_METAFIELD_KEYS
    ).map((key) => key.toLowerCase())
  );

  return {
    name: 'page_metafield',
    async resolve(source) {
      const metafields = source.page.metafields?.nodes || [];
      const metafield = metafields.find((item) => allowedKeys.has(`${item.namespace}.${item.key}`.toLowerCase()));

      if (!metafield) {
        return { found: false, reason: 'missing_page_metafield' };
      }

      const value = textFromMetafield(metafield);
      if (!value) {
        return { found: false, reason: 'empty_page_metafield' };
      }

      return {
        found: true,
        text: value,
        sections: htmlToSections(value, source.title),
        origin: 'page_metafield',
        confidence: 'high',
        metadata: {
          metafield_id: metafield.id,
          namespace: metafield.namespace,
          key: metafield.key,
          type: metafield.type,
          updated_at: metafield.updatedAt
        }
      };
    }
  };
}

function textFromMetafield(metafield) {
  if (typeof metafield.jsonValue === 'string') {
    return normalizePlainText(metafield.jsonValue);
  }

  if (metafield.jsonValue !== null && metafield.jsonValue !== undefined) {
    return normalizePlainText(extractStrings(cleanJsonValue(metafield.jsonValue)).join('\n\n'));
  }

  if (metafield.type?.includes('html')) {
    return htmlToText(metafield.value);
  }

  return normalizePlainText(cleanTextValue(metafield.value || ''));
}

function extractStrings(value) {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(extractStrings);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(extractStrings);
  }
  return [];
}
