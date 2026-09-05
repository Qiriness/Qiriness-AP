import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenAIClient } from './openai-client.mjs';
import { createUsageSink, noopUsageSink, USAGE_PASSES } from './usage-sink.mjs';

const at = () => new Date('2026-08-16T10:00:00.000Z');

// --- the buffer ------------------------------------------------------------

test('records the two halves and the total OpenAI reported', () => {
  const sink = createUsageSink({ now: at });
  sink.record({
    pass: 'categorise',
    model: 'gpt-4o-mini',
    ticketId: 't-1',
    usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 }
  });

  assert.deepEqual(sink.drain(), [
    {
      pass: 'categorise',
      model: 'gpt-4o-mini',
      ticketId: 't-1',
      inputTokens: 900,
      // Absent from the response, which is the ordinary case: nothing cached,
      // or a pass that has no prompt cache at all.
      cachedInputTokens: 0,
      outputTokens: 120,
      totalTokens: 1020,
      callCount: 1,
      succeeded: true,
      errorKind: null,
      occurredAt: '2026-08-16T10:00:00.000Z'
    }
  ]);
});

test('trusts the reported total over the sum of its halves', () => {
  // Cached and reasoning tokens are counted into `total_tokens` and into
  // neither half, so re-deriving the total would silently under-report them.
  const sink = createUsageSink({ now: at });
  sink.record({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 999 } });
  assert.equal(sink.drain()[0].totalTokens, 999);
});

test('falls back to the sum when no total was reported', () => {
  const sink = createUsageSink({ now: at });
  sink.record({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
  assert.equal(sink.drain()[0].totalTokens, 15);
});

test('accepts the embedding shape, which has no completion half', () => {
  const sink = createUsageSink({ now: at });
  sink.record({ pass: 'embed', usage: { prompt_tokens: 300, total_tokens: 300 } });

  const [entry] = sink.drain();
  assert.equal(entry.inputTokens, 300);
  assert.equal(entry.outputTokens, 0);
  assert.equal(entry.totalTokens, 300);
});

test('a failed call is a row, with no tokens and a classified reason', () => {
  // The ledger has to include what went wrong, or it under-reports exactly when
  // things are going wrong.
  const sink = createUsageSink({ now: at });
  sink.record({ pass: 'investigate', model: 'gpt-4o', usage: null, succeeded: false, errorKind: 'timeout' });

  const [entry] = sink.drain();
  assert.equal(entry.succeeded, false);
  assert.equal(entry.errorKind, 'timeout');
  assert.equal(entry.totalTokens, 0);
});

test('an unrecognised pass is recorded as other rather than failing the batch', () => {
  // The flush is a bulk insert against a CHECK constraint; one typo would take
  // the whole batch's cost history with it.
  const sink = createUsageSink({ now: at });
  sink.record({ pass: 'categorize' });
  assert.equal(sink.drain()[0].pass, 'other');
});

test('every accepted pass survives unchanged', () => {
  const sink = createUsageSink({ now: at });
  for (const pass of USAGE_PASSES) sink.record({ pass });
  assert.deepEqual(sink.drain().map((e) => e.pass), [...USAGE_PASSES]);
});

test('never throws on a malformed usage object', () => {
  const sink = createUsageSink({ now: at });
  for (const usage of [null, undefined, {}, 'nonsense', { prompt_tokens: -5 }, { prompt_tokens: 'x' }]) {
    assert.doesNotThrow(() => sink.record({ usage }));
  }
  for (const entry of sink.drain()) {
    assert.equal(entry.inputTokens, 0);
    assert.equal(entry.totalTokens, 0);
    assert.equal(entry.model, 'unknown');
  }
});

test('drain empties the buffer', () => {
  const sink = createUsageSink({ now: at });
  sink.record({});
  sink.record({});
  assert.equal(sink.size, 2);
  assert.equal(sink.drain().length, 2);
  assert.equal(sink.size, 0);
  assert.deepEqual(sink.drain(), []);
});

test('the no-op sink collects nothing and cannot be turned into one', () => {
  noopUsageSink.record({ pass: 'categorise', usage: { total_tokens: 10 } });
  assert.deepEqual(noopUsageSink.drain(), []);
  assert.ok(Object.isFrozen(noopUsageSink));
});

// --- the transport records through it --------------------------------------

function chatResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body
  };
}

const SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

test('completeJson reports the usage it used to discard', async () => {
  // The regression this whole module exists for: completeJson returns only the
  // parsed content, so before the sink nothing could see what it cost.
  const sink = createUsageSink({ now: at });
  const client = createOpenAIClient({
    apiKey: 'k',
    usageSink: sink,
    fetchImpl: async () =>
      chatResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 700, completion_tokens: 40, total_tokens: 740 }
      })
  });

  const result = await client.completeJson({
    model: 'gpt-4o-mini',
    user: 'hello',
    schema: SCHEMA,
    pass: 'categorise',
    ticketId: 't-9'
  });

  assert.deepEqual(result, { ok: true });
  const [entry] = sink.drain();
  assert.equal(entry.pass, 'categorise');
  assert.equal(entry.model, 'gpt-4o-mini');
  assert.equal(entry.ticketId, 't-9');
  assert.equal(entry.totalTokens, 740);
  assert.equal(entry.succeeded, true);
});

