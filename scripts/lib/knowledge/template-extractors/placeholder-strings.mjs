// Exact-match denylist of Shopify starter-theme (Dawn) default block content,
// copied verbatim from a live templates/page.faq.json fetch. Exact match only
// (never substring/startsWith) so a real merchant answer that happens to
// start with "Example" is never excluded.
const KNOWN_PLACEHOLDER_STRINGS = new Set([
  'example title',
  'rich text',
  'use this section to explain a set of product features, to link to a series of pages, or to answer common questions about your products. add images for emphasis.',
  'use this text to share information about your brand with your customers. describe a product, share announcements, or welcome customers to your store.'
]);

export function isKnownPlaceholder(text) {
  return KNOWN_PLACEHOLDER_STRINGS.has(normalize(text));
}

function normalize(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
