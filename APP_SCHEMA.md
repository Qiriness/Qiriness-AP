# APP_SCHEMA

## Stack

- Shopify
- Supabase
- PostgreSQL
- Frontend app: Next.js (App Router) + TypeScript + React 18, in `web/` (CSS Modules, no UI framework)
- Backend/sync: Node ESM scripts at repo root (`scripts/`), separate `package.json` from `web/`

## Route Map

```text
/
|-- README.md          # project overview
|-- PRODUCT.md         # impeccable product context for dashboard design direction
|-- AGENTS.md          # agent rules
|-- CLAUDE.md          # claude agent pointer
|-- APP_SCHEMA.md      # repo map
|-- MERCHANT_DATA_USE_DISCLOSURE.md # merchant-facing Shopify data-use disclosure draft
|-- SHOPIFY_PERSONAL_DATA_PROTECTION.md # Shopify protected customer data checklist
|-- package.json       # Node scripts for Shopify/Supabase sync (root; type: module)
|-- web/               # Next.js + TypeScript dashboard app (own package.json)
|   |-- app/
|   |   |-- layout.tsx        # root layout, Plus Jakarta Sans font, metadata
|   |   |-- globals.css       # design tokens (teal palette, scale, radii) + base styles
|   |   |-- page.tsx          # redirects / -> /agent-setup
|   |   `-- agent-setup/
|   |       `-- page.tsx      # Agent Setup route (renders AppShell + AgentSetup)
|   |-- components/
|   |   |-- icons.tsx         # single coherent inline SVG icon set
|   |   |-- app-shell/
|   |   |   |-- AppShell.tsx  # top bar + sidebar slot + mobile drawer state
|   |   |   `-- Sidebar.tsx   # primary nav (Agent Setup active; others "Soon"), store footer, collapse
|   |   |-- ui/
|   |   |   |-- Button.tsx    # shared button, all states (hover/focus/active/disabled/loading)
|   |   |   `-- StatusChip.tsx # article status pill + error chip (semantic colors)
|   |   `-- agent-setup/
|   |       |-- AgentSetup.tsx     # stateful orchestrator (articles, selection, save/sync/optimize/approve/unapprove/delete)
|   |       |-- SetupHeader.tsx    # title + readiness line + agent preview action
|   |       |-- ArticleLibrary.tsx # left pane: search, status filters, Drafting agent setup (Brand voice slot), Core setup checklist, category-grouped articles, create, empty states
|   |       |-- CollapsibleSection.tsx # generic collapsible group (Drafting agent setup, Core setup checklist, per-category article groups)
|   |       |-- CoreTopicPlaceholder.tsx # dashed "Not started" row for an empty core-topic slot (incl. the Brand voice slot); click creates a pre-filled draft
|   |       |-- ArticleListItem.tsx # one article row
|   |       |-- WorkspaceHeader.tsx # shared back-button + title input + status chip, used by both workspaces below
|   |       |-- EditorFooter.tsx   # shared word-count + save-state indicator shown under the rich-text editor, used by both workspaces below
|   |       |-- ArticleWorkspace.tsx # right pane for ordinary articles: source, sync state, category, editor; composes WorkspaceHeader/EditorFooter
|   |       |-- BrandVoiceWorkspace.tsx # right pane for the singleton Brand voice article (coreTopic === "brand"): role description, tone/voice, fixed response-framework/guardrails placeholders (ChipList), general context; composes WorkspaceHeader/EditorFooter — no source picker or category select
|   |       |-- ChipList.tsx       # read-only tag list (inline pill chips or vertical rows) for the fixed Response framework / Guidelines placeholders
|   |       |-- RichTextEditor.tsx # dependency-free contentEditable editor + Preview toggle
|   |       |-- SourcePageSelect.tsx # accessible Shopify source-page listbox
|   |       |-- CategorySelect.tsx # accessible knowledge-category listbox
|   |       |-- WorkspaceActions.tsx # Save draft / Optimize draft / Approve for agent / Unapprove / Delete article (two-step confirm)
|   |       |-- EmptyWorkspace.tsx # no-selection state
|   |       |-- LoadError.tsx      # shown when the server-side initial fetch fails (missing config, shop not synced)
|   |       `-- Toast.tsx          # transient feedback (aria-live)
|   |-- app/api/knowledge/         # server-only Route Handlers backing Agent Setup (see Knowledge API below)
|   |   |-- shopify-sources/route.ts     # GET: live Shopify page + policy catalog for the source dropdown
|   |   |-- articles/route.ts            # GET list, POST create (optionally imports a Shopify page or policy)
|   |   |-- articles/[id]/route.ts       # PATCH edit (title/content/category/core topic/status), DELETE
|   |   `-- articles/[id]/resync/route.ts # POST re-pull from the linked Shopify source (400 once the article is manual)
|   |-- lib/
|   |   |-- types.ts         # Article/ArticleStatus/SyncState/SaveState/ShopifyPage UI types
|   |   |-- demo-data.ts     # static dummy articles + Shopify pages (no real customer data; still used by the UI until it's wired to the API above)
|   |   `-- server/
|   |       |-- knowledge-service.ts # server-only service backing the Knowledge API; imports scripts/lib directly (see Knowledge API below)
|   |       `-- knowledge-errors.ts  # typed errors -> HTTP status mapping for the knowledge API routes
|   |-- next.config.mjs      # sets experimental.outputFileTracingRoot to the repo root for the scripts/lib import below
|   |-- tsconfig.json        # allowJs: true, so knowledge-service.ts can import scripts/lib/*.mjs directly
|   `-- package.json         # next/react/typescript; scripts: dev/build/start/lint/typecheck
|-- scripts/
|   |-- apply-supabase-migration.mjs # SQL migration runner using SUPABASE_DB_URL
|   |-- process-shopify-compliance-webhook.mjs # CLI harness for compliance webhook handler
|   |-- sync-shopify-products.mjs # Shopify product/metaobject sync orchestration
|   |-- sync-shopify-customers.mjs # Shopify customer sync orchestration
|   |-- sync-shopify-orders.mjs # Shopify order sync orchestration and retention cleanup
|   |-- sync-shopify-promotions.mjs # Shopify promotion/discount sync orchestration
|   |-- sync-shopify-content-catalog.mjs # lightweight nightly sync of all Shopify page + policy names/handles into shopify_content_sources (dropdown catalog only, no content, nothing writes to knowledge_documents)
|   |-- sync-shopify-nightly.mjs # nightly Shopify sync orchestrator
|   |-- sync-shopify-nightly.test.mjs # nightly schedule/order tests
|   |-- embed-knowledge-chunks.mjs # reconciler: embeds approved/non-brand chunks with missing/stale vectors, clears vectors on no-longer-approved chunks (safety net for the web service's inline embedding; idempotent; --dry-run/--limit)
|   `-- lib/
|       |-- compliance-audit.mjs        # sanitized compliance event and access logging helpers
|       |-- collections.mjs              # shared collection/object helpers
|       |-- hash.mjs                     # stable JSON hashing helper
|       |-- html-to-text.mjs             # Shopify HTML to cleaned plain text/sections
|       |-- knowledge-categories.mjs     # loose support category inference
|       |-- knowledge-chunker.mjs        # knowledge document chunk generation
|       |-- embeddings/
|       |   |-- embedding-input.mjs        # deterministic composed embed input (title + category + heading + chunk_text) + stable hash; distinct from content_hash so a title/category rename invalidates the vector
|       |   |-- openai-embeddings-client.mjs # dependency-free fetch wrapper for OpenAI /v1/embeddings (text-embedding-3-small, 1536 dims), batching + retry, injectable fetch for tests
|       |   `-- embed-chunks.mjs           # pure staleness gate + orchestration (shared by web service inline path and the reconciler); returns column patches, no Supabase
|       |-- knowledge-document-mapper.mjs # Shopify page/policy to knowledge_documents rows
|       |-- knowledge-navigation.mjs     # Shopify menu to navigation-area metadata
|       |-- shopify-theme-client.mjs     # read-only Shopify theme/asset client for template fallback
|       |-- shopify-admin-client.mjs     # Shopify Admin API queries and pagination
|       |-- shopify-compliance-webhooks.mjs # Shopify compliance webhook HMAC, privacy request, and redaction logic
|       |-- shopify-compliance-webhooks.test.mjs # compliance webhook tests
|       |-- shopify-customer-mapper.mjs  # Shopify customer to customers row mapper, including RFM group
|       |-- shopify-customer-mapper.test.mjs # customer mapper privacy/consent tests
|       |-- shopify-order-mapper.mjs # Shopify order to orders row mapper, including retention metadata
|       |-- shopify-order-mapper.test.mjs # order mapper privacy/channel/retention tests
|       |-- shopify-promotion-mapper.mjs # Shopify discount/promotion row mapper
|       |-- shopify-promotion-mapper.test.mjs # promotion mapper tests
|       |-- shopify-knowledge-client.mjs # Shopify pages (list + single-by-id), policies, and menus reader
|       |-- shopify-metaobject-mapper.mjs # Shopify metaobject row mapping
|       |-- shopify-product-mapper.mjs   # Shopify product row mapping
|       |-- shopify-shop-mapper.mjs      # Shopify shop row mapping
|       |-- shopify-sync-mappers.mjs     # mapper barrel exports
|       |-- shop-sync-service.mjs        # shared Shopify shop row upsert
|       |-- supabase-rest-client.mjs     # Supabase REST upsert client
|       |-- supabase-rest-client.test.mjs # Node regression tests for Supabase REST payload handling
|       |-- sync-config.mjs              # CLI/env parsing for sync scripts
|       |-- text-cleaning.mjs            # AI-facing French text normalization
|       `-- knowledge/
|           |-- source-discovery.mjs      # Shopify page identity/navigation source discovery (batch + single-page variants)
|           |-- knowledge-source-resolver.mjs # ordered content resolver coordinator
|           |-- template-traversal.mjs     # generic Shopify JSON template walker (order/block_order, disabled-skip); type-agnostic, no content logic
|           |-- content-resolvers/
|           |   |-- manual-override-resolver.mjs # optional local canonical text override
|           |   |-- page-metafield-resolver.mjs # dedicated AI/support page metafield content
|           |   |-- page-body-resolver.mjs      # Shopify Page.body content
|           |   `-- theme-template-resolver.mjs # Shopify theme template fallback; parses templates/page.*.json via template-extractors/
|           `-- template-extractors/       # section-type-keyed adapters (raw section -> typed semantic units), not per-page functions
|               |-- index.mjs              # registry: section type -> extractor, falls back to generic-fallback.mjs
|               |-- faq.mjs                # rich-text blocks = category markers, question blocks = one faq_item unit each
|               |-- rich-text.mjs          # heading/text blocks (or flat settings) -> one prose unit
|               |-- media-text.mjs         # re-exports rich-text.mjs (same shape on this theme)
|               |-- accordion.mjs          # one feature_item unit per block
|               |-- generic-fallback.mjs   # shallow allowlisted-key scan, confidence: low, for unrecognized section types
|               |-- text-utils.mjs         # shared HTML/Liquid-aware block text cleaning; flags liquid-type blocks for the trusted adapters to skip (fallback still extracts them at low confidence)
|               `-- placeholder-strings.mjs # exact-match denylist of Shopify starter-theme default block content
`-- supabase/
    `-- migrations/
        |-- 001_initial_schema.sql # consolidated Supabase schema for shops, customers, orders, products, knowledge, and compliance metadata
        |-- 002_promotions.sql # Shopify promotion and discount snapshot table
        |-- 003_knowledge_page_catalog.sql # shopify_content_sources catalog table (pages + policies) + knowledge_documents columns for the Agent Setup workflow
        |-- 004_brand_voice_profile.sql # adds knowledge_documents.voice_profile jsonb (structured brand-voice fields for the singleton Brand Voice article)
        |-- 004_brand_voice_profile.test.mjs # static migration coverage for the voice_profile column
        |-- 005_fix_core_topic_check_constraint.sql # re-applies 003's core_topic check constraint (combined delivery_returns slot) against the live database, which had drifted after 003 was edited post-apply
        |-- 005_fix_core_topic_check_constraint.test.mjs # static migration coverage asserting the re-added constraint has the combined slot, not the old split delivery/returns_exchanges
        |-- 006_knowledge_chunk_embeddings.sql # sizes knowledge_chunks.embedding to vector(1536), adds embedding_model/embedding_dimensions/embedded_input_hash/embedded_at determinism metadata + HNSW cosine index
        |-- 006_knowledge_chunk_embeddings.test.mjs # static migration coverage for the vector(1536) sizing, metadata columns, and ANN index
        |-- compliance-migrations.test.mjs # static migration coverage for compliance tables
        |-- orders-migration.test.mjs # static migration coverage for order table shape
        |-- promotions-migration.test.mjs # static migration coverage for promotion table shape
        `-- knowledge-page-catalog-migration.test.mjs # static migration coverage for shopify_content_sources + knowledge_documents additions
