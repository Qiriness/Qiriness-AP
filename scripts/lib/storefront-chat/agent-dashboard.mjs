/**
 * The arithmetic the Storefront Agent dashboard does on `storefront_agent_dashboard`'s
 * document: rates rebuilt from counts, tokens priced at read time. Pure.
 *
 * A RATE OVER NOTHING IS NULL, not 0: « no conversation was resolved » and « there
 * was no conversation » are different statements, and only the first is a zero.
 */

import { localized } from '../i18n/languages.mjs';
import { estimateCost } from '../llm-rates.mjs';

/** part / whole, or null when there is no whole. */
export function rate(part, whole) {
  const p = Number(part);
  const w = Number(whole);
  return Number.isFinite(p) && Number.isFinite(w) && w > 0 ? p / w : null;
}

/** A Postgres numeric (a string over the wire) or null. */
export function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The cost of the tokens rows (`{ route, intent, model, input, output }`), in
 * total, by route and by intent. `unpriced`: some model has no rate, so every
 * figure is a floor; a figure made only of unpriced models is null.
 *
 * @param {{ route: string, intent: string, model: string, input: number, output: number }[]} rows
 * @param {object} [rates]  llm-rates' table; the ambient one by default.
 * @returns {{ total: number | null, byRoute: Record<string, number>, byIntent: Record<string, number>, unpriced: boolean }}
 */
export function priceTokens(rows, rates) {
  const out = { total: null, byRoute: {}, byIntent: {}, unpriced: false };
  const add = (bucket, key, usd) => {
    bucket[key] = (bucket[key] ?? 0) + usd;
  };
  for (const row of rows ?? []) {
    const cost = estimateCost({ model: row.model, inputTokens: num(row.input) ?? 0, outputTokens: num(row.output) ?? 0, ...(rates ? { rates } : {}) });
    if (!cost.rated) {
      out.unpriced = true;
      continue;
    }
    out.total = (out.total ?? 0) + cost.totalUsd;
    add(out.byRoute, row.route, cost.totalUsd);
    add(out.byIntent, row.intent, cost.totalUsd);
  }
  return out;
}

/** The routine answers the dashboard charts, in the page's order. */
export const ROUTINE_FIELDS = ['main_concern', 'skin_type', 'age_band', 'routine_time'];

/**
 * `storefront_agent_routine_profile`'s document, each answer named in `lang`
 * from the shop's own labels (its Rules tab). A code the shop never labelled
 * keeps a null label (the page shows the code); a null code is an answer not
 * given (the eye routine asks no skin type), its label null too.
 *
 * @param {object | null} raw
 * @param {string} lang
 * @returns {{ total: number, charts: { field: string, slices: { code: string | null, label: string | null, routines: number }[] }[] }}
 */
export function routineProfile(raw, lang) {
  const labels = raw?.labels ?? {};
  const byKey = (rows) => new Map((Array.isArray(rows) ? rows : []).map((row) => [row?.key, row]));
  const ages = byKey(labels.age_ranges);
  const times = byKey(labels.routine_times);
  const name = {
    main_concern: (code) => localized(labels.main?.[code], lang),
    skin_type: (code) => localized(labels.skin?.[code], lang),
    age_band: (code) => localized(ages.get(code), lang, { prefix: 'label_' }),
    routine_time: (code) => localized(times.get(code), lang, { prefix: 'label_' }),
  };
  return {
    total: num(raw?.total) ?? 0,
    charts: ROUTINE_FIELDS.map((field) => ({
      field,
      slices: (Array.isArray(raw?.[field]) ? raw[field] : []).map((row) => ({
        code: row.code ?? null,
        label: row.code === null || row.code === undefined ? null : name[field](row.code),
        routines: num(row.routines) ?? 0,
      })),
    })),
  };
}
