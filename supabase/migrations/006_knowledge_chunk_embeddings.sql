-- Deterministic embeddings for approved knowledge chunks.
--
-- text-embedding-3-small at 1536 dimensions. Only chunks whose parent
-- knowledge_documents row is approved (approval_status = 'approved') and is not
-- the brand-voice document ever hold a vector — the embedding pipeline gates on
-- that. The metadata columns below make the pipeline deterministic: a vector is
-- stored with the exact composed-input hash + model + dimensions it was produced
-- for, so re-running the embedder for unchanged content is a no-op.
--
-- The embedding column was created as a bare, unsized `vector` in
-- 001_initial_schema.sql ("Stored without fixed dimensions until the embedding
-- model is finalized"). The model is now finalized, so we size it to
-- vector(1536); the column holds zero rows today, so the type change is safe.

alter table public.knowledge_chunks
  alter column embedding type vector(1536);

alter table public.knowledge_chunks
  add column embedding_model text,
  add column embedding_dimensions integer,
  add column embedded_input_hash text,
  add column embedded_at timestamptz;

alter table public.knowledge_chunks
  add constraint knowledge_chunks_embedding_dimensions_check check (
    embedding_dimensions is null or embedding_dimensions = 1536
  );

-- Approximate-nearest-neighbour index for cosine similarity retrieval. HNSW is
-- available in pgvector >= 0.5.0 (Supabase's managed pgvector supports it); if a
-- target database predates that, swap this for an ivfflat index.
create index knowledge_chunks_embedding_hnsw_idx
  on public.knowledge_chunks
  using hnsw (embedding vector_cosine_ops);

comment on column public.knowledge_chunks.embedding is
  'pgvector embedding (text-embedding-3-small, 1536 dims) for cosine retrieval. Present only while the parent document is approved and the vector matches the current composed input; cleared when the document leaves approved.';

comment on column public.knowledge_chunks.embedding_model is
  'OpenAI model the embedding was produced with, e.g. text-embedding-3-small. Used to detect stale vectors after a model change.';

comment on column public.knowledge_chunks.embedding_dimensions is
  'Dimension count requested for the embedding (1536). Used alongside embedding_model to detect vectors that must be recomputed.';

comment on column public.knowledge_chunks.embedded_input_hash is
  'Hash of the exact composed input text sent to the embedding model (title + category + section heading + chunk text). Distinct from content_hash, which ignores title/category/heading; a category rename changes this hash and invalidates the vector.';

comment on column public.knowledge_chunks.embedded_at is
  'Timestamp the embedding was last computed.';
