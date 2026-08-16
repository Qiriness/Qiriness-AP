# APP_SCHEMA

**Codebase navigator: where things are.** Why they are that way lives in `DECISIONS.md` — read the matching section there before changing any behaviour described here.

Three npm packages: root (`scripts/`), `web/`, `agent/`. Shopify (source of truth) → Supabase/PostgreSQL (+pgvector) → Next.js 14 App Router + TypeScript + React 18 dashboard (CSS Modules, no UI framework). AI provider: OpenAI.

Secrets live in one repo-root `.env.local`; `web/next.config.mjs` and `agent/src/config.mjs` both load it.
Conventions: `*.test.mjs` sits next to its source (`npm test` = `node --test`); every `.tsx` has a sibling `.module.css`. Neither is listed below.

## Map

```text
|-- *.md             # AGENTS (rules) · DECISIONS (why) · PRODUCT (design) · README (status)
|                    # AGENT_INTEGRATION_PLAN + Agent_Workflow (agent phases)
|                    # SHOPIFY_PERSONAL_DATA_PROTECTION + MERCHANT_DATA_USE_DISCLOSURE
|-- package.json     # sync:shopify:* · embed:* · cluster:tickets · db:apply:migration · test
|-- shopify.app.toml # Shopify app scopes (all read_*)
|-- web/
|   |-- app/
|   |   |-- layout.tsx globals.css        # root layout · design tokens (teal, scale, radii)
|   |   |-- page.tsx                      # / -> /agent-setup redirect
|   |   |-- agent-setup/page.tsx          # Server Component: article + source fetch
|   |   |-- tickets/page.tsx              # Server Component: the agent's queue
|   |   |-- settings/page.tsx             # Server Component: forwarding address book
|   |   `-- api/
|   |       |-- tickets/[id]/route.ts         # GET case file + order facts · PATCH status
|   |       |-- tickets/[id]/thread/route.ts  # GET the conversation (message bodies)
|   |       |-- forwarding/route.ts           # GET 14 categories · PUT upsert one
|   |       `-- knowledge/                    # shopify-sources · articles · articles/[id]
|   |                                         # · articles/[id]/resync
|   |-- components/
|   |   |-- icons.tsx                # inline SVG icon set
|   |   |-- app-shell/               # AppShell (top bar + drawer) · Sidebar
|   |   |-- ui/                      # Button · StatusChip · Dialog (modal shell)
|   |   |-- settings/                # ForwardingSettings (saves per row on blur)
|   |   |-- tickets/                 # TicketsView (orchestrator) · TicketSection ·
|   |   |                            # TicketStatCards · TicketTable · TicketDetailPanel ·
|   |   |                            # TicketThreadDialog · DroppedMailTable +
|   |   |                            # DroppedMailDialog · LevelChip · HappinessFace
|   |   `-- agent-setup/             # AgentSetup + SetupHeader (orchestrator, mutations) ·
|   |                                # ArticleLibrary (left pane) · ArticleWorkspace +
|   |                                # BrandVoiceWorkspace (right pane) · RichTextEditor ·
|   |                                # WorkspaceHeader EditorFooter CategorySelect
|   |                                # SourcePageSelect ChipList Toast (and friends)
|   |-- lib/
|   |   |-- types.ts             # UI types + label tables (categories, levels, VIP, RFM)
|   |   |-- knowledge-mapper.ts  # isomorphic: API JSON -> UI types
|   |   |-- ticket-stats.ts      # isomorphic: summariseTickets + isClosed
|   |   |-- ticket-detail.ts     # pure, 3 projections: case file -> 3 blocks ·
|   |   |                        # resolved_context -> order owner / status / tracking lines ·
|   |   |                        # evidence_gaps -> the facts behind the findings
|   |   |-- api/                 # client-side fetch wrappers (knowledge, tickets, forwarding)
|   |   |-- relative-time.ts demo-data.ts
|   |   `-- server/              # knowledge-service · forwarding-service ·
|   |                            # tickets-service (list + detail + thread + status) ·
|   |                            # dropped-mail-service · knowledge-errors
|   |-- next.config.mjs          # loadEnv() from root .env.local; staleTimes 0
|   `-- tsconfig.json            # allowJs, so services can import scripts/lib/*.mjs
|-- scripts/                     # one sync orchestrator per Shopify resource
|   |-- sync-shopify-{products,customers,orders,promotions,content-catalog}.mjs
|   |-- sync-shopify-nightly.mjs         # runs them all in order
|   |-- embed-{knowledge-chunks,ticket-messages,exemplars}.mjs  # embedding reconcilers
|   |-- import-exemplars.mjs             # Email-Example-Queries.md -> exemplar rows
|   |                                    # (drafts only; lib/exemplar-import.mjs parses)
|   |-- cluster-ticket-messages.mjs      # cluster:tickets -- recurring topics per subject
|   |-- apply-supabase-migration.mjs     # SQL runner
|   |-- process-shopify-compliance-webhook.mjs
|   `-- lib/
|       |-- shopify-{admin,knowledge,theme}-client.mjs
|       |-- shopify-*-mapper.mjs         # shop/product/metaobject/customer/order/promotion
|       |-- shopify-sync-mappers.mjs shop-sync-service.mjs
|       |-- supabase-rest-client.mjs     # REST select/upsert/update/delete/rpc
|       |-- tables.mjs                   # THE SCHEMA CONTRACT: 24 tables, 3 views,
|       |                                # 4 rpcs, and the recurring projections.
|       |                                # Asserted against the DDL by _shared.test
|       |-- ticket-record.mjs            # THE ONLY WRITER OF `tickets`: pass protocol
|       |                                # (claim/complete/skip/retry/abandon +
|       |                                # descriptors), the needs_* flags, the
|       |                                # lifecycle timestamps, the metadata trail,
|       |                                # the queue + thread reads. Shop-scoped
|       |-- ticket-priority.mjs          # pure read-time queue score + band:
|       |                                # level, customer wait, inbound contacts,
|       |                                # awaiting_human, VIP
|       |-- sync-config.mjs              # CLI + env parsing, loadEnv
|       |-- hash.mjs collections.mjs html-to-text.mjs text-cleaning.mjs
|       |-- quoted-reply.mjs             # strips reply chains
|       |-- shopify-rich-text.mjs cluster-messages.mjs message-audience.mjs
|       |-- sender-patterns.mjs           # email/domain matching, shared by the
|       |                                 # blocklist and the sender directory
|       |-- compliance-audit.mjs shopify-compliance-webhooks.mjs
|       |-- support-taxonomy.mjs         # THE vocabulary: 14 subjects · 4 kinds ·
|       |                                # level + team derivation · signal enums
|       |-- customer-segments.mjs        # THE VIP rule: rfm_group -> isVipRfmGroup
|       |-- knowledge-{chunker,categories,document-mapper,navigation}.mjs
|       |-- embeddings/                  # embedding-input · openai-embeddings-client ·
|       |                                # embed-chunks (pure staleness gate) ·
|       |                                # reconcile (THE loop, one descriptor per
|       |                                # embedded table; the 3 embed:* scripts are
|       |                                # a descriptor + a report each)
|       `-- knowledge/                   # source-discovery · knowledge-source-resolver ·
|                                        # content-resolvers/ · template-traversal ·
|                                        # template-extractors/
|-- agent/                       # always-on worker (own package.json; reuses scripts/lib/*)
|   |-- src/
|   |   |-- index.mjs config.mjs # entrypoint (--once) · env/tunables + Graph gate
|   |   |-- lib/ llm/            # logger (JSON, no PII) · shop · openai-client
|   |   |-- ingestion/           # graph-client · graph-message-mapper · contact-form ·
|   |   |                        # delta-poller · ticket-writer · message-embedder ·
|   |   |                        # spam-gate + blocklist-store + spam-classifier ·
|   |   |                        # sender-directory (who a sender is: context for
|   |   |                        # the case file, filter for the demand report) ·
|   |   |                        # spam-audit (rows, body cap/clock, retention purge) ·
|   |   |                        # spam-body-backfill
|   |   |-- pipeline/            # categorise (classify-only) · categorise-runner
|   |   |-- retrieval/           # retrieval-rules · knowledge-retrieval ·
|   |   |                        # exemplar-{rules,retrieval} (which situation is this) ·
|   |   |                        # product-{matching,context,lookup} ·
|   |   |                        # promotion-{rules,lookup} · abandoned-checkout ·
|   |   |                        # customer-{context,lookup}
|   |   |-- investigation/       # case-file (THE output contract) · investigation-rules ·
|   |   |                        # decompose{,-rules} (tasks + needs, one call) ·
|   |   |                        # answer-selection (which answer the findings
|   |   |                        #   select, and the next need to collect) ·
|   |   |                        # evidence-rules (19 needs, scored vs the ledger;
|   |   |                        #   + findings = the value each took, + a
|   |   |                        #   requires/moot DAG and orderNeeds) ·
|   |   |                        # tool-registry · investigate (bounded loop) ·
|   |   |                        # investigation-runner · create-investigation
|   |   |-- resolution/          # customer-resolution-runner · order-number-parser ·
|   |   |                        # confirmation-evidence (every address in the
|   |   |                        #   message, as hashes; no template parsing) ·
|   |   |                        # order-verification · order-resolution-runner ·
|   |   |                        # order-context + order-context-runner
|   |   |-- routing/             # forward-rules · forwarding-store · forward-runner
|   |   |-- lifecycle/           # auto-close (28d idle, level 4 exempt)
|   |   `-- tools/               # one CLI per pass -- see Agent CLIs below
|   `-- eval/                    # categorisation-cases (40 dummy) · score-categorisation ·
|                                # sample-mailbox (review:sample) · compare-review-labels
`-- supabase/migrations/         # BASELINE, 5 files by domain, run in order against
                                 # an EMPTY database -- see Database Map.
                                 # _shared.test.mjs holds the cross-file invariants;
                                 # each file has its own sibling .test.mjs.
                                 # _live.test.mjs APPLIES the baseline into a
                                 # throwaway schema and asserts the views behave --
                                 # skipped unless SUPABASE_DB_URL is set
```