```

## Database Map

- `public.shops` - Shopify shop records, environment, app settings, and sync cursors.
- `public.customers` - Lean Shopify customer snapshots for support lookup and segmentation.
  - Stores contact lookup fields, email marketing subscription state, coarse default location, lifetime order count, lifetime amount spent, last-order summary, and Shopify-computed RFM group.
  - `on_email_marketing_list` is generated from Shopify email marketing state.
  - `rfm_group` comes from Shopify `Customer.statistics.rfmGroup` and matches Shopify customer segmentation values such as `CHAMPIONS`, `LOYAL`, `ACTIVE`, and `AT_RISK`.
  - Raw payloads intentionally exclude full addresses, notes, and unnecessary personal data.
- `public.orders` - Lean Shopify order snapshots for order tracking and support workflows.
  - Stores Shopify order identity, optional local/customer Shopify linkage, order name/number, raw source name, merchant-facing sales channel, dashboard-facing `order_status`, source Shopify status fields, totals, tags, line items, fulfillments, returns, refunds, and Shopify timestamps.
  - `order_status` is derived for datatable filtering/display from cancellation, return/refund, delivery, and fulfillment state.
  - `source_name` preserves Shopify's raw source/platform value, while `sales_channel` stores the dashboard label such as Online Store, POS, Amazon, or another marketplace.
  - Retention metadata uses `delivered_at`, `return_refund_opened_at`, `return_refund_completed_at`, `retention_rule`, and `retention_delete_after`: delivered orders can be deleted 3 months after delivery; completed return/refund cases can be deleted 3 months after completion; orders still not delivered after 6 months or still in an unresolved return/refund after 6 months can also be deleted from the local operational table.
  - Customer-adjacent lookup fields are hashes (`customer_email_hash`, `customer_phone_hash`) instead of duplicated raw contact values.
  - `shipping_destination` is a coarse JSONB object only; street address and postcode are intentionally excluded.
  - Raw payloads must be sanitized to exclude street addresses, raw contact values, payment details, and unnecessary personal data.
  - Synced by `scripts/sync-shopify-orders.mjs`; the sync upserts accessible Shopify orders and deletes local rows whose `retention_delete_after` has passed.
- `public.products` - Shopify product snapshots, structured product metafields, variants JSONB, and structured product-specific FAQs.
  - First-class Shopify metafields: Usage Instructions, Short description, Conseils d'utilisation, Actifs & ingredients, ingredients popup, Product Ingredients.
  - Product-level stock is stored in `available_stock` as a simple support/dashboard summary.
  - Product FAQ and Product Ingredients metafields can reference shared Shopify metaobjects by ID.
- `public.promotions` - Shopify discount and promotion snapshots for support lookup and manual filtering.
  - Stores code-based and automatic discounts returned by Shopify `discountNodes`.
  - Code discounts store one row per redeem code; automatic discounts store one row with `code = null`.
  - `applies_once_per_customer` is a first-class column for later manual filtering of one-use/customer-specific promotions.
  - Raw payloads and rule snapshots exclude customer targeting details and personal data.
  - Synced by `scripts/sync-shopify-promotions.mjs`; a full non-limited sync deletes local rows no longer returned by Shopify.
- `public.shopify_metaobjects` - Shared Shopify metaobject snapshots, such as predefined FAQ and ingredient records linked from products.
  - The sync stores targeted full metaobject definitions/entries from Shopify Metaobjects, plus any product-linked entries.
  - AI-facing product/metaobject text is cleaned for common French mojibake before storage; raw Shopify payloads remain unmodified for traceability.
- `public.shopify_content_sources` - Unified, content-free catalog of every live Shopify Online Store page **and** shop policy (refund, privacy, shipping, terms of service, etc.), keyed by `source_type` ('shopify_page' | 'shopify_policy') + `shopify_source_id`. Populates the single Agent Setup "Shopify source" dropdown without pulling any body content for sources nobody has chosen to use yet.
  - Synced by `scripts/sync-shopify-content-catalog.mjs`; a full non-limited sync deletes local rows no longer returned by Shopify. Nothing here ever writes to `knowledge_documents` — that table is populated only by explicit user action.
  - Loosely coupled to `knowledge_documents` via matching `source_type` + `shopify_source_id` values, not a foreign key.
- `public.knowledge_documents` - Curated knowledge articles for AI support context and the Agent Setup dashboard. Nothing auto-syncs into this table; every row exists because a team member either imported a Shopify page/policy or wrote a manual article (see Knowledge API below), per PRODUCT.md's curated-library principle.
  - Stores source identity, navigation area, loose category, French canonical text, and parsed sections, plus the dashboard-workflow columns added in `003_knowledge_page_catalog.sql`: `content_html` (rich-text source of truth for the editor; `content_text`/`sections` are regenerated from it on every save/import/resync), `approval_status` (draft/in_review/approved/needs_optimization, independent of the Shopify-publish `status` column), and `core_topic` (optional one-of-six required-knowledge slot: order_policies, brand, confidentiality, delivery_returns, locations, faqs — at most one active article per shop per slot; delivery and returns/exchanges are intentionally one combined slot, not two).
  - `source_type` is `shopify_page`, `shopify_policy`, or `manual`. Editing an imported article in the dashboard converts `source_type` to `manual` (keeping `shopify_source_id`/`handle` for provenance) — that conversion **is** the mechanism that stops it from being resynced; there is no separate "locally modified" flag.
  - Page content is resolved in priority order: manual override, dedicated page metafield, Shopify `Page.body`, then theme template settings; policy content comes directly from Shopify's `shop.shopPolicies`, which has no per-item resolver chain.
- `public.knowledge_chunks` - Lean retrieval chunks linked to knowledge documents.
  - Keeps chunk category, token count, text, hash, and optional vector embedding; document-level source fields stay on `knowledge_documents`.
  - Chunks are regenerated for each synced or edited document so changed source text does not leave stale chunks behind. Regeneration carries a chunk's embedding forward (matched on `content_hash`) **only while the parent document is approved**; for a non-approved document the regenerated chunks are vectorless, which is how "delete on unapprove" happens.
  - `embedding` is `vector(1536)` for `text-embedding-3-small` (see `006_knowledge_chunk_embeddings.sql`). A chunk holds a vector **iff** its parent document is currently `approved`, is not the brand-voice document, and the vector matches the current composed input + model + dimensions. Determinism metadata: `embedding_model`, `embedding_dimensions`, `embedded_input_hash` (hash of `title + category + section heading + chunk text`, so a category rename invalidates the vector even though `content_hash` ignores it), and `embedded_at`.
  - Embedding runs two ways ("both"): inline + best-effort inside `knowledge-service.ts` when a document becomes/stays approved (never fails the request), and via the `embed-knowledge-chunks.mjs` reconciler for backfill, retries, and model changes. Editing an approved article's text demotes it out of `approved` (to `in_review`), keeping the invariant free of an approved-but-unembedded state.
- `public.integration_events` - Metadata-only log for sync, webhook, and reconciliation events.
  - Uses `event_key` for idempotency and stores sanitized counts/errors instead of raw payloads.
- `public.privacy_requests` - Shopify compliance webhook lifecycle records.
  - Stores topic, shop/customer identifiers, hashed contact values, processing status, deletion counts, and sanitized metadata.
- `public.data_access_events` - Service-level personal-data access audit trail.
  - Current sync paths write service events; future dashboard user views must write human access events here.

## Knowledge API

Server-only Next.js Route Handlers under `web/app/api/knowledge/` that back the Agent Setup dashboard. All routes use the Supabase service-role key server-side (never exposed to the browser) since every table has row level security enabled with no policies defined — see `001_initial_schema.sql`. Business logic lives in `web/lib/server/knowledge-service.ts`, which imports directly from `scripts/lib/*` (the same resolver pipeline, mapper, and chunker the sync scripts use) rather than duplicating it; `web/tsconfig.json` sets `allowJs: true` and `web/next.config.mjs` sets `experimental.outputFileTracingRoot` to the repo root to support this cross-package import.

- `GET /api/knowledge/shopify-sources` - lists the `shopify_content_sources` catalog (pages + policies), flagging which are already imported as articles.
- `GET /api/knowledge/articles` - lists every `knowledge_documents` row for the shop, mapped to the dashboard's article shape.
- `POST /api/knowledge/articles` - creates an article. With `sourceId` (a `shopify_content_sources.id`), resolves that page or policy's live content from Shopify and fills it in immediately; without it, creates an empty standalone article.
- `PATCH /api/knowledge/articles/:id` - saves title/content/category/core-topic/approval-status edits; converts `source_type` to `manual` if the article had a Shopify source (see the `source_type` note above — this is the whole lock mechanism). Editing the title/content of an `approved` article without an explicit status demotes it to `in_review` (an approved article's text can't silently change under the agent). After chunk regeneration, an approved non-brand article's chunks are embedded inline (best-effort) via the embeddings pipeline; see `knowledge_chunks` above.
- `POST /api/knowledge/articles/:id/resync` - re-pulls the linked Shopify page or policy's content; 400 once the article is `manual` (nothing left to resync from).
- `DELETE /api/knowledge/articles/:id` - hard-deletes the article (chunks cascade via FK); the source stays in the catalog and can be re-imported later.

The frontend (`web/lib/demo-data.ts`, `web/components/agent-setup/*`) is not wired to these routes yet — that's the next step once this API is exercised against real Shopify/Supabase credentials.

## Read Order
1. [AGENTS.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/AGENTS.md) - coding rules
2. [PRODUCT.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/PRODUCT.md) - dashboard design direction
3. [CLAUDE.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/CLAUDE.md) - agent 
4. [APP_SCHEMA.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/APP_SCHEMA.md) - repo map
5. [SHOPIFY_PERSONAL_DATA_PROTECTION.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/SHOPIFY_PERSONAL_DATA_PROTECTION.md) - protected customer data checklist
6. [MERCHANT_DATA_USE_DISCLOSURE.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/MERCHANT_DATA_USE_DISCLOSURE.md) - merchant-facing data use disclosure draft
7. [README.md](/C:/Users/gnoua/Desktop_backup/APP_DEV/03_Qiriness_Email/Qirines_Email_Automation/README.md) - product context and pointers

## Status

- App code: Next.js + TypeScript dashboard scaffolded in `web/`; first surface is the `Agent Setup` tab, fully wired to real Shopify/Supabase data end-to-end and verified live in-browser
- Routes: `/` (redirect) and `/agent-setup` (production-quality UI: article library, two-pane editor, source import/resync, save/optimize/approve/delete, responsive + a11y states)
- Knowledge API: `web/app/api/knowledge/*` Route Handlers for listing the unified Shopify source catalog and creating/editing/resyncing/deleting knowledge articles — see Knowledge API above. **Verified end-to-end against the real dev Shopify store and Supabase through the actual browser UI**: page import, policy import, edit-converts-to-manual (Resync correctly disappears), and delete were all exercised live, not just via curl. `web/components/agent-setup/AgentSetup.tsx` calls this API directly for all mutations; the initial article/source lists are fetched server-side in `web/app/agent-setup/page.tsx` (same process, no HTTP round-trip).
- Frontend data: `web/lib/demo-data.ts` is trimmed to just the sidebar's static branding (`TEAM_MEMBER`); all article/source data is real, from the Knowledge API. The Core setup checklist (6 topics) renders in `ArticleLibrary`, backed by `CoreTopic`/`CORE_TOPIC_LABELS`/`CORE_TOPIC_DEFAULT_CATEGORY`/`CORE_TOPICS` in `web/lib/types.ts`; unfilled slots are virtual placeholders (`CoreTopicPlaceholder`) computed client-side, never auto-created rows — clicking one calls `createArticle` with a pre-filled title/category/coreTopic. Non-core articles group by category (`CollapsibleSection` per category, only when ≥2 categories are present) below the checklist.
- Migrations: consolidated `001_initial_schema.sql` defines core operational tables; `002_promotions.sql` adds Shopify promotion snapshots; `003_knowledge_page_catalog.sql` adds the unified `shopify_content_sources` catalog table and the Agent Setup workflow columns on `knowledge_documents`. Reconciled and confirmed applied correctly to the dev Supabase database (the table was originally created under a different, superseded name/shape — this has been fixed). `006_knowledge_chunk_embeddings.sql` sizes `knowledge_chunks.embedding` to `vector(1536)` and adds embedding determinism metadata + an HNSW cosine index — **written, not yet applied to the dev database**.
- Resolved: the theme-template fallback resolver used to flatten every string setting in a Shopify JSON template (including disabled placeholder sections and presentation values) into one noisy blob per section. It now uses a type-aware pipeline (`scripts/lib/knowledge/template-traversal.mjs` + `template-extractors/`) — see the file map above — that skips `disabled` sections/blocks, dispatches by section type (FAQ, rich-text, media-text, accordion, or a shallow low-confidence fallback for unrecognized types), and gives the chunker (`knowledge-chunker.mjs`) a `unit_type` so FAQ answers and feature blocks each become exactly one retrieval chunk instead of being token-split. Dedicated adapters (FAQ/rich-text/accordion) still skip `liquid`-type blocks outright, but the generic fallback extracts their `code` field through the same HTML-cleaning pipeline as everything else (which strips embedded `<img src="data:...">` tags along with any other markup) and surfaces the result at `confidence: 'low'` for human review in the editor, rather than dropping it — a section that's pure layout/CSS with no real prose still yields nothing. Existing theme_template-origin articles (e.g. FAQ, La Marque) need a manual "Resync" from the dashboard to pick this up — nothing backfills automatically.
- Dev-environment note: Next.js dev mode's jest-worker pool was crashing on the Knowledge API routes (likely from the cross-package `.mjs` import graph); fixed with `experimental.cpus: 1` in `web/next.config.mjs`.
- Scripts: Shopify product/metaobject sync, customer sync, order sync, promotion sync, unified content-catalog sync (pages + policies), nightly sync orchestration, compliance webhook CLI harness, and the knowledge-chunk embedding reconciler (`embed-knowledge-chunks.mjs`, `npm run embed:knowledge`) added
- Script modules: Shopify sync, compliance audit, compliance webhook, persistence, config, mapper, hashing, chunking, text-cleaning, and embedding (`lib/embeddings/*`) modules added or split into focused units
- Tests: Node built-in regression tests added for Supabase REST bulk payload normalization, customer consent/RFM mapping, order privacy/channel/retention mapping, promotion mapping/migration coverage, nightly schedule/order (now including the content-catalog step), compliance/order/knowledge-page-catalog migrations, webhook redaction/HMAC, the embedding input composition + deterministic staleness gate, and the `006` embedding migration shape (95 tests, all passing)
- Config: frontend app config present in `web/` (Next.js, TypeScript, ESLint, `allowJs` for the cross-package knowledge-service import); backend/deploy config still pending
- Compliance docs: Shopify personal data protection checklist and merchant data-use disclosure added
