# APP_SCHEMA

**Codebase navigator: where things are.** This file is the index, read every session; the detail lives in `docs/schema/`, read the one part you need. Why things are that way lives in `DECISIONS.md` (also an index); read the matching section before changing any behaviour.

Three npm packages: root (`scripts/`), `web/`, `agent/`. Shopify (source of truth) → Supabase/PostgreSQL (+pgvector) → Next.js 14 App Router + TypeScript + React 18 dashboard (CSS Modules, no UI framework). AI provider: OpenAI.

Secrets live in one repo-root `.env.local`; `web/next.config.mjs` and `agent/src/config.mjs` both load it.
Conventions: `*.test.mjs` sits next to its source (`npm test` = `node --test`); every `.tsx` has a sibling `.module.css`. Table and RPC names are written once, in `scripts/lib/tables.mjs`.

## Where to look

| Open | When you need |
| --- | --- |
| `docs/schema/map-web.md` | a dashboard route, API handler, component, or `web/lib/server/*` service |
| `docs/schema/map-scripts.md` | a Shopify/Klaviyo/social sync, a shared `scripts/lib/*` module, a report or probe |
| `docs/schema/map-agent.md` | a worker module: mail, ingestion, casework, investigation, drafting, outbound, lifecycle, rehearsals |
| `docs/schema/database.md` | a table or view (by domain), the migration files, the read-only reports |
| `docs/schema/surfaces.md` | what a page shows, which roles see it, which services feed it |
| `docs/schema/worker.md` | the poll's pass order (load-bearing) and the agent CLIs |
| `docs/database-refactor-plan.md` | the database refactor in progress (started 2026-10-12) |

## Top level

```text
|-- *.md             # AGENTS (rules) · APP_SCHEMA (this index) · DECISIONS (why, index)
|                    # PRODUCT (design) · README (status) · CHANGELOG (built) · VALIDATION_LOG (unproven)
|                    # AGENT_INTEGRATION_PLAN + Agent_Workflow (agent phases)
|                    # SHOPIFY_PERSONAL_DATA_PROTECTION + MERCHANT_DATA_USE_DISCLOSURE
|-- docs/            # schema/ (this map's detail) · decisions/ (the why, per area)
|                    # archive/ (closed changelog and validation entries)
|-- package.json     # sync:shopify:* · embed:* · import/translate:exemplars · cluster:tickets
|                    # report:knowledge-gaps · report:investigation-calls
|                    # report:evidence-vocabulary · report:completeness-gate
|                    # report:collection-planner · report:collection-replay
|                    # probe:analytics (what ShopifyQL will answer)
|                    # sync:klaviyo (flows + campaigns; key from Vault)
|                    # sync:social (Meta + Google Ads + TikTok; tokens from Vault)
|                    # probe:meta (which Meta metric names still answer)
|                    # db:apply:migration · test
|                    # storefront:chat (one proxy-signed message to the advisor)
|                    # eval:resolution (the advisor's product resolver, live catalogue)
|                    # dev-store:sync / dev-store:remove (DEV ONLY, scripts/dev-store/:
|                    # copy the advisor's dev store into Supabase as a development shop)
|                    # eval:storefront-knowledge (read-only live policy/FAQ checks)
|                    # inspect:storefront-knowledge (source keys, headings, parameter availability)
|                    # inspect:storefront-shopping (shop-scoped inventory counts, no codes)
|-- shopify.app.toml # Shopify app scopes (all read_*)
|-- web/             # Next.js dashboard: app/ (pages + api/), components/, lib/server/ (services),
|                    # lib/i18n/ (fr default, en), middleware.ts (THE GATE: every page + API
|                    # needs a session, except login and the HMAC/clientState webhooks)
|-- scripts/         # one sync per Shopify resource + sync-shopify-nightly (runs them all),
|                    # Klaviyo/social syncs, embedders, importers, reports, migration runner;
|                    # lib/ is shared by web and agent (REST client, records, rules)
|-- storefront-app/  # SEPARATE Shopify app, DEV STORE ONLY (own toml, own client_id, no scopes,
|                    # [app_proxy]); run its `shopify app ...` commands from here, never root.
|                    # extensions/storefront-advisor/: the theme app extension (advisor embed)
|-- data/advisor/qiriness.json  # the brand's advisory playbooks + mappings + merchandising;
|                    # npm run advisor:load loads it, npm run eval:advisory checks it
|-- agent/           # always-on worker (own package.json; reuses scripts/lib/). src/: mail
|                    # (provider boundary) · ingestion · pipeline (categorise) · retrieval ·
|                    # investigation · resolution · routing · drafting · cases · casework ·
|                    # outbound (THE ONLY SENDER) · lifecycle · reports · tools (one CLI per
|                    # pass) · testing (rehearsal harness). eval/: offline scoring
`-- supabase/migrations/  # BASELINE files by domain, run in order against an EMPTY database,
                     # then numbered forward migrations. _shared.test.mjs: cross-file
                     # invariants; each file has a sibling .test.mjs. _live.test.mjs APPLIES
                     # the baseline into a throwaway schema; only with SUPABASE_TEST_DB_URL
                     # (the dev project), never the app database
