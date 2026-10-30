/**
 * Ingredient words a customer can exclude, across languages. « sans parfum »
 * and « fragrance-free » are one exclusion, and it must hit a product whose
 * key ingredients say « Parfum » whatever language the catalogue is written in.
 *
 * LANGUAGE, NOT BRAND: ordinary ingredient names. The profile stores the key
 * (`fragrance`); a value stored before the keys existed (« parfum ») still
 * expands to its group.
 */

import { norm } from './text.mjs';
import { LEXICONS } from '../i18n/languages.mjs';

// Each key's words in every language the chat speaks (i18n/<code>/lexicon.mjs, `ingredients`).
const GROUPS = {};
for (const lexicon of LEXICONS) {
  for (const [key, words] of Object.entries(lexicon.ingredients ?? {})) GROUPS[key] = [...new Set([...(GROUPS[key] ?? []), ...words])];
}

const KEY_OF = new Map(Object.entries(GROUPS).flatMap(([key, words]) => [[key, key], ...words.map((w) => [w, key])]));

/** A typed ingredient phrase → its key, or the phrase itself when unknown (« acide mandélique »). */
export function ingredientKey(phrase) {
  const p = norm(phrase);
  return KEY_OF.get(p) ?? KEY_OF.get(p.replace(/_/g, ' ')) ?? p;
}

/** Every word an exclusion stands for, to look for in a product's text. */
export function ingredientWords(value) {
  const key = ingredientKey(value);
  return GROUPS[key] ?? [norm(value)];
}
