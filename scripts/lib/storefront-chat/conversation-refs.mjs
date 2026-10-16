/**
 * What a customer points at without naming it — « les deux », « l'autre »,
 * « le premier », « ça » — and the conversation memory those words resolve
 * against.
 *
 * LANGUAGE, NOT BUSINESS. Everything hand-written here is French and English
 * grammar (about 99 % of customers): conjunctions that separate products,
 * deictic words, the shapes of a discovery question, and everyday words for
 * care types in both languages (`toCatalogueWords`). No product or range is
 * named; those come from the catalogue (product-resolver.mjs).
 *
 * THE MEMORY IS THE MESSAGE LOG. Each assistant row stores `refs` (what it
 * recommended as cards, what it mentioned) and the `resolution` of the question
 * it answered; `refsFromHistory` folds the session's recent rows into the few
 * sets these words can mean. Nothing else is stored.
 *
 * @typedef {object} ConversationRefs
 * @property {string[]} lastSet          the most recent set of products in play, in order
 * @property {string[]} lastRecommended  the most recent cards shown
 * @property {string | null} lastSingle  the product in play when the last set was one product
 * @property {{ mention: string, ids: string[] } | null} pending  the clarification just asked, if any
 */

/** Grammar that must never be typo-corrected into a product word (« trois » is not « trio »). */
export const GRAMMAR_WORDS = new Set([
  'deux', 'troi', 'trois', 'quatre', 'premier', 'premiere', 'second', 'seconde', 'deuxieme', 'troisieme', 'dernier', 'derniere',
  'autre', 'autres', 'celui', 'celle', 'ceux', 'celle', 'cela', 'matin', 'soir', 'both', 'other', 'first', 'last', 'third',
  'two', 'three', 'four', 'second', 'morning', 'evening', 'one', 'ones'
]);

/** Words that make the next word a named thing: articles, possessives, demonstratives. */
export const ANCHOR_WORDS = new Set([
  'le', 'la', 'l', 'les', 'du', 'au', 'aux', 'mon', 'ma', 'me', 'votre', 'vos', 'notre', 'ce', 'cet', 'cette',
  'the', 'my', 'your', 'our', 'this', 'that', 'these', 'those'
]);

/** Definite articles only: « la crème licorne » names a product; « cette crème » points at one. */
export const DEFINITE_WORDS = new Set(['le', 'la', 'l', 'les', 'the']);

/** Short function words that are never part of a product name. */
export const STOPWORD_LIKE = new Set([
  'de', 'des', 'du', 'et', 'ou', 'a', 'au', 'aux', 'en', 'pour', 'par', 'avec', 'sans', 'sur', 'dans', 'qui', 'que', 'est', 'il', 'elle',
  'ne', 'pas', 'plus', 'tres', 'bien', 'of', 'for', 'and', 'with', 'is', 'it', 'to', 'in', 'on', 'from', 'are', 'does', 'do', 'very', 'not'
]);

/**
 * Everyday words that are never a misspelt product word, so never typo-corrected:
 * « your » is not « jour », « vous » is not « doux ».
 */
export const COMMON_WORDS = new Set([
  ...STOPWORD_LIKE, ...ANCHOR_WORDS,
  'vous', 'avez', 'nous', 'leur', 'leurs', 'elles', 'mais', 'donc', 'alors', 'aussi', 'comme', 'quand', 'faire', 'peux', 'peut', 'veux', 'sont', 'etre', 'avoir', 'cette',
  'your', 'yours', 'what', 'have', 'will', 'would', 'could', 'should', 'about', 'there', 'their', 'them', 'they', 'when', 'where', 'which', 'with', 'this', 'that',
  'than', 'then', 'into', 'just', 'some', 'many', 'much', 'more', 'most', 'also', 'only', 'other', 'good', 'need', 'want', 'like', 'make', 'used', 'using'
]);

/** Indefinite articles: « des masques », « une crème » is discovery, not a reference. */
export const INDEFINITE_WORDS = new Set(['un', 'une', 'de', 'des', 'quelque', 'a', 'an', 'some', 'any']);

const SEPARATORS = /[,;/+]|\s(?:et|ou|avec|versus|vs|contre|puis|ainsi que|and|or|with)\s/i;

/** Raw text → normalised chunks, one per product mention. */
export function splitMentions(text, normaliseImpl = defaultNormalise) {
  return String(text ?? '')
    .split(SEPARATORS)
    .map((piece) => normaliseImpl(piece))
    .filter(Boolean);
}

