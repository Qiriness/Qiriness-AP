-- ============================================================================
-- 03 — KNOWLEDGE LIBRARY
-- The curated article library, its retrieval chunks, and the vector search RPC.
--
-- NOTHING AUTO-SYNCS INTO THIS. Shopify pages and policies are catalogued by
-- name in 02 (`shopify_content_sources`); a row appears here only when someone
-- imports one or writes an article by hand. `source_type = 'manual'` IS the
-- manual-edit lock — there is no separate flag, and resync is then unavailable.
--
-- `knowledge_documents.category` uses the SHARED support taxonomy, the same
-- vocabulary `tickets.category` uses in 04, so a ticket's subject filters
-- straight into matching chunks with no mapping in between. It carries two
-- knowledge-only values (`faq`, `brand_story`) that are never ticket subjects.
-- `scripts/lib/support-taxonomy.mjs` is the other copy of that list; a check
-- constraint cannot import a module, so the migration tests are what stop the
-- two drifting apart.
--
-- Requires: 01_foundation.sql (shops, set_updated_at) and the `vector`
-- extension it creates.
-- ============================================================================

-- ---------------------------------------------------------------- knowledge_documents

create table public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  source_type text not null,
  shopify_source_id text,
  handle text,
  title text not null,
  url_path text,
  navigation_area text,
  category text,
  locale text not null default 'fr',
  status text,
  content_html text,
  content_text text not null,
  sections jsonb not null default '[]'::jsonb,
  content_hash text not null,
  approval_status text not null default 'draft',
  core_topic text,
  -- Products this article is ABOUT, so a chunk that retrieval found can say
  -- which product the question was about when the title matcher could not.
  --
  -- `matchProduct` reads titles only, so « la batterie de mon masque ne tient
  -- pas » identifies nothing: none of those words is in any title. The article
  -- answering it knows what it is about, and retrieval finds it easily —
  -- « batterie » and « télécommande » appear in zero other chunks — so the
  -- article carries the identity the question could not.
  --
  -- NO FOREIGN KEY, because Postgres cannot reference from an array element.
  -- The safe direction is the one that fails quietly: products are soft-deleted,
  -- so ids persist, and resolution filters to active products anyway — a stale
  -- id resolves to nothing rather than to the wrong product. Same shape as
  -- orders.tracking_numbers and products.recommended_for_concerns.
  product_ids uuid[] not null default '{}',
  voice_profile jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  shopify_updated_at timestamptz,
  source_metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint knowledge_documents_navigation_area_check check (
    navigation_area is null or navigation_area in ('header', 'footer', 'manual')
  ),
  constraint knowledge_documents_sections_array_check check (
    jsonb_typeof(sections) = 'array'
  ),
  constraint knowledge_documents_source_metadata_object_check check (
    jsonb_typeof(source_metadata) = 'object'
  ),
  constraint knowledge_documents_approval_status_check check (
    approval_status in ('draft', 'in_review', 'approved', 'needs_optimization')
  ),
  -- Six slots, with delivery and returns combined into one. The app's CoreTopic
  -- type is the other copy of this list; they must agree or saving an article
  -- into a slot fails with a check violation.
  constraint knowledge_documents_core_topic_check check (
    core_topic is null or core_topic in (
      'order_policies',
      'brand',
      'confidentiality',
      'delivery_returns',
      'locations',
      'faqs'
    )
  ),
  -- THE SHARED SUBJECT VOCABULARY. Nullable: an article can exist before a
  -- category is chosen, and the check only rejects values outside the list.
  -- Includes the two knowledge-only shapes (faq, brand_story) that are never
  -- ticket subjects — nobody emails support "an FAQ", and brand story is
  -- drafting context. `scripts/lib/support-taxonomy.mjs` is the other copy of
  -- this list; a check constraint cannot import a module, so the migration
  -- tests are what stop the two drifting apart.
  constraint knowledge_documents_category_check check (
    category is null or category in (
      'order', 'delivery', 'return_exchange', 'product', 'product_stock', 'payment',
      'account', 'promotions', 'cosmetovigilance', 'legal_privacy', 'b2b',
      'partner_collaboration', 'careers', 'other', 'faq', 'brand_story'
    )
  )
);

