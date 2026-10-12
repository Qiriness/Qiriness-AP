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

const GROUPS = {
  fragrance: ['parfum', 'parfums', 'fragrance', 'fragrances', 'perfume'],
  alcohol: ['alcool', 'alcohol'],
  retinol: ['retinol'],
  essential_oils: ['huiles essentielles', 'huile essentielle', 'essential oils', 'essential oil'],
  oil: ['huile', 'huiles', 'oil', 'oils'],
  silicones: ['silicone', 'silicones'],
  sulfates: ['sulfate', 'sulfates', 'sulphate', 'sulphates'],
  parabens: ['paraben', 'parabens', 'parabene', 'parabenes'],
  niacinamide: ['niacinamide'],
  vitamin_c: ['vitamine c', 'vitamin c'],
  salicylic_acid: ['acide salicylique', 'salicylic acid'],
  glycolic_acid: ['acide glycolique', 'glycolic acid'],
  hyaluronic_acid: ['acide hyaluronique', 'hyaluronic acid'],
  lactic_acid: ['acide lactique', 'lactic acid'],
  azelaic_acid: ['acide azelaique', 'azelaic acid']
};

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