/** « quels sérums avez-vous », « une crème pour peau sèche », « que me conseillez-vous ». */
export function isDiscoveryQuestion(normalised) {
  return /\b(quel|quels|quelle|quelles|avez vous|auriez vous|vous avez|conseillez|recommandez|proposez|cherche (un|une|des)|un produit|une creme|un serum|un soin|une routine|pour (une|les|ma|mon) peau|pour peau|vos produits|which|what|do you have|have you got|recommend|suggest|something for|looking for (a|an|some)|a product|a cream|a serum|an? (routine|treatment)|for (dry|oily|combination|sensitive|my) skin|your products)\b/.test(
    ` ${normalised} `
  );
}

const PLURAL = /\b(?:tous les |toutes les |les |the |the first |all )(deux|2|trois|3|quatre|4|two|three|four)\b|\b(both)\b|\ball (three)\b/;
const COUNTS = { deux: 2, 2: 2, two: 2, both: 2, trois: 3, 3: 3, three: 3, quatre: 4, 4: 4, four: 4 };
const RECOMMENDED_CUE = /\b(conseill\w*|recommand\w*|propos\w*|suggere\w*|suggest\w*)\b/;
const OTHER = /\b(l autre|the other( one)?)\b/;
const ORDINALS = [
  [/\b(le |la )?(premier|premiere|first)\b/, 0],
  [/\b(le |la )?(second|seconde|deuxieme)\b/, 1],
  [/\b(le |la )?(troisieme|third)\b/, 2],
  [/\b(le |la )?(dernier|derniere|last)\b/, -1]
];
// « est-elle recommandée ? », « convient-il aux peaux sèches ? »: the subject
// pronoun after its verb is the product just discussed. Only after a verb: a
// plain « il » (« il fait chaud ») points at nothing. Missed, the question about
// the hand cream got the anti-age cream's card (dev store, 2026-10-16).
const INVERTED = /\b(est|sont|convient|conviennent|conviendrait|contient|marche|fonctionne|dure|coute|sent|existe|reste|peut|va|irait|serait|a t|existe t|convient t|faut) (elle|il|elles|ils)\b/;
const THIS = /\b(celui ci|celle ci|celui la|celle la|ce produit|ce soin|cet article|ca|cela|this one|that one|this product|this item|it)\b/;

/**
 * @param {string} normalised the customer message, normalised
 * @param {{ refs?: ConversationRefs | null, pageProductId?: string | null, careWords?: Set<string> }} context
 * @returns {{ ids?: string[], ambiguousIds?: string[], reason: string, cue: string } | null}
 */
export function detectReference(normalised, { refs = null, pageProductId = null, careWords = new Set() } = {}) {
  const text = ` ${normalised} `;
  const lastSet = refs?.lastSet ?? [];

  const plural = text.match(PLURAL);
  if (plural) {
    const n = COUNTS[plural[1] ?? plural[2] ?? plural[3]];
    const source = RECOMMENDED_CUE.test(text) && refs?.lastRecommended?.length ? refs.lastRecommended : lastSet.length ? lastSet : refs?.lastRecommended ?? [];
    if (source.length >= n) return { ids: source.slice(0, n), reason: `conversation: ${plural[0].trim()}`, cue: plural[0].trim() };
    // « les deux » when only one product was ever in play: say what there is and
    // flag the rest, so the model does not go and find a second one to compare.
    if (source.length > 0) {
      return { ids: source, reason: `conversation: ${plural[0].trim()} (only ${source.length} in play)`, cue: plural[0].trim(), shortfall: true };
    }
    return null;
  }

  const other = text.match(OTHER);
  if (other && lastSet.length === 2) {
    const current = refs?.focus && lastSet.includes(refs.focus) ? refs.focus : null;
    if (current) return { ids: lastSet.filter((id) => id !== current), reason: 'conversation: the other one', cue: other[0].trim() };
    return { ambiguousIds: lastSet, reason: 'conversation: the other one', cue: other[0].trim() };
  }

  for (const [pattern, position] of ORDINALS) {
    const hit = text.match(pattern);
    if (hit && lastSet.length > 1) {
      const id = position === -1 ? lastSet[lastSet.length - 1] : lastSet[position];
      if (id) return { ids: [id], reason: `conversation: ${hit[0].trim()}`, cue: hit[0].trim() };
    }
  }

  const demonstrative = text.match(THIS) ?? text.match(INVERTED) ?? matchDemonstrativeCare(text, careWords);
  if (demonstrative) {
    const cue = demonstrative[0].trim();
    if (refs?.lastSingle) return { ids: [refs.lastSingle], reason: 'conversation: the product just discussed', cue };
    if (pageProductId) return { ids: [pageProductId], reason: 'current page', cue };
    if (lastSet.length > 1) return { ambiguousIds: lastSet, reason: 'conversation: several products in play', cue };
  }
  return null;
}

