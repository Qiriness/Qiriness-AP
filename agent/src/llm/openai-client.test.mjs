import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenAIClient, isReasoningModel } from './openai-client.mjs';

function jsonResponse(obj, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

function completion(contentObject) {
  return { choices: [{ message: { content: JSON.stringify(contentObject) } }] };
}

test('completeJson parses structured content and sends a json_schema request', async () => {
  let sent;
  const fetchImpl = async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return jsonResponse(completion({ label: 'spam', reason: 'x' }));
  };
  const client = createOpenAIClient({ apiKey: 'k', fetchImpl });

  const result = await client.completeJson({
    model: 'm',
    system: 's',
    user: 'u',
    schema: { type: 'object' },
    schemaName: 'n'
  });

  assert.deepEqual(result, { label: 'spam', reason: 'x' });
  assert.equal(sent.model, 'm');
  assert.equal(sent.temperature, 0);
  assert.equal(sent.response_format.type, 'json_schema');
  assert.equal(sent.response_format.json_schema.name, 'n');
  assert.equal(sent.response_format.json_schema.strict, true);
});

test('retries on 429 then succeeds', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: 'rate' }, { ok: false, status: 429 });
    return jsonResponse(completion({ label: 'keep', reason: 'y' }));
  };
  const client = createOpenAIClient({ apiKey: 'k', fetchImpl, sleepImpl: async () => {} });

  const result = await client.completeJson({ model: 'm', user: 'u', schema: {} });
  assert.equal(result.label, 'keep');
  assert.equal(calls, 2);
});

function rateLimited(headers = {}) {
  return {
    ok: false,
    status: 429,
    headers: new Headers(headers),
    json: async () => ({ error: 'rate' }),
    text: async () => 'rate'
  };
}

test('a 429 waits what OpenAI asks for, not a fixed quarter second', async () => {
  const waits = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return rateLimited({ 'retry-after': '7' });
    if (calls === 2) return rateLimited({ 'x-ratelimit-reset-tokens': '1m0.5s' });
    return jsonResponse(completion({ label: 'keep', reason: 'y' }));
  };
  const client = createOpenAIClient({ apiKey: 'k', fetchImpl, sleepImpl: async (ms) => waits.push(ms) });

  await client.completeJson({ model: 'm', user: 'u', schema: {} });
  // 60.5 s is clamped to the one-minute ceiling.
  assert.deepEqual(waits, [7000, 60000]);
});

test('a 429 with no hint backs off from 2 s, and outlasts more attempts than a 5xx', async () => {
  // The bug this guards: three retries at 250/500/1000 ms gave up long before a
  // tokens-per-minute window reopened, so the ticket failed for nothing.
  const waits = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= 5) return rateLimited();
    return jsonResponse(completion({ label: 'keep', reason: 'y' }));
  };
  const client = createOpenAIClient({ apiKey: 'k', fetchImpl, sleepImpl: async (ms) => waits.push(ms) });

  const result = await client.completeJson({ model: 'm', user: 'u', schema: {} });
  assert.equal(result.label, 'keep');
  assert.deepEqual(waits, [2000, 4000, 8000, 16000, 32000]);
});

