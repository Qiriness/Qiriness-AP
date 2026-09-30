/**
 * Locale-aware number, money, date and relative-time formatting.
 *
 * Every function takes the locale, so a quantity is printed one way on a given
 * screen and `en-GB` is no longer hard-coded across the views. Isomorphic; no
 * imports beyond the locale tag.
 */

import { intlTag, type Locale } from "./locales.ts";

export function formatNumber(value: number, locale: Locale, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlTag(locale), options).format(value);
}

export function formatMoney(value: number, currency: string, locale: Locale, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlTag(locale), { style: "currency", currency, ...options }).format(value);
}

export function formatPercent(fraction: number, locale: Locale, digits = 1): string {
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(fraction);
}

export function formatDate(
  value: string | Date,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "";
  return new Intl.DateTimeFormat(intlTag(locale), options).format(date);
}

/** `2026-07-01` -> `Jul 2026` / `juil. 2026`. Month keys are UTC dates. */
export function formatMonthKey(month: string, locale: Locale): string {
  const parsed = new Date(`${month.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return month;
  return new Intl.DateTimeFormat(intlTag(locale), { month: "short", year: "numeric", timeZone: "UTC" }).format(parsed);
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "3 days ago" / "il y a 3 jours"; under a minute reads "now" / "maintenant". */
export function formatRelative(iso: string, locale: Locale, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = then - now.getTime();
  const formatter = new Intl.RelativeTimeFormat(intlTag(locale), { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return formatter.format(Math.trunc(diff / size), unit);
  }
  return formatter.format(0, "second");
}
