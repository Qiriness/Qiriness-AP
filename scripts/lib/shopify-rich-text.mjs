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
      // Keep the label, drop the URL: a support answer wants the words.
      return children();
    case 'root':
      return children();
    default:
      return children() || String(node.value ?? '');
  }
}
