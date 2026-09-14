/**
 * What a thousand tokens costs, and nothing else.
 *
 * WHY MONEY IS NOT STORED. `llm_usage` holds token counts (see 06_analytics.sql).
 * Rates change and models get swapped, and a euro figure written into a row is
 * wrong the day the rate card moves with no way to restate the history behind
 * it. So the tokens are the record and the price is applied at read time, by
 * this module, wherever the figure is being shown.
 *
 * IT LIVES IN `scripts/lib` because it has three readers — the agent worker, the
 * report scripts and the dashboard — and `web/` cannot import from `agent/src`.
 *
 * THE PRICES BELOW ARE NOT AUTHORITATIVE. They are the published list prices at
 * the time this was written, recorded so the panel has a number instead of a
 * blank. VERIFY AGAINST CURRENT OPENAI PRICING before treating any figure this
 * produces as a real spend, and override them with `LLM_RATES` rather than
 * editing this file when they move — that keeps the correction in the same place
 * as the rest of the deployment's configuration.
 */

/** Prices are per MILLION tokens, in USD — the unit OpenAI publishes. */
export const RATE_UNIT_TOKENS = 1_000_000;

/**
 * VERIFY AGAINST CURRENT OPENAI PRICING.
 *
 * Only the three models this project actually calls (see agent/src/config.mjs):
 * the triage and categorisation tier, the investigation tier, and the embedding
 * model. A model absent from this table is not free — see `estimateCost`.
 */
export const DEFAULT_MODEL_RATES = Object.freeze({
  // Investigation tier.
  'gpt-4o': { input: 2.5, output: 10 },
  // Spam gate, categoriser, decomposer.
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  // The management chat on Home (CHAT_MODEL's default). Standard tier, read from
  // developers.openai.com/api/docs/pricing on 2026-09-14. The only entry with a
  // cached rate: the chat's prompt is mostly cached, so pricing it at the full
  // input rate would overstate a conversation several times over.
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14 },
  // Embeddings have no completion half, so `output` is 0 rather than absent —
  // an absent field would read as "unpriced" in `estimateCost`, which is a
  // different statement from "this model cannot produce output tokens".
  'text-embedding-3-small': { input: 0.02, output: 0 }
});

/**
 * The rate table with any environment override merged over it.
 *
 * ONE VARIABLE, NOT TWO PER MODEL. `LLM_RATES` is a JSON object of
 * `{"model": {"input": <usd per 1M>, "output": <usd per 1M>}}`, because the set
 * of models is itself configuration (`AGENT_INVESTIGATOR_MODEL` and friends) and
 * a per-model variable name cannot be written down in advance for a model
 * nobody has chosen yet.
 *
 * Merged per model, not per field: a partial entry that specified only `input`
 * would silently keep the old `output` price, which is exactly the half-updated
 * rate card this override exists to prevent.
 *
 * MALFORMED JSON FALLS BACK TO THE DEFAULTS rather than throwing. This is read
 * on a dashboard render; a typo in an env var must not take the page down.
 */
export function resolveModelRates(env = process.env) {
  const raw = env?.LLM_RATES;
  if (!raw) {
    return DEFAULT_MODEL_RATES;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_MODEL_RATES;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return DEFAULT_MODEL_RATES;
  }

  const rates = { ...DEFAULT_MODEL_RATES };
  for (const [model, rate] of Object.entries(parsed)) {
    if (!rate || typeof rate !== 'object') {
      continue;
    }
    rates[model] = {
      input: toRate(rate.input),
      output: toRate(rate.output),
      ...(rate.cachedInput !== undefined ? { cachedInput: toRate(rate.cachedInput) } : {})
    };
  }
  return rates;
}

/**
 * Resolved once at import, from the ambient environment.
 *
 * The agent and the sync scripts read `.env.local` through
 * `sync-config.mjs#loadEnv`, which `process.env` alone does not see — those
 * callers should pass their own env to `resolveModelRates` and hand the result
 * to `estimateCost`. Next populates `process.env` itself, so the dashboard can
 * use this as it stands.
 */
export const MODEL_RATES = resolveModelRates();

/**
 * What a call's tokens are worth. Pure: no clock, no env, no I/O.
 *
 * `rated: false` IS THE POINT OF THE RETURN SHAPE. An unpriced model costs 0
 * here, which is indistinguishable from a free call unless the caller is told
 * which it was — and a dashboard that reports a new model's spend as €0.00
 * because nobody added its rate is worse than one that says it does not know.
 *
 * @param {object} options
 * @param {string} options.model
 * @param {number} [options.inputTokens]
 * @param {number} [options.outputTokens]
 * @param {number} [options.cachedInputTokens]
 *   The part of `inputTokens` served from the prompt cache — a subset, never an
 *   addition. Billed at the model's `cachedInput` rate when it has one; a model
 *   without one bills them at the full input rate, exactly as before.
 * @param {object} [options.rates]  defaults to the ambient table.
 * @returns {{inputUsd: number, outputUsd: number, totalUsd: number, rated: boolean}}
 */
export function estimateCost({ model, inputTokens = 0, outputTokens = 0, cachedInputTokens = 0, rates = MODEL_RATES } = {}) {
  const rate = rates?.[model];
  if (!rate) {
    return { inputUsd: 0, outputUsd: 0, totalUsd: 0, rated: false };
  }

  const input = toTokens(inputTokens);
  const cached = Math.min(toTokens(cachedInputTokens), input);
  const cachedRate = rate.cachedInput === undefined ? toRate(rate.input) : toRate(rate.cachedInput);
  const inputUsd = ((input - cached) * toRate(rate.input) + cached * cachedRate) / RATE_UNIT_TOKENS;
  const outputUsd = (toTokens(outputTokens) * toRate(rate.output)) / RATE_UNIT_TOKENS;
  return {
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
    rated: true
  };
}

function toTokens(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toRate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
