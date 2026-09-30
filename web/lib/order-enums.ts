/**
 * Shopify's status words in the reader's language.
 *
 * The order services word each status once, in English, from Shopify's ENUM
 * (`PARTIALLY_FULFILLED` -> "Partially fulfilled") and ship only that label. The
 * label maps back to its key, so the screen can translate it without the
 * services changing: `orderEnum.<KEY>` for Shopify's own statuses, the shared
 * `status.*` keys for ticket states, and the label itself when neither knows it
 * (a status Shopify adds later prints as it came, not as a blank).
 *
 * Pure and isomorphic.
 */

import type { Translate } from "./i18n/translate";

function keyOf(label: string): string {
  return label.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

export function enumText(t: Translate, label: string | null | undefined, group = "orderEnum"): string {
  if (!label) return "";
  const key = keyOf(label);
  for (const path of [`${group}.${key}`, `status.${key.toLowerCase()}`]) {
    const text = t(path);
    if (text !== path) return text;
  }
  return label;
}
