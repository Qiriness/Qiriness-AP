/**
 * The words for a period, a bucket and a freshness line, in the reader's
 * language.
 *
 * WHY THIS IS HERE AND NOT IN `scripts/lib/insights-range.mjs`. That module
 * builds English labels ("Last 30 days", "previous 7 days", "Week of 3 Aug 2026")
 * for the worker's monthly report as well as for the dashboard, and the report is
 * a separate document. The range itself is structured (`preset`, `from`, `to`,
 * `grain`, `query`), so the dashboard rebuilds the words from that and leaves the
 * shared module alone.
 *
 * Isomorphic and pure. Names come from `Intl` (month and weekday names are the
 * same in Node and Chrome); numbers are digits only.
 */

import { intlTag, type Locale } from "./i18n/locales";
import type { Translate } from "./i18n/translate";
import type { FreshnessItem, Grain, InsightsRange } from "./types";

const DAY_MS = 86_400_000;

/** `2026-08-11T00:00:00` (a wall-clock key) as a UTC date. */
function fromKey(key: string): Date {
  return new Date(`${key.slice(0, 19)}Z`);
}

function names(date: Date, locale: Locale, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(intlTag(locale), { ...options, timeZone: "UTC" }).format(date);
}

/** `11 Sep 2026` / `11 sept. 2026`. */
export function formatDayL(date: Date, locale: Locale): string {
  return names(date, locale, { day: "numeric", month: "short", year: "numeric" });
}

/** `September 2026` / `septembre 2026`. */
export function monthLabelL(date: Date, locale: Locale): string {
  return names(date, locale, { month: "long", year: "numeric" });
}

const PRESETS = ["24h", "7d", "30d", "6m", "1y", "all"];

/** The period the panel is showing, as a pill reads it. */
export function rangeLabel(range: InsightsRange, t: Translate, locale: Locale): string {
  if (PRESETS.includes(range.preset)) return t(`insights.range.preset.${range.preset}`);
  if (range.preset === "month") return monthLabelL(fromKey(range.from), locale);
  const last = new Date(fromKey(range.to).getTime() - DAY_MS);
  return `${formatDayL(fromKey(range.from), locale)} – ${formatDayL(last, locale)}`;
}

/** What the period is compared against ("vs …" follows it). */
export function compareLabel(range: InsightsRange, t: Translate, locale: Locale): string {
  if (range.preset === "all") return t("insights.range.compare.none");
  if (range.preset === "month") {
    const previous = monthLabelL(fromKey(range.previous.from), locale);
    return fromKey(range.now) < fromKey(range.to) ? t("insights.range.compare.sameDays", { month: previous }) : previous;
  }
  if (range.preset === "custom") {
    const days = Math.round((fromKey(range.to).getTime() - fromKey(range.from).getTime()) / DAY_MS);
    return t("insights.range.compare.previousDays", { count: days, n: days });
  }
  return t("insights.range.compare.previous", { span: t(`insights.range.short.${range.preset}`) });
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The axis label for one bucket. */
export function bucketLabelL(key: string, grain: Grain, locale: Locale): string {
  const d = fromKey(key);
  if (grain === "hour") return `${pad(d.getUTCHours())}:00`;
  if (grain === "month") return `${names(d, locale, { month: "short" })} ${String(d.getUTCFullYear()).slice(2)}`;
  return `${d.getUTCDate()} ${names(d, locale, { month: "short" })}`;
}

/** The tooltip label for one bucket: says what span the point covers. */
export function bucketTitleL(key: string, grain: Grain, t: Translate, locale: Locale): string {
  const d = fromKey(key);
  if (grain === "hour") return `${formatDayL(d, locale)}, ${pad(d.getUTCHours())}:00–${pad((d.getUTCHours() + 1) % 24)}:00`;
  if (grain === "day") return `${names(d, locale, { weekday: "short" })} ${formatDayL(d, locale)}`;
  if (grain === "week") return t("insights.range.weekOf", { day: formatDayL(d, locale) });
  return monthLabelL(d, locale);
}

/** A series point's axis label and tooltip title in the reader's language (the point's own English when it carries no grain). */
export function pointWords(
  point: { key: string; label: string; title: string; grain?: Grain },
  t: Translate,
  locale: Locale
): { label: string; title: string } {
  return point.grain
    ? { label: bucketLabelL(point.key, point.grain, locale), title: bucketTitleL(point.key, point.grain, t, locale) }
    : { label: point.label, title: point.title };
}

/** "3 h ago" and friends, from an instant; the words of `formatAgo` in the shared module. */
export function agoText(iso: string | null, t: Translate, now: Date = new Date()): string {
  if (!iso) return t("insights.ago.never");
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return t("insights.ago.unknown");
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60_000));
  if (minutes < 2) return t("insights.ago.now");
  if (minutes < 60) return t("insights.ago.minutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 36) return t("insights.ago.hours", { n: hours });
  return t("insights.ago.days", { count: Math.round(hours / 24), n: Math.round(hours / 24) });
}

/** A country's name in the reader's language from its ISO code; the data's own label when the code is not a region. */
export function countryName(code: string, fallback: string, locale: Locale): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return fallback;
  try {
    return new Intl.DisplayNames(intlTag(locale), { type: "region" }).of(code.toUpperCase()) ?? fallback;
  } catch {
    return fallback;
  }
}

const FRESHNESS_LABELS = ["orders", "mail", "sync", "topics"];
const FRESHNESS_CODES = ["synced", "never", "lastMessage", "stuck", "running", "failed", "built"];

/** A freshness item's label and sentence in the reader's language; the server's English stands when a code is unknown. */
export function freshnessLine(item: FreshnessItem, t: Translate, now: Date = new Date()): { label: string; text: string } {
  const label = FRESHNESS_LABELS.includes(item.id) ? t(`insights.freshness.label.${item.id}`) : item.label;
  const text =
    item.code && FRESHNESS_CODES.includes(item.code)
      ? t(`insights.freshness.text.${item.code}`, { ago: agoText(item.at, t, now) })
      : item.text;
  return { label, text };
}
