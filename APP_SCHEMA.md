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
|   |       |-- AgentSetup.tsx     # stateful orchestrator (articles, selection, save/sync/optimize/approve)
|   |       |-- SetupHeader.tsx    # title + readiness line + agent preview action
|   |       |-- ArticleLibrary.tsx # left pane: search, status filters, list, create, empty states
|   |       |-- ArticleListItem.tsx # one article row
|   |       |-- ArticleWorkspace.tsx # right pane: title, source, sync state, editor, context, actions
|   |       |-- RichTextEditor.tsx # dependency-free contentEditable editor + Preview toggle
|   |       |-- SourcePageSelect.tsx # accessible Shopify source-page listbox
|   |       |-- ContextSummary.tsx # brand voice + tone summary panel
|   |       |-- WorkspaceActions.tsx # Save draft / Optimize draft / Approve for agent
|   |       |-- EmptyWorkspace.tsx # no-selection state
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
|   `-- lib/
|       |-- compliance-audit.mjs        # sanitized compliance event and access logging helpers
|       |-- collections.mjs              # shared collection/object helpers
|       |-- hash.mjs                     # stable JSON hashing helper
|       |-- html-to-text.mjs             # Shopify HTML to cleaned plain text/sections
|       |-- knowledge-categories.mjs     # loose support category inference
|       |-- knowledge-chunker.mjs        # knowledge document chunk generation
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
|           `-- content-resolvers/
|               |-- manual-override-resolver.mjs # optional local canonical text override
|               |-- page-metafield-resolver.mjs # dedicated AI/support page metafield content
|               |-- page-body-resolver.mjs      # Shopify Page.body content
|               `-- theme-template-resolver.mjs # Shopify theme template/section settings fallback
`-- supabase/
    `-- migrations/
        |-- 001_initial_schema.sql # consolidated Supabase schema for shops, customers, orders, products, knowledge, and compliance metadata
        |-- 002_promotions.sql # Shopify promotion and discount snapshot table
        |-- 003_knowledge_page_catalog.sql # shopify_content_sources catalog table (pages + policies) + knowledge_documents columns for the Agent Setup workflow
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
  - Stores source identity, navigation area, loose category, French canonical text, and parsed sections, plus the dashboard-workflow columns added in `003_knowledge_page_catalog.sql`: `content_html` (rich-text source of truth for the editor; `content_text`/`sections` are regenerated from it on every save/import/resync), `approval_status` (draft/in_review/approved/needs_optimization, independent of the Shopify-publish `status` column), and `core_topic` (optional one-of-seven required-knowledge slot: order_policies, brand, confidentiality, delivery, returns_exchanges, locations, faqs — at most one active article per shop per slot).
  - `source_type` is `shopify_page`, `shopify_policy`, or `manual`. Editing an imported article in the dashboard converts `source_type` to `manual` (keeping `shopify_source_id`/`handle` for provenance) — that conversion **is** the mechanism that stops it from being resynced; there is no separate "locally modified" flag.
  - Page content is resolved in priority order: manual override, dedicated page metafield, Shopify `Page.body`, then theme template settings; policy content comes directly from Shopify's `shop.shopPolicies`, which has no per-item resolver chain.
- `public.knowledge_chunks` - Lean retrieval chunks linked to knowledge documents.
  - Keeps chunk category, token count, text, hash, and optional vector embedding; document-level source fields stay on `knowledge_documents`.
  - Chunks are regenerated for each synced or edited document so changed source text does not leave stale chunks behind.
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
- `PATCH /api/knowledge/articles/:id` - saves title/content/category/core-topic/approval-status edits; converts `source_type` to `manual` if the article had a Shopify source (see the `source_type` note above — this is the whole lock mechanism).
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
- Frontend data: `web/lib/demo-data.ts` is trimmed to just the sidebar's static branding (`TEAM_MEMBER`); all article/source data is real, from the Knowledge API. The "core setup" checklist for the 7 core topics has no UI yet (`Article.coreTopic` round-trips through the API already, just unused by any component).
- Migrations: consolidated `001_initial_schema.sql` defines core operational tables; `002_promotions.sql` adds Shopify promotion snapshots; `003_knowledge_page_catalog.sql` adds the unified `shopify_content_sources` catalog table and the Agent Setup workflow columns on `knowledge_documents`. Reconciled and confirmed applied correctly to the dev Supabase database (the table was originally created under a different, superseded name/shape — this has been fixed).
- Known issue: the theme-template fallback resolver (`scripts/lib/knowledge/content-resolvers/theme-template-resolver.mjs`) leaked raw Shopify section-setting tokens into imported content for at least one real page during live testing — its content-vs-setting heuristic needs tightening. Only affects pages with no usable page metafield or `Page.body`, which fall through to this last-resort resolver.
- Dev-environment note: Next.js dev mode's jest-worker pool was crashing on the Knowledge API routes (likely from the cross-package `.mjs` import graph); fixed with `experimental.cpus: 1` in `web/next.config.mjs`.
- Scripts: Shopify product/metaobject sync, customer sync, order sync, promotion sync, unified content-catalog sync (pages + policies), nightly sync orchestration, and compliance webhook CLI harness added
- Script modules: Shopify sync, compliance audit, compliance webhook, persistence, config, mapper, hashing, chunking, and text-cleaning modules added or split into focused units
- Tests: Node built-in regression tests added for Supabase REST bulk payload normalization, customer consent/RFM mapping, order privacy/channel/retention mapping, promotion mapping/migration coverage, nightly schedule/order (now including the content-catalog step), compliance/order/knowledge-page-catalog migrations, and webhook redaction/HMAC (43 tests, all passing)
- Config: frontend app config present in `web/` (Next.js, TypeScript, ESLint, `allowJs` for the cross-package knowledge-service import); backend/deploy config still pending
- Compliance docs: Shopify personal data protection checklist and merchant data-use disclosure added
