-- ============================================================================
-- 06 — KNOWLEDGE RETRIEVAL
-- The vector search behind the knowledge-retrieval tool: given an embedded
-- question, return the approved chunks that answer it.
--
-- WHY A DATABASE FUNCTION AND NOT A CLIENT-SIDE SCAN. PostgREST cannot express
-- a pgvector distance operator, so without this the only option is to pull every
-- chunk and its 1536 floats to the worker and rank in JavaScript. That is a full
-- table scan per question — precisely what `AGENTS.md` forbids of a tool — and it
-- cannot use the HNSW index 01 already builds. Here the ORDER BY is the index
-- lookup, and only the handful of rows actually wanted cross the wire.
--
-- SIMILARITY, NOT DISTANCE, in the output. `<=>` is cosine *distance*, so a
-- perfect match is 0 and the numbers run the wrong way for a threshold anyone
-- has to reason about. Returning `1 - distance` keeps every score in the code
-- and the docs on one scale: higher is better, and it is the same cosine the
-- clustering report and the coverage bands already use.
--
-- CATEGORIES ARE A LIST, chosen by the caller, not a single value fixed here.
-- Filtering to the ticket's own subject looks obvious and is wrong today: every
-- embedded chunk in the library is `faq`, so a `product` question filtered
-- strictly would match nothing at all. Which categories to search is policy that
-- changes as the library fills, so it lives in agent/src/retrieval where it can
-- be tested and revised — not baked into SQL. Null searches everything.
--
-- Only approved, non-brand chunks hold a vector at all (the embedding pipeline
-- gates on that, see 01), so `embedding is not null` is also the approval gate.
-- No separate status check is needed, and adding one would imply the invariant
-- is not trusted.
-- ============================================================================

create or replace function public.match_knowledge_chunks(
  query_embedding vector(1536),
  match_shop_id uuid,
  match_categories text[] default null,
  match_count integer default 5,
  min_similarity double precision default 0
)
returns table (
  chunk_id uuid,
  document_id uuid,
  document_title text,
  section_heading text,
  category text,
  chunk_text text,
  similarity double precision
)
language sql
stable
-- Explicit search_path: this runs under the service role, so it must not be
-- resolvable against a caller-controlled schema.
set search_path = public
as $$
  select
    kc.id,
    kd.id,
    kd.title,
    kc.section_heading,
    kc.category,
    kc.chunk_text,
    1 - (kc.embedding <=> query_embedding) as similarity
  from public.knowledge_chunks kc
  join public.knowledge_documents kd on kd.id = kc.knowledge_document_id
  where kc.embedding is not null
    and kd.shop_id = match_shop_id
    and (match_categories is null or kc.category = any (match_categories))
    and 1 - (kc.embedding <=> query_embedding) >= min_similarity
  order by kc.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

comment on function public.match_knowledge_chunks is
  'Vector search over approved knowledge chunks for the retrieval tool. Returns cosine SIMILARITY (higher is better), not the raw <=> distance. `match_categories` is a caller-supplied list rather than the ticket subject, because which categories are worth searching is policy that changes as the library fills -- see agent/src/retrieval/retrieval-rules.mjs. A chunk holds a vector only if its parent document is approved and not brand voice, so the null check is also the approval gate.';
