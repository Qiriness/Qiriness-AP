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

Built: one-way Shopify → Supabase sync, a curated knowledge library for AI context, retrieval embeddings, email ingestion into conversation-threaded tickets, categorisation, customer and order resolution, the Phase 4 retrieval tools, the exemplar layer, the investigation agent that uses them, team forwarding, and four analytics panels.

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
3. Apply the seven files in `supabase/migrations/` **in order** with `npm run db:apply:migration supabase/migrations/<file>`: `01_foundation.sql` → `02_shopify.sql` → `03_knowledge.sql` → `04_support.sql` → `05_exemplars.sql` → `06_analytics.sql` → `07_drafting.sql`. They are a baseline for an empty database, not idempotent patches, and the order is a dependency chain (everything references `shops`; tickets reference customers; exemplars reuse the `french_unaccent` config from 03; analytics and drafting read the support tables).
4. Sync Shopify data. Every script has a `:dry-run` twin — run that first to verify API access and mapping: `npm run sync:shopify:products` · `:customers` · `:orders` · `:promotions` · `:content-catalog`, or `npm run sync:shopify:nightly` for all of them in order.
5. `npm run embed:knowledge` to embed approved knowledge chunks (`:dry-run` available).
6. `npm test` runs the root test suite (`node --test`).

**Microsoft Graph application permissions:** `Mail.Read` for ingestion, plus **`Mail.Send`** for the forwarding pass — the only write the worker makes to Graph. Without it forwarding records every attempt as `failed` rather than failing quietly; ingestion and categorisation are unaffected.

**Shopify scopes:** `read_discounts` for promotions; `read_content`/`read_online_store_pages` and `read_legal_policies` for the content catalog; `read_themes` for the theme-template content fallback. Missing optional scopes surface as a clear import error rather than silent failure. For Shopify Dev Dashboard apps, leave `SHOPIFY_ADMIN_API_ACCESS_TOKEN` blank and the scripts request a short-lived Admin token from the client ID/secret at runtime.

### Dashboard (`web/`)

`cd web && npm install`, then `npm run dev` and open `http://localhost:3000` (redirects to `/agent-setup`). `npm run build`, `npm run lint`, `npm run typecheck` for checks. Run the root sync scripts at least once first — the Knowledge API looks the shop up by domain and returns a clear 404 until a `shops` row and the `shopify_content_sources` catalog exist.

### Agent worker (`agent/`)

`cd agent && npm install`, then `npm run ingest:once` for a single pass or `npm start` to poll. For a backlog review pass that stores and categorises mail without investigation or forwarding, run `npm run ingest:once -- --limit=500 --stop-after=categorise`. Every pipeline stage also has a standalone CLI, most with a `:dry-run` twin — see `APP_SCHEMA.md` § Agent CLIs.

## Current state

Working end to end against the live Shopify store (`qiriness.myshopify.com`) and the Supabase project: the Agent Setup, Tickets and Insights dashboards, the Shopify syncs, email ingestion, both spam gates, embeddings and retrieval, categorisation, customer and order resolution, the Phase 4 retrieval tools, the exemplar layer, and the investigation agent. **Drafting is not built.**

The full record of what was built and how far each piece is proven is in `CHANGELOG.md`; what remains unproven, with the check to run, is in `VALIDATION_LOG.md`.

**The data prerequisite is met.** 2052 orders spanning `#4716`–`#6770` — a range that contains every order number the mail corpus quotes — plus 58 201 customers, 116 products and 327 promotions.

**The pipeline has run over the corpus.** Measured 2026-08-17, read from the database:

| | |
| --- | --- |
| Tickets | 214, of which 203 categorised (L1 16 · L2 102 · L3 85) |
| Messages | 451, **all 451 embedded** |
| Customer link | 145 of 214 |
| Order link | **52** carry a confirmed `shopify_order_number` and a built `resolved_context` |
| Case files | 80 tickets investigated — 49 `needs_human`, 16 `needs_customer_input`, 15 `answerable`. 70 sit on tickets still live |
| Investigation queue | 113 flagged, **0 claimable** — all closed, so the flag is unreachable (`VALIDATION_LOG.md` item 16) |
| Knowledge | 61 chunks, all embedded — but **zero** in `delivery`, `order`, `promotions`, `payment`, `product_stock` |
| Exemplars | 31 approved, 94 phrasings embedded; `support_answers` still empty |