test('completeWithTools records too, and still returns usage to its caller', async () => {
  const sink = createUsageSink({ now: at });
  const client = createOpenAIClient({
    apiKey: 'k',
    usageSink: sink,
    fetchImpl: async () =>
      chatResponse({
        choices: [{ message: { content: 'hi', tool_calls: [] }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4000, completion_tokens: 500, total_tokens: 4500 }
      })
  });

  const result = await client.completeWithTools({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'go' }],
    pass: 'investigate',
    ticketId: 't-3'
  });

  // The existing contract is unchanged — the loop in investigate.mjs reads this.
  assert.deepEqual(result.usage, { prompt_tokens: 4000, completion_tokens: 500, total_tokens: 4500 });
  assert.equal(sink.drain()[0].totalTokens, 4500);
});

test('a call that exhausts its retries is recorded, and the error still propagates', async () => {
  const sink = createUsageSink({ now: at });
  const client = createOpenAIClient({
    apiKey: 'k',
    usageSink: sink,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      throw new Error('socket hang up');
    }
  });

  await assert.rejects(
    () => client.completeJson({ model: 'gpt-4o-mini', user: 'x', schema: SCHEMA, pass: 'spam' }),
    /OpenAI request failed/
  );

  const entries = sink.drain();
  assert.equal(entries.length, 1, 'retries of one call are not separate rows');
  assert.equal(entries[0].succeeded, false);
  assert.equal(entries[0].pass, 'spam');
});

test('a caller that passes no sink behaves exactly as before', async () => {
  const client = createOpenAIClient({
    apiKey: 'k',
    fetchImpl: async () =>
      chatResponse({ choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 5 } })
  });
  assert.deepEqual(await client.completeJson({ model: 'm', user: 'u', schema: SCHEMA }), { ok: true });
});

test('an unlabelled call still lands somewhere countable', async () => {
  const sink = createUsageSink({ now: at });
  const client = createOpenAIClient({
    apiKey: 'k',
    usageSink: sink,
    fetchImpl: async () =>
      chatResponse({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 5 } })
  });

  await client.completeJson({ model: 'm', user: 'u', schema: SCHEMA });
  const [entry] = sink.drain();
  assert.equal(entry.pass, 'other');
  assert.equal(entry.ticketId, null);
});

test('the cached half of the input is recorded, not folded into the total', () => {
  // WHY THIS FIELD EXISTS. Input is 76% of the bill, so the prompt cache is the
  // largest lever on cost — and `prompt_tokens` ALREADY INCLUDES cached tokens,
  // which means without this split nothing distinguishes a cache working
  // perfectly from one that never engages.
  const sink = createUsageSink({ now: at });
  sink.record({
    pass: 'investigate',
    model: 'gpt-4o',
    ticketId: 't-1',
    usage: {
      prompt_tokens: 1800,
      prompt_tokens_details: { cached_tokens: 1408 },
      completion_tokens: 140,
      total_tokens: 1940
    }
  });

  const [entry] = sink.drain();
  assert.equal(entry.inputTokens, 1800, 'the provider already counted the cached tokens in here');
  assert.equal(entry.cachedInputTokens, 1408, 'and this says how many of them were discounted');
  assert.equal(entry.totalTokens, 1940, 'the total is unchanged — cached is a subset, never an addition');
});

test('a response with no cache details reads as nothing cached', () => {
  // Embeddings carry no `prompt_tokens_details` at all, and a chat completion
  // below the cacheable length carries it with a zero. Neither is a fault.
  const sink = createUsageSink({ now: at });
  sink.record({ pass: 'embed', model: 'text-embedding-3-small', usage: { prompt_tokens: 400, total_tokens: 400 } });
  sink.record({ pass: 'categorise', model: 'gpt-4o-mini', usage: { prompt_tokens: 900, prompt_tokens_details: {}, completion_tokens: 40 } });

  for (const entry of sink.drain()) {
    assert.equal(entry.cachedInputTokens, 0);
  }
});

test('a malformed cache count costs the ticket nothing', () => {
  // Bookkeeping rides beside real work: every field here is coerced rather than
  // validated, because a usage row must never be the thing that fails a run.
  const sink = createUsageSink({ now: at });
  sink.record({
    pass: 'investigate',
    model: 'gpt-4o',
    usage: { prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 'lots' }, completion_tokens: 10 }
  });

  assert.equal(sink.drain()[0].cachedInputTokens, 0);
});