create unique index knowledge_documents_shop_source_id_unique
  on public.knowledge_documents (shop_id, source_type, shopify_source_id)
  where shopify_source_id is not null;

create unique index knowledge_documents_shop_source_handle_unique
  on public.knowledge_documents (shop_id, source_type, handle)
  where shopify_source_id is null and handle is not null;

-- At most one active article per shop per core-topic slot.
create unique index knowledge_documents_shop_core_topic_unique
  on public.knowledge_documents (shop_id, core_topic)
  where core_topic is not null;

create index knowledge_documents_shop_category_idx on public.knowledge_documents (shop_id, category);

create index knowledge_documents_shop_navigation_area_idx on public.knowledge_documents (shop_id, navigation_area);

create index knowledge_documents_shop_deleted_at_idx on public.knowledge_documents (shop_id, deleted_at);

create index knowledge_documents_sections_gin_idx on public.knowledge_documents using gin (sections);

create index knowledge_documents_product_ids_gin_idx on public.knowledge_documents using gin (product_ids);

create trigger knowledge_documents_set_updated_at
before update on public.knowledge_documents
for each row
execute function public.set_updated_at();

alter table public.knowledge_documents enable row level security;

comment on table public.knowledge_documents is
  'Cleaned Shopify header/footer page and policy content used as source material for AI support context.';

comment on column public.knowledge_documents.source_type is
  'shopify_page, shopify_policy, or manual. Editing an imported article in the dashboard converts this to manual (shopify_source_id/handle are kept for provenance), which is what stops it from being resynced from Shopify going forward.';

comment on column public.knowledge_documents.navigation_area is
  'Where the page is exposed in the storefront navigation: header, footer, or manual.';

comment on column public.knowledge_documents.content_html is
  'Rich-text HTML as edited in the Agent Setup dashboard. Source of truth for the editor; content_text and sections are regenerated from this on every save, import, or resync.';

comment on column public.knowledge_documents.content_text is
  'Cleaned canonical plain text used for AI context.';

comment on column public.knowledge_documents.sections is
  'Ordered section objects parsed from the page content, usually containing heading, text, order, and anchor.';

comment on column public.knowledge_documents.approval_status is
  'Team review state for agent usage: draft, in_review, approved, or needs_optimization. Independent of status, which holds the Shopify publish state for Shopify-sourced articles.';

comment on column public.knowledge_documents.core_topic is
  'Optional required-knowledge slot this article fulfills (order_policies, brand, confidentiality, delivery_returns, locations, faqs). At most one active article per shop per slot. Distinct from the category column.';

comment on column public.knowledge_documents.voice_profile is
  'Structured brand-voice fields for the singleton Brand Voice article (core_topic = ''brand''): { roleDescription: string, toneAndVoice: string }. Empty ({}) on every other article. Always-included drafting-agent context, distinct from content_html (used on this row for freeform general-context guidance) and from ordinary knowledge_documents rows, which are selectively retrieved via knowledge_chunks.';

comment on column public.knowledge_documents.product_ids is
  'Products this article is about, set by an operator in the knowledge editor. Lets a retrieved chunk resolve the product a question was about when the title matcher could not -- the words customers use about a device (batterie, telecommande, s''allume) are in no product title. Denormalised onto knowledge_chunks. Never overrides a product the customer named, and never sets reaction_product: a cosmetovigilance attribution must come from the customer, not from which article was retrieved.';

comment on column public.knowledge_documents.source_metadata is
  'Small sanitized source metadata snapshot. Do not store full page HTML or unnecessary raw payloads here.';

comment on column public.knowledge_documents.category is
  'Article subject, from the shared support taxonomy in scripts/lib/support-taxonomy.mjs. The same 14 subjects the ticket categoriser assigns, plus the knowledge-only shapes faq and brand_story. Tickets additionally carry a request_kind; an article is reference material and has no kind.';

-- ---------------------------------------------------------------- knowledge_chunks

