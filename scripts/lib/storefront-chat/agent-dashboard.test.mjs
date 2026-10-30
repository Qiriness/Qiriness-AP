import assert from 'node:assert/strict';
import test from 'node:test';

import { num, priceTokens, rate } from './agent-dashboard.mjs';

test('a rate over nothing is null, not zero', () => {
  assert.equal(rate(0, 0), null);
  assert.equal(rate(0, 4), 0);
  assert.equal(rate(1, 4), 0.25);
  assert.equal(num('12.50'), 12.5);
  assert.equal(num(null), null);
});

test('tokens are priced per model, by route and intent; an unknown model makes the figure a floor', () => {
  const rates = { cheap: { input: 1, output: 10 } };
  const priced = priceTokens(
    [
      { route: 'llm', intent: 'faq', model: 'cheap', input: 1_000_000, output: 100_000 },
      { route: 'llm', intent: 'routine_building', model: 'cheap', input: 500_000, output: 0 },
      { route: 'llm', intent: 'faq', model: 'mystery', input: 10, output: 10 },
    ],
    rates
  );
  assert.equal(priced.total, 2.5);
  assert.equal(priced.byRoute.llm, 2.5);
  assert.equal(priced.byIntent.faq, 2);
  assert.equal(priced.byIntent.routine_building, 0.5);
  assert.equal(priced.unpriced, true);
  assert.equal(priceTokens([{ route: 'llm', intent: 'faq', model: 'mystery', input: 1, output: 1 }], rates).total, null);
});
