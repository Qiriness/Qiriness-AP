import assert from 'node:assert/strict';
import test from 'node:test';

import { createInvestigationStack } from './create-investigation.mjs';

/**
 * A smoke test over the WIRING, which had none.
 *
 * This module builds the stack the worker and the CLI both use, and it is pure
 * assembly — so nothing here asserts behaviour. It exists because a refactor
 * deleted `const { investigate } = createInvestigator(...)` and both suites
 * stayed green: 1 520 tests and 916 tests, none of which construct the stack.
 * The failure surfaced only when a real investigation was run by hand.
 *
 * No network: `config.openaiApiKey` is the only thing the factory needs before
 * it constructs, and every client it builds is lazy.
 */
const CONFIG = {
  openaiApiKey: 'test-key',
  investigatorModel: 'gpt-4o',
  investigationMaxToolCalls: 6,
  investigationMaxTurns: 4,
  decomposerModel: 'gpt-4o-mini',
  embeddingModel: 'text-embedding-3-small',
  embeddingDimensions: 1536
};

test('the stack exposes everything its callers destructure', () => {
  // `index.mjs` and `run-investigation.mjs` read all four. A missing one is a
  // TypeError on the first ticket of a real run, not at construction.
  const stack = createInvestigationStack({ supabase: {}, shopId: 'shop-1', config: CONFIG });

  for (const key of ['investigate', 'store', 'registry', 'retrieveExemplar', 'lastOrderLookup']) {
    assert.ok(stack[key], `the stack does not expose ${key}`);
  }
  assert.equal(typeof stack.investigate, 'function');
  assert.equal(typeof stack.lastOrderLookup, 'function');
  assert.equal(typeof stack.retrieveExemplar, 'function');
});

test('no OpenAI key means no stack at all, rather than a half-built one', () => {
  assert.equal(createInvestigationStack({ supabase: {}, shopId: 'shop-1', config: {} }), null);
});

test('the last-order lookup is not reachable as a tool', () => {
  // The model may call what the registry holds. A candidate order is a number it
  // would quote at a customer, so it must not be in there.
  const stack = createInvestigationStack({ supabase: {}, shopId: 'shop-1', config: CONFIG });
  const toolNames = Object.keys(stack.registry.schemasFor?.('order') ?? stack.registry ?? {});
  assert.ok(!toolNames.includes('lastOrder'));
  assert.ok(!toolNames.includes('lastOrderLookup'));
});
