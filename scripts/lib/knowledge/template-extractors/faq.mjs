import { blockText, isSkippableBlockType } from './text-utils.mjs';

/**
 * `rich-text` blocks act as category markers; `question` blocks are
 * individual FAQ records assigned to the most recently seen category in
 * block_order order.
 */
export function extractFaqSection(section) {
  const units = [];
  let currentCategory = null;

  for (const block of section.blocks) {
    if (isSkippableBlockType(block.type)) {
      continue;
    }

    if (block.type === 'rich-text') {
      const category = blockText(block.settings.title);
      if (category) {
        currentCategory = category;
      }
      continue;
    }

    if (block.type !== 'question') {
      continue;
    }

    const question = blockText(block.settings.title);
    const answer = blockText(block.settings.text);
    if (!question || !answer) {
      continue;
    }

    units.push({
      type: 'faq_item',
      category: currentCategory,
      question,
      answer,
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
