# Database refactor plan

Working document for the database refactor started 2026-10-12. **Phase 0** (inventory) and **Phase 1** (scoring and domain split) are done. Later phases tick items off here. Open this file only when doing refactor work; `APP_SCHEMA.md` stays the map.

**Source of every figure:** read-only queries against production (`gvgcvf…`) on 2026-10-12.
- `pg_stat_*` counters run from **2026-08-07**, so they cover about 66 days and include traffic from before the `c8111fc` egress fix.
- Live egress could not be measured: Supabase blocked the project for exceeding its egress quota until **2026-10-15**, and PostgREST and the worker are down until then. Re-measure after that date (see the egress memory and `scripts/.tmp-egress-*.mjs`).
- Barbara Gould (`ybowyv…`) has the same schema and no data. It needs no separate work: it gets whatever migrations come out of this.

## Baseline

- **Migrations vs production: no drift.** 79 tables, 27 `public` views, 14 `chat` views, 169 functions (the extra live functions are pgvector's own), 310 indexes and 151 MB. Every migration-created table exists in production, and nothing exists in production without a migration.
- **Size:** `customers` 48 MB (indexes 26 MB, heap 21 MB), `ticket_messages` 29 MB (22 MB of it TOAST, i.e. bodies), `orders` 24 MB. Nothing else is above 10 MB.
- **Security baseline:** RLS is on for all 79 tables with no policies, so they are service-role only. Seven `SECURITY DEFINER` functions exist, all token or key vault helpers (`social_*_token`, `klaviyo_*_key`).

## P0 — before any refactor

| # | Item | State |
|---|---|---|
| P0.1 | **Customer redact searched only the first 1000 customers** (`shopify-compliance-webhooks.mjs`, unpaged select) | Fixed on branch `fix-compliance-customer-match`; not merged |
| P0.2 | **8 redacts (2026-09-11 → 09-17) marked `completed`, 0 deleted; all 8 customers still present.** The integration-event dedup means a re-delivery will not retry them. Each matches exactly 1 row by Shopify id; no tickets linked; 9 orders (`customer_id` → null by FK). **Shopify had already anonymised them** (`Anonymous Customer`, `anonymous-…@example.com`; city still real), and the 2026-10-11 nightly sync still received them, so **the nightly sync will re-create them** after a delete. 599 anonymised customers exist in total | **Closed 2026-10-12, no delete.** The user accepted Shopify's anonymised rows as compliant ("if they are anonymous it's ok"). The real `default_address_city` remains on them |
| P0.3 | Leftover schema `tmp_baseline_91d98ab4b248439d` (53 tables, 27 views, 3.2 MB) from a `_live.test.mjs` run that died before its cleanup (line 394). **Not an egress baseline**: those are JSON snapshot files | Drop (approved); make the test's drop survive a killed run |
| P0.4 | `patch()` in `scripts/lib/ticket-record.mjs` returned the full ticket row (~3 kB) on every write; nothing read it. About 15.6k calls/day cumulative, the largest single egress statement | **Fixed 2026-10-12** (with `data_access_events` and `spam_audit` writes); unmerged |
| P0.5 | The nightly customer sync re-imports customers Shopify has redacted, as Shopify's anonymised version | Accepted as-is with P0.2 |

## Cross-cutting items (not tied to one domain)

| # | Item | Evidence | Size |
|---|---|---|---|
| X1 | REST write helpers default to `return=representation` (`supabaseInsert`, `supabaseUpdate`, `supabaseUpdateById`, `supabaseUpsert`, `supabaseDelete`). Flip the default to `minimal` and opt in where the result is read | Writes returning full rows: tickets 15.6k/day, `data_access_events` 915, `shops` 505, `spam_audit` (incl. `body_text`) 254 | S |
| X2 | The nightly full sync rewrites every row whether or not it changed (`ON CONFLICT DO UPDATE`). **Built 2026-10-12 as migration 92** (skip-unchanged trigger + freshness from the last completed nightly); proven on PGlite, **unapplied**. Measured: 14 customers and 12 orders changed between two nightlies | `customers` 2.08M updates on 61k rows; `orders` 231k on 6k. Index (26 MB) is bigger than heap (21 MB). Add `WHERE … IS DISTINCT FROM` via an RPC, or skip pages whose `shopify_updated_at` has not moved | M |
| X3 | Index hygiene. **Decided 2026-10-12:** migration `91_redundant_indexes.sql` (unapplied) drops the 3 redundant copies; `support_answers_shop_set_fallback_unique` is partial and stays, and the redundant one there is `support_answers_shop_set_idx` (a prefix of `_key_unique`). **Foreign-key indexes not added**: every child table is tiny (≤ 1k rows), so a parent delete scans little and an index only costs writes; revisit if `ticket_messages` purges get slow. **Unused indexes left** until a full month of post-block traffic confirms them | 3 indexes that duplicate a unique constraint (`support_answers_shop_set_idx`, `sender_directory_shop_pattern_idx`, `email_blocklist_shop_pattern_idx`). 46 non-unique indexes with 0 scans since 08-07 (3.8 MB, mostly GIN on `products`/`orders`/`customers` JSON and arrays). 23 foreign keys without an index (mostly `trigger_message_id → ticket_messages`, `shop_id → shops`) | S |
| X4 | Function churn: 12 functions redefined across 3–4 migration files (`orders_list` ×4; `insights_*` ×3). The current definition can only be found by reading the last file | Collapsed by the baseline (X5) | — |
| X5 | Migration layout: 92 files, about 20.7k lines, applied in production so they cannot be rewritten. Generate a **squashed baseline** from the cleaned schema for fresh environments, archive the history, and keep forward-only migrations from then on | Decide after the domain work, so the baseline is the cleaned schema | M |
| X6 | **Done 2026-10-12** (migration 94, carrier_aliases; the marketplace array was already superseded by 60). Business literals in SQL | `array['amazon','connect-dev-1']` (`21_chat_vip.sql:44`) should come from `sales_channels`. Carrier patterns in `normalise_carrier` (`06_analytics.sql:38`) should be data. Default `'fr'` locale. Qiriness/Yves Rocher wording in `chat` view comments | S |
| X9 | **Offset paging was 71% of all database buffer reads.** `supabaseSelectAll` LIMIT/OFFSET over `customers` (501M + 130M blocks since 08-07) | **Done 2026-10-12**: keyset paging, 33× fewer blocks per full pass (measured). Re-check the top of `pg_stat_statements` by `shared_blks_hit` after the 15th | S |
| X10 | `insights_freshness`: 2.3 s average over 1,614 calls, but 18 ms when the database is quiet. Most likely contention from X9 | Re-measure after X9 ships before touching the function. If it is still slow: `tickets` and `ticket_messages` are seq-scanned for `min(first_message_at)` and `max(coalesce(sent_at, received_at))` | S |
| X8 | **`npm test` applies the whole baseline into production.** `_live.test.mjs` falls back to `.env.local`'s `SUPABASE_DB_URL` (production) and creates and drops a `tmp_baseline_*` schema on every run; a killed run is what left P0.3 behind. Point it at a dedicated variable (e.g. `SUPABASE_TEST_DB_URL`, dev project) and skip otherwise | **Done 2026-10-12**: reads only `SUPABASE_TEST_DB_URL` and refuses one equal to `SUPABASE_DB_URL` (both checked). Set it to the dev project in `.env.local` to run the test again. **The dev project no longer exists** (2026-10-12: `tenant/user postgres.qovuuv… not found`), so there is currently no Supabase database to test against; the 92 check ran on PGlite instead | S |
| X7 | **Done 2026-10-12**: 6 objects given rows in their domain tables (2 had been absent entirely, 4 only listed under migrations); `scripts/lib/schema-docs.test.mjs` now fails on any name in `tables.mjs` the map does not mention. Was: `docs/schema/database.md` (was the APP_SCHEMA Database Map) is missing 6 objects: `dropped_mail_clears`, `dropped_mail_list`, `support_parameters`, `ticket_case_state`, `social_audience_manual`, `social_post_manual_metrics` | Fix in the docs task | S |

## Domain workstreams

Ranked by impact × risk. "Hot" means it is on the worker's poll path or the sync/webhook path, so changes need a measured before/after.

### D1 — Shopify snapshots · `customers orders products promotions shops shopify_metaobjects sales_channels advice_collections shopify_content_sources` · **high**
- **`orders.line_items` is JSON that the SQL treats as a table.** `li.value->…` appears 140+ times across `insights_*`, and `chat.order_lines` re-derives the table on every query.
  - **Measured 2026-10-12, read-only, quiet database: not a performance problem at this size.** Unnesting all 19,126 lines takes ~80 ms. `insights_product_sales` takes 46 ms (30 days) to ~200 ms (all time). Its 459 ms production average is most plausibly the same contention as X10.
  - **Decision: deferred into D4.** The gain is maintainability: one place for the casts, and indexable `product_id`. That is worth taking only while the `insights_*` functions are being rewritten anyway.
  - **Design when it is done:** a `public.order_lines` table (`order_id` FK `on delete cascade`, `shop_id`, `line_index`, typed columns for what the SQL reads — `product_id`, `variant_id`, `title`, `sku`, `quantity`, `current_quantity`, `original_total`, `discounted_total`, `discounts jsonb`). Maintain it with an `after insert or update of line_items` trigger on `orders`, guarded `when (old.line_items is distinct from new.line_items)`. That gives **no sync code change**, it cannot drift from `line_items` (which stays as the raw snapshot), the backfill is one statement, and the nightly full upsert (X2) does not rewrite lines that did not change. Then repoint `chat.order_lines` and the `insights_*` functions one at a time, each checked against the old output.
- Other JSON on `orders`: `fulfillments` (460 B avg), `discount_applications`, `shipping_destination` (read 30+ times by key).
- **`shops` is a hot row.** 33.6k updates on 2 rows; `sync_cursors` (Graph delta links) is rewritten every poll. A `sync_cursors` table, one row per cursor, would stop rewriting the shop row.
- Write churn (X2) and unused GIN indexes (X3) mostly land here.
- Hot: yes (nightly sync, order webhooks).

### D2 — Agent email workflow · 26 tables, the largest domain · **high**
Split into four sub-tasks: **mail ingest** (`ticket_messages mail_jobs mail_subscriptions spam_audit email_blocklist sender_directory dropped_mail_clears`), **casework** (`tickets cases case_current case_links ticket_case_state ticket_case_actions issue_family_*`), **investigation and drafting** (`ticket_investigations ticket_drafts ticket_draft_edits outbound_actions agent_models`), and **routing** (`forwarding_* ticket_forwards ticket_routing category_forwarding ticket_snoozes ticket_overrides categorisation_review`).
- **Deferred 2026-10-12, pending clean numbers.** The ~15.6k metadata-only updates a day are cumulative from 2026-08-07, which is before order resolution stopped rewriting unchanged outcomes (`a82a298`, 10-05), `linkOrder` and `patch()` stopped returning rows (10-11 / 10-12), and customer resolution's 24 h back-off was confirmed in code. After the 15th, run `select pg_stat_statements_reset()` (with approval), leave the worker a day, then decide. If churn remains, the cheapest fix is the 92 pattern (skip a metadata write whose trail is unchanged apart from its timestamp), not a new table.
- **`tickets.metadata` is a read-modify-write log.** About 1M updates on 1,040 rows. Each pass merges its trail into one jsonb (`customer_resolution`, `order_resolution`, `categorisation`, `case_status`, `closed_reason`…), so every write first re-reads the blob (`linkCustomer` does a select and then a patch). Candidates: a `ticket_pass_trails (ticket_id, pass, …)` table, or `jsonb_set` via RPC. Either way, fix P0.4 first.
- **`ticket_investigations` has 17 of 27 columns as JSON.** The largest are `evidence_gaps`, `handoff`, `established`, `do_not_claim`, `reaction_report` and `tool_calls`. Decide which are queried (move those to columns) and which are just stored (leave them).
- `ticket_messages`: 22 MB of TOAST bodies, 65k seq scans. Check which readers select `body_text` when they do not need it.
- `category_forwarding` has no code reference.
- Duplicate indexes on `sender_directory` and `email_blocklist`; most of the unindexed foreign keys are here.
- Hot: yes (every poll).

### D3 — Projections (views) · **done 2026-10-12** (migration 93: 16 superseded views dropped; the list below was 15 + `fulfilment_ticket_coverage`)
- **15 leaf views have no consumer in code, in other views/functions or in the `chat` schema:** the 7 `fulfilment_*` views (`summary`, `summary_by_channel`, `by_month`, `by_carrier`, `by_bucket`, `by_channel_bucket`, `by_channel_month`), `fulfilment_ticket_coverage`, `support_by_category`, `support_purchase_states`, `support_purchase_by_category`, `investigation_verdicts`, `investigation_evidence_gaps`, `agent_pipeline_funnel`, `llm_usage_summary`, `llm_usage_by_month`. Check each against `DECISIONS.md`, then drop it or record why it stays (some may serve ad-hoc reports).
- **Not code-referenced, but they stay:** `case_facts` and `case_message_counts` feed `ticket_queue` and `customer_ticket_facts`; `ticket_reply_times` feeds `support_by_month`; `order_fulfilment_timing` feeds 7 views and 4 functions.
- Views built on views: `order_fulfilment_timing` feeds 7 views and 4 functions. Keep it as the single source.

### D4 — Analytics functions · `insights_* orders_list* vip_* customer_segment_*` · **medium**
- Collapse the redefinition history (X4).
- Repoint at `order_lines` once D1 lands. That is where most of the 140 JSON unpacks live (`insights_product_customer_mix`, `insights_promotions`, `insights_country_product_sales`, `insights_product_pairs`, `insights_collection_sales`; 2–3.7k characters each).
- Find shared building blocks: date-range, timezone and cancelled-order filtering are repeated in every function.
- Not hot (dashboard only), but the dashboard's egress is unmeasured.

### D5 — Management chat · `chat` schema (14 views), `chat_*` tables · **guard done 2026-10-12**: `npm run db:check:chat` runs after every migration (views run as the chat role + snapshot of the schema text)
- The model writes SQL against these views, so **every rename in D1–D4 must keep `chat.*` stable** or update the view comments the model reads. Nothing at compile time catches a break.
- X6 literals live here.

### D6 — Knowledge, exemplars, policies · `knowledge_* support_* company_policy*` · **low**
- `support_answers` duplicate index; unindexed foreign keys on `support_answers`, `company_policy_links` and `company_policy_versions`.
- `knowledge_chunks_embedding_hnsw_idx` has 0 scans: 34 rows, so Postgres sequential-scans. That is fine at this size; note it only.

### D7 — Compliance and audit · `privacy_requests data_access_events integration_events` · **P0 items above**, then low
- `data_access_events` insert returns the row (X1).

### D8 — Small domains · Social/paid (11 tables), Klaviyo (3), Storefront advisor (6), Rehearsals (2) · **low**
- All small. Review `SECURITY DEFINER` token functions (`search_path` pinned? grants?). Unindexed `shop_id` foreign keys on `ad_campaigns`, `social_audience` and `advisor_merchandising`.

## Docs workstream (token cost) — **done 2026-10-12** (see CHANGELOG)

Left: `docs/schema/database.md` is still ~16k tokens; split it per domain if DB sessions keep reading it whole. Root clutter (below) is untouched.

| File | ~Tokens | Plan |
|---|---|---|
| `APP_SCHEMA.md` | 51k, read every session | Keep a short index (≤3k): domains, one line each, plus links. Move Map (17.5k), Database Map (16k), Surfaces (10k) and Worker (6k) into `docs/schema/<area>.md`, read on demand. Generate the migration list from the database |
| `DECISIONS.md` | 210k | Split by `##` into `docs/decisions/<area>.md` behind an index. Investigation (60k) and Insights (41k) are 48% of it |
| `CHANGELOG.md` | 143k | Move entries older than ~30 days to `docs/archive/` |
| `VALIDATION_LOG.md` | 46k | Move closed items to the archive |
| `AGENTS.md`/`CLAUDE.md` | 1.4k | Update the read-order rules to the new layout |

Root clutter: `APP_SCHEMA.m`, `CHANGELOG.m`, `README.m`, `tmp-rerun-*.json`, `shopify.app.toml.bak` (check before deleting).

## Order

1. ~~P0.1–P0.5~~ done or closed 2026-10-12, except dropping the P0.3 schema (needs the user to run it).
2. ~~X3 redundant indexes~~ (migration 91 written, unapplied) · ~~X9 keyset paging~~ · ~~docs~~. X1 continues call site by call site.
3. **On 2026-10-15:** deploy, apply 91, re-measure egress and the `pg_stat_statements` top (by calls AND by blocks); then X10.
4. X2 (nightly sync rewrites unchanged rows) → D2 `tickets.metadata` trails → D4 (with `order_lines`) → D3.
5. D2 sub-tasks, one at a time, each measured before and after.
6. X5 squashed baseline from the cleaned schema.
7. D5 checks run after every step that touches a name.
