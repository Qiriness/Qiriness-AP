/**
 * The lookup itself: a key, optional `{name}` params, optional plural count.
 *
 * `en.ts` owns the keys; `fr.ts` is typed against them, so a missing French
 * string is a compile error rather than an English word on a French screen.
 * Plurals are `key_one` / `key_other` pairs resolved with `Intl.PluralRules`
 * (French treats 0 as singular). Pure, no imports beyond types.
 */

import { intlTag, type Locale } from "./locales.ts";

export type Dictionary = Record<string, string>;
export type Params = Record<string, string | number>;
export type Translate = (key: string, params?: Params) => string;

export function makeTranslate(locale: Locale, dictionary: Dictionary, fallback: Dictionary): Translate {
  const rules = new Intl.PluralRules(intlTag(locale));
  const formatter = new Intl.NumberFormat(intlTag(locale));
  return (key, params) => {
    let template: string | undefined;
    if (params && typeof params.count === "number") {
      const form = rules.select(params.count);
      const plural = form === "one" ? "one" : "other";
      template = dictionary[`${key}_${plural}`] ?? fallback[`${key}_${plural}`];
    }
    template ??= dictionary[key] ?? fallback[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = params[name];
      if (value === undefined) return whole;
      return typeof value === "number" ? formatter.format(value) : value;
    });
  };
}