`orders:resolve` and `context:build` have both run: the remaining 138 order-family tickets report `no_candidate` because they quote no order reference and their sender matches no order — the resolver's designed answer, not an unrun pass.

**The investigation cannot catch up with the order data**, though, and not for want of running. Only **23 of the 52** resolved tickets carry a case file; the other **29 are closed**, and `claim` requires `status = 'open'`. Auto-close retires a thread after 28 days of silence without clearing its `needs_investigation` flag, so on historical mail 139 tickets closed carrying a flag nothing can act on — **113 flagged, 0 claimable**. `--backfill` reaches 9 tickets that already have case files and none of the 113. The decision this needs is `VALIDATION_LOG.md` item 16.

**Tests:** 1310 from the repo root, 771 in `agent/`.

## Next Steps

**Reordered 2026-08-17, after reading the database rather than the docs.** Two items that headed this list are done and are gone from it: order resolution has run (52 tickets carry a confirmed number and a built context bundle), and `AGENT_INTEGRATION_PLAN.md` has been realigned with what was actually built. What changed the ordering:

- **Phase 5 is under way: the drafting agent writes replies.** `npm run draft` has produced
  **32 drafts over the whole draftable set** (15 `answerable`, 17 `needs_customer_input`) at
  ≈ $0.02 each, all passing the mechanical checks, none auto-sent. The system prompt is the
  Brand voice article, and approval of it gates the pass. What remains in this phase:
  **the review copy to the reviewer's own inbox**, **approve / edit / reject in the
  dashboard**, and the **send path** — the last still blocked on which mailbox this
  environment is for. Drafting stays operator-triggered, out of the poll, until the drafts
  have been read.
- **Reviewing those 32 drafts is the next real task**, and it is a reading job rather than a
  coding one: the checks can prove a named sentence is absent and cannot say the reply is
  right. 19 are marked `auto_send_eligible`, which is the number the eventual L1/L2
  graduation turns on.
- **The knowledge library moved up, because the gap is now specific rather than general.**
  61 chunks are embedded and **zero** of them are in `delivery`, `order`, `promotions`,
  `payment` or `product_stock` — the five highest-demand subjects. A level 1 ticket is by
  definition answerable from the library alone, so this is the ceiling on what drafting can
  auto-answer, not a tidy-up.
- **Three tables were empty where prose assumed rows.** `llm_usage` is fixed — nothing had
  ever constructed a usage sink, so every model call fell back to the no-op; it is wired and
  verified now. Still empty: `categorisation_review` (the 30 hand labels behind the
  77% / 90% / 73% accuracy numbers are gone) and `category_forwarding` / `ticket_forwards`
  (forwarding has never routed anything here).
- **There is no investigation backlog, though 113 tickets look like one.** They are all
  closed, and `claim` requires `status = 'open'` — which is right for the worker and wrong for
  a backfill over imported history. `npm run investigate -- --include-closed` lifts that filter
  deliberately, leaves every ticket's status untouched, and reaches 91 investigable tickets
  (28 of them carrying unread order context) for about $1.45.
- **Dashboard auth is still the blocking compliance item.** `/insights/customers` names
  individual customers and their lifetime spend; the panel says so, but a warning is not an
  access control.
- **The carrier table's lost / damaged / late columns are placeholders**, and the parcel-status
  question behind them is now answered: Shopify has no live status (`delivered_at` on 1 order
  in 2 006, `in_transit_at` on none). Filling them needs a delivery feed from the 3PL or a new
  classification axis — see `AGENT_INTEGRATION_PLAN.md` § Open questions.

The target is unchanged: **auto-resolve level 1 and 2, and for level 3 assemble everything a human needs to act.** On the current 203 categorised tickets that splits L1 16 (8%) · L2 102 (50%) · L3 85 (42%) · L4 0. What each tool is worth is in `AGENT_INTEGRATION_PLAN.md` Phase 4.

