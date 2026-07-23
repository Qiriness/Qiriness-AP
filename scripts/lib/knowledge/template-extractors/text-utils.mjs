import { htmlToText, normalizePlainText } from '../../html-to-text.mjs';
import { cleanTextValue } from '../../text-cleaning.mjs';

// Raw Liquid/code blocks (arbitrary template logic, asset data-URIs, etc.) are
// never safe to scrape for prose - see theme-template-resolver.mjs diagnosis.
const SKIPPABLE_BLOCK_TYPES = new Set(['liquid']);

export function isSkippableBlockType(type) {
  return SKIPPABLE_BLOCK_TYPES.has(type);
}

export function blockText(value) {
  const raw = cleanTextValue(String(value || '')).trim();
  if (!raw) {
    return '';
  }

  if (/<[a-z][\s\S]*>/i.test(raw)) {
    return htmlToText(raw);
  }

  return normalizePlainText(
    raw
      .replace(/\{\{[\s\S]*?\}\}/g, ' ')
      .replace(/\{%[\s\S]*?%\}/g, ' ')
  );
}
