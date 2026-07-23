import assert from 'node:assert/strict';
import test from 'node:test';

import { embedChunks, evaluateChunkEmbedding, buildClearEmbeddingPatch } from './embed-chunks.mjs';
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
