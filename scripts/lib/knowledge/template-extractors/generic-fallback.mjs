import { blockText, isSkippableBlockType } from './text-utils.mjs';
import { isKnownPlaceholder } from './placeholder-strings.mjs';

// Shallow, exact-key allowlist only - no recursive walk, no substring
// matching (substring would wrongly pull in e.g. "heading_size"). Constrained
// on purpose: this is a last-resort adapter for unrecognized section types,
// not a general-purpose scraper.
const CONTENT_KEYS = ['title', 'subtitle', 'heading', 'subheading', 'top_subheading', 'text', 'body', 'content', 'description'];

export function extractGenericSection(section) {
  const parts = [
    ...matchedValues(section.settings),
    ...section.blocks.flatMap(blockValues)
  ];

  if (parts.length === 0) {
    return [];
  }

  return [
    {
      type: 'generic',
      heading: null,
      text: parts.join('\n\n'),
      confidence: 'low',
      sourceRef: {
        sectionId: section.sectionId,
        sectionType: section.type,
        blockId: null,
        blockType: null,
        position: section.position
      }
    }
  ];
}

function blockValues(block) {
  // Dedicated adapters (faq/rich-text/accordion) still skip liquid blocks
  // outright - a raw-code block inside a trusted, structured section is
  // unexpected. Here, at the last-resort fallback, blockText() already
  // strips HTML tags (including any embedded <img src="data:..."> - the
  // whole tag, attributes and all, not just its text) and Liquid
  // {{ }}/{% %} syntax, so what's left is worth surfacing at low confidence
  // for a human to review in the editor, rather than dropping it entirely.
  if (block.type === 'liquid') {
    const value = blockText(block.settings.code);
    return value && !isKnownPlaceholder(value) ? [value] : [];
  }

  return isSkippableBlockType(block.type) ? [] : matchedValues(block.settings);
}

function matchedValues(settings = {}) {
  return CONTENT_KEYS
    .map((key) => blockText(settings[key]))
    .filter((value) => value && !isKnownPlaceholder(value));
}
