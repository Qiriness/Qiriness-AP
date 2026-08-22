import assert from 'node:assert/strict';
import test from 'node:test';

import { STEPS, createTrace, createTraceUsageSink, toolEntry, traceOpenAI } from './trace.mjs';

// --- the step stream ----------------------------------------------------------

test('an unknown step is a failure, not a step nobody renders', () => {
  const trace = createTrace();
  assert.throws(() => trace.step('drafting'), /Unknown trace step: drafting/);
  assert.deepEqual(trace.events, []);
});

test('every step carries its type and a stamp', () => {
  const trace = createTrace({ now: () => new Date('2026-08-22T10:00:00Z') });
  trace.step('categorise', { category: 'delivery' });
  assert.deepEqual(trace.events, [
    { type: 'categorise', at: '2026-08-22T10:00:00.000Z', category: 'delivery' }
  ]);
});

test('the step vocabulary is the pipeline, in order', () => {
  assert.ok(STEPS.includes('gate'));
  assert.ok(STEPS.indexOf('categorise') < STEPS.indexOf('case_file'));
  assert.ok(STEPS.indexOf('case_file') < STEPS.indexOf('draft'));
});

// --- cost ---------------------------------------------------------------------

test('tokens are totalled onto the run, not written to llm_usage', () => {
  // A rehearsal spends real money and none of it is the cost of handling the
  // mailbox — the only question llm_usage answers.
  const trace = createTrace();
  const sink = createTraceUsageSink(trace);
  sink.record({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  sink.record({ usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } });

  assert.deepEqual(trace.tokens, { input: 140, output: 30, total: 170, calls: 2 });
  // Same interface as the real sink, and it never hands anything to a writer.
  assert.deepEqual(sink.drain(), []);
});

test('a call with no usage object still counts as a call', () => {
  const trace = createTrace();
  createTraceUsageSink(trace).record({});
  assert.equal(trace.tokens.calls, 1);
  assert.equal(trace.tokens.total, 0);
});

// --- the OpenAI decorator -----------------------------------------------------

const fakeClient = {
  async completeJson() {
    return { category: 'delivery' };
  },
  async completeWithTools() {
    return { content: null, toolCalls: [{ id: '1', name: 'searchKnowledge', args: {} }] };
  }
};

test('it records what was sent, and returns what the client returned', async () => {
  const openai = traceOpenAI(fakeClient);
  const result = await openai.completeJson({
    model: 'gpt-4o-mini',
    system: 'tu es',
    user: 'bonjour',
    pass: 'categorise'
  });

  assert.deepEqual(result, { category: 'delivery' }, 'transparent to the caller');
  assert.equal(openai.calls.length, 1);
  assert.equal(openai.calls[0].pass, 'categorise');
  assert.equal(openai.calls[0].system, 'tu es');
  assert.deepEqual(openai.calls[0].messages, [{ role: 'user', content: 'bonjour' }]);
  assert.match(openai.calls[0].response, /delivery/);
});

test('a failed call is recorded and then rethrown', async () => {
  // A pass's own failure handling is part of what a rehearsal shows, so the
  // decorator must not swallow anything.
  const openai = traceOpenAI({
    async completeJson() {
      throw new Error('rate limited');
    }
  });
  await assert.rejects(() => openai.completeJson({ pass: 'draft', user: 'x' }), /rate limited/);
  assert.equal(openai.calls[0].failed, true);
  assert.equal(openai.calls[0].error, 'rate limited');
});

test('a tool turn records the tools offered, by name', async () => {
  const openai = traceOpenAI(fakeClient);
  await openai.completeWithTools({
    model: 'gpt-4o',
    system: 's',
    messages: [{ role: 'user', content: 'q' }],
    tools: [{ function: { name: 'searchKnowledge' } }, { function: { name: 'lookupProduct' } }],
    pass: 'investigate'
  });
  assert.deepEqual(openai.calls[0].tools, ['searchKnowledge', 'lookupProduct']);
  assert.equal(openai.calls[0].response, '→ searchKnowledge');
});

test('calls can be attributed to the pass that made them', async () => {
  const openai = traceOpenAI(fakeClient);
  await openai.completeJson({ pass: 'categorise', user: 'a' });
  await openai.completeJson({ pass: 'draft', user: 'b' });
  assert.equal(openai.callsFor('draft').length, 1);
  assert.equal(openai.callsFor('draft')[0].messages[0].content, 'b');
});

test('a very long prompt is capped rather than stored whole', async () => {
  const openai = traceOpenAI(fakeClient, { maxChars: 10 });
  await openai.completeJson({ pass: 'draft', user: 'x'.repeat(50) });
  assert.match(openai.calls[0].messages[0].content, /more characters\]$/);
});

// --- what a tool result is allowed to carry -----------------------------------

test('the exact text the model was handed travels whole', () => {
  // The point of the whole feature: `promptText` is what the model read.
  const entry = toolEntry({
    id: 't1',
    tool: 'searchKnowledge',
    outcome: 'answerable',
    caveats: [],
    promptText: '### Retours\nVous disposez de 14 jours.',
    data: {}
  });
  assert.equal(entry.promptText, '### Retours\nVous disposez de 14 jours.');
  assert.equal(entry.id, 't1');
});

test('`data` is reduced by an allow-list, so a new tool field is not stored by accident', () => {
  const entry = toolEntry({
    id: 't2',
    tool: 'lookupCustomer',
    outcome: 'found',
    promptText: '…',
    data: {
      profile: { name: 'Marie', ordersCount: 3 },
      // Anything not named in `detailOf` must not appear in a stored trace.
      secretNewColumn: 'street address, phone number'
    }
  });
  assert.deepEqual(entry.detail.customer, { name: 'Marie', ordersCount: 3 });
  assert.equal(entry.detail.secretNewColumn, undefined);
});

test('the whole knowledge ranking survives, because the article check needs it', () => {
  // Truncating this would turn an outranked article into a missing one.
  const candidates = Array.from({ length: 9 }, (_, i) => ({
    chunkId: `c${i}`,
    documentId: `d${i}`,
    title: `Article ${i}`,
    similarity: 0.7 - i / 100
  }));
  const entry = toolEntry({
    id: 't3',
    tool: 'searchKnowledge',
    outcome: 'answerable',
    promptText: '…',
    data: { verdict: 'answerable', bestSimilarity: 0.7, chunks: [], candidates }
  });
  assert.equal(entry.detail.candidates.length, 9);
  assert.equal(entry.detail.candidates[0].chunkId, 'c0');
  assert.equal(entry.detail.verdict, 'answerable');
});

test('an opening move is distinguishable from something the model asked for', () => {
  // "The model never looked it up" and "we looked it up before asking" are
  // different readings of the same ledger.
  assert.equal(toolEntry({ id: 't1', tool: 'x', source: 'opening_move' }).source, 'opening_move');
  assert.equal(toolEntry({ id: 't1', tool: 'x' }).source, 'model');
});