/** « cette crème », « this serum »: a demonstrative before one of the catalogue's own care words. */
function matchDemonstrativeCare(text, careWords) {
  for (const match of text.matchAll(/\b(ce|cet|cette|ces|this|that|these|those) (\w+)\b/g)) {
    const word = match[2].length > 3 && /[sx]$/.test(match[2]) ? match[2].slice(0, -1) : match[2];
    if (careWords.has(word)) return match;
  }
  return null;
}

/**
 * Everyday words for the same thing, in French and English. A customer's word
 * becomes the one the CATALOGUE uses when the catalogue lacks it: « the
 * Hyal-Aqua mask » reads « masque » on a French catalogue, and « le masque »
 * would read « mask » on an English one. Language, not brand: no product is named.
 */
const EQUIVALENTS = [
  ['creme', 'cream', 'creams', 'moisturiser', 'moisturizer'],
  ['masque', 'masques', 'mask', 'masks'],
  ['lotion', 'toner'],
  ['coffret', 'gift set', 'gift box', 'box set'],
  ['huile', 'oil'],
  ['lait', 'milk'],
  ['baume', 'balm'],
  ['gommage', 'scrub', 'exfoliator'],
  ['nettoyant', 'cleanser'],
  ['demaquillant', 'make up remover', 'makeup remover'],
  ['brume', 'mist'],
  ['eau', 'water'],
  ['mousse', 'foam'],
  ['patchs', 'patches'],
  ['nuit', 'night'],
  ['jour', 'day'],
  ['yeux', 'eye', 'eyes'],
  ['levres', 'lips'],
  ['mains', 'hand', 'hands'],
  ['corps', 'body'],
  ['visage', 'face'],
  ['gamme', 'range'],
  ['fleur d oranger', 'orange blossom'],
  ['quartz rose', 'rose quartz']
];
const EQUIVALENT_PHRASES = EQUIVALENTS.flatMap((group) => group.map((phrase) => [phrase, group])).sort((a, b) => b[0].length - a[0].length);

/**
 * Normalised text → the same text in the catalogue's words. `known(word)` says
 * whether a word is in the catalogue's titles.
 * @param {string} normalised
 * @param {(word: string) => boolean} known
 */
export function toCatalogueWords(normalised, known) {
  let text = ` ${normalised} `;
  const has = (phrase) => phrase.split(' ').every((w) => known(w));
  for (const [phrase, group] of EQUIVALENT_PHRASES) {
    if (!text.includes(` ${phrase} `) || has(phrase)) continue;
    const target = group.find((candidate) => candidate !== phrase && has(candidate));
    if (target) text = text.split(` ${phrase} `).join(` ${target} `);
  }
  return text.trim();
}

/**
 * The session's recent rows (oldest first, as the service reads them) → the
 * sets « les deux », « l'autre » and « ça » can mean.
 *
 * @param {{ role: string, context?: object | null }[]} rows
 * @returns {ConversationRefs & { focus: string | null }}
 */
export function refsFromHistory(rows) {
  let lastSet = [];
  let lastRecommended = [];
  let focus = null;
  let pending = null;
  let sawUser = false;

  let sawResolution = false;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const { role, context } = rows[i] ?? {};
    const resolution = context?.resolution;
    if (resolution && !sawResolution) {
      // Only the clarification asked in the LAST exchange is still pending.
      if (resolution.pending?.ids?.length) pending = { mention: String(resolution.pending.mention ?? ''), ids: ids(resolution.pending.ids) };
      sawResolution = true;
    }
    const resolvedIds = ids(resolution?.ids);
    if (!focus && resolvedIds.length === 1) focus = resolvedIds[0];
    if (role === 'assistant') {
      const recommended = ids(context?.refs?.recommended);
      const mentioned = ids(context?.refs?.mentioned);
      if (!lastRecommended.length && recommended.length) lastRecommended = recommended;
      if (!lastSet.length) lastSet = recommended.length ? recommended : mentioned;
    } else if (role === 'user') {
      sawUser = true;
    }
    if (!lastSet.length && resolvedIds.length) lastSet = resolvedIds;
    if (lastSet.length && lastRecommended.length && focus && sawResolution) break;
  }
  return { lastSet, lastRecommended, lastSingle: lastSet.length === 1 ? lastSet[0] : null, focus, pending };
}

function ids(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v) : [];
}

function defaultNormalise(text) {
  return String(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’‘`´']/g, ' ')
    .replace(/[^a-z0-9\-\s]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
