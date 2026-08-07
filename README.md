# Qiriness Customer Support OS

A customer-support operating system for **Qiriness**, a French skincare and cosmetics brand: an agentic email reply workflow plus a dashboard, modelled on [letterbook.ai](https://www.letterbook.ai/). Shopify is the source of truth; Supabase/PostgreSQL is the operational database.

## The documents

| File | Answers |
| --- | --- |
| `APP_SCHEMA.md` | **Where things are** — repository map, data model, pass order. Read first |
| `DECISIONS.md` | **Why they are that way** — per section, on demand. Read before changing behaviour |
| `AGENTS.md` | Coding rules |
| `CHANGELOG.md` | What has been built and how far it is proven |
| `VALIDATION_LOG.md` | What is built but **not yet proven against real data**, and the check to run |
| `PRODUCT.md` | Design direction |
| `AGENT_INTEGRATION_PLAN.md` | Agent workflow phases |
| `SHOPIFY_PERSONAL_DATA_PROTECTION.md` · `MERCHANT_DATA_USE_DISCLOSURE.md` | Compliance, for anything touching customer data |

## Scope

Built: one-way Shopify → Supabase sync, a curated knowledge library for AI context, retrieval embeddings, email ingestion into conversation-threaded tickets, categorisation, the Phase 4 retrieval tools, and the investigation agent that uses them.

Not built: reply drafting (Phase 5), dashboard authentication, deployed webhook routes.

## Architecture

- **Shopify** owns products, variants, customers, orders, fulfilments, refunds and discounts. Shopify IDs are the external identifiers.
- **Supabase PostgreSQL** (+pgvector) is the operational store. Sync is Shopify → Supabase only, combining an initial import, webhooks for near-real-time updates, and scheduled reconciliation to catch drift. Webhook signature validation and idempotent processing are required. Webhook routes are **not deployed yet**; sync runs as manual/nightly CLI scripts.
- Important Shopify fields go in structured columns; raw payloads are retained only where useful and sanitised of unnecessary personal data.
- French text destined for AI context is normalised for UTF-8/Windows-1252 mojibake before storage, with raw payloads kept for traceability.
- Customer personal data is minimised, hashed where it is only a lookup key, and excluded from AI prompts unless strictly required. AI workflows retrieve context progressively rather than loading whole records.
- Knowledge articles are a **curated library**: nothing auto-syncs into `knowledge_documents`.

## Stack

Confirmed: Shopify · Supabase · PostgreSQL · Next.js (App Router) + TypeScript + React 18 in `web/` (CSS Modules and design tokens, no UI framework) · Node ESM scripts at the repo root · OpenAI for embeddings and classification · Microsoft Graph for the support mailbox.

Pending: dashboard auth, ORM/DB client for app reads (scripts use `pg` + a Supabase REST client), job scheduling, webhook processing runtime, frontend test framework, deployment tooling.

## Getting started

1. `npm install` at the repo root.
2. Copy `.env.example` to `.env.local` and fill it in. This one repo-root file is the single source of truth for secrets — `web/next.config.mjs` and `agent/src/config.mjs` both load it, so there is no separate `web/.env.local`. Needed: `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_API_ACCESS_TOKEN` (or `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`), `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_URL`, `OPENAI_API_KEY`, and the `MS_GRAPH_*` + `SUPPORT_MAILBOX` vars for the agent worker. All server-only — never prefix with `NEXT_PUBLIC_`.
3. Apply the four files in `supabase/migrations/` **in order** with `npm run db:apply:migration supabase/migrations/<file>`: `01_foundation.sql` → `02_shopify.sql` → `03_knowledge.sql` → `04_support.sql`. They are a baseline for an empty database, not idempotent patches, and the order is a dependency chain (everything references `shops`; tickets reference customers).
4. Sync Shopify data. Every script has a `:dry-run` twin — run that first to verify API access and mapping: `npm run sync:shopify:products` · `:customers` · `:orders` · `:promotions` · `:content-catalog`, or `npm run sync:shopify:nightly` for all of them in order.
5. `npm run embed:knowledge` to embed approved knowledge chunks (`:dry-run` available).
6. `npm test` runs the root test suite (`node --test`).

**Microsoft Graph application permissions:** `Mail.Read` for ingestion, plus **`Mail.Send`** for the forwarding pass — the only write the worker makes to Graph. Without it forwarding records every attempt as `failed` rather than failing quietly; ingestion and categorisation are unaffected.

**Shopify scopes:** `read_discounts` for promotions; `read_content`/`read_online_store_pages` and `read_legal_policies` for the content catalog; `read_themes` for the theme-template content fallback. Missing optional scopes surface as a clear import error rather than silent failure. For Shopify Dev Dashboard apps, leave `SHOPIFY_ADMIN_API_ACCESS_TOKEN` blank and the scripts request a short-lived Admin token from the client ID/secret at runtime.

### Dashboard (`web/`)

`cd web && npm install`, then `npm run dev` and open `http://localhost:3000` (redirects to `/agent-setup`). `npm run build`, `npm run lint`, `npm run typecheck` for checks. Run the root sync scripts at least once first — the Knowledge API looks the shop up by domain and returns a clear 404 until a `shops` row and the `shopify_content_sources` catalog exist.

### Agent worker (`agent/`)

`cd agent && npm install`, then `npm run ingest:once` for a single pass or `npm start` to poll. Every pipeline stage also has a standalone CLI, most with a `:dry-run` twin — see `APP_SCHEMA.md` § Agent CLIs.

## Current state

Working end to end against the dev Shopify store and the dev Supabase project: the Agent Setup and Tickets dashboards, the Shopify syncs, email ingestion, both spam gates, embeddings and retrieval, categorisation, the Phase 4 retrieval tools, and the investigation agent. **Drafting is not built.**

The full record of what was built and how far each piece is proven is in `CHANGELOG.md`; what remains unproven, with the check to run, is in `VALIDATION_LOG.md`.

**The one thing gating most of the rest:** Supabase holds the *dev* store (12 orders, 15 customers) while the mail corpus is from the live inbox. Zero overlap, so `shopify_order_number` is set on 0 of 330 tickets and `customer_id` on 0 — which in turn means the order tools, the order-context bundle and the VIP badge are all correct code with no data to run against. See step 1 below.

**Tests:** 723 from the repo root, 456 in `agent/`.

## Next Steps

Reordered 2026-07-30 after measuring the clustered corpus against the level taxonomy. The target is explicit: **auto-resolve level 1 and 2, and for level 3 assemble everything a human needs to act.** Across 330 customer-facing categorised tickets that splits **L1 42 (13%) · L2 156 (47%) · L3 131 (40%) · L4 1**, so 60% is in scope for automation and 40% for context assembly. What each tool is worth is in `AGENT_INTEGRATION_PLAN.md` Phase 4.

The previous ordering put the knowledge library first, on the reasoning that only one of nine documents is `approved`. That was measured and is wrong: embedding the 19 unapproved draft chunks in memory and scoring them against the top 12 customer topics closed **0** of them. Approval was never the constraint. Roughly 127 messages of top demand need live order data and 46 need an article, so the tools layer is worth about three times the library.

1. **Sync real Shopify order data — the hard prerequisite for everything below.** Supabase holds the dev store: 12 orders, `#1001`–`#1012`, 15 customers. The mail references `#4854`, `#6216`, `#4613`, `Q00 26200111` — **zero overlap**. Re-measured 2026-08-07 with `customers:resolve:dry-run`: 500 considered, 500 `no_match`, 0 linked. This also gates the **VIP badge**, which reads the RFM segment through `customer_id`. No order tool can be validated against this, so it lands before Phase 4, not after (and it forces the dev/prod split at step 9).
2. **Decide which mailbox and which store this environment is for.** The stored corpus was ingested from `contact@qiriness.com`; `SUPPORT_MAILBOX` now points at `onouailhetas@lap-groupe.com`. Exchange item ids are mailbox-scoped, so every `graph_message_id` in the database is unusable against the configured mailbox — proven by `spam:backfill:dry-run`, which Graph rejects with `ErrorInvalidMailboxItemId` on kept and blocked messages alike. Nothing that addresses a message by id can work until these agree: not the spam-body backfill, not `/forward`, not a future "Add as ticket" re-fetch. This is one decision with step 1 and step 9.
3. **Phase 4 — the Tool Runner.** The individual tools are built, **but nothing exposes them to a model** beyond the investigation agent's own registry: there are no typed tool schemas for a general runner, no dispatch, and no approval gate. Wiring them up, with side-effecting tools returning "needs approval" instead of executing, is what turns a library of lookups into an agent.
4. **Fill the knowledge library — only the part clustering shows is genuinely answerable by an article.** The product questions: a product-quality problem (15) and pre-purchase questions on the LED mask, the coffret and ingredients (14+9+8) ≈ 46 messages. Leave the CGV and delivery drafts unapproved — they add retrieval noise without answering anything.
5. **Re-tune the clustering threshold against the bigger corpus, or decide it does not need it.** 0.68 was set by eye at ~225 messages; the corpus is now 1111 (563 customer-side). Worth a threshold sweep reporting size and cohesion distributions before changing the default, and worth checking whether `delivery` (168 messages) and `legal_privacy` (8) can share one number at all.
6. **Grow the real review set.** Ten of the 40 sampled emails are still unlabelled, and at n=30 the harness cannot resolve a change smaller than ~16 points. Label those ten, and sample toward ~100 before tuning anything against it.
7. **Realign `AGENT_INTEGRATION_PLAN.md` with what was actually built** — it still describes migrations `011`/`012`/`013`/`014`, the `category is null` selection the re-categorisation flag replaced, and the confidence signal that has since been measured and removed.
8. **Add dashboard authentication, role policies, and human personal-data access logging into `data_access_events`.** The thread dialog and the Irrelevant dialog now render full email bodies and sender addresses in the browser with no audit event, because there is no dashboard user identity to attribute one to — which is the thing to build first. `SHOPIFY_PERSONAL_DATA_PROTECTION.md` also needs updating to describe `spam_audit.body_text` as retained personal data with a 90-day life.
9. **Set up separate Supabase development and production projects.** Pointing a worker at a fresh mailbox triggers a full unordered delta enumeration — decide before go-live whether to ingest the backlog or seed the cursor and start clean.
10. **Tighten the theme-template resolver's "is this a real text setting" heuristic** — it leaked raw Shopify section-setting tokens into one imported page during testing. Only affects pages with no page-metafield and no usable `Page.body`.
11. **Add the remaining support tables for AI events**, and deploy runtime webhook routes over reusable handlers.
12. **Expand tests:** `web/lib/server/knowledge-service.ts` has none, and the dashboard has no component or interaction tests.
13. **Exercise the ticket detail panel against stored case files** — run `npm run investigate` so `ticket_investigations` holds rows, then check the three blocks against the CLI's `--brief` for the same ticket. The **Order block's status and tracking lines** need a ticket whose `resolved_context` is populated (blocked on step 1), and the **thread dialog** needs a ticket with more than one stored message.
