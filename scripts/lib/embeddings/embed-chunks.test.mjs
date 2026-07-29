import assert from 'node:assert/strict';
import test from 'node:test';

import {
  embedChunks,
  evaluateChunkEmbedding,
  buildClearEmbeddingPatch,
  TICKET_MESSAGE_INPUT
} from './embed-chunks.mjs';
import { buildEmbeddingInput, hashEmbeddingInput } from './embedding-input.mjs';

const MODEL = 'text-embedding-3-small';
const DIMS = 1536;

// A fake embedder that records how many inputs it was asked for, so tests can
// assert that unchanged chunks never reach the API.
function fakeClient() {
  const calls = [];
  return {
    model: MODEL,
    dimensions: DIMS,
    calls,
    async embed(inputs) {
      calls.push(inputs);
      return inputs.map((_, i) => [i, i, i]);
    }
  };
}

function freshChunk(overrides = {}) {
  return {
    id: 'chunk-1',
    title: 'Livraison',
    category: 'delivery',
    section_heading: 'Delais',
    chunk_text: 'Nous livrons en 3 jours.',
    embedding: null,
    embedding_model: null,
    embedding_dimensions: null,
    embedded_input_hash: null,
    ...overrides
  };
}

function embeddedChunk(overrides = {}) {
  const base = freshChunk(overrides);
  const hash = hashEmbeddingInput(buildEmbeddingInput(base));
  return {
    ...base,
    embedding: [0, 0, 0],
    embedding_model: MODEL,
    embedding_dimensions: DIMS,
    embedded_input_hash: hash,
    ...overrides
  };
}

test('a chunk with no embedding is stale', () => {
  const { needsEmbedding } = evaluateChunkEmbedding(freshChunk(), { model: MODEL, dimensions: DIMS });
  assert.equal(needsEmbedding, true);
});

test('a chunk embedded for the current input, model, and dimensions is not stale', () => {
  const { needsEmbedding } = evaluateChunkEmbedding(embeddedChunk(), { model: MODEL, dimensions: DIMS });
  assert.equal(needsEmbedding, false);
});

test('changing the model makes an otherwise-current chunk stale', () => {
  const chunk = embeddedChunk({ embedding_model: 'text-embedding-ada-002' });
  const { needsEmbedding } = evaluateChunkEmbedding(chunk, { model: MODEL, dimensions: DIMS });
  assert.equal(needsEmbedding, true);
});

test('editing the chunk text makes it stale via the input hash', () => {
  const chunk = embeddedChunk();
  chunk.chunk_text = 'Nous livrons en 2 jours.';
  const { needsEmbedding } = evaluateChunkEmbedding(chunk, { model: MODEL, dimensions: DIMS });
  assert.equal(needsEmbedding, true);
});

test('embedChunks only sends stale chunks and patches exactly those', async () => {
  const client = fakeClient();
  const chunks = [freshChunk({ id: 'a' }), embeddedChunk({ id: 'b' })];

  const { patches, embeddedCount, skippedCount } = await embedChunks({ chunks, client });

  assert.equal(embeddedCount, 1);
  assert.equal(skippedCount, 1);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].length, 1);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].id, 'a');
  assert.equal(patches[0].embedding_model, MODEL);
  assert.equal(patches[0].embedding_dimensions, DIMS);
  assert.ok(patches[0].embedded_input_hash);
  assert.ok(patches[0].embedded_at);
});

test('embedChunks is a no-op when everything is current (idempotent re-run)', async () => {
  const client = fakeClient();
  const chunks = [embeddedChunk({ id: 'a' }), embeddedChunk({ id: 'b' })];

  const { patches, embeddedCount } = await embedChunks({ chunks, client });

  assert.equal(embeddedCount, 0);
  assert.equal(patches.length, 0);
  assert.equal(client.calls.length, 0);
});

test('buildClearEmbeddingPatch nulls every embedding column', () => {
  assert.deepEqual(buildClearEmbeddingPatch('x'), {
    id: 'x',
    embedding: null,
    embedding_model: null,
    embedding_dimensions: null,
    embedded_input_hash: null,
    embedded_at: null
  });
});

// --- corpus-specific input composition ---------------------------------------

test('the message spec composes and hashes differently from the chunk spec', () => {
  // Same row, two corpora: a chunk reads title/heading/text, a message reads
  // subject/body. They must never collide on the hash gate.
  const row = { title: 'T', section_heading: 'H', chunk_text: 'Body.', subject: 'S', body_text: 'Body.' };
  const asChunk = evaluateChunkEmbedding(row, { model: 'm', dimensions: 1536 });
  const asMessage = evaluateChunkEmbedding(row, {
    model: 'm',
    dimensions: 1536,
    inputSpec: TICKET_MESSAGE_INPUT
  });
  assert.notEqual(asChunk.input, asMessage.input);
  assert.notEqual(asChunk.hash, asMessage.hash);
});

test('a message is re-embedded when its quoted history strips differently', () => {
  // The stripper version salts the message hash, so the gate reopens on a
  // stripper change without the version ever reaching the model.
  const stored = evaluateChunkEmbedding(
    { subject: 'Colis', body_text: 'Ma question.\n\nLe 1 juillet, X a écrit :\n> ancien' },
    { model: 'm', dimensions: 1536, inputSpec: TICKET_MESSAGE_INPUT }
  );
  assert.equal(stored.input, 'Colis\n\nMa question.');
  assert.doesNotMatch(stored.input, /ancien|a écrit/);
});

test('an unchanged message is skipped, so a re-run costs nothing', async () => {
  const message = { id: 'm1', subject: 'S', body_text: 'Bonjour.' };
  const first = evaluateChunkEmbedding(message, {
    model: 'text-embedding-3-small',
    dimensions: 1536,
    inputSpec: TICKET_MESSAGE_INPUT
  });

  let calls = 0;
  const client = {
    model: 'text-embedding-3-small',
    dimensions: 1536,
    embed: async (inputs) => {
      calls += 1;
      return inputs.map(() => [0.1, 0.2]);
    }
  };

  const settled = {
    ...message,
    embedding: [0.1, 0.2],
    embedding_model: 'text-embedding-3-small',
    embedding_dimensions: 1536,
    embedded_input_hash: first.hash
  };
  const result = await embedChunks({
    chunks: [settled],
    client,
    inputSpec: TICKET_MESSAGE_INPUT
  });
  assert.equal(calls, 0);
  assert.equal(result.patches.length, 0);
  assert.equal(result.skippedCount, 1);
});

test('a message that composes to nothing is never sent to the model', async () => {
  let calls = 0;
  const client = {
    model: 'm',
    dimensions: 1536,
    embed: async (inputs) => {
      calls += 1;
      return inputs.map(() => [0]);
    }
  };
  const result = await embedChunks({
    chunks: [{ id: 'empty', subject: '  ', body_text: '\n\n' }],
    client,
    inputSpec: TICKET_MESSAGE_INPUT
  });
  assert.equal(calls, 0);
  assert.equal(result.patches.length, 0);
});
