import { cleanTextValue } from './text-cleaning.mjs';

const BLOCK_TAG_PATTERN = /<\/?(address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)[^>]*>/gi;

// Standard HTML4 entity references (markup + Latin-1 supplement + the common
// "smart punctuation" set) - not a hand-picked list of whatever we happened
// to see, the same "add a proper decode table" fix used for mojibake in
// text-cleaning.mjs, applied to the separate problem of literal HTML named
// entities (e.g. content pasted from a word processor or an old CMS export).
const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['apos', "'"],
  ['gt', '>'],
  ['lt', '<'],
  ['nbsp', ' '],
  ['quot', '"'],
  // Latin-1 supplement (accented Latin characters, common in French content)
  ['Agrave', 'À'], ['Aacute', 'Á'], ['Acirc', 'Â'], ['Atilde', 'Ã'], ['Auml', 'Ä'], ['Aring', 'Å'],
  ['AElig', 'Æ'], ['Ccedil', 'Ç'],
  ['Egrave', 'È'], ['Eacute', 'É'], ['Ecirc', 'Ê'], ['Euml', 'Ë'],
  ['Igrave', 'Ì'], ['Iacute', 'Í'], ['Icirc', 'Î'], ['Iuml', 'Ï'],
  ['Ntilde', 'Ñ'],
  ['Ograve', 'Ò'], ['Oacute', 'Ó'], ['Ocirc', 'Ô'], ['Otilde', 'Õ'], ['Ouml', 'Ö'], ['Oslash', 'Ø'],
  ['Ugrave', 'Ù'], ['Uacute', 'Ú'], ['Ucirc', 'Û'], ['Uuml', 'Ü'],
  ['Yacute', 'Ý'],
  ['agrave', 'à'], ['aacute', 'á'], ['acirc', 'â'], ['atilde', 'ã'], ['auml', 'ä'], ['aring', 'å'],
  ['aelig', 'æ'], ['ccedil', 'ç'],
  ['egrave', 'è'], ['eacute', 'é'], ['ecirc', 'ê'], ['euml', 'ë'],
  ['igrave', 'ì'], ['iacute', 'í'], ['icirc', 'î'], ['iuml', 'ï'],
  ['ntilde', 'ñ'],
  ['ograve', 'ò'], ['oacute', 'ó'], ['ocirc', 'ô'], ['otilde', 'õ'], ['ouml', 'ö'], ['oslash', 'ø'],
  ['ugrave', 'ù'], ['uacute', 'ú'], ['ucirc', 'û'], ['uuml', 'ü'],
  ['yacute', 'ý'], ['yuml', 'ÿ'],
  ['ordf', 'ª'], ['ordm', 'º'], ['szlig', 'ß'],
  ['OElig', 'Œ'], ['oelig', 'œ'], ['Scaron', 'Š'], ['scaron', 'š'], ['Yuml', 'Ÿ'],
  ['deg', '°'], ['sect', '§'], ['para', '¶'], ['middot', '·'], ['copy', '©'], ['reg', '®'], ['trade', '™'],
  ['euro', '€'], ['cent', '¢'], ['pound', '£'], ['yen', '¥'],
  // Common "smart punctuation" (word processors, rich-text pastes)
  ['lsquo', '‘'], ['rsquo', '’'], ['sbquo', '‚'],
  ['ldquo', '“'], ['rdquo', '”'], ['bdquo', '„'],
  ['ndash', '–'], ['mdash', '—'],
  ['hellip', '…'], ['bull', '•']
]);

export function htmlToText(html) {
  if (!html) {
    return '';
  }

  const withoutScripts = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');

  const withBreaks = withoutScripts
    .replace(BLOCK_TAG_PATTERN, '\n')
    .replace(/<[^>]+>/g, ' ');

  return normalizePlainText(decodeHtmlEntities(withBreaks));
}

export function htmlToSections(html, fallbackHeading) {
  const headingMatches = [...String(html || '').matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)];
  if (headingMatches.length === 0) {
    const text = htmlToText(html);
    return text ? [sectionObject(fallbackHeading, text, 0)] : [];
  }

  const sections = [];
  const firstHeadingIndex = headingMatches[0].index ?? 0;
  const introHtml = String(html).slice(0, firstHeadingIndex);
  const introText = htmlToText(introHtml);

  if (introText) {
    sections.push(sectionObject(fallbackHeading, introText, sections.length));
  }

  for (let index = 0; index < headingMatches.length; index += 1) {
    const match = headingMatches[index];
    const nextMatch = headingMatches[index + 1];
    const heading = htmlToText(match[2]) || fallbackHeading;
    const start = (match.index ?? 0) + match[0].length;
    const end = nextMatch?.index ?? String(html).length;
    const text = htmlToText(String(html).slice(start, end));

    if (text) {
      sections.push(sectionObject(heading, text, sections.length));
    }
  }

  return sections.length > 0 ? sections : htmlToSections('', fallbackHeading);
}

function sectionObject(heading, text, order) {
  return {
    heading: normalizePlainText(heading || null),
    text,
    order,
    anchor: slugify(heading || `section-${order + 1}`)
  };
}

/**
 * Renders resolved sections (heading/text pairs) back into simple HTML, for
 * seeding the Agent Setup dashboard's rich-text editor at import time. None of
 * the four content resolvers preserve raw source HTML (theme-template and
 * manual-override sources often have no HTML to begin with), so this derives
 * a reasonable starter document from the structured text every resolver
 * already produces, rather than threading HTML through all four.
 */
export function sectionsToHtml(sections, fallbackTitle) {
  if (!Array.isArray(sections) || sections.length === 0) {
    return '';
  }

  return sections
    .map((section) => {
      const heading = section.heading && section.heading !== fallbackTitle
        ? `<h3>${escapeHtml(section.heading)}</h3>`
        : '';
      const paragraphs = String(section.text || '')
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
        .join('');
      return heading + paragraphs;
    })
    .join('');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function normalizePlainText(value) {
  return cleanTextValue(String(value || ''))
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith('#x')) {
      return decodeCodePoint(Number.parseInt(normalized.slice(2), 16), match);
    }
    if (normalized.startsWith('#')) {
      return decodeCodePoint(Number.parseInt(normalized.slice(1), 10), match);
    }
    return NAMED_ENTITIES.get(normalized) ?? match;
  });
}

function decodeCodePoint(codePoint, fallback) {
  if (!Number.isInteger(codePoint)) {
    return fallback;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

export function slugify(value) {
  const slug = cleanTextValue(String(value || ''))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || null;
}