```

## Database domains

All tables live in `public`, RLS on, service-role only. The management chat reads the `chat` schema's views as `mgmt_chat_ro`. Detail per domain: `docs/schema/database.md`.

| Domain | Main tables |
| --- | --- |
| Shopify snapshots | `shops` `customers` `orders` `order_lines` `products` `promotions` `sales_channels` `shopify_metaobjects` `advice_collections` `shopify_content_sources` |
| Curated knowledge | `knowledge_documents` `knowledge_chunks` `company_policies` |
| Support exemplars | `support_exemplars` `support_exemplar_phrasings` `support_answers` `company_policy_links` `company_policy_versions` `support_parameters` |
| Agent email workflow | `tickets` `ticket_messages` `cases` `case_current` `case_links` `ticket_case_state` `ticket_investigations` `ticket_drafts` `outbound_actions` `mail_jobs` `mail_subscriptions` `spam_audit` `email_blocklist` `sender_directory` `ticket_forwards` `ticket_routing` `forwarding_*` `ticket_snoozes` `ticket_overrides` `dropped_mail_clears` |
| Projections | views: `ticket_queue` `case_facts` `customer_ticket_facts` `order_fulfilment_timing` `support_by_month` … and the `insights_*` / `orders_list*` / `vip_*` functions |
| Agent rehearsals | `agent_test_runs` `llm_usage` |
| Management chat | `chat_conversations` `chat_turns` `chat_queries`; the `chat` schema (14 views) |
| Storefront advisor | `storefront_chat_*` `advisor_*` `advisory_events` (dev store only) |
| Klaviyo | `klaviyo_connections` `klaviyo_campaigns` `klaviyo_flow_days` |
| Social and paid media | `social_*` `ad_*` (incl. `social_post_manual_metrics` `social_audience_manual`) |
| Compliance and audit | `privacy_requests` `data_access_events` `integration_events` |
| Analytics | `ticket_clusters` `cluster_runs` `storefront_session_months` `carrier_aliases` (config) |

## Surfaces

`/home` (management chat) · `/agent-setup` (knowledge library, policies, rules, parameters) · `/tickets` (the queue) · `/conversations` (threads we opened) · `/insights` (eight panels) · `/orders` · `/settings` · `/login`. Roles and what each page reads: `docs/schema/surfaces.md`.

## Read Order

`AGENTS.md` (rules) → **this index** → the one `docs/schema/*.md` part you need → `DECISIONS.md` index → the matching `docs/decisions/*.md` section (why, on demand) → `PRODUCT.md` (design direction) → `README.md` (status + setup).

Then as needed: `AGENT_INTEGRATION_PLAN.md` for agent phases, `SHOPIFY_PERSONAL_DATA_PROTECTION.md` and `MERCHANT_DATA_USE_DISCLOSURE.md` for anything touching customer data.