## Database Map

Every table has RLS on with no policies: **service-role access only**. Shopify stays source of truth; all syncs idempotent.

### Shopify snapshots

| Table | Holds |
| --- | --- |
| `shops` | shop records, environment, app settings, `sync_cursors` (incl. mail delta link) |
| `customers` | lean support snapshot: contact, marketing state, coarse location, lifetime totals, last order, `rfm_group`. No addresses or notes |
| `orders` | identity, links, channel, derived `order_status`, totals, line items, fulfillments, returns, refunds. Contacts hashed, plus `customer_email_masked` (`j***l@orange.fr`) for the one question a hash cannot answer; destination coarse; `retention_delete_after` |
| `products` | snapshots + first-class metafields, `variants` jsonb, `available_stock` |
| `promotions` | one row per redeem code (`code = null` for automatic); `rule_snapshot` carries values, not just type names |
| `shopify_metaobjects` | shared metaobjects (FAQ, ingredient lists) referenced by products |
| `shopify_content_sources` | content-free catalog of live pages + policies. Feeds Agent Setup only; no FK to knowledge |

### Curated knowledge

Never auto-synced — every row is an explicit import or a hand-written article.

| Table | Holds |
| --- | --- |
| `knowledge_documents` | `content_html` is the editor's truth; `approval_status` independent of Shopify publish `status`; `core_topic` = 1 of 6 slots, max one per shop; `voice_profile` jsonb |
| `knowledge_chunks` | retrieval chunks + `embedding vector(1536)` HNSW cosine, plus the determinism quadruple |

