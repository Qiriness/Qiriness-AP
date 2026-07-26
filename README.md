# Qiriness Customer Support OS

A customer-support operating system for **Qiriness**, a French skincare and cosmetics brand: an agentic email reply workflow plus a dashboard, modelled on [letterbook.ai](https://www.letterbook.ai/). Shopify is the source of truth; Supabase/PostgreSQL is the operational database.

Repository map and data model: `APP_SCHEMA.md`. Coding rules: `AGENTS.md`. Design direction: `PRODUCT.md`. Agent workflow phases: `AGENT_INTEGRATION_PLAN.md`.

## Scope

Built or in progress: one-way Shopify -> Supabase sync, a curated knowledge library for AI context, retrieval embeddings, and email ingestion into conversation-threaded tickets.

Planned: order tracking, delivery issues, returns/refunds, product and payment questions, product advice, complaints and cosmetovigilance escalation, AI categorisation and reply drafting.

## Architecture

- **Shopify** owns products, variants, customers, orders, fulfilments, refunds, and discounts. Shopify IDs are the external identifiers.
- **Supabase PostgreSQL** (+pgvector) is the operational store. Sync is Shopify -> Supabase only, combining an initial import, webhooks for near-real-time updates, and scheduled reconciliation to catch drift. Webhook signature validation and idempotent processing are required. Webhook routes are **not deployed yet**; sync runs as manual/nightly CLI scripts.
- Important Shopify fields go in structured columns; raw payloads are retained only where useful and sanitised of unnecessary personal data.
- French text destined for AI context is normalised for UTF-8/Windows-1252 mojibake before storage, with raw payloads kept for traceability.
- Customer personal data is minimised, hashed where it is only a lookup key, and excluded from AI prompts unless strictly required. AI workflows retrieve context progressively rather than loading whole records.
- Knowledge articles are a **curated library**: nothing auto-syncs into `knowledge_documents`. Shopify pages and policies are catalogued by name only, and become articles when a team member imports one. See `APP_SCHEMA.md`'s Invariants.

## Stack

Confirmed: Shopify · Supabase · PostgreSQL · Next.js (App Router) + TypeScript + React 18 in `web/` (CSS Modules and design tokens, no UI framework) · Node ESM scripts at the repo root · OpenAI for embeddings and classification · Microsoft Graph for the support mailbox.

Pending: dashboard auth, ORM/DB client for app reads (scripts use `pg` + a Supabase REST client), job scheduling, webhook processing runtime, frontend test framework, deployment tooling.

## Getting started

1. `npm install` at the repo root.
2. Copy `.env.example` to `.env.local` and fill it in. This one repo-root file is the single source of truth for secrets — `web/next.config.mjs` and `agent/src/config.mjs` both load it, so there is no separate `web/.env.local`. Needed: `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_API_ACCESS_TOKEN` (or `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`), `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_URL`, `OPENAI_API_KEY`, and the `MS_GRAPH_*` + `SUPPORT_MAILBOX` vars for the agent worker. All server-only — never prefix with `NEXT_PUBLIC_`.
3. Apply the migrations in `supabase/migrations/` in order with `npm run db:apply:migration`.
4. Sync Shopify data. Every script has a `:dry-run` twin — run that first to verify API access and mapping:
   `npm run sync:shopify:products` · `:customers` · `:orders` · `:promotions` · `:content-catalog`, or `npm run sync:shopify:nightly` for all of them in order.
5. `npm run embed:knowledge` to embed approved knowledge chunks (`:dry-run` available).
6. `npm test` runs the root test suite (`node --test`).

Shopify scopes: `read_discounts` for promotions; `read_content`/`read_online_store_pages` and `read_legal_policies` for the content catalog; `read_themes` for the theme-template content fallback. Missing optional scopes surface as a clear import error rather than silent failure. For Shopify Dev Dashboard apps, leave `SHOPIFY_ADMIN_API_ACCESS_TOKEN` blank and the scripts request a short-lived Admin token from the client ID/secret at runtime.

### Dashboard (`web/`)

`cd web && npm install`, then `npm run dev` and open `http://localhost:3000` (redirects to `/agent-setup`). `npm run build`, `npm run lint`, `npm run typecheck` for checks. Run the root sync scripts at least once first — the Knowledge API looks the shop up by domain and returns a clear 404 until a `shops` row and the `shopify_content_sources` catalog exist.

### Agent worker (`agent/`)

`cd agent && npm install`, then `npm run ingest:once` for a single ingestion pass or `npm start` to poll. Also `npm run blocklist:add -- <email|domain>` and `npm run ingest:reset`.

## Development Status

Working and verified live against the dev Shopify store and Supabase:

- **Agent Setup dashboard** (`/agent-setup`) — the only surface built so far. Two-pane knowledge workflow: article library with search, status filters, a 6-slot core-topic checklist and category grouping; a workspace editor with Shopify page/policy import, resync, save/approve/delete, and a dedicated brand-voice workspace. Full state and a11y coverage. "Optimize" is still a local placeholder with no AI behind it.
- **Knowledge API** (`web/app/api/knowledge/*`) — exercised end-to-end through the real browser UI, not just curl: page import, policy import, edit-converts-to-manual (Resync correctly disappears), and delete.
- **Shopify sync scripts** — products/metaobjects, customers, orders, promotions, the unified page+policy content catalog, and nightly orchestration.
- **Email ingestion (agent Phase 1)** — verified against the real `onouailhetas@lap-groupe.com` mailbox: a first pass threaded 34 emails into 20 tickets, a second ingested nothing (cursor idempotency), and the delta cursor persists in `shops.sync_cursors`.
- **Spam gate pass 1** — the `email_blocklist` check inside the poller; blocking a sender live dropped their 5 messages and purged their stored mail.
- **Spam audit trail** — every gate decision writes a `spam_audit` row (`kept`/`blocked`, which pass decided, and a one-line reason; `unsure` when the classifier had no confident reason, `failed_open` when a keep was only a fail-open). Needed because dropped mail is never stored, so this is its only trace. `010` is applied and the write path was exercised against the live table: idempotent re-flush, one-line reason collapsing, and the `unsure` default all confirmed, then the test rows removed.
- **Support taxonomy pinned** — one shared vocabulary in `scripts/lib/support-taxonomy.mjs`: 14 subjects used by *both* knowledge categories and ticket categorisation (so a ticket's subject filters straight into matching knowledge chunks), plus `faq`/`brand_story` as knowledge-only, plus a tickets-only request kind (question/problem/complaint/contact) with a second subject+kind pair for emails spanning two topics. Level is derived from (subject, kind) and the categoriser can only escalate. `011` renamed the 9 existing articles and 54 chunks and constrained the column that had been free text "until the taxonomy is finalised"; `012` did the ticket side. Both applied and constraint enforcement verified live.
- **Migrations 001-005, 007-012** applied to dev. `005` exists because `003` was edited after being applied and the live database drifted; the fix was confirmed by direct query, with no data affected.

Built and unit-tested but **not yet run against live services**:

- **Knowledge embeddings** — `text-embedding-3-small` at 1536 dims, gated so only approved non-brand chunks hold vectors, with inline best-effort embedding on approval plus the `embed-knowledge-chunks.mjs` reconciler. Needs `006` applied and a first run with a real `OPENAI_API_KEY`.
- **Spam gate pass 2** — the LLM classifier (`gpt-4o-mini`, Structured Outputs) on new-conversation mail, which fails open on any error. No real model verdict has been recorded yet, so the reason quality (and how often it answers `unsure`) is still unmeasured.

Not built: dashboard authentication, deployed webhook routes, and the agent's categorisation, tool, and drafting stages. 201 tests pass from the repo root (50 of them the `agent/` worker's). Backend/deploy config is still pending.

## Next Steps

1. Apply `006_knowledge_chunk_embeddings.sql` to dev (confirm the managed pgvector supports HNSW; fall back to `ivfflat`), then run `embed:knowledge:dry-run` and `embed:knowledge` on an approved article. Then wire up the similarity search that consumes these vectors, filtered to approved chunks.
2. Run the LLM spam classifier against live mail, then read `spam_audit` to check its verdicts and reason quality before trusting it — in particular how often it answers `unsure`, and whether any `blocked` row looks like a genuine customer. Then build the agent's next phases per `AGENT_INTEGRATION_PLAN.md` (categorisation, order-context tools, drafting).
3. Add dashboard authentication, role policies, and human personal-data access logging into `data_access_events` before any customer data is exposed in the UI.
4. Tighten the theme-template resolver's "is this a real text setting" heuristic — it leaked raw Shopify section-setting tokens (e.g. `accent-color`, `vertical-bottom horizontal-left`) into one imported page during testing. Only affects pages with no page-metafield and no usable `Page.body`.
5. Set up separate Supabase development and production projects.
6. Add the remaining support tables for AI events, and deploy runtime webhook routes over reusable handlers.
7. Expand tests: `web/lib/server/knowledge-service.ts` has none, and Agent Setup has no component or interaction tests.
