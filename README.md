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
| `codex_plans/Rule_Guided_Investigation_Plan.md` | The rules layer — its sequencing table is the status of steps 1–9 |
| `codex_plans/Model_Cost_Notes.md` | Where the model spend goes, and which levers were measured and rejected |
| `SHOPIFY_PERSONAL_DATA_PROTECTION.md` · `MERCHANT_DATA_USE_DISCLOSURE.md` | Compliance, for anything touching customer data |

## Scope

Built: one-way Shopify → Supabase sync, a curated knowledge library for AI context, retrieval embeddings, email ingestion into conversation-threaded tickets (behind a provider-neutral `MailProvider`, Outlook implemented), categorisation, customer and order resolution, the Phase 4 retrieval tools, the exemplar layer, the investigation agent that uses them, the **rules layer** — 108 approved answers that decide the route, the question to ask and the reply's skeleton per situation, including per-request rulebooks for emails that ask two things — team forwarding, four analytics panels, an agent test chat, **reply drafting** — stored, checked and reviewable — and a **send path**: approved replies go out through one outbound worker, checked again at send time and confirmed from Sent Items. It is off (`OUTBOUND_SEND_ENABLED`) and has not sent anything yet.

Not built / not live: the send path has never run against the real mailbox; webhook routes (Shopify, Graph) are not deployed, so the Graph subscription stays dormant.

## Architecture

- **Shopify** owns products, variants, customers, orders, fulfilments, refunds and discounts. Shopify IDs are the external identifiers.
- **Supabase PostgreSQL** (+pgvector) is the operational store. Sync is Shopify → Supabase only, combining an initial import, webhooks for near-real-time updates, and scheduled reconciliation to catch drift. Webhook signature validation and idempotent processing are required. Webhook routes are **not deployed yet**. The nightly reconciliation runs as a scheduled GitHub Actions workflow (`.github/workflows/nightly-sync.yml`, 02:00 UTC, with a manual `workflow_dispatch` button); the same `npm run sync:shopify:nightly` still runs by hand. It moves to the app server when there is one — the job is one npm script, so that is a cron line rather than a rewrite.
- Important Shopify fields go in structured columns; raw payloads are retained only where useful and sanitised of unnecessary personal data.
- French text destined for AI context is normalised for UTF-8/Windows-1252 mojibake before storage, with raw payloads kept for traceability.
- Customer personal data is minimised, hashed where it is only a lookup key, and excluded from AI prompts unless strictly required. AI workflows retrieve context progressively rather than loading whole records.
- Knowledge articles are a **curated library**: nothing auto-syncs into `knowledge_documents`.

## Stack

Confirmed: Shopify · Supabase · PostgreSQL · Next.js (App Router) + TypeScript + React 18 in `web/` (CSS Modules and design tokens, no UI framework) · Node ESM scripts at the repo root · OpenAI for embeddings and classification · Microsoft Graph for the support mailbox.

Pending: ORM/DB client for app reads (scripts use `pg` + a Supabase REST client), webhook processing runtime, frontend test framework, deployment tooling. Job scheduling is covered for the nightly Shopify sync only — the agent worker and the embedding pipelines are still started by hand.

## Getting started

1. `npm install` at the repo root.
2. Copy `.env.example` to `.env.local` and fill it in. This one repo-root file is the single source of truth for secrets — `web/next.config.mjs` and `agent/src/config.mjs` both load it, so there is no separate `web/.env.local`. Needed: `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_API_ACCESS_TOKEN` (or `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`), `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_URL`, `OPENAI_API_KEY`, and the `MS_GRAPH_*` + `SUPPORT_MAILBOX` vars for the agent worker. The management chat on Home also needs `CHAT_DB_URL` — the URL of its read-only database role, set up once as described in `DECISIONS.md § Management chat` — and takes an optional `CHAT_MODEL` (default `gpt-5.2`). All server-only — never prefix with `NEXT_PUBLIC_`.
3. Apply the nine files in `supabase/migrations/` **in order** with `npm run db:apply:migration supabase/migrations/<file>`: `01_foundation.sql` → `02_shopify.sql` → `03_knowledge.sql` → `04_support.sql` → `05_exemplars.sql` → `06_analytics.sql` → `07_drafting.sql` → `08_testing.sql` → `09_parameters.sql`. They are a baseline for an empty database, not idempotent patches, and the order is a dependency chain (everything references `shops`; tickets reference customers; exemplars reuse the `french_unaccent` config from 03; analytics and drafting read the support tables).
4. Sync Shopify data. Every script has a `:dry-run` twin — run that first to verify API access and mapping: `npm run sync:shopify:products` · `:customers` · `:orders` · `:promotions` · `:content-catalog`, or `npm run sync:shopify:nightly` for all of them in order.
5. `npm run embed:knowledge` to embed approved knowledge chunks (`:dry-run` available).
6. `npm test` runs the root test suite (`node --test`).