-- Retrieval chunks generated from knowledge_documents sections.
--
-- Determinism: a vector is stored with the exact composed-input hash, model and
-- dimension count it was produced for, so re-running the embedder over unchanged
-- content is a no-op. Only chunks whose parent document is approved and is not
-- the brand-voice document ever hold a vector -- the pipeline gates on that.
-- Accent-insensitive French text search.
--
-- The stock `french` config stems but keeps accents, so `retractation` finds
-- nothing while `rétractation` does — and customers routinely type without
-- accents. Chaining `unaccent` ahead of the stemmer fixes both directions at
-- index and query time, as long as BOTH use this configuration.
--
-- Created in the public schema so a generated column can name it: the column's
-- expression must resolve the config the same way for ever, and an unqualified
-- name would depend on search_path.
create text search configuration public.french_unaccent (copy = french);

alter text search configuration public.french_unaccent
  alter mapping for hword, hword_part, word
  with unaccent, french_stem;

create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  knowledge_document_id uuid not null references public.knowledge_documents(id) on delete cascade,
  chunk_index integer not null,
  section_index integer,
  section_heading text,
  -- Denormalised from the parent document; constrained with it in 03.
  category text,
  -- Denormalised from the parent document, the same way category is: retrieval
  -- returns chunks, so the identity has to travel with the chunk or every hit
  -- would need a second query back to its document.
  product_ids uuid[] not null default '{}',
  chunk_text text not null,
  token_count integer,
  content_hash text not null,
  embedding vector(1536),
  -- THE LEXICAL HALF of hybrid retrieval, generated so it can never drift from
  -- the text it indexes.
  --
  -- Dense embedding alone discriminates poorly on this corpus: measured over the
  -- retrieval eval, correct answers scored 0.47-0.59 and incorrect ones
  -- 0.46-0.50 — French support prose shares so much boilerplate that cosine has
  -- a high floor and a narrow spread. It is worst at exactly what customers
  -- type: a code (UKLED20), an order number, a product name.
  --
  -- THE SECTION HEADING IS INDEXED WITH THE TEXT, and weighted above it. The
  -- eval showed the best-scoring chunks are those whose heading IS the customer's
  -- question ("Je ne me souviens plus de mon mot de passe, que faire ?"), so the
  -- heading carries more signal per word than the body.
  search_vector tsvector generated always as (
    setweight(to_tsvector('public.french_unaccent', coalesce(section_heading, '')), 'A') ||
    setweight(to_tsvector('public.french_unaccent', coalesce(chunk_text, '')), 'B')
  ) stored,
  embedding_model text,
  embedding_dimensions integer,
  embedded_input_hash text,
  embedded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint knowledge_chunks_document_chunk_unique unique (knowledge_document_id, chunk_index),
  constraint knowledge_chunks_chunk_index_check check (chunk_index >= 0),
  constraint knowledge_chunks_section_index_check check (
    section_index is null or section_index >= 0
  ),
  constraint knowledge_chunks_token_count_check check (
    token_count is null or token_count >= 0
  ),
  constraint knowledge_chunks_embedding_dimensions_check check (
    embedding_dimensions is null or embedding_dimensions = 1536
  )
);

create index knowledge_chunks_document_id_idx on public.knowledge_chunks (knowledge_document_id);

create index knowledge_chunks_category_idx on public.knowledge_chunks (category);

create index knowledge_chunks_product_ids_gin_idx on public.knowledge_chunks using gin (product_ids);

