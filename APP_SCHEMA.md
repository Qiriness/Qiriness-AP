# APP_SCHEMA

Codebase navigator. Three separate Node/npm packages: root (`scripts/`), `web/`, `agent/`. Stack: Shopify (source of truth) -> Supabase/PostgreSQL (+pgvector) -> Next.js 14 App Router + TypeScript + React 18 dashboard (CSS Modules, no UI framework). AI provider: OpenAI.
Secrets live in one repo-root `.env.local`; `web/next.config.mjs` and `agent/src/config.mjs` both load it.
Conventions: `*.test.mjs` sit next to their source (`npm test` = `node --test`); every `.tsx` has a sibling `.module.css`. Neither is listed below.

## Map

```text
|-- *.md             # AGENTS (rules) · PRODUCT (design direction) · README (context + status)
|                    # AGENT_INTEGRATION_PLAN + Agent_Workflow (agent phases) · compliance pair:
|                    # SHOPIFY_PERSONAL_DATA_PROTECTION, MERCHANT_DATA_USE_DISCLOSURE
|-- package.json     # root scripts: sync:shopify:*, embed:knowledge, db:apply:migration, test
|-- shopify.app.toml # Shopify app scopes (read_discounts, pages/policies/themes)
|-- web/
|   |-- app/
|   |   |-- layout.tsx globals.css   # root layout · design tokens (teal palette, scale, radii)
|   |   |-- page.tsx                 # / -> /agent-setup redirect
|   |   |-- agent-setup/page.tsx     # Server Component: initial article+source fetch (no HTTP hop)
|   |   `-- api/knowledge/           # server-only Route Handlers -- see Knowledge API below
|   |       |-- shopify-sources/route.ts
|   |       |-- articles/route.ts               # GET list · POST create/import
|   |       |-- articles/[id]/route.ts          # PATCH edit · DELETE
|   |       `-- articles/[id]/resync/route.ts   # POST re-pull from Shopify
|   |-- components/
|   |   |-- icons.tsx                # inline SVG icon set
|   |   |-- app-shell/               # AppShell (top bar + mobile drawer) · Sidebar (nav, store footer)
|   |   |-- ui/                      # Button (all states) · StatusChip (status + error pills)
|   |   `-- agent-setup/
|   |       |-- AgentSetup.tsx SetupHeader.tsx # orchestrator (all mutations) · readiness header
|   |       |-- ArticleLibrary.tsx   # left pane: search, filters, core checklist, category groups
|   |       |-- CollapsibleSection.tsx CoreTopicPlaceholder.tsx ArticleListItem.tsx
|   |       |-- ArticleWorkspace.tsx # right pane: source, sync state, category select, editor
|   |       |-- BrandVoiceWorkspace.tsx # right pane for the singleton brand-voice article
|   |       |-- WorkspaceHeader.tsx EditorFooter.tsx # shared by both workspaces above
|   |       |-- RichTextEditor.tsx   # dependency-free contentEditable + Preview toggle
|   |       `-- SourcePageSelect.tsx CategorySelect.tsx ChipList.tsx WorkspaceActions.tsx
|   |                                # EmptyWorkspace.tsx LoadError.tsx Toast.tsx
|   |-- lib/
|   |   |-- types.ts             # Article/status/sync UI types, CoreTopic + CORE_TOPIC_* tables
|   |   |-- knowledge-mapper.ts  # isomorphic API JSON -> UI types (shared by both fetch paths)
|   |   |-- api/knowledge.ts     # client-side fetch wrapper for mutations
|   |   |-- relative-time.ts demo-data.ts # "2h ago" labels · static sidebar branding only
|   |   `-- server/              # knowledge-service.ts (all business logic; imports scripts/lib/*) ·
|   |                            # knowledge-errors.ts (typed errors -> HTTP status)
|   |-- next.config.mjs          # loads root .env.local; outputFileTracingRoot; cpus:1; staleTimes 0
|   `-- tsconfig.json            # allowJs, so knowledge-service.ts can import scripts/lib/*.mjs
|-- scripts/                     # sync orchestrators (one per Shopify resource)
|   |-- sync-shopify-{products,customers,orders,promotions}.mjs
|   |-- sync-shopify-content-catalog.mjs # page+policy names/handles -> shopify_content_sources
|   |                                    # sync-shopify-nightly.mjs runs them all in order
|   |-- embed-knowledge-chunks.mjs apply-supabase-migration.mjs # embedding reconciler · SQL runner
|   |-- process-shopify-compliance-webhook.mjs # compliance webhook CLI harness
|   `-- lib/
|       |-- shopify-admin-client.mjs shopify-knowledge-client.mjs shopify-theme-client.mjs
|       |-- shopify-*-mapper.mjs         # shop/product/metaobject/customer/order/promotion row mappers
|       |-- shopify-sync-mappers.mjs shop-sync-service.mjs # mapper barrel · shared shop upsert
|       |-- supabase-rest-client.mjs sync-config.mjs      # REST upserts · CLI/env parsing
|       |-- hash.mjs collections.mjs html-to-text.mjs text-cleaning.mjs # incl. French mojibake fix
|       |-- compliance-audit.mjs shopify-compliance-webhooks.mjs # audit logs · HMAC + redaction
|       |-- support-taxonomy.mjs         # THE shared vocabulary: 14 subjects (+faq/brand_story
|       |                                # knowledge-only) · 4 request kinds · level + team derivation
|       |-- knowledge-{chunker,categories,document-mapper,navigation}.mjs # chunking · category
|       |                                # inference · page->row mapping · menus -> header/footer
|       |-- embeddings/
|       |   |-- embedding-input.mjs      # composed input (title+category+heading+text) + its hash
|       |   |-- openai-embeddings-client.mjs # text-embedding-3-small, 1536d, batching + retry
|       |   `-- embed-chunks.mjs         # pure staleness gate; returns column patches, no DB
|       `-- knowledge/
|           |-- source-discovery.mjs knowledge-source-resolver.mjs # identity · resolver ordering
|           |-- content-resolvers/       # manual-override -> page-metafield -> page-body -> theme-template
|           |-- template-traversal.mjs   # generic Shopify JSON template walker (skips disabled)
|           `-- template-extractors/     # section-type -> semantic units: index (registry), faq, rich-
|                                        # text, media-text, accordion, generic-fallback (low confidence),
|                                        # text-utils, placeholder-strings (denylist)
|-- agent/                       # always-on worker (own package.json; reuses scripts/lib/*)
|   `-- src/
|       |-- index.mjs config.mjs # entrypoint (--once) · env/tunables + Graph credential gate
|       |-- lib/ llm/            # logger (JSON, no PII) · shop.mjs · openai-client (Chat
|       |                        # Completions + Structured Outputs, injectable fetch/retry)
|       |-- ingestion/
|       |   |-- graph-client.mjs graph-message-mapper.mjs # Graph auth + delta fetch · pure mapper
|       |   |-- delta-poller.mjs         # follows delta pages, persists cursor, runs both gates
|       |   |-- ticket-writer.mjs        # thread by conversationId, idempotent message upsert
|       |   |-- spam-gate.mjs blocklist-store.mjs spam-classifier.mjs # pass 1 (rules) · pass 2 (LLM)
|       |   `-- spam-audit.mjs           # pure reason/row building + buffer -> spam_audit store
|       `-- tools/               # add-blocklist.mjs (blocklist:add) · reset-cursor.mjs (ingest:reset)
`-- supabase/migrations/         # 001 core schema · 002 promotions · 003 content catalog + Agent
                                 # Setup columns · 004 voice_profile · 005 core_topic constraint fix
                                 # · 006 chunk embeddings · 007+008 tickets · 009 email_blocklist
                                 # · 010 spam_audit · 011 knowledge taxonomy rename + constraint
                                 # · 012 ticket subjects/request kinds (010-012 applied to dev)
```

