# Phase 2 — Deterministic embedding of approved knowledge chunks

## Goal

Populate `knowledge_chunks.embedding` with `text-embedding-3-small` vectors at
**1536 dimensions**, but only for chunks whose parent knowledge document is
**approved for the agent**. The pipeline must be deterministic: the same chunk
content is embedded exactly once, and re-running the process never re-calls the
OpenAI API for unchanged text.

## Model / retrieval

- Model: `text-embedding-3-small`
- Dimensions: `1536` (passed explicitly on every request)
- Distance: cosine

## Core invariant

> A chunk holds a vector **iff** its parent document is currently `approved`,
> is not the brand-voice document (`core_topic = 'brand'`), and the stored
> vector matches the current composed input text + model + dimensions.

## Why "deterministic" is a pipeline property, not a model guarantee

OpenAI's embedding endpoint is not guaranteed to return bit-identical floats
across calls. We make _our pipeline_ deterministic instead: each vector is
stored with the exact input hash + model + dimensions it was produced for, and
every run gates on that triple. Same input → we skip the call. This makes the
reconciler idempotent (a second run is a no-op) and re-approvals cheap.

## Decisions (agreed)

1. **Trigger = Both.** Inline embedding at approval time inside
   `knowledge-service.ts` (immediate), plus a reconciler script as a safety net
   for retries, backfills, and model changes. Inline failures never fail the
   approve request — the reconciler fills the gap.
2. **Delete on unapprove.** When a document leaves `approved` (explicit
   unapprove, or a text edit that demotes it), its chunks' vectors are cleared.
   Re-approving unchanged text re-embeds (accepted trade-off at this volume).
3. **Embed input = heading-prefixed + category.** Composed deterministically as
   `title → category → section_heading → chunk_text`. Because `content_hash`
   ignores title/category/heading, a separate `embedded_input_hash` covers the
   full composed string so a category rename correctly invalidates the vector.
4. **Edit-of-approved-text demotes out of `approved`.** This is NOT current
   behaviour (`updateArticle` only changes `approval_status` when the caller
   passes one explicitly). We add it: editing the title/content of an
   `approved` doc without an explicit status sets it to `in_review`. Mirrors the
   existing resync behaviour (which sets `needs_optimization`). Keeps the
   invariant free of an "approved but unembedded" state.

## Volume context

Curated library, human-paced. Missing/stale vectors appear only on: first
approval, editing an approved doc's text, resync of an approved doc, or a
one-off model/dimension change. Bursty during agent setup, near-zero at steady
state — tens of chunks total. Inline is cheap; the reconciler rarely has work.

## Work items

### 1. Config — `scripts/lib/sync-config.mjs`
Add to `loadConfig()` (all optional so existing scripts keep working):
- `openaiApiKey: env.OPENAI_API_KEY`
- `embeddingModel: env.EMBEDDING_MODEL || 'text-embedding-3-small'`
- `embeddingDimensions: Number(env.EMBEDDING_DIMENSIONS) || 1536`

The embedding client throws a clear error if `openaiApiKey` is missing when
actually invoked, rather than making `loadConfig` require it globally.

### 2. Migration — `supabase/migrations/006_knowledge_chunk_embeddings.sql`
- `alter column embedding type vector(1536)` (safe: column is bare `vector`,
  zero rows written).
- Add `embedding_model text`, `embedding_dimensions integer`,
  `embedded_input_hash text`, `embedded_at timestamptz`.
- HNSW cosine index on `embedding` (confirm live pgvector supports HNSW before
  applying; else `ivfflat`).
- Static coverage test `006_knowledge_chunk_embeddings.test.mjs`.

### 3. Embeddings module — `scripts/lib/embeddings/` (pure, no Supabase)
- `embedding-input.mjs` — `buildEmbeddingInput()` (deterministic normalized
  composed string) + `hashEmbeddingInput()`.
- `openai-embeddings-client.mjs` — thin `fetch` wrapper (`model`, batched
  `input`, `dimensions: 1536`), bounded retry, injectable `fetch` for tests.
- `embed-chunks.mjs` — staleness selection + orchestration; returns rows patched
  with `embedding / embedding_model / embedding_dimensions / embedded_input_hash
  / embedded_at`.
- Tests: `embedding-input.test.mjs`, `embed-chunks.test.mjs` (fake embedder, no
  network).

### 4. Service hooks — `web/lib/server/knowledge-service.ts`
- Demote-on-edit (item 4 above).
- After chunk text is written: if the resulting state is approved + non-brand,
  embed the doc's chunks inline (try/catch, best-effort); otherwise clear the
  four embedding columns for the doc's chunks.
- Import/resync paths unchanged (they never produce `approved`).

### 5. Reconciler — `scripts/embed-knowledge-chunks.mjs`
- Embeds approved, non-brand chunks with missing/stale vectors; clears vectors
  on chunks whose parent is no longer approved. `--dry-run` / `--limit` via
  `parseArgs`. `npm run embed:knowledge`. Idempotent.

### 6. Docs
- Update `APP_SCHEMA.md` (knowledge_chunks columns, embeddings module, new
  script) and `README.md` (Development Status / Next Steps).

## Assumptions to confirm during build
1. Live pgvector supports HNSW (else ivfflat).
2. Demotion target = `in_review` for manual edits (resync stays
   `needs_optimization`).
3. OpenAI cost negligible at this volume.
