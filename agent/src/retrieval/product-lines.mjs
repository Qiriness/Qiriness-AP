import { CONCERNS, READABLE_CONCERNS, productMatchesConcern } from './product-concerns.mjs';

// How a suggested product is written out: the name, one line on what it does,
// and the skin it suits.
//
// WHY NOT A BARE LIST OF NAMES. A reply that answers « quel sérum pour mes
// rides ? » with three product names has told the customer nothing they could
// not get from the menu — they still have to open all three and work out which
// is for them. The shop already holds both halves of the answer, and the whole
// value of choosing three products is lost if the reply does not say why.
//
// THE TAGS ARE USED HERE, AND THAT IS NOT THE THING DECISIONS.md FORBIDS. The
// recorded rule is that the tags cannot CHOOSE a product — `peaux sensibles` is
// on 52 of 90 sellable products, so "for sensitive skin we suggest these 64" is
// not a recommendation. That argument is about selection. This is description:
// the product has already been chosen, by the collection intersection, and the
// question is only what to say about it. « convient aux peaux sensibles » is
// exactly what the merchandising means and exactly what a customer wants to
// read.
//
// TOUS TYPES DE PEAUX IS A REAL ANSWER, and the common one: a cleanser on this
// catalogue carries nine skin types at once. Listing nine would read as evasion.
// Anything matching most of the vocabulary collapses to the phrase the shop
// itself uses.

/**
 * Above this share of the readable skin types, a product is simply for everyone.
 *
 * Three of five rather than all five: the catalogue routinely tags a universal
 * product with four of them and leaves one off, and a reply that listed « peaux
 * sèches, grasses, mixtes, matures » instead of « tous types de peaux » is worse
 * French for the same fact.
 */
const UNIVERSAL_AT = 0.6;

/**
 * One product as a reply line: `- Name — what it does. Pour <skin>.`
 *
 * The summary is the shop's own `short_description`, never a sentence composed
 * here — a description invented about a cosmetic is the drafting mistake this
 * whole layer exists to prevent. A product without one gets no summary rather
 * than a generated one.
 */
export function productLine({ title, summary, tags } = {}) {
  const parts = [`- ${String(title ?? '').trim()}`];
  const said = sentence(summary);
  if (said) {
    parts.push(` — ${said}`);
  }
  const skin = skinPhrase(tags);
  if (skin) {
    parts.push(` ${skin}`);
  }
  return parts.join('');
}

export function productLines(products = []) {
  return products.map((product) => productLine(product)).join('\n');
}

/**
 * Who the product is for, in the shop's own words.
 *
 * Null when the tags say nothing about skin: silence is honest, and « convient à
 * tous les types de peaux » asserted from no tag at all would be a claim this
 * codebase never checked.
 */
export function skinPhrase(tags = []) {
  const list = Array.isArray(tags) ? tags : [];
  if (list.length === 0) {
    return null;
  }
  if (productMatchesConcern(list, 'all_types')) {
    return 'Convient à tous les types de peaux.';
  }

  const matched = READABLE_CONCERNS.filter((key) => productMatchesConcern(list, key));
  if (matched.length === 0) {
    return null;
  }
  if (matched.length / READABLE_CONCERNS.length >= UNIVERSAL_AT) {
    return 'Convient à tous les types de peaux.';
  }
  return `Pour ${matched.map((key) => CONCERNS[key].label).join(' et ')}.`;
}

/** The shop's summary, trimmed to one sentence and closed properly. */
function sentence(summary) {
  const text = String(summary ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return null;
  }
  // First sentence only. `short_description` runs to three or four on some
  // products, and a suggestion list of paragraphs stops being a list.
  const first = text.split(/(?<=[.!?])\s/)[0].trim();
  return /[.!?]$/.test(first) ? first : `${first}.`;
}
