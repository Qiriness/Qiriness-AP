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
3. Apply the three migration files in `supabase/migrations/` **in order** (`01_core_schema.sql`, `02_spam_filter.sql`, `03_categorisation.sql`) with `npm run db:apply:migration`. They are a baseline for an empty database, not idempotent patches — 03 extends tables 01 creates.
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
- **Email ingestion (agent Phase 1)** — verified against the real `onouailhetas@lap-groupe.com` mailbox (cursor idempotency, delta cursor persisted in `shops.sync_cursors`), then end-to-end against the live `contact@qiriness.com` support inbox: 500 messages -> 125 blocklisted, 27 LLM-filtered, 348 stored as 171 threaded tickets, all categorised with no failures. That run is what surfaced the four ingestion fixes below.
- **Ingestion reads the envelope correctly (found by running it on real mail).** Four defects, none visible on synthetic data:
  - *Direction.* The Inbox is not only inbound — the team's own replies land back in it. 123 of 348 messages were sent by the support address and stored as customer mail, putting Qiriness's own reply at the end of 43% of threads, exactly where the categoriser reads how the customer currently feels. A message from the support mailbox is now `outbound`, is never spam-triaged, and is never classified.
  - *Contact-form identity.* 53% of support mail arrives through the Shopify form, which sends from `mailer@shopify.com` with the customer's real name, address, country and message in the body. 95 tickets shared 2 `requester_email_hash` values, so the join key to `orders.customer_email_hash` was unusable for half the inbox. `contact-form.mjs` now parses those fields; distinct requesters went from 76 to 108 and the worst collision from 73 tickets to 8.
  - *`first_message_at`.* Graph's delta is not chronological, so threads are routinely opened by a later reply. The column was late on 93 of 171 tickets (5 days on average, 24 at worst) and the categoriser queue sorts on it. It now moves backwards as well as forwards.
  - *Queue starvation.* A thread holding only our own replies cannot be classified. It was skipped but left pending, so it sat at the front of an oldest-first batch of 25 forever — 11 such tickets took 11 of every 25 slots on every pass. Skipping now clears the flag, which ingestion re-raises when a customer message arrives.