1. **Phase 5 — drafting.** A `ticket_drafts` table keyed on the trigger message (so a reply cannot silently overwrite a draft under review), the mid-tier drafting call over `toDraftingPrompt` + order context + brand voice + retrieved chunks + the matched exemplar, and the gate: `answerable` → draft a reply, `needs_customer_input` → draft the question in the stored `MISSING_FIELDS` wording, `needs_human` → no customer-facing draft at all. **The live slice is 22 tickets** — 9 `answerable` and open, 13 awaiting the customer — and six `answerable` threads have already auto-closed unanswered, which is this phase's absence measured. Everything stays behind `DRAFT_ONLY`; the send path is separate and blocked by step 3.
2. **Fill the knowledge library on the five empty subjects.** `delivery`, `order`, `promotions`, `payment`, `product_stock` hold zero chunks between them, and `product` holds four. Clustering says the answerable product demand is a quality problem (15) plus pre-purchase questions on the LED mask, the coffret and ingredients (14+9+8) ≈ 46 messages. Leave the CGV drafts unapproved — they add retrieval noise without answering anything.
3. **Decide which mailbox and which store this environment is for.** The stored corpus was ingested from `contact@qiriness.com`; `SUPPORT_MAILBOX` now points at `onouailhetas@lap-groupe.com`. Exchange item ids are mailbox-scoped, so every `graph_message_id` in the database is unusable against the configured mailbox — proven by `spam:backfill:dry-run`, which Graph rejects with `ErrorInvalidMailboxItemId` on kept and blocked messages alike. Nothing that addresses a message by id can work until these agree: not the spam-body backfill, not `/forward`, not "Add as ticket", **and not Phase 5's send step**. One decision with step 9.
4. **Check `scripts/lib/llm-rates.mjs` against current OpenAI pricing.** Cost is now measured rather than guessed — an investigated ticket is 4 calls, ~5 500 in / 520 out, **≈ $0.016** — but every figure on `/insights/agent` is only as good as that rate card, and nobody has verified it. ~~Confirm the token sink is writing~~ and ~~decide what a closed ticket's pending flag means~~ — both **done 2026-08-17** (`VALIDATION_LOG.md` items 14 and 16).
5. **Re-sample and re-label the categorisation review set.** `categorisation_review` is empty, so the real-mail accuracy figures cannot be recomputed, extended or defended. `npm run review:sample` then blind labelling; sample toward ~100 rather than back to 30, since at n=30 the harness cannot resolve a change smaller than ~16 points.
6. **Write the answer skeletons.** `support_answers` has 0 rows and `answer_set` is null on every exemplar, so `answer-selection.mjs` is a mechanism with no content. Estimated 10–15 answers across the four families, keyed by evidence position. Not a Phase 5 blocker; it is what later makes a reply's structure deterministic instead of model-chosen.
7. **Configure forwarding and run it once for real.** No `category_forwarding` address is set, so the pass has never routed a message; the last live attempts returned `ErrorMailboxMoveInProgress`. Confirm a forwarded CV arrives as a CV — the one thing no test covers.
8. **Add dashboard authentication, role policies, and human personal-data access logging into `data_access_events`.** The thread dialog and the Irrelevant dialog now render full email bodies and sender addresses in the browser with no audit event, because there is no dashboard user identity to attribute one to — which is the thing to build first. `SHOPIFY_PERSONAL_DATA_PROTECTION.md` also needs updating to describe `spam_audit.body_text` as retained personal data with a 90-day life.
9. **Set up separate Supabase development and production projects.** Pointing a worker at a fresh mailbox triggers a full unordered delta enumeration — decide before go-live whether to ingest the backlog or seed the cursor and start clean.
10. **Re-tune the clustering threshold, or decide it does not need it.** 0.68 was set by eye at ~225 messages. One persisted run exists (2026-08-16, threshold 0.68, `min_size` 2), so a second can be compared instead of argued about — worth a sweep reporting size and cohesion distributions, and worth checking whether `delivery` and `legal_privacy` can share one number at all.
11. **Build the case-file corpus when a bigger sample is wanted** — `npm run investigate -- --include-closed --limit N`, ≈ $0.016 per ticket, 91 in scope, statuses untouched. Not urgent: what Phase 5 needs from this corpus is the verdict mix, and 80 case files already give that. ~~Catch up the investigation backlog~~ — there was none.
12. **Tighten the theme-template resolver's "is this a real text setting" heuristic** — it leaked raw Shopify section-setting tokens into one imported page during testing. Only affects pages with no page-metafield and no usable `Page.body`.
13. **Add the remaining support tables for AI events**, and deploy runtime webhook routes over reusable handlers.
14. **Expand tests:** `web/lib/server/knowledge-service.ts` has none, and the dashboard has no component or interaction tests.
15. **Exercise the ticket detail panel against stored case files** — now possible: 80 tickets carry a case file and 52 of those carry a populated `resolved_context`, so the Order block's status and tracking lines have data behind them. Check the three blocks against the CLI's `--brief` for the same ticket, and use a multi-message ticket for the thread dialog.
