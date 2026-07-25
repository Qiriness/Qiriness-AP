import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenAIClient } from './openai-client.mjs';

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

test('throws on a non-retryable error', async () => {
  const fetchImpl = async () => jsonResponse({ error: 'bad' }, { ok: false, status: 400 });
  const client = createOpenAIClient({ apiKey: 'k', fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(() => client.completeJson({ model: 'm', user: 'u', schema: {} }), /400/);
});

test('requires an api key', () => {
  assert.throws(() => createOpenAIClient({}), /API key/);
});
