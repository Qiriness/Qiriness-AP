# APP_SCHEMA

Codebase navigator. Three separate Node/npm packages: root (`scripts/`), `web/`, `agent/`. Stack: Shopify (source of truth) -> Supabase/PostgreSQL (+pgvector) -> Next.js 14 App Router + TypeScript + React 18 dashboard (CSS Modules, no UI framework). AI provider: OpenAI.
Secrets live in one repo-root `.env.local`; `web/next.config.mjs` and `agent/src/config.mjs` both load it.
Conventions: `*.test.mjs` sit next to their source (`npm test` = `node --test`); every `.tsx` has a sibling `.module.css`. Neither is listed below.

## Map

```text
|-- *.md             # AGENTS (rules) · PRODUCT (design direction) · README (context + status)
|                    # VALIDATION_LOG (built but unproven against real data)
|                    # AGENT_INTEGRATION_PLAN + Agent_Workflow (agent phases) · compliance pair:
|                    # SHOPIFY_PERSONAL_DATA_PROTECTION, MERCHANT_DATA_USE_DISCLOSURE
|-- package.json     # root scripts: sync:shopify:*, embed:knowledge, db:apply:migration, test
|-- shopify.app.toml # Shopify app scopes (read_discounts, pages/policies/themes)
|-- web/
|   |-- app/
|   |   |-- layout.tsx globals.css   # root layout · design tokens (teal palette, scale, radii)
|   |   |-- page.tsx                 # / -> /agent-setup redirect
|   |   |-- agent-setup/page.tsx     # Server Component: initial article+source fetch (no HTTP hop)
|   |   |-- tickets/page.tsx         # Server Component: the agent's queue, read-only -- see below
|   |   |-- settings/page.tsx        # Server Component: forwarding address book -- see below
|   |   |-- api/forwarding/route.ts  # GET all 14 categories · PUT upsert one
|   |   `-- api/knowledge/           # server-only Route Handlers -- see Knowledge API below
|   |       |-- shopify-sources/route.ts
|   |       |-- articles/route.ts               # GET list · POST create/import
|   |       |-- articles/[id]/route.ts          # PATCH edit · DELETE
|   |       `-- articles/[id]/resync/route.ts   # POST re-pull from Shopify
|   |-- components/
|   |   |-- icons.tsx                # inline SVG icon set
|   |   |-- app-shell/               # AppShell (top bar + mobile drawer) · Sidebar (nav, store footer)
|   |   |-- ui/                      # Button (all states) · StatusChip (status + error pills)
|   |   |-- settings/                # ForwardingSettings (address book, saves per row on blur)
|   |   |-- tickets/                 # TicketsView (orchestrator: 3 sections, filters, mutations) ·
|   |   |                            # TicketSection (collapsible) · TicketStatCards (4 figures) ·
|   |   |                            # TicketTable · DroppedMailTable · LevelChip (severity pill) ·
|   |   |                            # HappinessFace (leading mood light: 1-2 green, 3 amber, 4 red)
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
|   |   |-- ticket-stats.ts      # isomorphic summariseTickets + isClosed (server and client)
|   |   |-- api/knowledge.ts     # client-side fetch wrapper for mutations
|   |   |-- relative-time.ts demo-data.ts # "2h ago" labels · static sidebar branding only
|   |   `-- server/              # knowledge-service.ts (all business logic; imports scripts/lib/*) ·
|   |                            # forwarding-service.ts (address book read/upsert) ·
|   |                            # tickets-service.ts (queue read + summariseTickets) ·
|   |                            # knowledge-errors.ts (typed errors -> HTTP status)
|   |-- next.config.mjs          # hydrates process.env from root .env.local via scripts/lib
|   |                            # loadEnv(); outputFileTracingRoot; cpus:1; staleTimes 0
|   `-- tsconfig.json            # allowJs, so knowledge-service.ts can import scripts/lib/*.mjs
|-- scripts/                     # sync orchestrators (one per Shopify resource)
|   |-- sync-shopify-{products,customers,orders,promotions}.mjs
|   |-- sync-shopify-content-catalog.mjs # page+policy names/handles -> shopify_content_sources
|   |                                    # sync-shopify-nightly.mjs runs them all in order
|   |-- embed-knowledge-chunks.mjs embed-ticket-messages.mjs # the two embedding reconcilers
|   |-- cluster-ticket-messages.mjs      # cluster:tickets -- recurring topics per subject
|   |                                    # customer mail only; --internal / --all-senders to widen
|   |-- apply-supabase-migration.mjs     # SQL runner
|   |-- process-shopify-compliance-webhook.mjs # compliance webhook CLI harness
|   `-- lib/
|       |-- shopify-admin-client.mjs shopify-knowledge-client.mjs shopify-theme-client.mjs
|       |-- shopify-*-mapper.mjs         # shop/product/metaobject/customer/order/promotion row mappers
|       |-- shopify-sync-mappers.mjs shop-sync-service.mjs # mapper barrel · shared shop upsert
|       |-- supabase-rest-client.mjs sync-config.mjs      # REST upserts · rpc · CLI/env parsing
|       |                            # every request sends cache:'no-store' — Next's Data Cache
|       |                            # otherwise pins the first response for a year (see module doc)
|       |                                # supabaseSelectAll pages past PostgREST's silent 1000-row cap
|       |-- hash.mjs collections.mjs html-to-text.mjs text-cleaning.mjs # incl. French mojibake fix
|       |-- quoted-reply.mjs           # strips reply chains (53% of the mail corpus)
|       |-- shopify-rich-text.mjs     # metaobject rich-text JSON -> readable plain text
|       |-- cluster-messages.mjs       # pure average-link clustering + near-dupe collapse
|       |-- message-audience.mjs       # our own senders vs customers (30% of inbound was ours)
|       |-- compliance-audit.mjs shopify-compliance-webhooks.mjs # audit logs · HMAC + redaction
|       |-- support-taxonomy.mjs         # THE shared vocabulary: 14 subjects (+faq/brand_story
|       |                                # knowledge-only) · 4 request kinds · level + team derivation
|       |-- knowledge-{chunker,categories,document-mapper,navigation}.mjs # chunking · category
|       |                                # inference · page->row mapping · menus -> header/footer
|       |-- embeddings/
|       |   |-- embedding-input.mjs      # composed input per corpus (chunk: title+heading+text;
|       |   |                            # message: subject+stripped body) + its salted hash
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
|       |   |                            # (mapper also derives direction + normalises form mail)
|       |   |-- contact-form.mjs         # parses the Shopify contact-form wrapper -> real customer
|       |   |-- delta-poller.mjs         # follows delta pages, persists cursor, runs both gates
|       |   |-- ticket-writer.mjs        # thread by conversationId, idempotent message upsert
|       |   |-- message-embedder.mjs     # inline best-effort vector, written with the row
|       |   |-- spam-gate.mjs blocklist-store.mjs spam-classifier.mjs # pass 1 (rules) · pass 2 (LLM)
|       |   `-- spam-audit.mjs           # pure reason/row building + buffer -> spam_audit store
|       |-- pipeline/
|       |   |-- categorise.mjs           # classify-only: enums from support-taxonomy, level clamp
|       |   |                            # + confidence / language / happiness signals
|       |   `-- categorise-runner.mjs    # batch pass over needs_categorisation + level ratchet
|       |-- retrieval/
|       |   |-- retrieval-rules.mjs      # pure: categories to search · answerable/weak/none bands
|       |   |                            # · the query text · best-match (not crowd) verdict
|       |   |-- knowledge-retrieval.mjs  # embed once + one indexed RPC; no scan, no PII
|       |   |-- product-matching.mjs     # pure: TITLE-only name match, IDF-weighted,
|       |   |                            # accent/apostrophe folding, ambiguity as an outcome
|       |   |-- product-context.mjs      # row -> named sections (description/usage/
|       |   |                            # ingredients/FAQ) + prompt rendering
|       |   |-- promotion-rules.mjs      # pure: code match + typo suggest · pass/fail/UNKNOWN
|       |   |                            # eligibility checks, three-valued verdict
|       |   |-- promotion-lookup.mjs     # code extraction from text · detail · listActive
|       |   |-- abandoned-checkout.mjs   # live Shopify lookup: the only view of a basket
|       |   |                            # (date window + client-side email match; UNVALIDATED)
|       |   |-- product-lookup.mjs       # the two tools: full context · stock only; active
|       |   |                            # products only; ambiguity returns ALL candidates
|       |   |-- customer-context.mjs     # pure: customers row -> the CRM bundle SHARED with
|       |   |                            # order-context · account state · prompt text that
|       |   |                            # withholds the email unless asked
|       |   `-- customer-lookup.mjs      # the CRM tool: by raw email OR by ticket email-hash;
|       |                                # needs no order number; writes data_access_events
|       |-- investigation/       # the agent that USES the tools above (Phase 4b)
|       |   |-- case-file.mjs     # THE OUTPUT CONTRACT: schema · verifyFindings (drops any
|       |   |                     # claim citing a call that never ran) · deriveDoNotClaim ·
|       |   |                     # toDraftingPrompt / toHumanBrief (two projections, one object)
|       |   |-- investigation-rules.mjs # the guidelines, pure: allowedTools (the 14x4 scope
|       |   |                     # guardrail) · requiredEvidence · openingMoves ·
|       |   |                     # escalationTriggers · ENABLED_SUBJECTS
|       |   |-- tool-registry.mjs # binds the retrieval tools, scopes them per ticket, and
|       |   |                     # normalises each tool's shape into outcome + caveats
|       |   |-- investigate.mjs   # bounded tool-calling loop: 6 calls, 4 turns, args cache
|       |   |-- investigation-runner.mjs # the pass + store + the one-off --backfill
|       |   `-- create-investigation.mjs # one stack, shared by the worker and the CLI
|       |-- resolution/
|       |   |-- customer-resolution-runner.mjs # links tickets.customer_id from the requester
|       |   |                             # hash alone (no order number); the hash IS the
|       |   |                             # contact-form address, not Shopify's mailer.
|       |   |                             # Refuses notification senders; a miss retries daily
|       |   |-- order-number-parser.mjs   # pure: #NNNN / "commande n° NNNN" only; classifies
|       |   |                             # the Q00 ERP refs (911 in corpus) as NOT Shopify
|       |   |-- order-verification.mjs    # pure: email-hash proof · name_match (corroboration,
|       |   |                             # never written) · mismatch · suggests asking for the
|       |   |                             # purchase email when unresolved
|       |   |-- order-resolution-runner.mjs # batched lookup; writes only a confirmed match
|       |   |-- order-context.mjs         # pure: order+customer -> the drafting bundle; derives
|       |   |                             # delivery state and signals, no street/phone; the
|       |   |                             # customer half comes from retrieval/customer-context
|       |   `-- order-context-runner.mjs  # fills tickets.resolved_context + links customer_id
|       |-- routing/
|       |   |-- forward-rules.mjs        # pure: who qualifies (contact-kind + configured address
|       |   |                            # + external sender) · French covering note ·
|       |   |                            # transient-vs-permanent Graph error split
|       |   |-- forwarding-store.mjs     # address book read · pending select · attempt ledger
|       |   `-- forward-runner.mjs       # the pass; one failure never stops the rest
|       |-- lifecycle/
|       |   `-- auto-close.mjs           # pure shouldAutoClose (21d idle, level 4 exempt) + the
|       |                                # pass; runs last so it sees this poll's timestamps
|       `-- tools/               # add-blocklist.mjs (blocklist:add) · reset-cursor.mjs (ingest:reset)
|                                # run-forwarding.mjs (forward:once / forward:dry-run)
|                                # run-auto-close.mjs (tickets:autoclose[:dry-run])
|                                # run-order-resolution.mjs (orders:resolve[:dry-run])
|                                # run-order-context.mjs (context:build[:dry-run] · --refresh)
|                                # run-customer-lookup.mjs (customer:lookup -- <email> [--json]
|                                # [--with-email]) — no ticket, no order number needed
|                                # run-customer-resolution.mjs (customers:resolve[:dry-run])
|                                # run-investigation.mjs (investigate[:dry-run] · --show/--brief
|                                # render the case file · --backfill queues categorised tickets)
|   `-- eval/                    # categorisation-cases.mjs (40 labelled dummy emails) ·
|                                # score-categorisation.mjs (pure, 3 axes) · run-... (eval:categorise)
|                                # sample-mailbox.mjs (review:sample -- GET-only mailbox pull, no
|                                # ingestion) · compare-review-labels.mjs (review:compare)
`-- supabase/migrations/         # BASELINE, run in order against an empty database:
                                 # 01_core_schema.sql   Shopify snapshots · promotions · content
                                 #                      catalog · knowledge + chunk embeddings ·
                                 #                      compliance/audit · tickets + messages
                                 # 02_spam_filter.sql   email_blocklist · spam_audit
                                 # 03_categorisation.sql  taxonomy constraints · ticket subject/kind
                                 #                      axes · re-categorisation flag + confidence /
                                 #                      language / happiness · categorisation_review
                                 # 04_forwarding.sql   category_forwarding (per-category address
                                 #                      book) · ticket_forwards (attempt ledger,
                                 #                      unique(ticket_message_id) = idempotency)
                                 # 05_forwarding_retry.sql  attempts counter: `sent` is final,
                                 #                      `failed` retries to a cap (transient Graph
                                 #                      errors do not consume an attempt)
                                 # 06_knowledge_retrieval.sql  match_knowledge_chunks() RPC:
                                 #                      HNSW vector search returning SIMILARITY,
                                 #                      caller-supplied category list
                                 # 07_investigation.sql  tickets.needs_investigation (mirrors 03's
                                 #                      flag, but defaults FALSE) · ticket_investigations
                                 #                      (the case file; unique(shop_id,
                                 #                      trigger_message_id) = idempotency)
                                 # Each has a .test.mjs asserting the SQL against
                                 # scripts/lib/support-taxonomy.mjs (see the invariant below).
