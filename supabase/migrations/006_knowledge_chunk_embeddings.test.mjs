import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const migration = readFileSync(new URL('./006_knowledge_chunk_embeddings.sql', import.meta.url), 'utf8');

test('embedding migration sizes the vector column to 1536 dimensions', () => {
  assert.match(
    migration,
    /alter column embedding type vector\(1536\)/i
  );
});

test('embedding migration adds the determinism metadata columns', () => {
  assert.match(migration, /add column embedding_model text/i);
  assert.match(migration, /add column embedding_dimensions integer/i);
  assert.match(migration, /add column embedded_input_hash text/i);
  assert.match(migration, /add column embedded_at timestamptz/i);
});

test('embedding migration constrains dimensions to 1536', () => {
  assert.match(
    migration,
    /embedding_dimensions is null or embedding_dimensions = 1536/i
  );
});

test('embedding migration creates a cosine ANN index on the vector', () => {
  assert.match(
    migration,
    /create index knowledge_chunks_embedding_hnsw_idx\s+on public\.knowledge_chunks\s+using hnsw \(embedding vector_cosine_ops\)/i
  );
});
