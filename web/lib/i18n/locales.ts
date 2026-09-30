/**
 * Which languages the dashboard speaks, and how one is chosen.
 *
 * The UI language is a per-person preference and is NOT the customer's
 * language: drafts, acknowledgements and everything the agent writes keep
 * following the customer. Pure and isomorphic; no imports, so `node --test`
 * can load it.
 */

export const SUPPORTED_LOCALES = ["fr", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** French: the team's working language, and what a person who never chose gets. */
export const DEFAULT_LOCALE: Locale = "fr";

/** Cookie the server components read; mirrored to the account's `user_metadata.locale`. */
export const LOCALE_COOKIE = "qos_lang";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** The saved choice if there is one, else the default. */
export function resolveLocale(saved: unknown): Locale {
  return isLocale(saved) ? saved : DEFAULT_LOCALE;
}

/** BCP 47 tag for `Intl`. French uses fr-FR (1 234,50 €), English keeps en-GB (day first). */
export function intlTag(locale: Locale): string {
  return locale === "fr" ? "fr-FR" : "en-GB";
}
