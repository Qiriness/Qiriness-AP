/** The locale and `t()` for Server Components. Server-only: reads the cookie. */

import { cookies } from "next/headers";
import { DICTIONARIES, SOURCE_DICTIONARY } from "./dictionaries";
import { LOCALE_COOKIE, resolveLocale, type Locale } from "./locales";
import { makeInsightsFormat, type InsightsFormat } from "../insights-format";
import { makeTranslate, type Translate } from "./translate";

export function getLocale(): Locale {
  return resolveLocale(cookies().get(LOCALE_COOKIE)?.value);
}

export function getT(locale: Locale = getLocale()): Translate {
  return makeTranslate(locale, DICTIONARIES[locale], SOURCE_DICTIONARY);
}

/** The Insights formatters bound to the request's language, for Server Components. */
export function getFormat(locale: Locale = getLocale()): InsightsFormat {
  return makeInsightsFormat(locale, getT(locale));
}
