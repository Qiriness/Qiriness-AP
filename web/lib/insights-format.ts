/**
 * Isomorphic formatting for the Insights panels — the same file in the services
 * that map the rows, the server components that render tiles, and the client
 * charts that render tooltips, so a quantity cannot be printed two ways on one
 * screen.
 *
 * Every function takes the UI locale (`fr` | `en`, default `fr`). The default is
 * what an unconverted caller (the Orders list prints euros through here) gets.
 *
 * Pure: no Supabase import, nothing server-only. Keep it that way — the reads
 * live in lib/server/insights/.
 */

import type { Locale } from "./i18n/locales";
import type { Translate } from "./i18n/translate";
import { intlTag } from "./i18n/locales";
import type { ValueUnit } from "./types";

/** `2026-07-01` -> `Jul 2026` / `juil. 2026`. Month keys are dates, so they also sort as strings. */
export function formatMonth(month: string, locale: Locale = "fr"): string {
  const parsed = new Date(`${month.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return month;
  return parsed.toLocaleDateString(intlTag(locale), { month: "short", year: "numeric", timeZone: "UTC" });
}

/** How long ago, in the words a staleness banner needs. */
export function agoInDays(iso: string, now: Date = new Date()): number | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

export function formatAge(iso: string, t: Translate, now: Date = new Date()): string {
  const days = agoInDays(iso, now);
  if (days === null) return t("insights.age.unknown");
  if (days === 0) return t("insights.age.today");
  if (days === 1) return t("insights.age.yesterday");
  return t("insights.age.days", { count: days, n: days });
}

// --- separators -----------------------------------------------------------------

/*
 * BUILT BY HAND, NOT BY `Intl`, WHERE A CLIENT COMPONENT PRINTS IT. Node and
 * Chrome ship different CLDR data: `toLocaleString` gave "58.4K" on the server
 * and "58.4k" in the browser, and fr-FR's group separator has moved between
 * U+00A0 and U+202F across versions. Any difference fails hydration and makes
 * React re-render the whole page on load. These produce the same characters
 * everywhere, for both languages.
 */
const NBSP = " ";

function groupSeparator(locale: Locale): string {
  return locale === "fr" ? NBSP : ",";
}

function decimalSeparator(locale: Locale): string {
  return locale === "fr" ? "," : ".";
}

/** Digits grouped in threes with `separator`. */
function grouped(integer: number, separator: string): string {
  return String(Math.abs(Math.trunc(integer))).replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/** `value` to `digits` decimals with the locale's separators, sign included. */
function fixed(value: number, digits: number, locale: Locale): string {
  const factor = 10 ** digits;
  const rounded = Math.round(Math.abs(value) * factor) / factor;
  const whole = grouped(Math.floor(rounded), groupSeparator(locale));
  const fraction = digits > 0 ? String(Math.round((rounded - Math.floor(rounded)) * factor)).padStart(digits, "0") : "";
  const sign = value < 0 && rounded !== 0 ? "−" : "";
  return `${sign}${whole}${digits > 0 ? decimalSeparator(locale) + fraction : ""}`;
}

/** A plain quantity: `1 234` / `1,234`. */
export function integer(value: number, locale: Locale = "fr"): string {
  return fixed(Math.round(value), 0, locale);
}

/** A quantity to `digits` decimals. */
export function decimal(value: number, digits: number, locale: Locale = "fr"): string {
  return fixed(value, digits, locale);
}

// --- quantities ---------------------------------------------------------------

/** An hours figure, at the precision the number deserves. Past two days, in days. */
export function hours(value: number | null, locale: Locale = "fr"): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const dayUnit = locale === "fr" ? "j" : "d";
  if (value >= 48) return `${fixed(value / 24, 1, locale)} ${dayUnit}`;
  if (value >= 10) return `${fixed(Math.round(value), 0, locale)} h`;
  return `${fixed(value, 1, locale)} h`;
}

export function percent(part: number, whole: number, digits = 1, locale: Locale = "fr"): string {
  if (!whole) return "—";
  return percentOf((part / whole) * 100, digits, locale);
}

/** A percentage that is already a percentage: `12,3 %` / `12.3%`. */
export function percentOf(value: number, digits = 1, locale: Locale = "fr"): string {
  return `${fixed(value, digits, locale)}${locale === "fr" ? NBSP : ""}%`;
}

/**
 * Text folded for a search match: lower case, accents removed, spaces collapsed.
 * `"  Crème  Légère"` -> `"creme legere"`. The catalogue is French, so a search
 * box that is not accent-insensitive misses what people type.
 */
export function foldForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Euros as the reader expects them: `16 375,77 €` in French, `€16,375.77` in English. */
export function euros(
  value: number | null,
  { cents = false }: { cents?: boolean } = {},
  locale: Locale = "fr"
): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const text = fixed(cents ? Math.round(value * 100) / 100 : Math.round(value), cents ? 2 : 0, locale);
  const negative = text.startsWith("−");
  const body = negative ? text.slice(1) : text;
  const sign = negative ? "−" : "";
  return locale === "fr" ? `${sign}${body}${NBSP}€` : `${sign}€${body}`;
}

/**
 * A dollar figure that stays honest at both ends: agent spend is fractions of a
 * cent per call and could be hundreds a month, and `$0.00` for a real cost is
 * the same lie as a zero on a tile.
 */
export function usd(value: number | null, locale: Locale = "fr"): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.01) return locale === "fr" ? `<0,01${NBSP}$` : "<$0.01";
  const body = fixed(value, 2, locale);
  return locale === "fr" ? `${body}${NBSP}$` : `$${body}`;
}

/** `1,234` below ten thousand, `58.4k` / `2.1M` above. Hand-built for the reason above. */
export function compactNumber(value: number, locale: Locale = "fr"): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  const gap = locale === "fr" ? NBSP : "";
  if (abs >= 1_000_000) return `${sign}${trimZero(fixed(abs / 1_000_000, 1, locale), locale)}${gap}M`;
  if (abs >= 10_000) return `${sign}${trimZero(fixed(abs / 1_000, 1, locale), locale)}${gap}k`;
  return `${sign}${grouped(Math.round(abs), groupSeparator(locale))}`;
}

function trimZero(text: string, locale: Locale): string {
  const zero = `${decimalSeparator(locale)}0`;
  return text.endsWith(zero) ? text.slice(0, -2) : text;
}

/** One value in its unit — what charts and tooltips call, because they are handed a unit, not a function. */
export function formatValue(unit: ValueUnit, value: number | null, locale: Locale = "fr"): string {
  if (value === null || !Number.isFinite(value)) return "—";
  switch (unit) {
    case "euro":
      return euros(value, {}, locale);
    case "hours":
      return hours(value, locale);
    case "percent":
      return percentOf(value, 1, locale);
    case "usd":
      return usd(value, locale);
    case "tokens":
      return compactNumber(Math.round(value), locale);
    default:
      return integer(value, locale);
  }
}

/** An axis tick: shorter than a tooltip value, since there are several side by side. */
export function formatTick(unit: ValueUnit, value: number, locale: Locale = "fr"): string {
  switch (unit) {
    case "euro":
      if (value >= 1000) {
        const thousands = trimZero(fixed(value / 1000, 1, locale), locale);
        return locale === "fr" ? `${thousands}${NBSP}k€` : `€${thousands}k`;
      }
      return locale === "fr" ? `${integer(value, locale)}${NBSP}€` : `€${integer(value, locale)}`;
    case "usd":
      if (value >= 1) return locale === "fr" ? `${integer(value, locale)}${NBSP}$` : `$${integer(value, locale)}`;
      return locale === "fr" ? `${fixed(value, 2, locale)}${NBSP}$` : `$${fixed(value, 2, locale)}`;
    case "hours":
      return `${integer(value, locale)} h`;
    case "percent":
      return `${integer(value, locale)}${locale === "fr" ? NBSP : ""}%`;
    case "tokens":
      return compactNumber(value, locale);
    default:
      return integer(value, locale);
  }
}

/**
 * Every formatter above with the locale (and, for ages, the translator) already
 * applied — what `useFormat()` and `getFormat()` hand a component, so a call
 * site reads `euros(x)` and cannot forget the language.
 */
export function makeInsightsFormat(locale: Locale, t: Translate) {
  return {
    locale,
    month: (month: string) => formatMonth(month, locale),
    age: (iso: string, now?: Date) => formatAge(iso, t, now),
    integer: (value: number) => integer(value, locale),
    decimal: (value: number, digits: number) => decimal(value, digits, locale),
    hours: (value: number | null) => hours(value, locale),
    percent: (part: number, whole: number, digits = 1) => percent(part, whole, digits, locale),
    percentOf: (value: number, digits = 1) => percentOf(value, digits, locale),
    euros: (value: number | null, options: { cents?: boolean } = {}) => euros(value, options, locale),
    usd: (value: number | null) => usd(value, locale),
    compactNumber: (value: number) => compactNumber(value, locale),
    value: (unit: ValueUnit, value: number | null) => formatValue(unit, value, locale),
    tick: (unit: ValueUnit, value: number) => formatTick(unit, value, locale),
  };
}

export type InsightsFormat = ReturnType<typeof makeInsightsFormat>;