test('a 429 still gives up eventually', async () => {
  let calls = 0;
  const fetchImpl = async () => ((calls += 1), rateLimited());
  const client = createOpenAIClient({ apiKey: 'k', fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(() => client.completeJson({ model: 'm', user: 'u', schema: {} }), /429/);
  assert.equal(calls, 7);
});

test('a 5xx keeps the short backoff and three retries', async () => {
  const waits = [];
  let calls = 0;
  const fetchImpl = async () => ((calls += 1), jsonResponse({ error: 'down' }, { ok: false, status: 503 }));
  const client = createOpenAIClient({ apiKey: 'k', fetchImpl, sleepImpl: async (ms) => waits.push(ms) });
  await assert.rejects(() => client.completeJson({ model: 'm', user: 'u', schema: {} }), /503/);
  assert.equal(calls, 4);
  assert.deepEqual(waits, [250, 500, 1000]);
});

test('throws on a non-retryable error', async () => {
  const fetchImpl = async () => jsonResponse({ error: 'bad' }, { ok: false, status: 400 });
  const client = createOpenAIClient({ apiKey: 'k', fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(() => client.completeJson({ model: 'm', user: 'u', schema: {} }), /400/);
});

test('requires an api key', () => {
  assert.throws(() => createOpenAIClient({}), /API key/);
});

function toolCallCompletion(calls) {
  return {
    choices: [
      {
        message: { content: null, tool_calls: calls },
        finish_reason: 'tool_calls'
      }
    ]
  };
}

test('completeWithTools returns parsed tool calls', async () => {
  let sent;
  const fetchImpl = async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return jsonResponse(
      toolCallCompletion([
        { id: 'call_1', function: { name: 'lookupPromotion', arguments: '{"code":"BIENVENUE10"}' } }
      ])
    );
  };
  const client = createOpenAIClient({ apiKey: 'k', fetchImpl });

  const turn = await client.completeWithTools({
    model: 'm',
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
    tools: [{ type: 'function', function: { name: 'lookupPromotion' } }]
  });

  assert.equal(turn.toolCalls.length, 1);
  assert.deepEqual(turn.toolCalls[0].args, { code: 'BIENVENUE10' });
  assert.equal(turn.toolCalls[0].id, 'call_1');
  assert.equal(sent.tool_choice, 'auto');
  assert.equal(sent.messages[0].role, 'system');
});

test('malformed tool arguments come back as an error, never as a throw', async () => {
  // Losing a whole investigation to one truncated argument string would leave
  // the model no route to correct itself.
  const fetchImpl = async () =>
    jsonResponse(
      toolCallCompletion([{ id: 'call_1', function: { name: 'lookupStock', arguments: '{"q":' } }])
    );
  const client = createOpenAIClient({ apiKey: 'k', fetchImpl });

  const turn = await client.completeWithTools({ model: 'm', messages: [], tools: [{}] });
  assert.equal(turn.toolCalls[0].args, null);
  assert.match(turn.toolCalls[0].argsError, /JSON/i);
});

test('the final turn asks for a schema and forbids further tool calls', async () => {
  let sent;
  const fetchImpl = async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return jsonResponse({ choices: [{ message: { content: '{"verdict":"answerable"}' } }] });
  };
  const client = createOpenAIClient({ apiKey: 'k', fetchImpl });

  const turn = await client.completeWithTools({
    model: 'm',
    messages: [{ role: 'user', content: 'u' }],
    tools: [{ type: 'function', function: { name: 'x' } }],
    toolChoice: 'none',
    schema: { type: 'object' },
    schemaName: 'case_file'
  });

  assert.equal(sent.tool_choice, 'none');
  assert.equal(sent.response_format.json_schema.name, 'case_file');
  assert.deepEqual(turn.toolCalls, []);
  assert.equal(JSON.parse(turn.content).verdict, 'answerable');
});

test('completeWithTools retries a 429 like completeJson does', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: 'rate' }, { ok: false, status: 429 });
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  const client = createOpenAIClient({ apiKey: 'k', fetchImpl, sleepImpl: async () => {} });

  const turn = await client.completeWithTools({ model: 'm', messages: [] });
  assert.equal(turn.content, 'ok');
  assert.equal(calls, 2);
});

test('a reasoning model gets max_completion_tokens and no temperature', async () => {
  // gpt-5 and the o-series answer 400 to `temperature` and `max_tokens`.
  const bodies = [];
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  const client = createOpenAIClient({ apiKey: 'k', fetchImpl });

  await client.completeWithTools({ model: 'gpt-5.2', messages: [], maxTokens: 900 });
  await client.completeWithTools({ model: 'gpt-4o', messages: [], maxTokens: 900 });

  assert.equal(bodies[0].max_completion_tokens, 900);
  assert.equal(bodies[0].temperature, undefined);
  assert.equal(bodies[0].max_tokens, undefined);
  assert.equal(bodies[1].max_tokens, 900);
  assert.equal(bodies[1].temperature, 0);
  assert.equal(isReasoningModel('o3'), true);
  assert.equal(isReasoningModel('gpt-4o-mini'), false);
});

test('no tools means no tools field at all', async () => {
  // An empty array would be sent as `tools: []`, which the API rejects.
  let sent;
  const fetchImpl = async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  const client = createOpenAIClient({ apiKey: 'k', fetchImpl });

  await client.completeWithTools({ model: 'm', messages: [], tools: [] });
  assert.equal(sent.tools, undefined);
  assert.equal(sent.tool_choice, undefined);
});
