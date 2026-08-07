import assert from 'node:assert/strict';
import test from 'node:test';

import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_ONLY_SUBJECTS } from '../../scripts/lib/support-taxonomy.mjs';
import { checkClause, literalsIn, read, tablesIn } from './_shared.test.mjs';

const sql = read('03_knowledge');

test('creates exactly the two tables it documents', () => {
  assert.deepEqual(tablesIn(sql).sort(), ['knowledge_chunks', 'knowledge_documents']);
});

// --- the shared vocabulary --------------------------------------------------

test('knowledge_documents.category is constrained to every taxonomy value', () => {
  // THE invariant this file exists to protect: a check constraint cannot import
  // support-taxonomy.mjs, so the list is written twice and this is what stops
  // the copies drifting. A ticket subject filters straight into matching chunks
  // only because both sides use the same words.
  const clause = checkClause(sql, 'knowledge_documents_category_check');
  assert.ok(clause, 'the category check is missing');
  assert.deepEqual(literalsIn(clause), [...KNOWLEDGE_CATEGORIES].sort());
});

test('the knowledge-only shapes are present here and only here', () => {
  // faq and brand_story describe reference material. 04 must NOT accept them as
  // ticket subjects — nobody emails support "an FAQ".
  for (const category of KNOWLEDGE_ONLY_SUBJECTS) {
    assert.match(sql, new RegExp(`'${category}'`), category);
  }
  const ticketClause = checkClause(read('04_support'), 'tickets_category_check');
  assert.ok(ticketClause, 'the ticket category check is missing');
  for (const category of KNOWLEDGE_ONLY_SUBJECTS) {
    assert.doesNotMatch(ticketClause, new RegExp(`'${category}'`), `${category} must not be a ticket subject`);
  }
});

// --- the article model ------------------------------------------------------

test('the manual-edit lock is a source_type transition, not a flag', () => {
  // No `is_manual` column: two ways to express one state can disagree.
  assert.match(sql, /source_type text not null/i);
  assert.doesNotMatch(sql, /is_manual|manually_edited/i);
});

test('approval_status covers the four agent workflow states', () => {
  assert.match(
    sql,
    /constraint knowledge_documents_approval_status_check check \(\s*approval_status in \('draft', 'in_review', 'approved', 'needs_optimization'\)\s*\)/i
  );
});

test('core_topic is the six combined slots, not the older seven', () => {
  const clause = sql.match(/constraint knowledge_documents_core_topic_check check \(([\s\S]*?)\n  \)/i)?.[1];
  const slots = [...clause.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(slots.sort(), [
    'brand', 'confidentiality', 'delivery_returns', 'faqs', 'locations', 'order_policies'
  ]);
});

test('one active article per core-topic slot per shop', () => {
  assert.match(sql, /create unique index knowledge_documents_shop_core_topic_unique/i);
});

test('the brand-voice column is structured, defaulted and documented', () => {
  assert.match(sql, /voice_profile jsonb not null default '\{\}'::jsonb/i);
  assert.match(sql, /comment on column public\.knowledge_documents\.voice_profile is/i);
});

// --- retrieval --------------------------------------------------------------

test('chunk vectors are sized and carry their determinism metadata', () => {
  assert.match(sql, /embedding vector\(1536\)/i);
  for (const column of ['embedding_model', 'embedding_dimensions', 'embedded_input_hash', 'embedded_at']) {
    assert.match(sql, new RegExp(`${column}\\b`), column);
  }
});

test('the vector index is HNSW cosine, matching the RPC order by', () => {
  assert.match(sql, /create index knowledge_chunks_embedding_hnsw_idx[\s\S]*?using hnsw \(embedding vector_cosine_ops\)/i);
});

test('a chunk dies with its document', () => {
  assert.match(sql, /document_id uuid not null references public\.knowledge_documents\(id\) on delete cascade/i);
});

// --- the search function ----------------------------------------------------

test('it returns similarity, not raw cosine distance', () => {
  // Every band in the codebase is on one scale because of this.
  assert.match(sql, /create or replace function public\.match_knowledge_chunks/i);
  assert.match(sql, /1 - \(/i);
});

test('the ORDER BY is the raw distance, so the HNSW index is usable', () => {
  // Ordering by the derived similarity would defeat the index and force a scan.
  const body = sql.split('create or replace function public.match_knowledge_chunks')[1];
  assert.match(body, /order by[\s\S]*?<=>/i);
});

test('only chunks that hold a vector are searched, which is the approval gate', () => {
  const body = sql.split('create or replace function public.match_knowledge_chunks')[1];
  assert.match(body, /embedding is not null/i);
});

test('results are scoped to one shop and search_path is pinned', () => {
  const body = sql.split('create or replace function public.match_knowledge_chunks')[1];
  assert.match(body, /shop_id/i);
  // Runs under the service role, so an unpinned search_path is a hijack risk.
  assert.match(body, /set search_path/i);
});

test('the function is read-only', () => {
  const body = sql.split('create or replace function public.match_knowledge_chunks')[1];
  assert.match(body, /\bstable\b/i);
  assert.doesNotMatch(body.split('$$')[1] || '', /\b(insert|update|delete)\b/i);
});