-- Approximate-nearest-neighbour index for cosine retrieval. HNSW needs pgvector
-- >= 0.5.0 (Supabase's managed pgvector has it); on an older target, swap for
-- ivfflat.
create index knowledge_chunks_embedding_hnsw_idx
  on public.knowledge_chunks
  using hnsw (embedding vector_cosine_ops);

create trigger knowledge_chunks_set_updated_at
before update on public.knowledge_chunks
for each row
execute function public.set_updated_at();

alter table public.knowledge_chunks enable row level security;

comment on table public.knowledge_chunks is
  'AI retrieval chunks generated from knowledge_documents sections.';

comment on column public.knowledge_chunks.token_count is
  'Approximate token count used to tune chunking and prompt budgets.';

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

comment on column public.knowledge_chunks.product_ids is
  'Denormalised from knowledge_documents.product_ids, the same way category is, so retrieval can resolve a product without a second query per hit.';

comment on column public.knowledge_chunks.category is
  'Denormalised copy of the parent knowledge_documents.category, kept in step with it. Included in embedded_input_hash, so a category change invalidates the chunk vector and the next embed run refreshes it.';

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
  product_ids uuid[],
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
    kc.product_ids,
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

-- ---------------------------------------------------------------- lexical search

-- The lexical half of hybrid retrieval, deliberately a SEPARATE function from
-- match_knowledge_chunks rather than a fused one.
--
-- Two retrievers, one fusion, and the fusion is NOT here. Reciprocal Rank Fusion
-- is a judgement about how much to trust each retriever, and this project keeps
-- judgement in tested JavaScript and vector maths in Postgres (see
-- retrieval-rules.mjs). Fusing in SQL would bury a tunable weighting inside a
-- migration where it cannot be unit-tested or argued with.
--
-- Returns ts_rank_cd rather than ts_rank: the cover-density variant accounts for
-- how close the matched terms are to each other, which is what separates a chunk
-- that actually discusses "délai de rétractation" from one that happens to
-- mention both words paragraphs apart.
create or replace function public.search_knowledge_chunks_text(
  query_text text,
  match_shop_id uuid,
  match_categories text[] default null,
  match_count integer default 5
)
returns table (
  chunk_id uuid,
  document_id uuid,
  document_title text,
  section_heading text,
  category text,
  product_ids uuid[],
  chunk_text text,
  rank double precision
)
language sql
stable
set search_path = public
as $$
  -- THE QUERY IS OR-ED, NOT AND-ED, and that is the whole difficulty here.
  --
  -- The natural choice, websearch_to_tsquery, joins every term with AND. That
  -- is right for a search box where someone types three words, and completely
  -- wrong for a retrieval query built from a whole customer email: a 14-word
  -- question becomes `del & retourn & articl & bonjour & recu & ...`, which no
  -- chunk on earth satisfies. Measured before this fix: 4 results for the single
  -- word "rétractation", 0 for any real ticket.
  --
  -- So the query text is passed through the SAME configuration that built the
  -- index, and its lexemes are OR-ed. Recall comes from the OR; precision comes
  -- from ts_rank_cd, which rewards chunks covering more of the query with the
  -- terms closer together — and from the A/B weighting, which puts a section
  -- heading above body text.
  with q as (
    select nullif(
      (select string_agg(lexeme, ' | ') from unnest(to_tsvector('public.french_unaccent', coalesce(query_text, '')))),
      ''
    )::tsquery as tsq
  )
  select
    c.id,
    d.id,
    d.title,
    c.section_heading,
    c.category,
    c.product_ids,
    c.chunk_text,
    ts_rank_cd(c.search_vector, q.tsq)::double precision
  from public.knowledge_chunks c
  join public.knowledge_documents d on d.id = c.knowledge_document_id
  cross join q
  where q.tsq is not null
    and d.shop_id = match_shop_id
    and d.deleted_at is null
    -- Same approval gate as the dense side. A draft article must not become
    -- reachable just because it is lexically searchable.
    and d.approval_status = 'approved'
    and (match_categories is null or c.category = any (match_categories))
    and c.search_vector @@ q.tsq
  order by ts_rank_cd(c.search_vector, q.tsq) desc
  limit greatest(coalesce(match_count, 5), 1);
$$;

comment on function public.search_knowledge_chunks_text is
  'Lexical (full-text) half of hybrid knowledge retrieval. Accent-insensitive French via the french_unaccent configuration, section headings weighted above body text, and the same approval + category gates as match_knowledge_chunks. Ranking is ts_rank_cd; fusion with the dense results happens in the agent, not here.';

create index knowledge_chunks_search_vector_gin_idx
  on public.knowledge_chunks
  using gin (search_vector);
