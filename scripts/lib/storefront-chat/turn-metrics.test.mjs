import assert from 'node:assert/strict';
import test from 'node:test';

import { failureCode, intentOfTurn, shownProductIds, turnRecord } from './turn-metrics.mjs';

const base = { shopDomain: 'dev.myshopify.com', conversationId: '00000000-0000-4000-8000-000000000001', startedAt: '2026-10-30T10:00:00Z', latencyMs: 3200 };

test('an LLM turn: tokens, model time, cards and the discovery intent', () => {
  const row = turnRecord({
    ...base,
    reply: {
      model: 'gpt-6-luna',
      usage: { inputTokens: 8000, outputTokens: 120 },
      trace: { calls: [1800, 900], tools: [{ name: 'search_products', args: {}, found: 3 }] },
      products: [{ id: 'p1', url: '/products/a' }, { id: 'p2', url: '/products/b' }],
      advisor: { mode: 'conversation' },
    },
  });
  assert.equal(row.route, 'llm');
  assert.equal(row.status, 'answered');
  assert.equal(row.intent, 'product_discovery');
  assert.equal(row.model_calls, 2);
  assert.equal(row.model_ms, 2700);
  assert.equal(row.input_tokens, 8000);
  assert.deepEqual(row.product_ids, ['p1', 'p2']);
  assert.deepEqual(row.fallbacks, []);
  assert.equal(row.unanswered, false);
  assert.equal(row.escalated, false);
});

test('a turn the code answered is rule-based, and a builder question is routine building', () => {
  const row = turnRecord({ ...base, reply: { model: null, trace: { calls: [], tools: [], model_skipped: 'builder_question' }, products: [] } });
  assert.equal(row.route, 'rules');
  assert.equal(row.rule, 'builder_question');
  assert.equal(row.intent, 'routine_building');
  assert.equal(row.model_ms, null);
});

test('the mock agent has no trace and no model', () => {
  assert.equal(turnRecord({ ...base, reply: { text: 'Bonjour', products: [] } }).route, 'mock');
});

test('a failed turn keeps its code and is counted against the model', () => {
  const row = turnRecord({ ...base, error: { code: failureCode(new Error('no reply within 20000 ms')) } });
  assert.equal(row.status, 'failed');
  assert.equal(row.error_code, 'timeout');
  assert.equal(row.route, 'llm');
  assert.equal(failureCode(new Error('model call failed: 500')), 'model_error');
});

test('a policy question with nothing found is unanswered; a found one is not', () => {
  const missed = turnRecord({ ...base, reply: { model: 'm', trace: { calls: [900], tools: [{ name: 'search_faqs', status: 'not_found' }] } } });
  assert.equal(missed.intent, 'faq');
  assert.equal(missed.unanswered, true);
  const found = turnRecord({
    ...base,
    reply: { model: 'm', trace: { calls: [900], tools: [{ name: 'search_faqs', status: 'not_found' }, { name: 'get_policy', status: 'found' }] } },
  });
  assert.equal(found.unanswered, false);
});

test('an unavailable source and an exhausted tool loop are fallbacks; a failure is counted', () => {
  const row = turnRecord({
    ...base,
    reply: { model: 'm', trace: { calls: [800, 700, 600], tools: [{ name: 'get_cart_context', status: 'unavailable' }], advice: { reader: { status: 'read' } } } },
  });
  assert.deepEqual(row.fallbacks, ['source_unavailable', 'forced_answer', 'lexicon_backup']);
  assert.equal(row.tool_failures, 1);
  assert.equal(row.tool_calls, 1);
});

test('an order lookup or a contact link is customer service', () => {
  assert.equal(intentOfTurn({ trace: { tools: [{ name: 'get_order_status', status: 'on_the_way' }] } }), 'customer_service');
  const row = turnRecord({ ...base, reply: { model: 'm', trace: { calls: [500], tools: [] }, contact: { url: '/pages/contact' } } });
  assert.equal(row.escalated, true);
  assert.equal(row.intent, 'customer_service');
});

test('a repurchase opening or a purchase question is reordering', () => {
  assert.equal(intentOfTurn({ opening: true }), 'reordering');
  assert.equal(intentOfTurn({ trace: { model_skipped: 'purchase_question' } }), 'reordering');
  // The routine builder outranks it.
  assert.equal(intentOfTurn({ opening: true, mode: 'routine_builder' }), 'routine_building');
});

test('the products shown include follow-up and routine cards, once each', () => {
  const ids = shownProductIds({
    products: [{ id: 'a' }],
    followUp: { products: [{ id: 'b' }, { id: 'a' }] },
    routineView: { moments: [{ steps: [{ product_id: 'c' }, { product_id: 'b' }] }] },
  });
  assert.deepEqual(ids, ['a', 'b', 'c']);
});
