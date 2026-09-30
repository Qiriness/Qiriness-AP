import { isReplyLinkUrl, splitLinkMarkers } from './reply-link.mjs';

// THE HTML A CUSTOMER REPLY IS SENT AS, and the only place it is shaped.
//
// A reply leaves as HTML (Graph's reply draft takes `contentType: html`). The
// agent writes plain text, a person may now write or edit with bold, italics,
// underline, lists and links, and both have to reach the mailbox as the same
// small, safe subset. One module for both runtimes — the dashboard's editor
// and save path, and the outbound worker — so what the reviewer approved and
// what the customer receives are cut by one rule.
//
// THE SANITISER REBUILDS, IT DOES NOT FILTER. Every tag in the output is
// written here from a fixed list, with no attribute but a checked `href`;
// everything else in the input becomes text. Nothing a browser pasted, and no
// attribute on an allowed tag, can reach the mailbox by being overlooked.
//
// Pure and dependency-free: the browser bundle imports it (web/lib/reply-html.ts).

/** Tags a reply may carry, and what each is written as. */
const TAG_MAP = {
  p: 'p',
  div: 'p', // contentEditable makes a line a <div>; a mail client wants a paragraph
  br: 'br',
  b: 'strong',
  strong: 'strong',
  i: 'em',
  em: 'em',
  u: 'u',
  a: 'a',
  ul: 'ul',
  ol: 'ol',
  li: 'li'
};

const VOID = new Set(['br']);

// Dropped with everything inside them, not unwrapped: their text is not prose.
const DROP_WITH_CONTENT = /<(script|style|head|title|template|noscript|xml|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** An address a customer may be sent to: https, or mailto for an address. */
export function isSafeReplyHref(value) {
  const text = String(value ?? '').trim();
  if (/^mailto:[^\s@<>"']+@[^\s@<>"']+$/i.test(text)) return true;
  return isReplyLinkUrl(text);
}

/**
 * Any HTML -> the reply subset. Unknown tags are unwrapped (their text kept),
 * a link with an unsafe address keeps its words and loses the link, and tags
 * left open are closed at the end.
 */
export function sanitiseReplyHtml(html) {
  const source = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DROP_WITH_CONTENT, '');

  const out = [];
  const open = [];
  const tokenPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|<|>|[^<>]+/g;

  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    const name = match[1]?.toLowerCase();
    if (!name) {
      out.push(escapeText(decodeEntities(token)));
      continue;
    }
    const tag = TAG_MAP[name];
    if (!tag) continue;
    const closing = token.startsWith('</');

    if (VOID.has(tag)) {
      if (!closing) out.push('<br>');
      continue;
    }
    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at === -1) continue;
      // Close everything opened inside it too, so the nesting stays valid.
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    if (tag === 'a') {
      const href = attribute(match[2], 'href');
      if (!href || !isSafeReplyHref(href)) continue;
      out.push(`<a href="${escapeAttribute(href.trim())}">`);
      open.push('a');
      continue;
    }
    // A paragraph never nests in a paragraph: contentEditable's <div><div> is two lines.
    if (tag === 'p' && open.includes('p')) {
      while (open.length > open.lastIndexOf('p')) out.push(`</${open.pop()}>`);
    }
    out.push(`<${tag}>`);
    open.push(tag);
  }
  while (open.length > 0) out.push(`</${open.pop()}>`);

  return out
    .join('')
    .replace(/<(strong|em|u|a|li|ul|ol)(?: [^>]*)?><\/\1>/g, '')
    .replace(/<p>(?:\s|&nbsp;)*<\/p>/g, '<p><br></p>')
    .trim();
}

/**
 * Plain text -> reply HTML: escaped, blank lines become paragraphs, single
 * newlines line breaks, and the draft's `[[word]]` marker becomes the link it
 * stands for (reply-link.mjs). Without a usable link the marker stays as
 * written — the drafting check already fails such a draft.
 *
 * @param {string} text
 * @param {{ url: string, label: string } | null} [link]
 */
export function textToReplyHtml(text, link = null) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => {
      const inner = splitLinkMarkers(paragraph, link)
        .map((segment) => {
          const words = escapeText(segment.text).replace(/\n/g, '<br>');
          return segment.url ? `<a href="${escapeAttribute(segment.url)}">${words}</a>` : words;
        })
        .join('');
      return `<p>${inner}</p>`;
    })
    .join('\n');
}

/**
 * Reply HTML -> the plain text every reader of `body_text` gets: the edit log,
 * the outbound copy, a preview. Paragraphs are blank-line separated and list
 * items dashed. A link reads « words (address) », except the draft's own link,
 * which goes back to its `[[word]]` marker so an unchanged draft reads as
 * unchanged.
 *
 * @param {string} html
 * @param {{ link?: { url: string, label: string } | null }} [options]
 */
export function replyHtmlToText(html, { link = null } = {}) {
  const clean = sanitiseReplyHtml(html);
  const text = clean
    .replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, (_, href, words) => {
      const url = decodeEntities(href);
      const label = words.replace(/<[^>]+>/g, '');
      if (link?.url && url === link.url) return `[[${label}]]`;
      const plain = decodeEntities(label).trim();
      return plain === url || `mailto:${plain}` === url ? label : `${label} (${escapeText(url)})`;
    })
    .replace(/<br>/g, '\n')
    .replace(/<li>/g, '- ')
    .replace(/<\/li>/g, '\n')
    .replace(/<\/(p|ul|ol)>/g, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Whether a reply's HTML says anything once the markup is gone. */
export function replyHtmlIsEmpty(html) {
  return replyHtmlToText(html).replace(/\s+/g, '') === '';
}

function attribute(attributes, name) {
  const match = String(attributes ?? '').match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
  );
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '');
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+[0-9]*);/gi, (whole, body) => {
    const key = body.toLowerCase();
    if (NAMED[key] !== undefined) return NAMED[key];
    const code = key.startsWith('#x') ? parseInt(key.slice(2), 16) : key.startsWith('#') ? parseInt(key.slice(1), 10) : NaN;
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
  });
}

function escapeText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(text) {
  return escapeText(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
