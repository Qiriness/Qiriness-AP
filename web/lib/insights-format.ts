/**
 * Isomorphic formatting for the Insights panels — the same file in the services
 * that map the rows, the server components that render tiles, and the client
 * charts that render tooltips, so a quantity cannot be printed two ways on one
 * screen.
 *
 * Pure: no Supabase import, nothing server-only. Keep it that way — the reads
 * live in lib/server/insights/.
 */

import type { ValueUnit } from "./types";

/** `2026-07-01` -> `Jul 2026`. Month keys are dates, so they also sort as strings. */
export function formatMonth(month: string): string {
  const parsed = new Date(`${month.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return month;
  return parsed.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** How long ago, in the words a staleness banner needs. */
export function agoInDays(iso: string, now: Date = new Date()): number | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

export function formatAge(iso: string, now: Date = new Date()): string {
  const days = agoInDays(iso, now);
  if (days === null) return "unknown";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

// --- quantities ---------------------------------------------------------------

/** An hours figure, at the precision the number deserves. Past two days, in days. */
export function hours(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 48) return `${(value / 24).toFixed(1)} d`;
  if (value >= 10) return `${Math.round(value)} h`;
  return `${value.toFixed(1)} h`;
}

export function percent(part: number, whole: number, digits = 1): string {
  if (!whole) return "—";
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

/*
 * BUILT BY HAND, NOT BY `Intl`, WHERE A CLIENT COMPONENT PRINTS IT. Node and
 * Chrome ship different CLDR data: `toLocaleString` gave "58.4K" on the server
 * and "58.4k" in the browser, and fr-FR's group separator has moved between
 * U+00A0 and U+202F across versions. Any difference fails hydration and makes
 * React re-render the whole page on load. These two produce the same
 * characters everywhere.
 */

/** Digits grouped in threes with `separator`. */
function grouped(integer: number, separator: string): string {
  return String(Math.abs(Math.trunc(integer))).replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/**
 * Text folded for a search match: lower case, accents removed, spaces collapsed.
 * `"  Crème  Légère"` -> `"creme legere"`. The catalogue is French, so a search
 * box that is not accent-insensitive misses what people type.
 */
export function foldForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Euros as a French merchant reads them: `16 375,77 €`. */
export function euros(value: number | null, { cents = false }: { cents?: boolean } = {}): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const rounded = cents ? Math.round(value * 100) / 100 : Math.round(value);
  const sign = rounded < 0 ? "−" : "";
  const whole = grouped(Math.abs(rounded), " ");
  const fraction = cents ? `,${String(Math.round(Math.abs(rounded) * 100) % 100).padStart(2, "0")}` : "";
  return `${sign}${whole}${fraction} €`;
}

/**
 * A dollar figure that stays honest at both ends: agent spend is fractions of a
 * cent per call and could be hundreds a month, and `$0.00` for a real cost is
 * the same lie as a zero on a tile.
 */
export function usd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.01) return "<$0.01";
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** `1,234` below ten thousand, `58.4k` / `2.1M` above. Hand-built for the reason above. */
export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}${trimZero((abs / 1_000_000).toFixed(1))}M`;
  if (abs >= 10_000) return `${sign}${trimZero((abs / 1_000).toFixed(1))}k`;
  return `${sign}${grouped(Math.round(abs), ",")}`;
}

function trimZero(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/** One value in its unit — what charts and tooltips call, because they are handed a unit, not a function. */
export function formatValue(unit: ValueUnit, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  switch (unit) {
    case "euro":
      return euros(value);
    case "hours":
      return hours(value);
    case "percent":
      return `${value.toFixed(1)}%`;
    case "usd":
      return usd(value);
    case "tokens":
      return compactNumber(Math.round(value));
    default:
      return Math.round(value).toLocaleString("en-GB");
  }
}

/** An axis tick: shorter than a tooltip value, since there are several side by side. */
export function formatTick(unit: ValueUnit, value: number): string {
  switch (unit) {
    case "euro":
      return value >= 1000 ? `€${(value / 1000).toLocaleString("en-GB", { maximumFractionDigits: 1 })}k` : `€${value}`;
    case "usd":
      return value >= 1 ? `$${value.toLocaleString("en-GB", { maximumFractionDigits: 0 })}` : `$${value.toFixed(2)}`;
    case "hours":
      return `${value} h`;
    case "percent":
      return `${value}%`;
    case "tokens":
      return compactNumber(value);
    default:
      return value.toLocaleString("en-GB");
  }
}