- **Spam gate pass 1** — the `email_blocklist` check inside the poller; blocking a sender live dropped their 5 messages and purged their stored mail.
- **Spam audit trail** — every gate decision writes a `spam_audit` row (`kept`/`blocked`, which pass decided, and a one-line reason; `unsure` when the classifier had no confident reason, `failed_open` when a keep was only a fail-open). Needed because dropped mail is never stored, so this is its only trace. The write path was exercised against the live table: idempotent re-flush, one-line reason collapsing, and the `unsure` default all confirmed, then the test rows removed.
- **Support taxonomy pinned** — one shared vocabulary in `scripts/lib/support-taxonomy.mjs`: 14 subjects used by *both* knowledge categories and ticket categorisation (so a ticket's subject filters straight into matching knowledge chunks), plus `faq`/`brand_story` as knowledge-only, plus a tickets-only request kind (question/problem/complaint/contact) with a second subject+kind pair for emails spanning two topics. Level is derived from (subject, kind) and the categoriser can only escalate. The rename of the 9 existing articles and 54 chunks ran once against dev; the constraints on both the knowledge and ticket sides are applied and their enforcement verified live.
- **Level 4 means severity, not subject** — reserved for an explicit threat of legal action or public exposure, hospitalisation, or grave injury/danger. No (subject, kind) pair derives it, so it can only arrive as a categoriser escalation read from the email itself, and should be rare. A reported skin reaction is a level 2 `cosmetovigilance` problem (the formulations are natural, so reactions are mild allergies or irritations), and an RGPD request is level 3 human work. The database column comments carry this rule; an earlier version had shipped a subject-implied one, and the correction is applied to dev.
- **Human review set on real mail** — 40 emails randomly sampled from `contact@qiriness.com` (Nov 2025 / Dec 2025 / Jan 2026, 40 of 1,027) sit in `categorisation_review` awaiting hand labelling, after which `npm run review:compare` scores the agent against them. The sampler is read-only on the mailbox (GET only, no ingestion, no delta cursor) and the agent's own labels stay empty until after review, so the labelling is blind.
- **Schema fully applied to dev.** The migrations are now a three-file **baseline** -- `01_core_schema.sql`, `02_spam_filter.sql`, `03_categorisation.sql` -- run in order against an empty database, replacing the 15 numbered files that built dev incrementally (kept in git history). The baseline was verified to reproduce the live dev schema exactly: 384 columns, 147 constraints and 136 indexes, zero differences.

Built and unit-tested but **not yet run against live services**:

- **Knowledge embeddings** — `text-embedding-3-small` at 1536 dims, gated so only approved non-brand chunks hold vectors, with inline best-effort embedding on approval plus the `embed-knowledge-chunks.mjs` reconciler. The schema side is applied; this needs a first run with a real `OPENAI_API_KEY`.
- **Spam gate pass 2** — the LLM classifier (`gpt-4o-mini`, Structured Outputs) on new-conversation mail, which fails open on any error. No real model verdict has been recorded yet, so the reason quality (and how often it answers `unsure`) is still unmeasured.
- **Categorising agent (agent Phase 3)** — a batch pass in the same poll that fills `category` + `request_kind` (plus the optional secondary pair), the derived `level`, and `responsible_team` on every open ticket still uncategorised. Classification only: no tools, no order lookup, and the prompt carries the subject and message bodies but never the sender's address or name. The Structured Outputs enums are generated from `support-taxonomy.mjs`, the level is clamped to the derived floor (including the secondary pair's), level 4 is reachable only by the severity escalation described above, and three failed attempts write (other, problem) → level 3 so the ticket reaches a human instead of retrying forever. Measured twice. Against 40 invented cases (`npm run eval:categorise`): ~38-39/40 on all three axes. Against **30 hand-labelled real emails** from `contact@qiriness.com` (`categorisation_review`, `npm run review:compare`): subject 77%, kind 90%, level 73% — up from 67% / 70% / 60% before the real set exposed four wrong rules. Real mail is what drives the taxonomy now: the dispatch boundary between order and delivery, `complaint` only when nothing actionable is asked, `contact` only for a first approach, and the level floors all changed because human labelling disagreed with them.
- **Re-categorisation as threads grow** — a ticket's labels describe the conversation so far, not the email that opened it. Ingestion re-flags a ticket the moment a new *inbound* message joins the thread (never on our own replies), and the same batch pass re-reads it **blind** — the model is not shown its previous answer, which would only make it defend a first call that may have been wrong. A level may then rise but never fall (`ratchetLevel`), so an order question that becomes a lost parcel escalates, while a polite follow-up cannot walk a promised refund back out of the human queue. Superseded labels are kept in `metadata.categorisation.history`.
- **Two per-ticket signals** — read off the same email in the same call, since the model has already paid to read it. `language`, the language to reply in, restricted to what the desk can actually write (`other` routes to a human) — the drafting agent needs this before it writes a word, and on live mail it correctly caught 5 English, 1 Italian and 1 Spanish email among 163 French ones. `happiness` 1-4 (1 happy, 2 neutral, 3 discontent, 4 really unhappy: threatening to stop buying, calling it unacceptable, or chasing an unanswered thread). Happiness is **not** wired to `level` in either direction — level is what work a ticket needs, happiness is how the customer feels.
- **A third signal was built, measured, and removed.** The categoriser was also asked how confident it was. It answered `high` on 171 of 171 live tickets and 40 of 40 review cases: Structured Outputs emits fields in order, so the model was rating an answer it had already committed to in the same forward pass. The per-band accuracy report added to the eval is what caught it. The question was dropped rather than reworded — a constant field carries no information, and one called *confidence* invites the wrong decision downstream. `tickets.categorisation_confidence` survives as a known-untrustworthy marker written only by the failure paths. Until a calibrated signal exists (sampling for agreement, or token logprobs), Phase 5 should gate auto-drafting on `level` + `happiness`.