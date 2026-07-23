import { getOrderedSections } from '../template-traversal.mjs';
import { extractFaqSection } from './faq.mjs';
import { extractRichTextSection } from './rich-text.mjs';
import { extractMediaTextSection } from './media-text.mjs';
import { extractAccordionSection } from './accordion.mjs';
import { extractGenericSection } from './generic-fallback.mjs';

const EXTRACTORS_BY_SECTION_TYPE = {
  faq: extractFaqSection,
  'rich-text': extractRichTextSection,
  'media-text': extractMediaTextSection,
  'advanced-accordion': extractAccordionSection
};

/** Raw Shopify JSON template -> ordered, typed semantic units (stage 2). */
export function extractSemanticUnits(template) {
  return getOrderedSections(template).flatMap((section) => {
    const extractor = EXTRACTORS_BY_SECTION_TYPE[section.type] || extractGenericSection;
    return extractor(section);
  });
}
