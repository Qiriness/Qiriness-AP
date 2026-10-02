"use client";

import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { DEFAULT_LOCALE, type Locale } from "./locales";
import { makeInsightsFormat, type InsightsFormat } from "../insights-format";
import { makeTranslate, type Dictionary, type Params, type Translate } from "./translate";
import { marketplaceList, shopLabel, useShop } from "../shop-context";

/**
 * The locale and its ONE dictionary. The server picks the dictionary and hands it
 * down, so the browser never downloads the other language (both used to be
 * bundled, about 40 kB). `fr.ts` is typed against `en.ts`, so the active
 * dictionary has every key and no fallback language is needed.
 */
const LocaleContext = createContext<{ locale: Locale; messages: Dictionary }>({ locale: DEFAULT_LOCALE, messages: {} });

/** Wraps the app once, in the root layout, with the locale the server resolved. */
export function I18nProvider({ locale, messages, children }: { locale: Locale; messages: Dictionary; children: ReactNode }) {
  const value = useMemo(() => ({ locale, messages }), [locale, messages]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext).locale;
}

export function useT(): Translate {
  const { locale, messages } = useContext(LocaleContext);
  // `{store}` in any string is the shop's name, `{marketplaces}` its
  // marketplaces' names (shop-context.tsx).
  const shop = useShop();
  const store = shopLabel(shop);
  const marketplaces = marketplaceList(shop, locale);
  return useMemo(
    () => makeTranslate(locale, messages, {}, { store, marketplaces }),
    [locale, messages, store, marketplaces]
  );
}

/** The Insights formatters bound to the UI language: `const { euros } = useFormat()`. */
export function useFormat(): InsightsFormat {
  const locale = useLocale();
  const t = useT();
  return useMemo(() => makeInsightsFormat(locale, t), [locale, t]);
}

/**
 * A translated string as a component, for the places a shared piece (the
 * Insights kit is rendered by Server and Client Components alike) has to say
 * something and cannot call `getT()` or `useT()`. A key that is not in the
 * dictionary prints as itself, which is how a server-built sentence such as a
 * blocked reason passes through untouched.
 */
export function Tx({ k, params }: { k: string; params?: Params }) {
  const t = useT();
  return <>{t(k, params)}</>;
}
