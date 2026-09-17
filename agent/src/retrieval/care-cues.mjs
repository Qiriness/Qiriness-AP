// The type of care a customer names, read out of their own words.
//
// WHY THIS EXISTS, MEASURED. On « je voudrais un sérum ... j'ai la peau sensible
// et des rides » the model called the tool with two concerns and NO type of
// care, and the reply offered a sunscreen, a cream and a mist. The type of care
// is the one requirement the customer has already decided — it is what they came
// for — and leaving it to the model to remember is leaving the load-bearing part
// to judgement. Reading it from the text makes it a fact.
//
// IT DOES NOT REPLACE WHAT THE MODEL NAMES, it is unioned with it. Concerns
// genuinely need reading — « ma peau tiraille », « je brille en fin de journée »
// — and no cue list covers that. This covers the half that is nearly always
// written literally: a customer asking for a serum says the word « sérum ».
//
// A CUE RESOLVES TO A TOKEN, NOT TO A COLLECTION. The cues are French skincare
// words and belong here; which collections exist is the shop's, and changes
// whenever somebody curates. So a cue names a token, the token is looked up in
// the ACTIVE category titles, and a cue whose token matches nothing simply finds
// nothing — activating « Soins solaires et teintés » is what makes « spf »
// reachable, not an edit to this file.
//
// AMBIGUITY RESOLVES TO NOTHING. « une crème » matches Crèmes de Jour, Crèmes
// Hydratantes and Crèmes Mains on this shop, and picking one of three would be
// inventing the answer the customer did not give. A cue must land on exactly one
// active collection or it is dropped — the same stance `matchProduct` takes on a
// tie, and the same one `resolveRequirements` takes on an unknown name.

/**
 * Customer words for a type of care, and the title token each looks for.
 *
 * ORDERED LONGEST-PHRASE-FIRST within a family, because « crème pour les mains »
 * must be read as hand cream rather than as the bare « crème » that resolves to
 * nothing. The scan takes the first cue that fires per entry.
 */
export const CARE_CUES = [
  { token: 'contour', cues: ['contour des yeux', 'contour yeux', 'contour de l oeil', 'contour'] },
  { token: 'main', cues: ['creme pour les mains', 'creme mains', 'creme main', 'pour les mains', 'mains seches'] },
  { token: 'solaire', cues: ['spf', 'ecran solaire', 'protection solaire', 'creme solaire', 'solaire'] },
  { token: 'serum', cues: ['serum'] },
  { token: 'patch', cues: ['patch'] },
  { token: 'masque', cues: ['masque'] },
  { token: 'gommage', cues: ['gommage', 'exfoliant', 'exfolier'] },
  { token: 'lotion', cues: ['lotion'] },
  { token: 'nettoyant', cues: ['nettoyant', 'nettoyer ma peau', 'nettoyage'] },
  { token: 'demaquillant', cues: ['demaquillant', 'demaquiller', 'demaquillage'] },
  { token: 'jour', cues: ['creme de jour', 'soin de jour'] },
  { token: 'nuit', cues: ['creme de nuit', 'soin de nuit'] },
  { token: 'levre', cues: ['levres', 'levre', 'baume a levres'] },
  { token: 'corps', cues: ['pour le corps', 'soin du corps', 'lait corps'] }
];

/** Below this, a prefix match is a coincidence rather than a French plural. */
const MIN_TOKEN = 4;

/**
 * The active CATEGORY collections the customer's own words point at.
 *
 * @param text         the customer's message, quoted history already removed
 * @param collections  the activated collections
 * @returns the matched collections, in the order the cues are declared
 */
export function careCollectionsInText(text, collections = []) {
  const haystack = fold(text);
  if (!haystack) {
    return [];
  }
  const categories = collections.filter((collection) => collection.axis === 'category');
  const matched = [];

  for (const { token, cues } of CARE_CUES) {
    if (!cues.some((cue) => containsPhrase(haystack, fold(cue)))) {
      continue;
    }
    const hits = categories.filter((collection) => titleHasToken(collection.title, token));
    // Exactly one, or nothing. Two collections sharing the token means the
    // customer's word did not narrow it, and choosing would be inventing.
    if (hits.length === 1 && !matched.includes(hits[0])) {
      matched.push(hits[0]);
    }
  }
  return matched;
}

/**
 * Whole words only, with the French plural allowed.
 *
 * « insensible » must not contain « sensible », so the phrase is bounded on both
 * sides — but « des sérums » has to find the cue « serum », so a trailing `s` is
 * optional. That is the same tolerance `titleHasToken` gives the other side, and
 * for the same reason: these are nouns a customer writes either way.
 */
function containsPhrase(haystack, needle) {
  if (!needle) return false;
  return new RegExp(`(^| )${escapeRegExp(needle)}s?( |$)`).test(haystack);
}

/**
 * Does any word of this title start with the cue's token?
 *
 * A PREFIX, WHICH IS FRENCH PLURALS AND NOTHING CLEVERER. « serum » has to reach
 * « Sérums Visage » and « solaire » « Soins solaires et teintés »; a stemmer
 * would be a second thing to be wrong about, and the tokens here are chosen so
 * that a prefix is enough.
 */
function titleHasToken(title, token) {
  if (token.length < MIN_TOKEN) return false;
  return fold(title)
    .split(' ')
    .some((word) => word.startsWith(token));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case- and accent-insensitive, as everywhere else in this codebase. */
function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
