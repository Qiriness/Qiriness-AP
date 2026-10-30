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
 * @property {{ mention: string, ids: string[], settled: string[], labels: object } | null} pending  the clarification just asked, if any
 *   (settled: the products found beside it; labels: its options as offered, id → label)
 */

import { alternation, packs, wordsAt } from '../i18n/languages.mjs';

// Every word list below is every supported language's (i18n/<code>/words.mjs, `refs`).
const words = (key) => wordsAt(`refs.${key}`);
const alt = (key) => alternation(`refs.${key}`);

/** Grammar that must never be typo-corrected into a product word (« trois » is not « trio »). */
export const GRAMMAR_WORDS = new Set(words('grammar'));

/** Words that make the next word a named thing: articles, possessives, demonstratives. */
export const ANCHOR_WORDS = new Set(words('anchors'));

/** Definite articles only: « la crème licorne » names a product; « cette crème » points at one. */
export const DEFINITE_WORDS = new Set(words('definite'));

/** Short function words that are never part of a product name. */
export const STOPWORD_LIKE = new Set(words('stopwords'));

/**
 * Everyday words that are never a misspelt product word, so never typo-corrected:
 * « your » is not « jour », « vous » is not « doux »; « moins » (stemmed « moin ») is one letter from « mains ».
 */
export const COMMON_WORDS = new Set([...STOPWORD_LIKE, ...ANCHOR_WORDS, ...words('common')]);

/** Indefinite articles: « des masques », « une crème » is discovery, not a reference. */
export const INDEFINITE_WORDS = new Set(words('indefinite'));

const SEPARATORS = new RegExp(`[,;/+]|\\s(?:${alt('separators')})\\s`, 'i');

/** Raw text → normalised chunks, one per product mention. */
export function splitMentions(text, normaliseImpl = defaultNormalise) {
  return String(text ?? '')
    .split(SEPARATORS)
    .map((piece) => normaliseImpl(piece))
    .filter(Boolean);
}

const DISCOVERY = new RegExp(`\\b(${alt('discovery')})\\b`);

/** « quels sérums avez-vous », « une crème pour peau sèche », « que me conseillez-vous ». */
export function isDiscoveryQuestion(normalised) {
  return DISCOVERY.test(` ${normalised} `);
}

// « les deux », « tous les trois », "both": how many of the products in play.
const COUNTS = Object.assign({}, ...words('counts'), ...words('pluralAlone'));
const PLURAL_ALONE = Object.keys(Object.assign({}, ...words('pluralAlone')));
const PLURAL = new RegExp(
  `\\b(?:${alt('pluralPrefixes')})(${Object.keys(Object.assign({}, ...words('counts'))).join('|')})\\b`
  + (PLURAL_ALONE.length ? `|\\b(${PLURAL_ALONE.join('|')})\\b` : '')
);
const RECOMMENDED_CUE = new RegExp(`\\b(${alt('recommendedCue')})\\b`);
const OTHER = new RegExp(`\\b(${alt('other')})\\b`);
const ORDINALS = [['first', 0], ['second', 1], ['third', 2], ['last', -1]]
  .map(([key, position]) => [words(`ordinals.${key}`), position])
  .filter(([fragments]) => fragments.length)
  .map(([fragments, position]) => [new RegExp(`\\b(?:${fragments.join('|')})\\b`), position]);
// « est-elle recommandée ? », « convient-il aux peaux sèches ? »: the subject
// pronoun after its verb is the product just discussed. Only after a verb: a
// plain « il » (« il fait chaud ») points at nothing. Missed, the question about
// the hand cream got the anti-age cream's card (dev store, 2026-10-16).
const INVERTED = words('inverted').length ? new RegExp(`\\b(?:${alt('inverted')})\\b`) : null;
const THIS = new RegExp(`\\b(${alt('this')})\\b`);
const DEMONSTRATIVE_BEFORE = new RegExp(`\\b(${alt('demonstratives')}) (\\w+)\\b`, 'g');

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
    const n = COUNTS[plural[1] ?? plural[2]];
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

  const demonstrative = text.match(THIS) ?? (INVERTED && text.match(INVERTED)) ?? matchDemonstrativeCare(text, careWords);
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
  for (const match of text.matchAll(DEMONSTRATIVE_BEFORE)) {
    const word = match[2].length > 3 && /[sx]$/.test(match[2]) ? match[2].slice(0, -1) : match[2];
    if (careWords.has(word)) return match;
  }
  return null;
}

/**
 * Everyday words for the same thing, in every language the chat speaks (i18n/<code>/words.mjs,
 * `equivalents`: the same key is the same thing). A customer's word becomes the one the CATALOGUE
 * uses when the catalogue lacks it: « the Hyal-Aqua mask » reads « masque » on a French catalogue,
 * and « le masque » would read « mask » on an English one. Language, not brand: no product is named.
 */
const EQUIVALENTS = (() => {
  const groups = new Map();
  for (const pack of packs()) for (const [key, phrases] of Object.entries(pack.words.equivalents ?? {})) groups.set(key, [...(groups.get(key) ?? []), ...phrases]);
  return [...groups.values()];
})();
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
      if (resolution.pending?.ids?.length) {
        const labels = resolution.pending.labels && typeof resolution.pending.labels === 'object' ? Object.fromEntries(Object.entries(resolution.pending.labels).filter(([id, l]) => ids([id]).length && typeof l === 'string').map(([id, l]) => [id, l.slice(0, 200)])) : {};
        pending = { mention: String(resolution.pending.mention ?? ''), ids: ids(resolution.pending.ids), settled: ids(resolution.pending.settled), labels };
      }
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
    .replace(/ß/g, 'ss')
    .replace(/[’‘`´']/g, ' ')
    .replace(/[^a-z0-9\-\s]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