```

## Database Map

**Shopify snapshots** -- Shopify stays source of truth, all syncs idempotent. Every table has RLS on with no policies, so access is service-role only.
- `shops` - shop records, environment, app settings, `sync_cursors` (incl. the mail delta link).
- `customers` - lean support snapshots: contact lookup, marketing state, coarse location, lifetime totals, last order, Shopify `rfm_group` (`CHAMPIONS`/`LOYAL`/...). No addresses or notes.
- `orders` - identity, order/customer links, channel (`source_name` raw vs `sales_channel` label), derived `order_status`, totals, line items, fulfillments, returns, refunds. Contact fields are hashes (`customer_email_hash`, `customer_phone_hash`); `shipping_destination` is coarse only (no street/postcode). Retention: delivered or completed return/refund +3mo, undelivered or unresolved +6mo -> `retention_delete_after`, deleted by the order sync.
- `products` - snapshots + first-class metafields (Usage Instructions, Short description, Conseils d'utilisation, Actifs & ingredients, ingredients popup, Product Ingredients), `variants` jsonb, product-level `available_stock`.
- `promotions` - discount snapshots, one row per redeem code (`code = null` for automatic), `applies_once_per_customer` first-class. Full sync deletes rows Shopify no longer returns. `rule_snapshot` carries the **values**, not just the type names: `minimum_requirement` (subtotal or quantity, with the threshold), `customer_gets`/`customer_buys` (percentage or amount, plus the products/collections it is restricted to, with titles), and `customer_selection` (all / segments / named customers). Those fields were `__typename`-only until 2026-08-01, which made the commonest promotions question unanswerable.
- `shopify_metaobjects` - shared metaobjects (FAQ, ingredient lists) referenced by products.
- `shopify_content_sources` - content-free catalog of every live page **and** policy, keyed `source_type` (`shopify_page`|`shopify_policy`) + `shopify_source_id`. Feeds the Agent Setup dropdown only; loosely coupled to `knowledge_documents` (no FK).

**Support taxonomy** (`scripts/lib/support-taxonomy.mjs`) -- one vocabulary, two consumers. **Subjects** (14: order, delivery, return_exchange, product, product_stock, payment, account, promotions, cosmetovigilance, legal_privacy, b2b, partner_collaboration, careers, other) are shared by `knowledge_documents.category` and `tickets.category`, so a ticket's subject filters straight into matching knowledge chunks with no mapping. `faq` + `brand_story` are knowledge-only (an article is reference material; nobody emails "an FAQ"). **Request kinds** (question/problem/complaint/contact) are tickets-only and stored separately from the subject -- never composed into one value like `order_problem`, which would need stripping for every knowledge lookup and make the categoriser pick 1-of-23 instead of 1-of-14 plus 1-of-4. `complaint` is a kind, not a subject, so a delivery complaint is (delivery, complaint). Both axes constrained in the database (03). **Level** is derived from the pair. Subjects whose answers live in the database (order, delivery, payment, account, product_stock, promotions) floor at **2 for both questions and problems** -- measured against human labelling on real mail, most "problems" there are answered by looking something up, and flooring them at 3 made a third of the review set impossible to agree with. Other questions 1, other problems/complaints 3, `contact` 2, plus one override: `cosmetovigilance` + `problem` -> 2 (natural formulations, so a reported reaction is a mild allergy, answerable with advice). The categoriser escalates to 3 itself when the fix requires *changing* something. **No pair derives level 4** -- see the invariant below. The module also holds the per-ticket **signal** vocabularies (`CONFIDENCE_LEVELS`, `REPLY_LANGUAGES`, `HAPPINESS_SCORES`) and `ratchetLevel`, for the same reason as the rest: one list per vocabulary, shared by the model's response schema, the database check constraint and its test.

**Curated knowledge** -- never auto-synced; every row is an explicit import or a hand-written article.
- `knowledge_documents` - `content_html` is the editor's source of truth (`content_text`/`sections` regenerate on save); `approval_status` (draft/in_review/approved/needs_optimization) is independent of Shopify's publish `status`; `core_topic` is one of 6 slots (order_policies, brand, confidentiality, delivery_returns, locations, faqs), max one article per shop per slot; `voice_profile` jsonb holds the brand-voice fields.
- `knowledge_chunks` - retrieval chunks (category, tokens, text, `content_hash`, `embedding vector(1536)` + HNSW cosine). Determinism metadata: `embedding_model`, `embedding_dimensions`, `embedded_input_hash`, `embedded_at`.

**Agent email workflow** -- see `AGENT_INTEGRATION_PLAN.md`.
- `tickets` - `shopify_order_number` is written **only** by a confirmed order-number resolution (the order's `customer_email_hash` equals the ticket's `requester_email_hash`); a name-only agreement or an order belonging to someone else is recorded in `metadata.order_resolution` and left off the column. One per Graph `conversationId` (unique `shop_id` + `graph_conversation_id`), not per email. Categoriser fills `category` + `request_kind` (and the optional `secondary_category` + `secondary_request_kind` pair, for an email raising two subjects of different kinds — a secondary kind without a secondary subject is rejected), `level` 1-4, `responsible_team` (finance/marketing/sales/logistics/contact). **`customer_id` has two writers and one meaning**: the customer-resolution pass links it from the requester's own address on any ticket, and order-context links it from a confirmed order — the second never overwrites a value already there, and both are keyed on the same requester hash, so they agree by construction. `metadata.customer_resolution` records what was tried and when, so an unlinked ticket is explained rather than merely empty. **`level` is derived** from (subject, kind) by `defaultLevel()`, and the categoriser may only escalate above that floor, never below. Deriving it stops two model-assigned fields contradicting each other on the same "needs action" axis. Level 4 is the exception: no subject derives it (see the invariant below); 03 carries the corrected wording (an earlier migration had shipped a subject-implied rule). 03 also adds the re-categorisation loop and three per-ticket signals: `needs_categorisation` (the pending flag — a boolean rather than a `categorised_at < last_message_at` comparison, because PostgREST cannot compare two columns and our own outbound replies also move `last_message_at`), `categorised_at`, `categorisation_confidence` (a *known-untrustworthy* marker, not a model self-assessment — see the invariant), `language` (the language to reply in, restricted to what the desk writes; `other` routes to a human), and `happiness` 1-4 (1 happy .. 4 really unhappy). **`happiness` is not wired to `level` in either direction** — see the invariant. `resolved_context` jsonb + `context_resolved_at` is a re-resolvable order/customer bundle for the drafting agent (holds PII, never billing/street address). `priority` 1-5. Retention mirrors `orders` (`resolved_at`/`closed_at`/`archived_at`/`retention_delete_after`); `deleted_at` is the separate compliance soft-delete. Stores only `requester_email_hash` + `requester_name`.
- `ticket_messages` - one row per Graph message, idempotent on `shop_id` + `graph_message_id`. Reply envelope (`from_email`, `to_emails`, `cc_emails`), cleaned `body_text`, sanitised payload, and body `embedding vector(1536)` + HNSW for similar-ticket retrieval.
- `ticket_investigations` - **the case file**, one row per investigation run and the contract the drafting agent will read. Written by the investigation pass from the retrieval tools' output. Four *separate* evidence columns — `established` (facts, each carrying the `tool_calls` ids it rests on), `unverified` (what the customer asserted or no tool could settle), `missing` (the fields only the customer can supply), `do_not_claim` (prohibitions) — because merging them is precisely the failure the promotion tool measured: a doubt inside a list of facts is read as a fact. `handoff` is internal and excluded from every customer-facing rendering; `context_ref` **points at** `tickets.resolved_context` rather than copying it, so personal data is not duplicated per run. `dropped_claims` keeps the claims that cited a tool call which never ran. **`unique(shop_id, trigger_message_id)`** is the idempotency key — one investigation per inbound message, so a reply produces a new reading instead of overwriting the previous one, and the thread's trajectory survives as rows. `customer_id` is denormalised and indexed: that is the seam Phase 7 memory hangs off. No `reply_intent` column (derived from `verdict`) and no confidence column (measured constant, see the invariant).
- `email_blocklist` - per-shop sender email/domain rules with `hit_count`/`last_hit_at`; matched mail is dropped before any write.
- `category_forwarding` - per-category forwarding address book (unique `shop_id` + `category`), read by the agent's forwarding pass and written by Settings. **A null/absent address is the off switch** — there is deliberately no separate `enabled` flag, because two ways to express the same state can disagree. Keyed by category rather than `responsible_team`: the team mapping sends `careers` to `contact`, the generic bucket the mail just came from.
- `ticket_forwards` - one row per email forwarded to a colleague, `sent` or `failed`, and the idempotency ledger: **`unique(ticket_message_id)`** is what makes the pass safe to re-run. Per message, not per ticket, so a candidate's follow-up still reaches the recipient exactly once. Snapshots the category + address used, so re-routing tomorrow does not rewrite where mail went yesterday. Failures are rows, not silence — a Graph rejection stays visible and retryable.
- `categorisation_review` - **testing artefact, not runtime**: a random sample of real support mail (`npm run review:sample`, read-only GETs, no ingestion) that a human labels in the Supabase table editor, then scored against the agent (`npm run review:compare`). Blind by design -- `agent_*` stays empty until the comparison runs, because an agent answer beside an empty box anchors the reviewer. Human columns carry the same check constraints as `tickets`, so a typo is rejected rather than counted as a disagreement. Sender reduced to `from_domain`; 3-month default retention.
- `spam_audit` - one row per spam-gate decision, idempotent on `shop_id` + `graph_message_id`: `outcome` (`kept`/`blocked`), `decided_by` (`blocklist`/`llm`), a one-line `reason`, plus `label`, `model`, `blocklist_rule_id`, and `failed_open` (kept only because the classifier errored). Exists because both passes drop mail before any write, so a blocked email would otherwise leave no trace. Keeps `from_email` + `subject` — the deliberate narrow exception to not storing blocked mail, needed to review a decision and build a rule from it — but **never the body**. Untriaged replies produce no row.

- `integration_events` - metadata-only sync/webhook log, idempotent on `event_key`. `privacy_requests` - Shopify compliance webhook lifecycle (hashed contacts, deletion counts).
- `data_access_events` - personal-data access audit trail. Sync paths write service events, and so does the agent's customer lookup (`action: customer_lookup`, the customer id hashed) — reading a customer to answer a ticket is access, whether a human or the worker did it. The write **fails open**: the data has already been read by then, so an audit outage must not also cost the answer. **Future dashboard user views must write human access events here.**

## Knowledge API

Server-only Route Handlers under `web/app/api/knowledge/`, all using the Supabase service-role key. Logic lives in `web/lib/server/knowledge-service.ts`, which imports `scripts/lib/*` directly (same resolver, mapper, chunker as the sync scripts) rather than duplicating it.
- `GET shopify-sources` - the catalog (pages + policies), flagging what is already imported. `GET articles` / `POST articles` - list; create empty, or resolve a `sourceId`'s live Shopify content and fill it in.
- `PATCH articles/:id` - title/content/category/core-topic/status. Converts `source_type` to `manual`; demotes an `approved` article to `in_review` when its text changes; re-embeds approved non-brand chunks inline (best-effort).
- `POST articles/:id/resync` - re-pull from the linked source; 400 once `manual`. `DELETE articles/:id` - hard delete (chunks cascade); the source stays re-importable.

## Tickets

`/tickets` (`web/app/tickets/page.tsx` -> `web/components/tickets/`) over `web/lib/server/tickets-service.ts` and `dropped-mail-service.ts`. Three stacked collapsible sections, each a table that scrolls inside a fixed 26rem height so the sections below stay reachable:

| Section | Source | Row action |
| --- | --- | --- |
| **Queue** | `tickets`, status not resolved/closed | Close ticket |
| **Irrelevant** | `spam_audit`, `outcome = 'blocked'` | Add as ticket *(disabled)* |
| **Closed** | `tickets`, status resolved/closed | Reopen ticket |

- **The middle section is not tickets.** Dropped mail never reaches the `tickets` table — the gate runs before the ticket write (`agent/src/ingestion/delta-poller.mjs`: "spam is dropped here — never written to the database"), so the only trace is a `spam_audit` row holding sender, subject and a one-line reason. **There is no body**, which is why "Add as ticket" is disabled rather than absent: promoting one back means the agent re-fetching it from Graph, and hiding the button would hide that it is recoverable at all.
- Filtered on `outcome = 'blocked'`, not `label = 'irrelevant'`: the blocklist pass writes no label, and every row currently carrying `irrelevant` was in fact *kept* (the label predates the change that made it drop). Blocked is the only field that reliably means "never became a ticket".
- **Tickets close themselves after 21 days of silence** (`agent/src/lifecycle/auto-close.mjs`, last pass of every poll so it sees the timestamps that poll just advanced). Without it `status` carried no information at all — every one of the 565 tickets read `open`, including threads last touched seven months ago. **Level 4 is exempt and that is the whole safety margin**: it means legal threat, hospitalisation or grave danger, and there silence is the opposite of resolved. Level 3 closes with everything else. Inactivity is `last_message_at`, which advances on our own replies too, so a thread the team is working stays open while the customer is quiet. Auto-closed rows are stamped `metadata.closed_reason = 'inactivity'` so they stay distinguishable from a hand close.
- **The level exemption is applied in JS, not SQL.** PostgREST's `not.eq` on a nullable column drops the NULL rows as well, which would have silently spared every uncategorised ticket — the largest group in the table. There is a regression test for exactly that.
- **A ticket still flagged `needs_categorisation` is never auto-closed.** The categoriser selects on `status = 'open'` (`categorise-runner.mjs`), so closing one that is still queued drops it out of that queue for good and freezes it as uncategorised — only a customer reply could ever label it afterwards. The categoriser drains 25 per poll, so this defers a close by a few polls; getting it wrong is unrecoverable. The flag clears itself either way, including on a thread holding no customer message at all, so nothing is exempt permanently.
- **A customer reply reopens a closed ticket** (`ticket-writer.mjs`, in the branch that already special-cases inbound for re-categorisation), clearing `closed_at`/`resolved_at` with the status. Inbound only: a ticket does not reopen because *we* sent something. Without this half, auto-close would make the queue tidy and wrong.
- **Mutations.** `PATCH web/app/api/tickets/[id]` accepts only `open`, `resolved`, `closed`. The rest (`awaiting_customer`, `forwarded`, `spam`…) are the worker's to set from what it observed — an operator asserting them by hand would put the UI and the pipeline in disagreement. `closed_at`/`resolved_at` are maintained alongside the status and cleared on reopen, since retention reads them.
- **The four header cards.** Open tickets · High priority · Level 3 · New tickets (24h and 30d in one card). `summariseTickets()` lives in `web/lib/ticket-stats.ts` — isomorphic and pure, like `knowledge-mapper.ts` — so the server reduces it on first paint and the client re-reduces it after a status change from the same array the tables render. A card can never disagree with the rows under it.
- **"High priority" is level 3 + 4, not the `priority` column.** Nothing in the pipeline writes `priority`, so all 565 rows sit at its default of 3 and a card reading it would show zero for ever. Level is what the categoriser actually assigns. Swap the source in `summariseTickets` when priority starts being written.
- **Volume windows are rolling (now -24h / -30d), not calendar day and month.** Ingestion runs in bursts; on any day without a poll the calendar figures both read zero and the card looks broken rather than idle. Counted on `first_message_at`, so reviving an old thread does not inflate today's intake.
- **Level, not status, is the primary filter.** Every ticket is `open` today because nothing closes them, so status tabs would be one tab holding everything. Filtering, search and sort all run client-side over the full set — 565 rows is far too few to justify a round trip per keystroke.
- Soft-deleted rows are excluded in the query, not the mapper, so a compliance delete cannot reach the UI via a caller that forgot to filter.

## Forwarding API

`web/app/api/forwarding/` over `web/lib/server/forwarding-service.ts`, same service-role pattern. `GET` returns all 14 ticket categories with their address (`null` where unset) so the form never has to reconstruct missing rows; `PUT` upserts one category. Saving an empty address clears it, which is how a category is switched off. Surfaced at `/settings` (`web/components/settings/ForwardingSettings.tsx`), which saves per row on blur rather than behind one Save button.

## Agent Worker

Ingestion, resolution, categorisation, investigation and forwarding (Phase 1-3, the Phase 4 retrieval tools and the agent that uses them; drafting is not built yet). Run `npm run ingest:once` or `npm start` from `agent/`; one poll runs every pass below, in this order.
1. `index.mjs` loads config, asserts Graph credentials, resolves `shops.id` for `SHOPIFY_STORE_DOMAIN`.
2. `delta-poller.mjs` reads `shops.sync_cursors.mail_ingest_delta_link` and follows Graph pages to the `@odata.deltaLink`, writing the cursor back so restarts resume. The delta query is the source of truth -- a future change-notification subscription would only trigger this engine.
3. `graph-message-mapper.mjs` maps each message to row fields, cleans the body via `htmlToText`, hashes the sender with `hashIdentifier` so it matches `orders.customer_email_hash`. It also performs two normalisations, because the Graph envelope does not say what the rest of the pipeline needs:
   - **Direction.** The poller reads the Inbox, but the Inbox is not only inbound — the team's replies land back in it. A message whose sender is the support mailbox is recorded `outbound`. Measured on real mail, 123 of 348 messages; before this they were stored as customer mail and sat at the end of 43% of threads, exactly where the categoriser looks for how the customer currently feels.
   - **Identity.** A Shopify contact-form notification is *about* a customer but *from* `mailer@shopify.com`. `contact-form.mjs` parses the labelled body fields (`Name`, `E-mail`, `Indicatif de pays`, `Phone`, `Corps`) and those replace the envelope; `body_text` becomes the customer's own text. Without it 95 tickets shared 2 requester hashes, so `requester_email_hash` — the join key to `orders.customer_email_hash` — was unusable for half the inbox. The parser returns null on an unrecognised template, so a reworded form degrades to the envelope rather than to a wrong customer. It already understands the planned `Catégorie` / `Numéro de commande` dropdown fields, which land in `raw_graph_payload.contactForm` until the Shopify form ships them.
4. **Gate 1** (no LLM): `email_blocklist` email/domain match -> dropped before any write, hit counts recorded.
5. `ticket-writer.mjs` threads survivors by conversation; store interface injected for tests. It also embeds each message inline (best-effort) so the row is written complete in one upsert — an embedding failure never fails ingestion, and `npm run embed:tickets` is the reconciler that repairs any gap.
6. **Gate 2** (LLM, new conversations only): `spam-classifier.mjs` (`gpt-4o-mini`, Structured Outputs) drops `spam` **and `irrelevant`** before insert. `irrelevant` was previously labelled and then kept anyway, which made the label decorative -- automated notices, FYI forwards of a provider's mail and test messages all became tickets a human had to close. Both outcomes write a `spam_audit` row, so a wrong drop is reviewable and can be promoted back by hand. The prompt is explicit that internal mail *about a customer* is customer work: measured on this mailbox 17 of 20 purely internal threads were relances, tracking numbers and refund decisions, and dropping them would have destroyed live level-3 cases. Replies into existing tickets are never triaged, and it **fails open** on any error or missing key.
7. Every decision from either gate buffers in a `spam-audit.mjs` collector and flushes once per poll into `spam_audit`. The flush is best-effort — a failed audit write is logged, never fatal, since a retried poll must not re-drop mail.
7b. **Customer resolution** runs as soon as the mail is stored and before every LLM pass (`agent/src/resolution/customer-resolution-runner.mjs`): identity is what a ticket has from its first message, so it waits on nothing — no category, no order number, no OpenAI key. It calls the CRM lookup with `tickets.requester_email_hash` and writes `tickets.customer_id`, which until now was only ever set as a by-product of a confirmed order number — leaving every account question, pre-sales enquiry and contact-form message permanently unlinked. **The hash it keys on is the address the customer typed**, because ingestion already replaced the contact form's `mailer@shopify.com` envelope with the form's own `E-mail` field; nothing here re-derives identity from the envelope. Three rules make the pass safe to run every minute: a small denylist of **notification senders** (Shopify's mailers, plus the support mailbox from config) is refused outright and never retried, because a contact-form body that fails to parse leaves one of those as the requester and linking them would give every such ticket the same wrong customer; a `no_match` is a real answer that is nonetheless **re-asked once a day**, since customers arrive from the nightly sync and today's stranger is next week's buyer; and every outcome, match or not, is recorded in `metadata.customer_resolution` with the hash it was tried against, so a re-parse or a backfilled requester re-opens the question immediately while an unchanged one stays quiet. The lookup's process-wide hash index is dropped once per pass that has work, so a customer synced since startup is visible.
8. **Categorisation** (LLM) runs after ingestion in the same poll, as a separate batch pass: `categorise-runner.mjs` selects open tickets flagged `needs_categorisation` (oldest first, 25/poll) rather than what the poll just wrote, so anything missed by a crash or a key-less run is caught up automatically. `categorise.mjs` is classification-only (no tools, no DB) and sends subject + first/latest inbound body — never the sender's address or name. It returns the two taxonomy axes plus two signals about the ticket: the `language` to reply in and customer `happiness` (1-4). A failure leaves the ticket pending and counts the attempt in `metadata.categorisation`; after 3 it is written as (other, problem) -> level 3, team contact, flagged `failed`, so it lands in front of a human instead of retrying forever — unless the ticket already had labels, in which case those are kept and only marked low-confidence (see the invariant).
8b. **Re-categorisation.** A ticket's labels describe the conversation so far, not the email that opened it, so ingestion re-raises `needs_categorisation` whenever a new **inbound** message joins a thread (never on our own outbound replies, which also move `last_message_at`) and the same pass re-reads it. The re-run is **blind** — the model is never shown its previous answer, which would only make it defend a first call that may have been wrong. Stability comes from the ratchet instead: `ratchetLevel` lets a level rise but never fall, so an escalation is picked up while a calmer follow-up cannot walk back work the ticket has already earned. Superseded labels are kept in `metadata.categorisation.history` (newest first, capped at 5) so a ticket shows its trajectory, and `proposed_level` records what the model actually said before the ratchet.
8c. **Investigation** (LLM + tools) runs immediately after categorisation and consumes its output in the same poll — the categoriser raises `needs_investigation` in the same patch that clears its own flag, and is the **only** writer of it, so a thread is never investigated against labels describing an older conversation. This is the first stage that *chooses* what to do, and the first with a budget: **6 tool calls, 4 model turns**, identical-args calls served from a per-run cache. Every bound resolves to an outcome (`needs_human`, budget exhausted), never an exception. **What keeps the loop short is that most of the evidence is deterministic** — a product question always needs the product matched against the question text, a promotions ticket always needs its codes extracted — so `openingMoves()` fetches those *before* the model's first turn; measured over 40 real tickets the whole run took 1–3 tool calls against a ceiling of 6. Scope is `ENABLED_SUBJECTS` (product, product_stock, promotions, account, other): the order family has full rules and no synced data behind it, `cosmetovigilance` and `legal_privacy` are deliberately toolless (a confident-looking case file about a reported skin reaction is worse than none), and the forwarded subjects have nothing to investigate. Out-of-scope tickets are skipped *and their flag cleared*, for the same reason the categoriser clears its own on an unclassifiable thread — so **enabling a subject later means re-raising the flag** (`npm run investigate -- --backfill`), not only editing the array.
9. **Measured, not assumed** — two review sets. Synthetic (`agent/eval/categorisation-cases.mjs`, `npm run eval:categorise`): 40 dummy emails, ~38-39/40 on all three axes. **Real** (`categorisation_review`, `npm run review:sample` + `review:compare`): 30 hand-labelled emails from the live mailbox -- subject 77%, kind 90%, level 73%. The real set is what drives the rules: the boundary definitions in the prompt (dispatch splits order/delivery; `complaint` only without an actionable request; `contact` only for a first approach; L3 = something must change) and the level floors all come from measured disagreements with human labelling, not from intuition. The synthetic set only guards against regressions. That band report is what retired the self-reported confidence field: it showed `high` on 40 of 40 cases, matching 171 of 171 on live mail, so the signal was measured to be worthless before anything was built on it.
10. **Forwarding** runs last, after categorisation, because it reads the category and kind that step assigns. `forward-rules.mjs` is the whole decision: `request_kind = 'contact'` **and** the category has an address in `category_forwarding`. Both halves are load-bearing — routing on category alone would divert genuine `b2b` reorder problems as FYIs, and the taxonomy already restricts `contact` to b2b, partner_collaboration and careers (38 of 330 customer-facing tickets on the measured corpus). The covering note is in French (internal mail, French company), and sidesteps both tu/vous and gender agreement by never addressing the reader and referring to `le message` rather than a pronoun agreeing with the category phrase. Sends via Graph's own `/forward` action, so the recipient gets the original mail with attachments intact (a CV arrives as a CV) rather than a re-composition of the stripped `body_text` we store. Selects on ticket state rather than on what the poll just wrote, so mail that became forwardable only because an address was configured today is caught up with no backfill. **Needs the `Mail.Send` Graph application permission** — the only write this worker makes to Graph; without it every attempt lands as a `failed` row rather than silently doing nothing.

## Invariants

- Nothing auto-writes `knowledge_documents`; the catalog sync only fills `shopify_content_sources`. `source_type` -> `manual` **is** the manual-edit lock — no separate flag, and resync is then unavailable.
- A chunk holds a vector **iff** its parent document is currently `approved` and not brand-voice, and the vector matches the current input hash + model + dimensions. Unapproving regenerates chunks vectorless. Embedding runs both inline (on approval, best-effort) and via the reconciler. `embedded_input_hash` covers title + category too, so a rename invalidates the vector even though `content_hash` ignores it.
- Spam is never stored -- both gates drop mail before the first insert. `spam_audit` is the only trace of a dropped email (decision + sender + subject, never the body), so it is what makes a wrong drop reviewable at all.
- A ticket's `level` is never below `defaultLevel(category, request_kind)` — including the *secondary* pair's floor, so an order question that also asks for a return is level 3. The model can only escalate, and an unusable answer falls back to a kind that raises the floor (`problem`), never one that lowers it.
- **Every stored message is embedded; only approved knowledge chunks are.** The corpora differ because their gates differ: a chunk holds a vector iff its parent is approved and not brand-voice, whereas a message is part of the corpus by virtue of existing. Both share one determinism quadruple (`embedding_model`, `embedding_dimensions`, `embedded_input_hash`, `embedded_at`), so a re-run over unchanged text is a no-op for either — verified on real data: 348 messages embedded, second run embedded 0. Message hashes are additionally salted with the quoted-reply stripper version, so changing how history is stripped correctly invalidates every message vector without the version ever reaching the model.
- **The category is never embedded.** Retrieval always filters by category first, so embedding the category name into a chunk adds a near-constant to every candidate in the filtered set — no discriminative value, and it dilutes the content. `title` carries the topical anchoring instead.
- Only **inbound** messages are classified, ever. The spam gate skips outbound (blocking the support address would drop every reply the team sent), and the categoriser reads `findInboundMessages` only — spending a model call on text Qiriness wrote would make `happiness` measure our own tone. A thread holding *only* our replies is therefore unclassifiable: it is skipped **and taken out of the pending queue**, because ingestion re-raises `needs_categorisation` the moment a customer message arrives. Leaving it pending instead parks it at the front of an oldest-first batch permanently — measured on real mail, 11 such tickets took 11 of every 25 slots on every pass.
- `first_message_at` tracks the **true earliest** message, moving backwards as well as forwards. Graph's delta is not chronological, so on an initial enumeration a thread is routinely opened by one of its later replies; "the first message we saw" was late on 93 of 171 tickets, by 5 days on average and 24 at worst, and the categoriser queue is ordered on this column.
- A ticket's `level` never falls **across** re-categorisations either (`ratchetLevel`). A thread is re-read blind whenever the customer replies, so without the ratchet a polite follow-up could silently drop a level 3 back to 2 and take a promised refund out of the human queue. Levels only climb; a human closing the ticket is what ends it. The model's un-ratcheted answer is kept in `metadata.categorisation.proposed_level` so the clamp stays visible.
- **The categoriser is never asked how confident it is.** It was, and answered `high` on 171 of 171 live tickets and 40 of 40 review cases — Structured Outputs emits fields in order, so the model rated an answer it had already committed to in the same forward pass, with nothing pushing it toward calibration. A constant field carries no information and a constant field *called confidence* invites the wrong decision downstream, so the question was dropped. `tickets.categorisation_confidence` survives as a **known-untrustworthy marker**: only `low` is written, only by the failure paths (retries exhausted, or stale labels after a failed re-categorisation), and a clean categorisation clears it to NULL. Until a calibrated signal exists (sampling for agreement, or token logprobs), Phase 5 should gate auto-drafting on `level` and `happiness` instead — on this mailbox, level 1 alone is 17 of 160 tickets and every one of them is calm.
- **`happiness` and `level` are independent, deliberately.** `level` is what *work* a ticket needs; `happiness` is how the customer *feels*. An angry customer asking where their parcel is stays level 2 with happiness 4; a cheerful refund request is level 3 with happiness 1. Nothing derives one from the other — a mood-implied level would repeat exactly the mistake the level-4 rule was rewritten to fix, and refill the manager queue with routine mail. Happiness reaches Phase 5 as drafting tone, not as routing.
- **Level 4 is a severity judgement, not a subject.** No `(subject, kind)` pair derives it: it means an explicit threat of legal action or public exposure, hospitalisation, or grave injury/danger, so it arrives only as a categoriser escalation read from the email text and should be rare. The three triggers live in the categoriser prompt and the model must name the one that fired in its `reason`. A subject-implied 4 would make the level mean *this topic* rather than *this is serious*, filling the manager queue with routine mail.
- **An investigated fact must cite a tool call that actually ran.** `verifyFindings()` drops any `established` entry whose `evidence_ids` are not in that run's own ledger, and if that empties the list the verdict is forced to `needs_human`. A model that has read *"j'ai bien été livré"* will otherwise restate it as an established fact — and unlike a wrong reply, **a wrong case file becomes the drafting agent's ground truth**, with every downstream check applied to prose written from it. Dropped claims are kept in `dropped_claims` rather than discarded, because a run that keeps producing them is a prompt problem worth seeing. Measured over 40 real tickets: 0 unsourced claims stored, 0 dropped.
- **The agent's guardrails are code; only its guidelines are prose.** What a ticket's agent may call is `allowedTools(category, request_kind, level)` — a table, tested across all 14 subjects × 4 kinds, that the model never sees the outside of. Level 4 and the `contact` kind get an empty registry and no model call at all. What a *good* investigation contains (`requiredEvidence`) is stated in the prompt **and** checked afterwards; neither is trusted alone. The distinction matters because this agent never contacts a customer: its rules are operational (what it may read, what it may spend), not editorial.
- **The case file's prohibitions are derived, never asked for.** `do_not_claim` is generated from the caveats the tools raised (`basket_unseeable`, `eligibility_undetermined`, `order_unconfirmed`, `product_ambiguous`, `knowledge_weak`/`none`, `customer_unknown`, `stock_unknown`) plus the `missing` list. Asked for them, a model produces the caveats it happens to remember — and it is least likely to remember the one covering the gap it has just filled in. Same reasoning retires the model-set reply intent (derived from the verdict) and the wording of any question to a customer (looked up from the field key).
- **Weak knowledge chunks are withheld, not flagged.** Below the answerable band the chunks never reach the case file at all; only the prohibition does. Showing a drafting model text it is told not to use is a temptation with no upside — measured, the near-misses are contractual CGV text scoring 0.45–0.55 against operational questions.
- Unfilled core-topic slots are client-side placeholders, never database rows; clicking one creates a pre-filled draft.
- The migrations are a **baseline**, not a history: three files describing the schema as it should be, run in order against an empty database. They are not idempotent and not re-runnable over a populated one. Dev was built by the historical numbered sequence and matches this baseline exactly (verified column-, constraint- and index-wise); a fresh database gets there by running the three files. Editing one therefore means editing the definition, so re-apply against a fresh database rather than patching dev in place.

## Read Order

`AGENTS.md` (rules) -> this map -> `PRODUCT.md` (design direction) -> `README.md` (context, status, setup). Then as needed: `AGENT_INTEGRATION_PLAN.md` for agent phases, `SHOPIFY_PERSONAL_DATA_PROTECTION.md` and `MERCHANT_DATA_USE_DISCLOSURE.md` for anything touching customer data.
