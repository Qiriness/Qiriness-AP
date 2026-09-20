// How a customer's word is matched against a collection title.
//
// SHARED BY BOTH CUE LISTS — `care-cues` (the type of care, a `category`) and
// `concern-cues` (what is wrong, a `concern`). They read the same messages
// against the same titles, and two ideas of what « whole word » means is the
// drift worth one module to prevent.

/** Case- and accent-insensitive, like every other product search in this codebase. */
export function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Whole words only, with the French plural allowed.
 *
 * « insensible » must not contain « sensible », so the phrase is bounded on both
 * sides — but « des sérums » has to find the cue « serum », so a trailing `s` is
 * optional. That is the same tolerance `titleHasToken` gives the other side, and
 * for the same reason: these are nouns a customer writes either way.
 */
export function containsPhrase(haystack, needle) {
  return phraseAt(haystack, needle) >= 0;
}

/** Where the phrase first appears as whole words, or -1. */
export function phraseAt(haystack, needle) {
  if (!needle) return -1;
  return haystack.search(new RegExp(`(^| )${escapeRegExp(needle)}s?( |$)`));
}

/** Below this, a prefix match is a coincidence rather than a French plural. */
const MIN_TOKEN = 4;

/**
 * Does this title carry the cue's token?
 *
 * A PREFIX, WHICH IS FRENCH PLURALS AND NOTHING CLEVERER. « serum » has to reach
 * « Sérums Visage » and « solaire » « Soins solaires et teintés »; a stemmer
 * would be a second thing to be wrong about, and the tokens are chosen so that a
 * prefix is enough.
 *
 * A TOKEN MAY BE A PHRASE, for a title whose meaning is in two words: « anti
 * age » has to reach « Diag - Anti-âge » and « Crèmes Anti-Âge & Anti-Rides »,
 * and the bare « age » is three letters and would match « agenda ». A phrase is
 * matched whole, with the same plural tolerance.
 */
export function titleHasToken(title, token) {
  const folded = fold(title);
  if (token.includes(' ')) {
    return containsPhrase(folded, token);
  }
  if (token.length < MIN_TOKEN) return false;
  return folded.split(' ').some((word) => word.startsWith(token));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
