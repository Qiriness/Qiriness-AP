import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const migration = readFileSync(new URL('./06_knowledge_retrieval.sql', import.meta.url), 'utf8');

test('it returns similarity, not raw cosine distance', () => {
  // `<=>` is distance: 0 is perfect and the numbers run the wrong way for any
  // threshold a human has to reason about. Every band in the codebase is a
  // similarity, so the function must return one.
  assert.match(migration, /1 - \(kc\.embedding <=> query_embedding\) as similarity/);
});

test('the ORDER BY is the raw distance, so the HNSW index is usable', () => {
  // Ordering by `1 - distance` desc would not match the index operator class
  // and would silently fall back to a sequential scan.
  assert.match(migration, /order by kc\.embedding <=> query_embedding/);
});

test('only chunks that hold a vector are searched, which is the approval gate', () => {
  assert.match(migration, /kc\.embedding is not null/);
});

test('results are scoped to one shop', () => {
  assert.match(migration, /kd\.shop_id = match_shop_id/);
});

test('categories are a caller-supplied list, and null means everything', () => {
  // Policy lives in agent/src/retrieval/retrieval-rules.mjs, not in SQL: today
  // every embedded chunk is `faq`, so a hardcoded subject filter would return
  // nothing for the product tickets this tool exists to serve.
  assert.match(migration, /match_categories text\[\] default null/);
  assert.match(migration, /match_categories is null or kc\.category = any \(match_categories\)/);
});

test('search_path is pinned, since this runs under the service role', () => {
  assert.match(migration, /set search_path = public/);
});

test('the function is read-only', () => {
  assert.match(migration, /language sql\s*\n\s*stable/);
  for (const line of migration.split('\n').filter((l) => !l.trim().startsWith('--'))) {
    assert.doesNotMatch(line, /^\s*(update|insert|delete|drop)\s+/i, line);
  }
});

test('a zero or negative match_count cannot produce an unbounded query', () => {
  assert.match(migration, /limit greatest\(match_count, 1\)/);
});
