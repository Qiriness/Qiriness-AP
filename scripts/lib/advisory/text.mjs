/**
 * Text helpers for the advisory core. Kept here, not imported from the
 * storefront or the support agent, so `advisory/` depends on nothing but
 * itself (isolation.test.mjs).
 */

/** Lower case, accents and apostrophes gone, single spaces: « Crème d’Exception » → « creme d exception ». */
export function norm(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Plural folding, the resolver's rule: « crèmes » → « creme », « patchs » → « patch ». */
export function fold(word) {
  return word.length > 3 && /[sx]$/.test(word) ? word.slice(0, -1) : word;
}

/** Does normalised `haystack` contain normalised `phrase` as whole words? */
export function hasPhrase(haystack, phrase) {
  const p = norm(phrase);
  return Boolean(p) && ` ${haystack} `.includes(` ${p} `);
}

/** The title's head noun, folded: the care type (« Crème … » → creme, « Patchs … » → patch). */
export function careTypeOf(title) {
  return fold(norm(title).split(' ')[0] ?? '');
}
