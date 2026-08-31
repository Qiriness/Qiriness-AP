// Flattens Shopify's rich-text JSON to plain text.
//
// WHY THIS EXISTS. Metaobject rich-text fields are stored as a nested
// `{type:'root', children:[...]}` document, and Shopify hands it over as a JSON
// *string* inside the field value. So `product_faqs[].answer` and
// `product_ingredients[].fields.ingredients_text.value` look like text but are
// 300 characters of escaped JSON. Passed to a model as "the answer", that is
// pure noise consuming tokens; shown to a person it is unreadable.
//
// Pure and defensive: any shape it does not recognise degrades to the text it
// can find rather than throwing, because this runs over live merchandising data
// that nobody validates for us.

/**
 * Accepts the JSON string Shopify stores, an already-parsed node, or plain text,
 * and returns readable plain text.
 *
 * Lists become `- ` lines and paragraphs are separated by blank lines, because
 * the output goes into an LLM prompt where that structure is the only thing
 * distinguishing three ingredients from one sentence.
 */
export function flattenRichText(value) {
  const node = parse(value);
  if (node === null) {
    return '';
  }
  if (typeof node === 'string') {
    return node.trim();
  }
  return render(node, 0).replace(/\n{3,}/g, '\n\n').trim();
}

function parse(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'object') {
    return value;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  // Only attempt a parse when it plausibly is the rich-text document; a real
  // sentence starting with "{" is not worth guessing at.
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * A link worth carrying its URL: one that resolves to a file rather than a page.
 *
 * BY EXTENSION, not by host, so a manual moved off Shopify's CDN still counts and
 * nothing here knows which shop it is running for. `http(s)` only — a `mailto:`
 * or a relative path is not something to paste into a reply.
 */
const DOCUMENT_EXTENSIONS = /\.(pdf|docx?|xlsx?|pptx?|csv|zip)$/i;

function isDocumentUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    // The query string is where Shopify puts `?v=1760451724`, so the extension
    // has to be read from the path alone.
    return /^https?:$/.test(parsed.protocol) && DOCUMENT_EXTENSIONS.test(parsed.pathname);
  } catch {
    return false;
  }
}

function render(node, depth) {
  if (node === null || node === undefined) {
    return '';
  }
  if (typeof node === 'string') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => render(child, depth)).join('');
  }

  const children = () => (Array.isArray(node.children) ? node.children : [])
    .map((child) => render(child, depth + 1))
    .join('');

  switch (node.type) {
    case 'text':
      // `bold`/`italic` are dropped rather than turned into markers: the
      // consumer is a model reading for meaning, and ** noise ** costs tokens
      // without adding any.
      return String(node.value ?? '');
    case 'paragraph':
      return `${children()}\n\n`;
    case 'heading':
      return `${children()}\n\n`;
    case 'list':
      return `${children()}\n`;
    case 'list-item':
      return `- ${children().trim()}\n`;
    case 'link':
      // KEEP THE LABEL, AND THE URL ONLY WHEN IT IS A DOCUMENT.
      //
      // Dropping every URL was right until a link turned out to BE the answer.
      // « Guide d'utilisation et fiche technique » on the LED mask pointed at the
      // user manual — the one source answering battery life, the remote and what
      // to do when it will not switch on — and flattened to those five words with
      // nothing behind them, which is worse than omitting it: the sheet tells the
      // agent a guide exists and gives it no way to hand it over.
      //
      // MEASURED ACROSS THE WHOLE CATALOGUE, where exactly three links exist and
      // they split on this line: two are storefront product pages (merchandising
      // cross-sell, one carrying `?_pos=4&_sid=…` tracking) and one is the manual.
      // A page is navigation the agent has no business pasting — `crossSellFor`
      // already owns recommending products — while a document is a thing a
      // customer can be given.
      return isDocumentUrl(node.url) ? `${children()} (${node.url})` : children();
    case 'root':
      return children();
    default:
      return children() || String(node.value ?? '');
  }
}