### Support exemplars

The recurring situations, not the answers to them. Same document/chunk mechanics as knowledge, in their own tables so retrieval can never reach a *question* while looking for policy.

| Table | Holds |
| --- | --- |
| `support_exemplars` | canonical question, `exemplar_key` (`P-16`), subject + kind, `requirement_needs text[]` constrained to the `evidence-rules.mjs` vocabulary, `approval_status` (gates the vector), `demand_message_count` |
| `support_exemplar_phrasings` | one row per canonical + real phrasing, each with its own `embedding vector(1536)` and the determinism quadruple. `language` + `translated_from_index` carry non-French rows; translations live at `phrasing_index >= 100`, out of reach of the importer's positional pruner. `match_support_exemplars()` returns one row per **exemplar**, scored by its best phrasing, and reports which language matched |
| `support_answers` | answer skeletons keyed by **evidence position**, shared across exemplars rather than nested. `when_conditions jsonb` = `{need: [findings]}`; one `is_fallback` per `answer_set`. Selected by `answer-selection.mjs`, which also derives the next need to collect |

### Agent email workflow

| Table | Holds |
| --- | --- |
| `tickets` | one per Graph `conversationId`. Taxonomy axes, `level`, `responsible_team`, `customer_id`, `shopify_order_number`, signals (`language`, `happiness`, `categorisation_confidence`), `resolved_context` jsonb, lifecycle + retention timestamps |
| `ticket_messages` | one per Graph message. Envelope, cleaned `body_text`, sanitised payload, `embedding vector(1536)` |
| `ticket_investigations` | **the case file**: `established` / `unverified` / `missing` / `do_not_claim` (four separate columns), `handoff`, `context_ref`, `dropped_claims`, `evidence_gaps` (what the ticket required vs what was obtained, each entry carrying the `finding` and the `details` naming WHICH product or code it is about — diagnostic, does not move the verdict), `exemplar_match` (which recurring situation this is; recorded, never acted on). `unique(shop_id, trigger_message_id)` |
| `email_blocklist` | per-shop sender email/domain rules + hit counts |
| `sender_directory` | per-shop sender email/domain → `label` (internal, contractor, logistics, courier, retailer, distributor, supplier, partner, other) + free-text `note`. Read into the case file as context and by `cluster:tickets` to tell customer demand from our own mail. Replaces `INTERNAL_EMAIL_DOMAINS`. Rows are exceptions; an unlisted sender is a consumer |
| `spam_audit` | one row per gate decision. `outcome`, `decided_by`, `reason`, `label`, `model`, `failed_open`, sender, subject, and on a block `body_text` + `body_captured_at` + `body_expires_at` |
| `category_forwarding` | per-category address book. A null address is the off switch |
| `ticket_forwards` | attempt ledger, `unique(ticket_message_id)`, `sent`/`failed` + attempt counter |
| `categorisation_review` | **testing artefact, not runtime**: hand-labelled sample scored against the agent |