**Microsoft Graph application permissions:** `Mail.Read` for ingestion, **`Mail.Send`** for the forwarding pass and for sending replies, and **`Mail.ReadWrite`** for the reply drafts the outbound worker creates before sending (granted 2026-09-28). Without them the affected pass records failures rather than failing quietly; ingestion and categorisation are unaffected.

**Mail layer switches** (all off by default): `OUTBOUND_SEND_ENABLED=true` makes « Approve » in `/tickets` send, through the worker; `OUTBOUND_STOP_BEFORE_SEND=true` stops the worker at a threaded reply draft in the support mailbox's Drafts folder (for testing: send it from Outlook yourself); `DRAFT_ONLY=false` additionally lets eligible drafts send themselves; `MAIL_WEBHOOK_URL` (the public URL of `/api/webhooks/graph`) makes the worker keep Graph change-notification subscriptions. `JOB_CHECK_INTERVAL_MS` (5000) and `MAIL_JOB_MAX_ATTEMPTS` (5) tune the queue. `npm run mail:status` (in `agent/`) shows where it all stands.

**Shopify scopes:** `read_discounts` for promotions; `read_content`/`read_online_store_pages` and `read_legal_policies` for the content catalog; `read_themes` for the theme-template content fallback. Missing optional scopes surface as a clear import error rather than silent failure. For Shopify Dev Dashboard apps, leave `SHOPIFY_ADMIN_API_ACCESS_TOKEN` blank and the scripts request a short-lived Admin token from the client ID/secret at runtime.

### Social connectors (Meta, Google Ads, TikTok)

