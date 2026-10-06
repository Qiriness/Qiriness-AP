/**
 * What a customer points at without naming it — « les deux », « l'autre »,
 * « le premier », « ça » — and the conversation memory those words resolve
 * against.
 *
 * LANGUAGE, NOT BUSINESS. Everything hand-written here is French (and a little
 * English) grammar: conjunctions that separate products, deictic words, and the
 * shapes of a discovery question. No product, range or type is named; those
 * come from the catalogue (product-resolver.mjs).
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
  'autre', 'autres', 'celui', 'celle', 'ceux', 'celle', 'cela', 'matin', 'soir', 'both', 'other', 'first', 'last', 'third'
]);

/** Words that make the next word a named thing: articles, possessives, demonstratives. */
export const ANCHOR_WORDS = new Set([
  'le', 'la', 'l', 'les', 'du', 'au', 'aux', 'mon', 'ma', 'me', 'votre', 'vos', 'notre', 'ce', 'cet', 'cette', 'the', 'my', 'your'
]);

/** Definite articles only: « la crème licorne » names a product; « cette crème » points at one. */
export const DEFINITE_WORDS = new Set(['le', 'la', 'l', 'les', 'the']);

/** Short function words that are never part of a product name. */
export const STOPWORD_LIKE = new Set([
  'de', 'des', 'du', 'et', 'ou', 'a', 'au', 'aux', 'en', 'pour', 'par', 'avec', 'sans', 'sur', 'dans', 'qui', 'que', 'est', 'il', 'elle',
  'ne', 'pas', 'plus', 'tres', 'bien', 'of', 'for', 'and', 'with', 'is', 'it'
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
  return /\b(quel|quels|quelle|quelles|avez vous|auriez vous|vous avez|conseillez|recommandez|proposez|cherche (un|une|des)|un produit|une creme|un serum|un soin|une routine|pour (une|les|ma|mon) peau|pour peau|which|do you have|recommend|something for|looking for (a|an|some))\b/.test(
    ` ${normalised} `
  );
}

const PLURAL = /\b(?:tous les |toutes les |les )(deux|2|trois|3|quatre|4)\b|\b(both)\b|\ball (three)\b/;
const COUNTS = { deux: 2, 2: 2, both: 2, trois: 3, 3: 3, three: 3, quatre: 4, 4: 4 };
const RECOMMENDED_CUE = /\b(conseill\w*|recommand\w*|propos\w*|suggere\w*|suggest\w*)\b/;
const OTHER = /\b(l autre|the other( one)?)\b/;
const ORDINALS = [
  [/\b(le |la )?(premier|premiere|first)\b/, 0],
  [/\b(le |la )?(second|seconde|deuxieme)\b/, 1],
  [/\b(le |la )?(troisieme|third)\b/, 2],
  [/\b(le |la )?(dernier|derniere|last)\b/, -1]
];
const THIS = /\b(celui ci|celle ci|celui la|celle la|ce produit|ce soin|cet article|ca|cela|this one|this product)\b/;

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

  const demonstrative = text.match(THIS) ?? matchDemonstrativeCare(text, careWords);
  if (demonstrative) {
    const cue = demonstrative[0].trim();
    if (refs?.lastSingle) return { ids: [refs.lastSingle], reason: 'conversation: the product just discussed', cue };
    if (pageProductId) return { ids: [pageProductId], reason: 'current page', cue };
    if (lastSet.length > 1) return { ambiguousIds: lastSet, reason: 'conversation: several products in play', cue };
  }
  return null;
}

/** « cette crème », « ce sérum »: a demonstrative before one of the catalogue's own care words. */
function matchDemonstrativeCare(text, careWords) {
  for (const match of text.matchAll(/\b(ce|cet|cette|ces) (\w+)\b/g)) {
    const word = match[2].length > 3 && /[sx]$/.test(match[2]) ? match[2].slice(0, -1) : match[2];
    if (careWords.has(word)) return match;
  }
  return null;
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