### Projections

Views and functions for shapes that were being assembled client-side by reading
rows and discarding most of them. Joins and aggregates only — judgement stays in
tested JavaScript. Every view is `security_invoker`, or it would read past the
RLS on the tables under it.

| Object | Answers | Replaces |
| --- | --- | --- |
| `ticket_message_counts` | messages per ticket + inbound/outbound activity facts, soft-deleted excluded | a full read of `ticket_messages` to count in a Map |
| `ticket_first_inbound` | one row per ticket: its earliest inbound message | a read of every inbound body in the shop, keeping one per ticket |
| `ticket_queue` | the dashboard row: ticket + customer + count, soft-deleted excluded | `TICKET_LIST_SELECT` + the count join, in `tickets-service.ts` |
| `order_number_range(shop)` | lowest and highest `order_number`, live orders only | an asc/desc pair of `limit 1` reads |

### Compliance and audit

| Table | Holds |
| --- | --- |
| `integration_events` | metadata-only sync/webhook log, idempotent on `event_key` |
| `privacy_requests` | Shopify compliance webhook lifecycle (hashed contacts, deletion counts) |
| `data_access_events` | personal-data access audit trail. Sync paths and the agent's customer lookup write here |

### Migration files

**Five files, by domain, run in order against an empty database.** The order is a plain dependency chain, and every table is created *complete* — there is no `alter table … add column` anywhere in the baseline, and a test asserts that.

