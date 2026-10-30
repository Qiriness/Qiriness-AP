/**
 * The arithmetic the Storefront Agent dashboard does on `storefront_agent_dashboard`'s
 * document: rates rebuilt from counts, tokens priced at read time. Pure.
 *
 * A RATE OVER NOTHING IS NULL, not 0: « no conversation was resolved » and « there
 * was no conversation » are different statements, and only the first is a zero.
 */

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
