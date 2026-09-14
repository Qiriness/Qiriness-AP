import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MODEL_RATES,
  RATE_UNIT_TOKENS,
  estimateCost,
  resolveModelRates
} from './llm-rates.mjs';

const rates = DEFAULT_MODEL_RATES;

test('prices a call at the published per-million rate', () => {
  // 1M input on gpt-4o at 2.50, half a million output at 10.00.
  const cost = estimateCost({
    model: 'gpt-4o',
    inputTokens: RATE_UNIT_TOKENS,
    outputTokens: RATE_UNIT_TOKENS / 2,
    rates
  });

  assert.equal(cost.inputUsd, 2.5);
  assert.equal(cost.outputUsd, 5);
  assert.equal(cost.totalUsd, 7.5);
  assert.equal(cost.rated, true);
});

test('the cheap tier really is two orders of magnitude cheaper', () => {
  const mini = estimateCost({ model: 'gpt-4o-mini', inputTokens: 1_000_000, rates });
  const full = estimateCost({ model: 'gpt-4o', inputTokens: 1_000_000, rates });
  assert.ok(mini.totalUsd < full.totalUsd / 10, `${mini.totalUsd} vs ${full.totalUsd}`);
});

test('an embedding call has an input price and no output price', () => {
  const cost = estimateCost({
    model: 'text-embedding-3-small',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    rates
  });
  assert.equal(cost.inputUsd, 0.02);
  assert.equal(cost.outputUsd, 0, 'an embedding cannot produce output tokens');
  assert.equal(cost.rated, true);
});

test('an unpriced model reports that it is unpriced, not that it was free', () => {
  // The point of the return shape: €0.00 because nobody added a rate is worse
  // than a panel saying it does not know.
  const cost = estimateCost({ model: 'gpt-5-something', inputTokens: 10_000, rates });
  assert.equal(cost.totalUsd, 0);
  assert.equal(cost.rated, false);
});

test('zero and missing token counts cost nothing but stay rated', () => {
  const cost = estimateCost({ model: 'gpt-4o', rates });
  assert.equal(cost.totalUsd, 0);
  assert.equal(cost.rated, true);
});

test('negative and non-numeric token counts are floored at zero', () => {
  for (const inputTokens of [-100, 'many', NaN, null, undefined]) {
    const cost = estimateCost({ model: 'gpt-4o', inputTokens, rates });
    assert.equal(cost.inputUsd, 0, String(inputTokens));
  }
});

test('estimateCost is pure — no env, no clock, no defaults leaking in', () => {
  const custom = { 'my-model': { input: 1000, output: 2000 } };
  const cost = estimateCost({ model: 'my-model', inputTokens: 1_000_000, rates: custom });
  assert.equal(cost.inputUsd, 1000);
  // A model priced only in the ambient table must not resolve through a custom one.
  assert.equal(estimateCost({ model: 'gpt-4o', inputTokens: 1_000_000, rates: custom }).rated, false);
});

// --- the override ----------------------------------------------------------

test('no override returns the defaults unchanged', () => {
  assert.equal(resolveModelRates({}), DEFAULT_MODEL_RATES);
  assert.equal(resolveModelRates({ LLM_RATES: '' }), DEFAULT_MODEL_RATES);
});

test('LLM_RATES overrides one model and leaves the rest alone', () => {
  const resolved = resolveModelRates({
    LLM_RATES: JSON.stringify({ 'gpt-4o': { input: 1, output: 4 } })
  });
  assert.deepEqual(resolved['gpt-4o'], { input: 1, output: 4 });
  assert.deepEqual(resolved['gpt-4o-mini'], DEFAULT_MODEL_RATES['gpt-4o-mini']);
});

test('LLM_RATES can price a model the defaults have never heard of', () => {
  const resolved = resolveModelRates({ LLM_RATES: JSON.stringify({ 'new-model': { input: 3, output: 9 } }) });
  assert.equal(estimateCost({ model: 'new-model', inputTokens: 1_000_000, rates: resolved }).totalUsd, 3);
});

test('a half-specified override does not keep the old other half', () => {
  // The exact half-updated rate card this merge rule exists to prevent.
  const resolved = resolveModelRates({ LLM_RATES: JSON.stringify({ 'gpt-4o': { input: 1 } }) });
  assert.deepEqual(resolved['gpt-4o'], { input: 1, output: 0 });
});

test('malformed JSON falls back rather than taking the page down', () => {
  // This is read on a dashboard render.
  for (const raw of ['{not json', '[]', 'null', '"text"', '42']) {
    assert.equal(resolveModelRates({ LLM_RATES: raw }), DEFAULT_MODEL_RATES, raw);
  }
});

test('a non-object entry inside a valid override is skipped, not fatal', () => {
  const resolved = resolveModelRates({
    LLM_RATES: JSON.stringify({ 'gpt-4o': 'free', 'gpt-4o-mini': { input: 2, output: 3 } })
  });
  assert.deepEqual(resolved['gpt-4o'], DEFAULT_MODEL_RATES['gpt-4o']);
  assert.deepEqual(resolved['gpt-4o-mini'], { input: 2, output: 3 });
});

test('cached input is billed at the cached rate, and only where the model has one', () => {
  const custom = { cached: { input: 2, cachedInput: 0.2, output: 10 }, plain: { input: 2, output: 10 } };
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

  // Half a million at 2, half a million at 0.2.
  close(estimateCost({ model: 'cached', inputTokens: 1_000_000, cachedInputTokens: 500_000, rates: custom }).inputUsd, 1.1);
  // No cachedInput rate: the old arithmetic, unchanged.
  close(estimateCost({ model: 'plain', inputTokens: 1_000_000, cachedInputTokens: 500_000, rates: custom }).inputUsd, 2);
  // Cached is a subset of input, so it cannot exceed it.
  close(estimateCost({ model: 'cached', inputTokens: 100, cachedInputTokens: 1_000_000, rates: custom }).inputUsd, (100 * 0.2) / 1_000_000);
});

test('LLM_RATES carries a cached-input rate through when one is given', () => {
  const resolved = resolveModelRates({ LLM_RATES: '{"m": {"input": 1, "cachedInput": 0.1, "output": 8}}' });
  assert.deepEqual(resolved.m, { input: 1, output: 8, cachedInput: 0.1 });
});

test('the default table is frozen, so a caller cannot reprice it globally', () => {
  assert.ok(Object.isFrozen(DEFAULT_MODEL_RATES));
});

test('the defaults cover exactly the models the project calls', () => {
  // agent/src/config.mjs: triage + categoriser + decomposer on mini,
  // investigator on gpt-4o, embeddings on text-embedding-3-small; and the
  // management chat's default model (web/lib/server/chat-service.ts).
  assert.deepEqual(Object.keys(DEFAULT_MODEL_RATES).sort(), [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-5.2',
    'text-embedding-3-small'
  ]);
});