| File | Creates | Depends on |
| --- | --- | --- |
| `01_foundation.sql` | extensions, `set_updated_at()`, `shops`, `integration_events`, `privacy_requests`, `data_access_events` | — |
| `02_shopify.sql` | `is_valid_product_faqs()`, `customers`, `orders`, `products`, `shopify_metaobjects`, `promotions`, `shopify_content_sources`, `order_number_range()` | 01 |
| `03_knowledge.sql` | `knowledge_documents`, `knowledge_chunks`, `match_knowledge_chunks()`, `search_knowledge_chunks_text()` | 01 |
| `04_support.sql` | `tickets`, `ticket_messages`, `email_blocklist`, `sender_directory`, `spam_audit`, `ticket_investigations`, `category_forwarding`, `ticket_forwards`, `categorisation_review`, the three views | 01, 02 |
| `05_exemplars.sql` | `support_exemplars`, `support_exemplar_phrasings`, `support_answers`, `match_support_exemplars()` | 01, 03 (`french_unaccent`) |

`_shared.test.mjs` holds the cross-file invariants (no data statements, RLS on every table, every table and view documented, nothing referenced before it is created, every view `security_invoker` and revoked from the anon roles, every embedded table carrying the whole determinism quadruple, and `scripts/lib/tables.mjs` naming exactly what the baseline creates). Each file has a sibling test for its own contents.

`_live.test.mjs` is the only test that **runs** the SQL: it applies the baseline into a throwaway schema, seeds a handful of rows, asserts each projection returns what it claims, and drops the schema. Skipped unless `SUPABASE_DB_URL` is set, so `npm test` still passes without a database.

## Surfaces

All Route Handlers are server-only and use the Supabase service-role key.

### `/agent-setup` — knowledge library

`web/app/agent-setup/` → `web/components/agent-setup/`, over `web/lib/server/knowledge-service.ts` (which imports `scripts/lib/*` directly rather than duplicating the resolver, mapper and chunker).

- `GET knowledge/shopify-sources` — the catalog, flagging what is already imported
- `GET|POST knowledge/articles` — list; create empty, or resolve a `sourceId`'s live content
- `PATCH knowledge/articles/:id` — converts `source_type` to `manual`; demotes `approved` → `in_review` on a text change; re-embeds inline (best-effort)
- `POST knowledge/articles/:id/resync` — 400 once `manual`. `DELETE` — hard delete, chunks cascade

### `/tickets` — the queue

`web/app/tickets/` → `web/components/tickets/`, over `tickets-service.ts` + `dropped-mail-service.ts`. `tickets-service.ts` does not touch `tickets` itself: every read and the one write go through `scripts/lib/ticket-record.mjs`, and the list reads the `ticket_queue` view. Queue priority is computed in `scripts/lib/ticket-priority.mjs`; the view supplies facts (`inbound_count`, `waiting_since`), JavaScript owns the tunable judgement. Four stacked collapsible sections, each scrolling inside a fixed height:

| Section | Source | Row action |
| --- | --- | --- |
| **Queue** | `tickets`, status not resolved/closed, waiting less than 14 days | Close ticket |
| **Irrelevant** | `spam_audit`, `outcome = 'blocked'` | Add as ticket *(disabled)* |
| **Backlog** | `tickets`, status not resolved/closed, waiting 14+ days | Close ticket |
| **Closed** | `tickets`, status resolved/closed | Reopen ticket |

Row interactions: chevron expands the agent's reading (`TicketDetailPanel`: Results · Order · Action — the Order block leads with the name on the order and the masked order contact address, so ownership can be checked against the requester by eye); subject opens the conversation (`TicketThreadDialog`: draft + email chain). In the Irrelevant table the subject opens the dropped email (`DroppedMailDialog`). Four header cards, plus level tabs, category filter and sort — all client-side over the open-ticket set, then split into Queue and Backlog. Search is **per section**, in each `TicketSection` header (shown only while the section is open), so each of the four tables filters itself.

### `/settings` — forwarding address book

`web/app/api/forwarding/` over `forwarding-service.ts`. `GET` returns all 14 ticket categories with their address (`null` where unset); `PUT` upserts one. Saving an empty address clears it.

