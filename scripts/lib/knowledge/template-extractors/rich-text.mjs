import { blockText, isSkippableBlockType } from './text-utils.mjs';
import { isKnownPlaceholder } from './placeholder-strings.mjs';

const HEADING_BLOCK_TYPES = new Set(['heading']);
const TEXT_BLOCK_TYPES = new Set(['text']);
const FALLBACK_SETTINGS_KEYS = ['heading', 'title', 'subheading', 'subtitle', 'text', 'body', 'content', 'description'];

/**
 * Dawn-style prose sections: real content lives in `heading`/`text` typed
 * blocks. Some section types (e.g. background-image-text) keep the same
 * content directly on section.settings instead of blocks - fall back to
 * scanning those settings when the section has no blocks at all.
 */
export function extractRichTextSection(section) {
  const headingParts = [];
  const textParts = [];

  for (const block of section.blocks) {
    if (isSkippableBlockType(block.type)) {
      continue;
    }

    if (HEADING_BLOCK_TYPES.has(block.type)) {
      const value = blockText(block.settings.title);
      if (value && !isKnownPlaceholder(value)) {
        headingParts.push(value);
      }
      continue;
    }

    if (TEXT_BLOCK_TYPES.has(block.type)) {
      const value = blockText(block.settings.text);
      if (value && !isKnownPlaceholder(value)) {
        textParts.push(value);
      }
    }
  }

  if (headingParts.length === 0 && textParts.length === 0) {
    return extractFromFlatSettings(section);
  }

  const text = textParts.join('\n\n');
  if (!text) {
    return [];
  }

  return [
    {
      type: 'prose',
      heading: headingParts[0] || null,
      text,
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

function extractFromFlatSettings(section) {
  const entries = FALLBACK_SETTINGS_KEYS
    .map((key) => [key, blockText(section.settings[key])])
    .filter(([, value]) => value && !isKnownPlaceholder(value));

  if (entries.length === 0) {
    return [];
  }

  const heading = entries.find(([key]) => key === 'heading' || key === 'title')?.[1] || null;
  const text = entries
    .filter(([key]) => key !== 'heading' && key !== 'title')
    .map(([, value]) => value)
    .join('\n\n') || entries[0][1];

  if (!text) {
    return [];
  }

  return [
    {
      type: 'prose',
      heading,
      text,
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
