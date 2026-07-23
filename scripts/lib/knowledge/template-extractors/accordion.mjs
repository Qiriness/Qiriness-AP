import { blockText, isSkippableBlockType } from './text-utils.mjs';
import { isKnownPlaceholder } from './placeholder-strings.mjs';

/** One feature_item semantic unit per non-disabled, non-placeholder block. */
export function extractAccordionSection(section) {
  const units = [];

  for (const block of section.blocks) {
    if (isSkippableBlockType(block.type)) {
      continue;
    }

    const heading = blockText(block.settings.title);
    const text = blockText(block.settings.text || block.settings.body);
    if (!heading || !text || isKnownPlaceholder(heading) || isKnownPlaceholder(text)) {
      continue;
    }

    units.push({
      type: 'feature_item',
      heading,
      text,
      sourceRef: {
        sectionId: section.sectionId,
        sectionType: section.type,
        blockId: block.blockId,
        blockType: block.type,
        position: block.position
      }
    });
  }

  return units;
}