## Agent Worker

Run `npm run ingest:once` or `npm start` from `agent/`. One poll runs every pass below, **in this order** — the order is load-bearing (see `DECISIONS.md`).

| # | Pass | Module |
| --- | --- | --- |
| 1 | load config, assert Graph creds, resolve `shops.id` | `index.mjs` |
| 2 | follow Graph delta pages, persist cursor | `ingestion/delta-poller.mjs` |
| 3 | map messages; derive direction + normalise contact-form identity | `ingestion/graph-message-mapper.mjs` |
| 4 | **Gate 1** (no LLM): blocklist match → dropped before any write | `ingestion/spam-gate.mjs` |
| 5 | thread survivors by conversation; embed inline (best-effort) | `ingestion/ticket-writer.mjs` |
| 6 | **Gate 2** (LLM, new conversations only): drops `spam` **and** `irrelevant`; fails open | `ingestion/spam-classifier.mjs` |
| 7 | flush gate decisions (with body on a block) to `spam_audit` | `ingestion/spam-audit.mjs` |
| 8 | **Customer resolution** — needs no category, order number or LLM key | `resolution/customer-resolution-runner.mjs` |
| 9 | **Categorisation** (LLM) — 25/poll, oldest first, selects on the pending flag | `pipeline/categorise-runner.mjs` |
| 10 | **Investigation** (LLM + tools) — decompose (only if long / 2 subjects / 2 `?`), then 6 tool calls +2 per extra task, 4 turns, `ENABLED_SUBJECTS` only | `investigation/investigation-runner.mjs` |
| 11 | **Order resolution** then **order context** | `resolution/order-*-runner.mjs` |
| 12 | **Forwarding** — `contact` kind + a configured address; needs `Mail.Send` | `routing/forward-runner.mjs` |
| 13 | **Auto-close** — 28d idle, level 4 exempt; last so it sees this poll's timestamps | `lifecycle/auto-close.mjs` |
| 14 | **Retention purge** — nulls expired `spam_audit` bodies; best-effort | `ingestion/spam-audit.mjs` |

Built through Phase 4 (retrieval tools + the agent that uses them). **Drafting is Phase 5 and is not built.**

### Agent CLIs

From `agent/`. Every pass has a standalone runner, most with `:dry-run`.

| Command | Does |
| --- | --- |
| `ingest:once` / `start` | one poll / the loop. Supports `--limit=N`; with `--stop-after=categorise`, that limit applies to both Graph ingestion and the categorisation batch |
| `ingest:reset` | clear the delta cursor |
| `blocklist:add` | add a blocklist rule |
| `spam:backfill[:dry-run] -- --limit=N` | re-read dropped mail from Graph to fill `spam_audit` bodies |
| `customers:resolve[:dry-run]` | link `tickets.customer_id` from the requester hash |
| `customer:lookup -- <email> [--json] [--with-email]` | the CRM tool, no ticket needed |
| `orders:resolve[:dry-run]` | confirm order numbers |
| `context:build[:dry-run] [--refresh]` | fill `tickets.resolved_context` |
| `investigate[:dry-run] [--show/--brief] [--backfill]` | run + render case files |
| `forward:once` / `forward:dry-run` | the forwarding pass |
| `tickets:autoclose[:dry-run]` | the lifecycle pass |
| `eval:categorise` · `eval:retrieval` · `eval:diagnose` · `eval:exemplars` · `review:sample` · `review:compare` | every measurement — indexed in **`agent/eval/README.md`**, which says what each is judged against (three labelled sets, two proxies) |

## Read Order

`AGENTS.md` (rules) → **this map** → `DECISIONS.md` (why, per section, on demand) → `PRODUCT.md` (design direction) → `README.md` (status + setup).

Then as needed: `AGENT_INTEGRATION_PLAN.md` for agent phases, `SHOPIFY_PERSONAL_DATA_PROTECTION.md` and `MERCHANT_DATA_USE_DISCLOSURE.md` for anything touching customer data.