The Insights → Social media tab connects through OAuth. Each shop's token goes to Supabase Vault. **This app's own credentials** are set once, as env vars, in three places: **Vercel** (the connect callback), **Render** (the worker's sync) and **GitHub Actions secrets** (the nightly). Until they are set, Connect is shown disabled with the missing names.

1. **Meta**
   - Create a **Business** app at developers.facebook.com and add **Facebook Login for Business** and the **Marketing API**.
   - Permissions: `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `read_insights`, `instagram_basic`, `instagram_manage_insights`, `ads_read`, `business_management`. Nothing that writes (`ads_management`, `pages_manage_*`, `instagram_manage_comments` / `_contents`, `instagram_content_publish`).
   - `read_insights` may no longer be offered in a Login for Business configuration (seen 2026-10-07). Connect without it: Instagram, posts and ads do not need it, and Page-level figures the token cannot read show as « — ».
   - The token keeps the permissions it was issued with: after changing the configuration, click **Reconnect**.
   - Valid OAuth redirect URI: `https://qiriness-ap.vercel.app/api/settings/integrations/meta/callback`, plus `http://localhost:3000/...` for development.
   - Set `META_APP_ID` and `META_APP_SECRET`. `META_LOGIN_CONFIG_ID` is optional: a Login for Business configuration, used instead of the scope list.
   - In **Development mode**, only people with a role on the app can connect. Add the person who will click Connect.
2. **Google Ads**
   - In a Google Cloud project, enable the **Google Ads API** and create an **OAuth client (Web application)** with the redirect URI `…/api/settings/integrations/google/callback`.
   - Set the OAuth consent screen to **In production**. In « Testing », refresh tokens expire after 7 days.
   - On the Google Ads API page of that **same Cloud project**, apply for **Basic access**. It needs brand verification and is then reviewed automatically within minutes. A new project starts at **Test** access, which is refused on real (production) ad accounts.
   - **No developer token and no manager account are needed.** Google sunset developer tokens on 2026-09-09; access levels now belong to the Cloud project. A manager account matters only if the ad accounts are reached through one.
   - Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
3. **TikTok**
   - Configure Login Kit for Web and Display API in the TikTok developer app; request `user.info.basic`, `user.info.stats`, and `video.list`. Production access depends on TikTok approving the app and scopes.
   - Register `https://qiriness-ap.vercel.app/api/settings/integrations/tiktok/callback` exactly (or the callback under `PUBLIC_APP_URL`).
   - Set `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` on Vercel, the Render worker and GitHub Actions secrets. The nightly workflow forwards both secrets.
   - Apply migration `85_tiktok.sql` after the existing social migrations through 84. Connect and **Sync now** enqueue the same `sync_social` worker jobs as Meta/Google; nightly and `npm run sync:social -- --provider=tiktok` use the same implementation.
   - One TikTok login per shop. Connecting a different login disables the previous account for sync while retaining its history. Reconnecting the same account preserves its tracking and engagement basis choices. New TikTok accounts use interactions ÷ views.
   - Tokens refresh automatically and rotate together in Vault. Public videos from the last year carry lifetime views/likes/comments/shares; follower history starts at the first sync. Daily views, unique reach and audience demographics remain unavailable. See [TikTok video list](https://developers.tiktok.com/doc/tiktok-api-v2-video-list/) and [token management](https://developers.tiktok.com/doc/oauth-user-access-token-management/).
4. Set `SOCIAL_OAUTH_STATE_SECRET` (32+ random characters) on Vercel. Set `PUBLIC_APP_URL` if the dashboard is reached through another host than the one registered.
5. Apply the required social migrations, then open Insights → Social media → **Connections** and click **Connect**. The worker runs the first sync within minutes. `npm run probe:meta` lists which Meta metric names still answer.


`cd web && npm install`, then `npm run dev` and open `http://localhost:3000` (redirects to `/agent-setup`). `npm run build`, `npm run lint`, `npm run typecheck` for checks. Set `PAGE_TIMING=1` to print how long each page's reads take to the server console. `next dev` compiles each page on first visit, so measure page speed on `npm run build && npm run start` — and stop the dev server first, since both use `web/.next`. Run the root sync scripts at least once first — the Knowledge API looks the shop up by domain and returns a clear 404 until a `shops` row and the `shopify_content_sources` catalog exist.

### Social media reports

On Insights → Social media → All platforms, use the report card at the bottom to choose the ending calendar month, a 1/6/12-month comparison, and platforms. Download the editable HTML, then open it in a browser to edit commentary, images or branding, adjust included platforms, save the revision, or print/save as PDF. Post tables include posts published in the selected period with latest stored lifetime figures and observation dates. These differ from the report's period-only daily activity totals; missing daily metrics or follower history remain unavailable. Imported historical-snapshot datasets retain their strict observation cutoff. Saved platform bands and engagement-rate bases are captured at download time.

From `web/`, `npm run report:social:verify` runs synthetic Chromium checks and writes a sample PDF/screenshots under `.next/social-report-validation/`. It uses installed Edge/Chrome on Windows; elsewhere install a Playwright Chromium browser or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

### Agent worker (`agent/`)

`cd agent && npm install`, then `npm run ingest:once` for a single pass or `npm start` to poll. For a backlog review pass that stores and categorises mail without investigation or forwarding, run `npm run ingest:once -- --limit=500 --stop-after=categorise`. Every pipeline stage also has a standalone CLI, most with a `:dry-run` twin — see `APP_SCHEMA.md` § Agent CLIs.

## Current state

Working end to end against the live Shopify store (`qiriness.myshopify.com`) and the Supabase project: the Agent Setup, Tickets and Insights dashboards, the management chat on Home (Beta — built and checked against real data; waiting on its database role's password before it runs in the app), the Shopify syncs, email ingestion, both spam gates, embeddings and retrieval, categorisation, customer and order resolution, the Phase 4 retrieval tools, the exemplar layer, the investigation agent, the **rules layer**, and the drafting agent. **Nothing can send an email to a customer** — there is no code path that can address one.

The full record of what was built and how far each piece is proven is in `CHANGELOG.md`; what remains unproven, with the check to run, is in `VALIDATION_LOG.md`.

**The data prerequisite is met.** 2006 orders, 58 201 customers, 116 products and 327 promotions — a range that contains every order number the mail corpus quotes.

**The pipeline has run over the corpus.** Re-measured **2026-09-09**, read from the database, not from these documents:

| | |
| --- | --- |
| Tickets | 400, of which 383 categorised (L1 32 · L2 188 · L3 161 · L4 2) |
| Messages | 852, 851 embedded. The corpus spans 2026-02-26 → 2026-08-19 |
| Customer link | 244 of 400 |
| Order link | **78** carry a confirmed `shopify_order_number` and an `order` block in `resolved_context` (the other 322 hold `{}`) |
| Case files | 137 tickets investigated — 75 `needs_human`, 33 `needs_customer_input`, 29 `answerable`. All 137 carry an `exemplar_match`; **50 carry a `findings_trace`** |
| Drafts | **120** — 107 pass the mechanical checks · 29 `terminal` · 91 `intermediary` · **25 `auto_send_eligible`** (acted on by nothing). 1 approved, 2 edited, 117 still pending review |
| Rules | **108 approved answers, 1 draft**, across 7 answer sets — orders 52 · products 20 · cosmetovigilance 8 · promotions 8 · returns 8 · payments 6 · accounts 6 |
| Exemplars | 38, all approved (37 live, O-11 soft-deleted). **706 phrasings, 696 embedded** — 144 authored (11 of them real English, Spanish or Dutch mail) + 562 translations in `fr en es it de`. A same-corpus A/B puts **133 tickets over MATCHED, up from 125** |
| Knowledge | 73 chunks — faq 23 · legal_privacy 18 · product 12 · brand_story 9 · return_exchange 5 · cosmetovigilance 5 · account 1. **Still zero** in `delivery`, `order`, `promotions`, `payment`, `product_stock` |
| Test chat | `agent_test_runs` holds **34 complete runs** (2026-08-21 → 2026-08-28), **0** with an ideal answer saved |
| Attachments | 88 inbound messages carry one, all with metadata. **15 tickets carry a real photo** (shown in the panel; **35 of 37 parts still resolve in the mailbox**); **74 mention one that never arrived** |

**The investigation backlog is drained.** 28 tickets are open and 330 closed; 6 still carry
`needs_investigation` and 2 of those are claimable. The 113-flagged / 0-claimable deadlock
that `VALIDATION_LOG.md` item 16 describes was resolved by `--include-closed`, and the corpus
has since been investigated three times over.

**Two claims that were true in August are no longer true**, and are corrected here rather than
left to mislead: `support_answers` is not empty (109 rows, 108 approved), and the agent test
chat has been run (34 stored runs). Item 17's *live-data* check is still open — none of those
runs has been compared against the same ticket through the worker, and no ideal answer has
been saved, which is what `agent_test_runs.ideal_body_text` exists for.

**The 2026-09-07 prompt-cache change is proven on real mail.** A 12-ticket batch on
2026-09-09 (10 investigated, 0 failed, 45 model calls, 78 740 tokens) took the investigate
pass from 21% to **61% cached**, and the closing call — 0% on 8 of 8 before — now caches on
**10 of 10**. `VALIDATION_LOG.md` item 18 is closed; what it turned up instead is step 8
below. `llm_usage` holds 2174 calls.

**Tests:** 2013 from the repo root, 1299 in `agent/`. Both suites pass as of 2026-09-09.

## Next Steps

**Historical reports (2026-10-09):** deploy the post-table, audience and follower/comparison corrections and download fresh reports. Stored December counts and 1/6/12-month calculations have been verified in the renderer; reconciliation against the Meta UI/export remains open in VALIDATION_LOG. Reports show country-only audience cards, single-line post captions and the dashboard's best posting hours/days for the selected period; lengthy availability sections are removed.

**TikTok (2026-10-09):** connector and worker integration are implemented; migration 85 is applied and verified on Qiriness Supabase. Configure the TikTok app credentials on Vercel/Render/GitHub Actions, deploy web/worker changes, and complete the remaining live checks in `VALIDATION_LOG.md` → TikTok. TikTok app approval, live OAuth and deployment remain unverified.

**Storefront shopping:** run `VALIDATION_LOG.md` item 46 before treating generated
cart/stock/promotion replies as validated. The dev shop needs its own synced shopping
data for stock/eligibility. Public Qiriness offers are available as a preview when
that allowed shop is unsynced; production stock/eligibility are not substituted.
`npm run inspect:storefront-shopping` checks
source counts without exposing codes or modifying data. Payment FAQs keep their
existing route; delivery calculations and checkout modifications remain deferred.
Previewing an offer cannot establish dev-cart eligibility. Review language
continuity on country-only replies alongside the shopping checks.

**Storefront knowledge (2026-10-06):** review policy/FAQ replies and product-guidance
fallbacks through the dev-store widget (`VALIDATION_LOG.md` item 45). Retrieval uses
existing policies, parameters and approved FAQ sections; storage is unchanged.
Run `npm run eval:storefront-knowledge` for a read-only source check. Review missing
privacy and fixed shipping-price information before expanding those answers.

**Storefront advisor (2026-10-06):** product resolution (`resolve_products`, clarification chips, conversation references) is built: 71/71 on `npm run eval:resolution`. Run `VALIDATION_LOG.md` item 43 on the store before building compare / ingredients / routine on top of it. Phase 3 (read-only `search_products` / `get_product`, product cards) is built. Check that the dev store holds the production handles, then run `VALIDATION_LOG.md` item 42. Product images need the sync to read `featuredImage` (decision pending). Phase 2 (AI replies, no product data) is built and tested by signed requests. Set `STOREFRONT_CHAT_AGENT=llm`, restart `shopify app dev`, and run `VALIDATION_LOG.md` item 41 before Phase 3 (read-only product tools). Phase 1 is built (`docs/storefront-chatbot.md`). Link `storefront-app/` to the dev store, set the two `STOREFRONT_*` env vars (migration 76 applied 2026-10-05), then run `VALIDATION_LOG.md` item 40. Phase 2 (an LLM reply) comes only after Phase 1 has been seen working on the dev store. Never on production.

**Social media (2026-10-05):** register the Meta app, and the Google Cloud OAuth client with Basic access on its project (§ Social connectors above), connect both (migration 70 applied 2026-10-05), and run the checks in `VALIDATION_LOG.md` item 38. Start with `npm run probe:meta`: Meta's metric names are the most likely thing to need a change.

**Cases (2026-10-02):** apply migration 61, run `npm run cases:targets` and then
`npm run cases:replay` in `agent/`, and read every link it lists before setting
`CASE_LINKER_ENABLED=true` (`VALIDATION_LOG.md` item 36, `DECISIONS.md` § Cases).

**Queue priority:** run the live sampling check in `VALIDATION_LOG.md` item 30
before treating the new action-window bands as operationally proven. In
particular, verify pre/post-fulfilment changes and the 3 / 3 / 6 working-day
thresholds against Shopify; deadline-specific historic cases have no structured
deadline and are deliberately not guessed from email prose.

**2026-09-26: the agent's next phase is `codex_plans/Case_State_Plan.md`.** In order:

1. make the mailbox cursor stick;
2. read Sent Items;
3. build the timeline evaluation;
4. derive `case_current`;
5. add obligations and next action;
6. version the drafts, then put drafting in the poll.

Nothing in it is built yet. The list below predates it.

**Reordered 2026-09-09, after reading the database and running a batch rather than the docs.** What changed the
ordering: the rules layer landed (steps 1–8 of `codex_plans/Rule_Guided_Investigation_Plan.md`),
and cost work moved from guesswork to measurement. Items that headed the August list and are
now done are gone from it — order resolution, the investigation-queue deadlock, the `llm_usage`
sink, `support_answers` being empty, and the first pass of the test chat.

1. **Fill the knowledge library on the five empty subjects.** `delivery`, `order`,
   `promotions`, `payment` and `product_stock` hold **zero chunks between them** — unchanged
   since August, while everything downstream of retrieval improved. A level 1 ticket is by
   definition answerable from the library alone, so this is the ceiling on what drafting can
   auto-answer, and it now caps a rules layer that is otherwise finished.
   **Also: the cosmetovigilance article is unpublished and its 5 chunks are unembedded**, so
   `searchKnowledge` on a CV ticket reaches nothing — publish it, then `npm run embed:knowledge`.
   Worth checking why while you are there: *Masque LED Visage — Questions fréquentes* carries
   the same null status and its 12 chunks **are** embedded, so the approval filter is not
   deciding this on its own.
2. **Review the 120 drafts.** A reading job, not a coding one: the checks can prove a named
   sentence is absent and cannot say a reply is right. 117 are still `pending`, and the **25
   marked `auto_send_eligible`** are the number the eventual L1/L2 graduation turns on.

   **The translated library is live** — imported, embedded, and confirmed through the real
   RPC (3 exemplars on 12 of 12 non-French tickets). **125 → 133 tickets clear MATCHED**,
   Italian moving 0 → 4 of 6. `VALIDATION_LOG.md` item 20 is closed; what it leaves behind is
   small and unblocking: delete the merged-away O-11 from `Email-Example-Queries.md`, decide
   whether P-21 should be in the document so it can be translated, read the ~130 unreviewed
   translations, and re-read the band sweep now that 562 rows have joined the pool.
3. **Re-test what the mailbox mismatch was blocking — the mismatch itself is gone.**
   `SUPPORT_MAILBOX` is `contact@qiriness.com`, the mailbox the corpus came from, and
   measured 2026-09-09 against the live API stored message ids resolve: **35 of 37 stored
   photo parts fetch, with zero `ErrorInvalidMailboxItemId`.** The claim that every
   `graph_message_id` was unusable was true when written and is not now; `.env.local` is
   gitignored, so nothing in the repo caught it changing. The **spam-body backfill** and
   **`/forward`** were both parked on that premise and should be re-run rather than assumed
   broken. What remains a real decision is which mailbox and store this environment is *for*
   before go-live — one decision with step 12.
4. **Then the send path, in this order:** the review copy to the reviewer's own inbox ·
   approve / edit / reject in the dashboard · sending, and the auto-close on `terminal` that
   `disposition` exists for. Drafting stays operator-triggered, out of the poll, until the
   drafts have been read. No longer blocked by the mailbox — see step 3 — so what gates it
   is reading the drafts and deciding the environment.
5. **Save ideal answers from the test chat.** 34 runs are stored and **none** has an ideal
   answer against it, so the feedback loop the table was built for has never closed. Pair this
   with item 17's live-data check — take one real ingested ticket, run its message through the
   test chat, and confirm the category, tool set and verdict agree with the worker's stored
   run. A divergence means the transcript cannot be trusted.
6. **Re-run the collection replay now that the rules have improved.** Suppression ships off
   because the 2026-09-03 replay found that every situation that would save a call would also
   lose a fact (13 saved, 7 lost over 47 traced runs). The rules layer has changed
   substantially since, and **50 of 137 investigations now carry a trace** where 2 did.
   `npm run report:collection-replay` is the instrument; step 9 of the plan is the decision.
7. **Store the decomposer's task count** — one field, and the largest *unmeasured* cost lever
   left (`codex_plans/Model_Cost_Notes.md` item 2). Then **find out whether the spam gate calls
   a model**: it runs on more messages than anything else in the pipeline and is invisible in
   `llm_usage`.
8. **Settle whether the closing investigation call is worth its own model call.** The
   2026-09-07 cache fix is proven on a real batch (`VALIDATION_LOG.md` item 18: the last call
   per ticket caches on 10 of 10, the investigate pass went 21% → 61%). Measuring it turned up
   a separate question: the model reaches for `finalize_investigation` mid-loop on **every**
   ticket, its complete case file is discarded, and the closing call then generates one again.
   Collection has already stopped either way, so this is not the suppression trade the code
   comment cites. The experiment is cheap — compare the discarded arguments against the
   closing call's output on the same run. Agreement means one model call per ticket bought for
   nothing; disagreement settles it in writing. Neither blocks anything.
9. **Re-sample and re-label the categorisation review set.** `categorisation_review` is still
   empty, so the real-mail accuracy figures cannot be recomputed or defended.
   `npm run review:sample`, then blind labelling; sample toward ~100 rather than back to 30,
   since at n=30 the harness cannot resolve a change smaller than ~16 points.
10. **Switch team forwarding on.** Built and rehearsed (2026-09-29), still off. Turn it on in
    Agent Setup → Forwarding (and the acknowledgement separately), make sure the worker that
    runs categorisation also runs the forward stage, and watch the first `forward.pass`.
    `ticket_forwards` still holds 0 rows: confirm a forwarded CV arrives as a CV and that the
    acknowledgement threads under the sender's message. Nocibé reorder POs have no destination
    yet; marketcom also receives non-partnership mail the categoriser files as partnerships.
11. ~~**Add dashboard authentication, role policies, and personal-data access logging.**~~
    **Built 2026-09-11**: email + password sign-in through **Supabase Auth**, Developer / Management /
    Contact roles (Contact cannot open Insights → Sales), and a `data_access_events` row per
    named-customer view. Still open: create the real accounts (`npm run users -- add --email … --role …`,
    VALIDATION_LOG.md item 23), turn off public sign-up in the Supabase dashboard, and `SHOPIFY_PERSONAL_DATA_PROTECTION.md` still needs `spam_audit.body_text`
    described as retained personal data with a 90-day life.
12. **Set up separate Supabase development and production projects.** Pointing a worker at a
    fresh mailbox triggers a full unordered delta enumeration — decide before go-live whether
    to ingest the backlog or seed the cursor and start clean.
13. **Check `scripts/lib/llm-rates.mjs` against current OpenAI pricing.** Cost is measured now,
    but every figure on `/insights/agent` is only as good as that rate card, and nobody has
    verified it.
14. **Re-tune the clustering threshold, or decide it does not need it.** 0.68 was set by eye at
    ~225 messages, and the corpus is now 852. One persisted run exists (2026-08-16), so a
    second can be compared instead of argued about.
15. **The carrier table's lost / damaged / late columns are placeholders.** Shopify has no live
    parcel status (`delivered_at` on 1 order in 2006, `in_transit_at` on none), so filling them
    needs a delivery feed from the 3PL — see `AGENT_INTEGRATION_PLAN.md` § Open questions.
16. **Tighten the theme-template resolver's "is this a real text setting" heuristic** — it
    leaked raw Shopify section-setting tokens into one imported page during testing.
17. **Add the remaining support tables for AI events**, and deploy runtime webhook routes over
    reusable handlers.
18. **Expand tests:** `web/lib/server/knowledge-service.ts` has none, and the dashboard has no
    component or interaction tests.
19. **Finish making Insights live end to end** (the panels themselves are ranged and
    self-refreshing since 2026-09-11). Three sources still gate it:
    - **Ship the shop-sync change to wherever the nightly sync runs.** Until the workflow
      runs the new `mapShop`, `shops.iana_timezone` stays null and every chart cuts days in
      UTC (the strip says so). The same change stops the sync wiping the mail cursor.
    - **Automate the mail worker** — deliberately manual for now. Until it is, the Support
      panel hatches every day after the last manual run and blocks the contact rate.
    - **Run the order sync more than nightly** if "Last 24 hours" is to mean anything for
      orders: with one run a night, most of any 24-hour window is not synced yet.
20. **Check the storefront figures against the Shopify admin, then decide about the
    funnel's middle.** Sessions, conversion, bounce and traffic by channel now render on
    Overview, Marketing and the monthly report, read live from ShopifyQL (2026-09-23,
    `DECISIONS.md` § Insights). Two things are open:
    - **Nobody has compared them with Analytics → Reports.** Do one week and one month
      before anyone acts on them (`VALIDATION_LOG.md` item 15).
    - **The funnel is measured** (sessions → cart → checkout → purchase). An earlier note
      here said it was impossible without a web pixel; that was wrong, and the mistake is
      recorded in `DECISIONS.md` § Insights. Only **product views** has no metric.
    Klaviyo is connected (2026-09-25: key on Settings → Integrations, nightly sync, the
    Marketing card) and needs its first real sync checked (`VALIDATION_LOG.md` item 17).
    Google/Meta Ads and social remain unchosen integrations.
21. **Send the monthly sales report automatically.** It is downloadable today
    (`/api/insights/report`, Overview → Monthly sales report) and rendered by a pure function
    a job can call, but nothing emails it: the CEOs' addresses, the sender and the schedule
    (1st of the month, shop clock) are undecided.
22. **Move the nightly Shopify sync from GitHub Actions to Render.** Not urgent. One run took
    71 min (2026-09-11), about 2,100 min/month, at or over GitHub Free's 2,000 private-repo
    minutes — check Billing → Actions. Plan: a separate Render Cron Job (about $1/month;
    confirm on render.com/pricing) rather than a cron inside the worker, so polling and a
    redeploy cannot kill it mid-sync. It needs an overlap guard (skip while an
    `integration_events` row is `processing`) to replace the workflow's `concurrency`, and
    the five repo secrets copied to Render. The dry-run button is lost. Then remove
    `.github/workflows/nightly-sync.yml` and update Dev info (`web/lib/dev-stack.ts`).

The target is unchanged: **auto-resolve level 1 and 2, and for level 3 assemble everything a
human needs to act.** On the 383 categorised tickets that splits L1 32 (8%) · L2 188 (49%) ·
L3 161 (42%) · L4 2 — the same shape as August at nearly twice the volume. What each tool is
worth is in `AGENT_INTEGRATION_PLAN.md` Phase 4.