## Database Map

**Shopify snapshots** -- Shopify stays source of truth, all syncs idempotent. Every table has RLS on with no policies, so access is service-role only.
- `shops` - shop records, environment, app settings, `sync_cursors` (incl. the mail delta link).
- `customers` - lean support snapshots: contact lookup, marketing state, coarse location, lifetime totals, last order, Shopify `rfm_group` (`CHAMPIONS`/`LOYAL`/...). No addresses or notes.
- `orders` - identity, order/customer links, channel (`source_name` raw vs `sales_channel` label), derived `order_status`, totals, line items, fulfillments, returns, refunds. Contact fields are hashes (`customer_email_hash`, `customer_phone_hash`); `shipping_destination` is coarse only (no street/postcode). Retention: delivered or completed return/refund +3mo, undelivered or unresolved +6mo -> `retention_delete_after`, deleted by the order sync.
- `products` - snapshots + first-class metafields (Usage Instructions, Short description, Conseils d'utilisation, Actifs & ingredients, ingredients popup, Product Ingredients), `variants` jsonb, product-level `available_stock`.
- `promotions` - discount snapshots, one row per redeem code (`code = null` for automatic), `applies_once_per_customer` first-class. Full sync deletes rows Shopify no longer returns.
- `shopify_metaobjects` - shared metaobjects (FAQ, ingredient lists) referenced by products.
- `shopify_content_sources` - content-free catalog of every live page **and** policy, keyed `source_type` (`shopify_page`|`shopify_policy`) + `shopify_source_id`. Feeds the Agent Setup dropdown only; loosely coupled to `knowledge_documents` (no FK).

**Support taxonomy** (`scripts/lib/support-taxonomy.mjs`) -- one vocabulary, two consumers. **Subjects** (14: order, delivery, return_exchange, product, product_stock, payment, account, promotions, cosmetovigilance, legal_privacy, b2b, partner_collaboration, careers, other) are shared by `knowledge_documents.category` and `tickets.category`, so a ticket's subject filters straight into matching knowledge chunks with no mapping. `faq` + `brand_story` are knowledge-only (an article is reference material; nobody emails "an FAQ"). **Request kinds** (question/problem/complaint/contact) are tickets-only and stored separately from the subject -- never composed into one value like `order_problem`, which would need stripping for every knowledge lookup and make the categoriser pick 1-of-23 instead of 1-of-14 plus 1-of-4. `complaint` is a kind, not a subject, so a delivery complaint is (delivery, complaint). Both axes constrained in the database (011/012).

**Curated knowledge** -- never auto-synced; every row is an explicit import or a hand-written article.
- `knowledge_documents` - `content_html` is the editor's source of truth (`content_text`/`sections` regenerate on save); `approval_status` (draft/in_review/approved/needs_optimization) is independent of Shopify's publish `status`; `core_topic` is one of 6 slots (order_policies, brand, confidentiality, delivery_returns, locations, faqs), max one article per shop per slot; `voice_profile` jsonb holds the brand-voice fields.
- `knowledge_chunks` - retrieval chunks (category, tokens, text, `content_hash`, `embedding vector(1536)` + HNSW cosine). Determinism metadata: `embedding_model`, `embedding_dimensions`, `embedded_input_hash`, `embedded_at`.

**Agent email workflow** -- see `AGENT_INTEGRATION_PLAN.md`.
- `tickets` - one per Graph `conversationId` (unique `shop_id` + `graph_conversation_id`), not per email. Categoriser fills `category` + `request_kind` (and the optional `secondary_category` + `secondary_request_kind` pair, for an email raising two subjects of different kinds — a secondary kind without a secondary subject is rejected), `level` 1-4, `responsible_team` (finance/marketing/sales/logistics/contact), `shopify_order_number`, `customer_id`. **`level` is derived** from (subject, kind) by `defaultLevel()`, and the categoriser may only escalate above that floor, never below — cosmetovigilance is always 4, a legal_privacy problem/complaint is 4. Deriving it stops two model-assigned fields contradicting each other on the same "needs action" axis. `resolved_context` jsonb + `context_resolved_at` is a re-resolvable order/customer bundle for the drafting agent (holds PII, never billing/street address). `priority` 1-5. Retention mirrors `orders` (`resolved_at`/`closed_at`/`archived_at`/`retention_delete_after`); `deleted_at` is the separate compliance soft-delete. Stores only `requester_email_hash` + `requester_name`.
- `ticket_messages` - one row per Graph message, idempotent on `shop_id` + `graph_message_id`. Reply envelope (`from_email`, `to_emails`, `cc_emails`), cleaned `body_text`, sanitised payload, and body `embedding vector(1536)` + HNSW for similar-ticket retrieval.
- `email_blocklist` - per-shop sender email/domain rules with `hit_count`/`last_hit_at`; matched mail is dropped before any write.
- `spam_audit` - one row per spam-gate decision, idempotent on `shop_id` + `graph_message_id`: `outcome` (`kept`/`blocked`), `decided_by` (`blocklist`/`llm`), a one-line `reason`, plus `label`, `model`, `blocklist_rule_id`, and `failed_open` (kept only because the classifier errored). Exists because both passes drop mail before any write, so a blocked email would otherwise leave no trace. Keeps `from_email` + `subject` — the deliberate narrow exception to not storing blocked mail, needed to review a decision and build a rule from it — but **never the body**. Untriaged replies produce no row.

- `integration_events` - metadata-only sync/webhook log, idempotent on `event_key`. `privacy_requests` - Shopify compliance webhook lifecycle (hashed contacts, deletion counts).
- `data_access_events` - personal-data access audit trail. Sync paths write service events; **future dashboard user views must write human access events here.**

## Knowledge API

Server-only Route Handlers under `web/app/api/knowledge/`, all using the Supabase service-role key. Logic lives in `web/lib/server/knowledge-service.ts`, which imports `scripts/lib/*` directly (same resolver, mapper, chunker as the sync scripts) rather than duplicating it.
- `GET shopify-sources` - the catalog (pages + policies), flagging what is already imported. `GET articles` / `POST articles` - list; create empty, or resolve a `sourceId`'s live Shopify content and fill it in.
- `PATCH articles/:id` - title/content/category/core-topic/status. Converts `source_type` to `manual`; demotes an `approved` article to `in_review` when its text changes; re-embeds approved non-brand chunks inline (best-effort).
- `POST articles/:id/resync` - re-pull from the linked source; 400 once `manual`. `DELETE articles/:id` - hard delete (chunks cascade); the source stays re-importable.

## Agent Worker

Ingestion (Phase 1 + 2; categorisation, tools, and drafting are not built yet). Run `npm run ingest:once` or `npm start` from `agent/`.
1. `index.mjs` loads config, asserts Graph credentials, resolves `shops.id` for `SHOPIFY_STORE_DOMAIN`.
2. `delta-poller.mjs` reads `shops.sync_cursors.mail_ingest_delta_link` and follows Graph pages to the `@odata.deltaLink`, writing the cursor back so restarts resume. The delta query is the source of truth -- a future change-notification subscription would only trigger this engine.
3. `graph-message-mapper.mjs` maps each message to row fields, cleans the body via `htmlToText`, hashes the sender with `hashIdentifier` so it matches `orders.customer_email_hash`.
4. **Gate 1** (no LLM): `email_blocklist` email/domain match -> dropped before any write, hit counts recorded.
5. `ticket-writer.mjs` threads survivors by conversation; store interface injected for tests.
6. **Gate 2** (LLM, new conversations only): `spam-classifier.mjs` (`gpt-4o-mini`, Structured Outputs) drops spam before insert. Replies into existing tickets are never triaged, and it **fails open** on any error or missing key.
7. Every decision from either gate buffers in a `spam-audit.mjs` collector and flushes once per poll into `spam_audit`. The flush is best-effort — a failed audit write is logged, never fatal, since a retried poll must not re-drop mail.

## Invariants

- Nothing auto-writes `knowledge_documents`; the catalog sync only fills `shopify_content_sources`. `source_type` -> `manual` **is** the manual-edit lock — no separate flag, and resync is then unavailable.
- A chunk holds a vector **iff** its parent document is currently `approved` and not brand-voice, and the vector matches the current input hash + model + dimensions. Unapproving regenerates chunks vectorless. Embedding runs both inline (on approval, best-effort) and via the reconciler. `embedded_input_hash` covers title + category too, so a rename invalidates the vector even though `content_hash` ignores it.
- Spam is never stored -- both gates drop mail before the first insert. `spam_audit` is the only trace of a dropped email (decision + sender + subject, never the body), so it is what makes a wrong drop reviewable at all.
- Unfilled core-topic slots are client-side placeholders, never database rows; clicking one creates a pre-filled draft.
- Editing an already-applied migration requires re-applying it (or a corrective migration) against dev -- see `005`.

## Read Order

`AGENTS.md` (rules) -> this map -> `PRODUCT.md` (design direction) -> `README.md` (context, status, setup). Then as needed: `AGENT_INTEGRATION_PLAN.md` for agent phases, `SHOPIFY_PERSONAL_DATA_PROTECTION.md` and `MERCHANT_DATA_USE_DISCLOSURE.md` for anything touching customer data.
