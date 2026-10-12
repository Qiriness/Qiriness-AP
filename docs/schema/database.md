# Database map

Every table and view by domain, the migration files, and the read-only reports. Part of the schema map; the index is `APP_SCHEMA.md`. Why things are this way: `DECISIONS.md`.


Every table has RLS on with no policies: **service-role access only**. Shopify stays source of truth; all syncs idempotent.

### Shopify snapshots

| Table | Holds |
| --- | --- |
| `shops` | shop records, environment, app settings, `sync_cursors` (incl. mail delta link), `storefront_url` (Shopify `primaryDomain.url` — where customers go, unlike `shop_domain` which is the *.myshopify.com identity webhooks key on; the base for `/account/login`), `customer_accounts_version` (`CLASSIC` — decides whether a password exists at all), `iana_timezone` (Shopify's `ianaTimezone` — where a day starts on the Insights charts; null until a sync runs the current `mapShop`), `sync_cursors` (mail keys `mail_ingest_delta_link` · `mail_ingest_resume_link` · `mail_sent_delta_link` · `mail_sent_resume_link` · `mail_ingest_cutover_at` (written once) · `mail_id_type` (`immutable` after `ids:translate`), all owned by `ingestion/delta-poller.mjs` `CURSOR_KEYS` — **never written by `mapShop`**), **order retention switch** `order_retention_mode` (`months`/`indefinite`) + `_months` + `_changed_at` + `_reason` — read by `scripts/lib/order-retention.mjs`, never written by `mapShop`; **the VIP rule** `vip_min_spend` + `vip_min_orders` + `vip_window_months` (all or none) + `vip_rule_changed_at` — set on the Customers panel, read by `scripts/lib/vip-rule.mjs` |
| `customers` | lean support snapshot: contact, marketing state, coarse location, lifetime totals, last order, `rfm_group`. No addresses or notes |
| `orders` | identity, links, channel, derived `order_status`, totals, line items, fulfillments, returns, refunds. Contacts hashed, plus `customer_email_masked` (`j***l@orange.fr`) for the one question a hash cannot answer; `tracking_numbers text[]` (GIN) lifted out of fulfillments so a ticket can be resolved from a parcel number; destination coarse; `retention_rule` names only WHY the clock started, `retention_delete_after` carries the period and is **null when kept indefinitely** |
| `products` | snapshots + first-class metafields, `variants` jsonb, `available_stock` |
| `sales_channels` | the shop's marketplaces (migration 60): `platform_key` (URL/filter id, never `all`/`shopify`, never changes), `label`, `handles` (Shopify `sales_channel_handle`s), `analytics_names` (ShopifyQL `sales_channel`, lower case), `position`. Every handle not listed is the shop's own store. Read by the Insights platform filter and services (`getMarketplaces`), the VIP rule, order resolution's anonymous-buyer rule, the chat prompt and `chat.vip_customer_rows()`. Edited on Setup → Sales channels |
| `promotions` | one row per discount, its redeem codes in the `codes` jsonb (empty for automatic); `method` `code`/`automatic`; two local columns the sync never writes, `offerable_in_replies` (codes, default false) and `describable_in_replies` (automatic offers, default true); `rule_snapshot` carries values, not just type names — complete product/collection lists per leg and `destination` (country codes) for shipping discounts |
| `advice_collections` | every Shopify collection (175), plus the team's decision about each: `is_active` (may support answer from it), `axis` (`concern` / `category` / `range` — a « gamme », storefront advisor only, migration 77), `note`. `product_ids` holds the LIVE products, refreshed for active collections only — see DECISIONS.md § advice from collections |
| `shopify_metaobjects` | shared metaobjects (FAQ, ingredient lists) referenced by products |
| `shopify_content_sources` | content-free catalog of live pages + policies. Feeds Agent Setup only; no FK to knowledge |

### Curated knowledge

Never auto-synced — every row is an explicit import or a hand-written article.

| Table | Holds |
| --- | --- |
| `knowledge_documents` | `content_html` is the editor's truth; `approval_status` independent of Shopify publish `status`; `core_topic` = `brand` or null since migration 56 (the « Core setup » checklist is gone; policies live in `company_policies`); `voice_profile` jsonb = the drafting agent's system prompt on the singleton `brand` row (`roleDescription`, `toneAndVoice`, `responseFramework[]`, `guidelinesAndGuardrails[]`, `closingLine`, `signature`) — all five stored, so the worker reads one source rather than a constant in `web/` |
| `knowledge_chunks` | retrieval chunks + `embedding vector(1536)` HNSW cosine, plus the determinism quadruple; `category` and `product_ids` denormalised from the parent document |

### Support exemplars

The recurring situations, not the answers to them. Same document/chunk mechanics as knowledge, in their own tables so retrieval can never reach a *question* while looking for policy.

| Table | Holds |
| --- | --- |
| `support_exemplars` | canonical question, `exemplar_key` (`P-16`), subject + kind, `requirement_needs text[]` constrained to the `evidence-rules.mjs` vocabulary, `approval_status` (gates the vector), `demand_message_count`, `answer_set` naming which policy family it draws on (`commande` on the 11 order/delivery situations), `never_auto_send` (Rules page switch: its drafts never send themselves, migration 63) |
| `support_exemplar_phrasings` | one row per canonical + real phrasing, each with its own `embedding vector(1536)` and the determinism quadruple. `language` is declared in the document — a variant's annotation may open with a code (`_(en)_`), and **12 of the 168 authored phrasings are real English, Spanish or Dutch mail**. Translations live at `phrasing_index >= 100` (`TRANSLATION_INDEX_BASE + source * 10 + language slot`, from `lib/exemplar-translation.mjs`), out of reach of the importer's pruner; every authored phrasing is translated into each of `fr en es it de` it is not already written in, giving **674 rows for 168 phrasings** (counted 2026-09-21; 842 in all, of which 832 are embedded — the 10 unembedded are soft-deleted `O-11`'s). `match_support_exemplars()` returns one row per **exemplar**, scored by its best phrasing, reports which language matched, and over-fetches `match_count * 64` — above the 60-row ceiling one exemplar's translations can reach |
| `company_policies` | **the company's policies** (migration 55): `policy_key` (fixed once created; the `getPolicy` tool's argument), `name`, `purpose` (the agent reads it to decide whether to fetch), `content` (plain text, may quote `{parameter}` placeholders), `active`, `version` (raised on every change of text), `updated_by`. Not the rulebook: says what the company's rule is, never what happens in a case. Screen: **Agent Setup → Policies** (`PolicyLibrary`) |
| `company_policy_versions` | every version of every policy's text, append-only (`policy_id`, `version`, `content`, `saved_by`) |
| `company_policy_links` | a policy made available to a whole situation (`situation_key`) or one rule (`answer_id`, cascade), exactly one; unique per target. A reference, never a copy. Edited on the rulebook's « Linked policies » blocks |
| `support_answers` | the policy rules. Two axes: `situation_key` (what the customer wants, from the matched exemplar; null = any) and `when_conditions jsonb` = `{need: [findings]}` (what is true). A matched rule carries an `answer_skeleton`, and may `route` to `needs_human`/`needs_customer_input`, hand out **`offer_code`** (a live discount code, picked by an operator from the promotions cleared on `/agent-setup/promotions`; no FK because `promotions` is Shopify-synced, so it is re-checked at drafting time and dropped if it stops being ACTIVE + offerable), and name **`ask text[]`** (`MISSING_FIELDS` keys — a list since 2026-08-30, because a reaction with no product named needs the product *and* the batch number) — **never to `answerable`**, enforced by a check constraint, so a rule can only ever tighten. A rule may also pin **`knowledge_document_id`** — the approved article it answers from, chosen in the editor like a code and carried into the drafting prompt under its own heading, separate from what retrieval found. A real FK (`on delete set null`) unlike `offer_code`, because no sync rewrites these rows; approval is still re-checked at drafting and the article dropped if it is no longer approved. **`tones text[]`** (keys of `scripts/lib/reply-tones.mjs`, check-constrained, `{}` = Brand voice alone) reach the drafting prompt as `## Ton de cette réponse`; unioned across requests. **`link_url` + `link_label`** (https only, both or neither): the prompt gets only the label and asks for one `[[ici]]` marker; the address is copied to `ticket_drafts.reply_link` and put on the marked word wherever a draft is rendered (`TrackingText`, marker rules in `scripts/lib/reply-link.mjs`); checks `link_placed` / `no_orphan_link_marker`. **`checks jsonb`** (`[{owner, need}]`, migration 44): the checks the rule opens on a case, in order; copied onto `exemplar_match.policy.check_sequences` and walked by the fold (`casework/rule-checks.mjs`). One `is_fallback` per `answer_set`. Selected by `answer-selection.mjs` (situation outranks condition depth), which also derives the next need to collect. **119 approved rules, counted 2026-09-21 — 63 in `orders`, 20 in `products`, 8 each in `cosmetovigilance`, `returns` and `promotions`, 6 each in `accounts` and `payments`**, beside 11 drafts (5 `orders`, 5 `products`, 1 `promotions`) that no run can reach, loaded per ticket by `loadAnswers` (approved only) and selected after the tool loop closes. **Live: a matched route tightens the verdict in `buildCaseFile`, never loosens it**, and the selection is recorded on `ticket_investigations.exemplar_match.policy` with `verdict_before_policy` beside it. `answer_skeleton` travels into the drafting prompt as `## Ce que cette réponse doit faire` — read out of `exemplar_match.policy` **by name**, so the diagnostics beside it cannot reach a model. `notify_on` (`refund_recorded`): the rule is the template for the refund notice; its answer set is the notice's scope (migration 72). Set from the rule editor's « Tell the customer when a refund is recorded » box, shown only in a set whose rules read `refund_state` (returns); one rule at a time, locked on the others |
| `support_parameters` | the numbers the desk runs on — returns window, dispatch delays, free-shipping threshold — held once so a rule, an article and a skeleton cannot disagree (09). Read by code through `scripts/lib/parameters.mjs`; never retrieved as prose |

### Agent email workflow

| Table | Holds |
| --- | --- |
| `tickets` | one per Graph `conversationId` — a THREAD. **`case_id`** (not null: the case above the thread, migration 61) + **`case_link_state`** (`pending` until the `link` pass decides, once; `decided` after). Taxonomy axes, `level`, `responsible_team`, `customer_id`, `shopify_order_number`, signals (`language`, `happiness`, `categorisation_confidence`), `resolved_context` jsonb, `duplicate_of_ticket_id` + `duplicate_reason` + `duplicate_detected_at` (**linked, never merged** — set by deterministic rules only; the drafting *and* investigation queues skip a linked ticket. **Since migration 61 a new duplicate joins its original's case instead**, and the existing links were folded into cases), `sender_label` (`internal`/`contractor` when one of OUR addresses opened the thread — stamped at creation from `sender_directory`, skips drafting, investigation still runs), `related_ticket_id` + `related_score` + `related_detected_at` (**no longer written since migration 61**: a similar message is a candidate for the `link` pass instead; the old rows stay, shown only on a thread with no case of several threads), lifecycle + retention timestamps, `overrides` jsonb (a person's corrections per field: `{value, ai_value, set_by, set_at, source}`; the column of an overridden field holds the person's value — migration 48), `fact_drift` jsonb (the change router's record of order states that moved under the latest case file: `{changed, outcome, reason, case_file_at, checked_at}`; hashed into the case version by the fold — migration 69) |
| `ticket_overrides` | **every correction and reset** made in « Edit case »: `field`, `action` (`set` / `cleared`), `value`, `ai_value`, `source`, `set_by` (user id), `set_at`. Append-only audit; the active values are `tickets.overrides` (migration 48) |
| `ticket_snoozes` | **a case hidden from the queue until something happens** (migration 54): `source` (`auto`: the fold, after a message of ours was sent / `manual`), `waiting_for` (customer / colleague / partner / date), `reason` (a person's note), `wake_at` (**never null**: the deadline), `trigger_message_id` + `case_version` (auto), `snoozed_by`, `woke_at` + `wake_reason` (a new message by actor, `deadline`, `manual`, `case_changed`, `resolved`, `order_update`) + `woken_by`. One open row per ticket (`woke_at` null); one automatic snooze per message of ours. Not a ticket status. Written only by `scripts/lib/snooze-record.mjs` |
| `case_current` | **the current state of each case**, one row per ticket, overwritten in place (migration 41). Folded in code by `casework/case-fold.mjs` from the messages (with their actor), the Case Manager readings and the latest case file: `pending_customer_inputs`, `commitments`, `contradictions`, `obligations` (each `{id, owner, need, quote, status, opened_at, cleared_by}`, stage 5; a rule step adds `rule`, `step`, `steps`, and `status: queued` until its turn), `last_actor`, `next_actor` (customer / support / colleague / partner / nobody), `resolved`, `version` (raised only when `material_hash` changes), `folded_at`. No model writes it. `next_actor` sets the ticket's status (5c, `casework/case-status.mjs`; the move is recorded in `tickets.metadata.case_status`). Shown on the ticket's **Case** block |
| `ticket_case_actions` | **a person settled an open check** from the ticket page: `obligation_id`, `action` (`fulfilled` / `cancelled`), `acted_by` (user id), `acted_at`. Append-only; the fold applies the latest per check (migration 43) |
| `cases` | **the customer's problem, above its threads** (migration 61). A ticket inserted without one gets one from the trigger `tickets_open_case`. Several tickets share a `case_id`; nothing is merged. `latest_actionable_inbound_message_id` + `reply_thread_id` (**the reply target**: the newest customer message no later outbound answers, on any thread — `case-reply-target.mjs`; plain uuids, not FKs; recomputed after the fold and on every link; `target_computed_at` null = never computed, which turns the case gates off), `case_key` (`requester hash \| order \| family`), `issue_family`. **No address stored.** Written only by `scripts/lib/case-record.mjs` |
| `case_links` | **every linking decision**, append-only, a new case included: `ticket_id`, `from_case_id` → `to_case_id`, `decision` (`link` / `new_case`), `method` (`first_contact`, `reply_chain`, `identical_body`, `tracking`, `order_family`, `unique_match`, `model`, `model_off`, `no_candidates`, `excluded_sender`, `backfill`), `candidates` (`[{case_id, reasons}]`), `model` + `model_answer` |
| `issue_family_members` · `issue_family_transitions` | **configuration**, per shop: subject or situation → family (DELIVERY, ORDER_CHANGE, REFUND_RETURN, PAYMENT, PROMOTION, PRODUCT, ACCOUNT, COSMETOVIGILANCE), and which family may continue as which (directed; a family is always compatible with itself). Seeded by migration 61; read by `case-link-rules.mjs` |
| `ticket_messages` | one per Graph message. **`actor`** (customer / support / colleague / partner, migration 41; **`automated`** for an out-of-office, migration 73, marked in `raw_graph_payload.autoReply` by `ingestion/auto-reply.mjs` and skipped by the reopen, the wake, the fold and the reading queues) is stamped at arrival from the direction and the sender directory through `AGENT_ACTOR_BY_LABEL`, and moves with a re-filed direction. Envelope, cleaned `body_text`, sanitised payload, `embedding vector(1536)`, the RFC 5322 reply chain (`in_reply_to` + `reference_ids[]`, captured for deduplication — only those two headers are kept, the rest is `Received` chains carrying relay IPs), and `attachments jsonb` -- part METADATA only (name, contentType, size, isInline), never bytes. **NULL means never fetched**, `[]` means fetched and empty |
| `ticket_investigations` | **the case file**: `established` / `unverified` / `missing` / `do_not_claim` (four separate columns), `handoff`, `context_ref`, `dropped_claims`, `evidence_gaps` (what the ticket required vs what was obtained, each entry carrying the `finding` and the `details` naming WHICH product or code it is about — diagnostic, does not move the verdict), `exemplar_match` (which recurring situation this is; recorded, never acted on), `candidate_order` (**internal**: the customer's last order as a FULL bundle, same shape and builder as `resolved_context`, fetched in the order tool's unresolved branch so it can never sit beside a confirmed order. Rendered in the human brief and the dashboard under Last order headings, **never** in the drafting prompt). `reaction_report` (**cosmetovigilance only, nullable**: the product the customer BLAMES, their words for it, and the symptoms — attribution, never causation. Lifted out of the ledger by `reactionReportFrom` because `tool_calls` drops every tool's `data`. On the detail projection, deliberately **not** on the drafting one). `findings_trace` (**nullable**: the derived findings after each tool call, in call order — one entry per `tool_calls` entry, `{call, tool, findings}`, scored over the whole need vocabulary. The replay tape: `tool_calls` drops every tool's `data` and 8 of the finding derivations read it, so a replay over `tool_calls` alone would score those as absent and stop earlier. NULL means the row predates the column and can never be filled; `[]` means the run made no calls. On no projection at all). `recommendations` (**what `recommendProducts` put forward, as the tool rendered it** — one entry per type of care, with the product lines a reply quotes. Written by code off the tool ledger like `knowledge`, never by the model, and printed FIRST in the drafting prompt, before `## Établi`; migration 32). `unique(shop_id, trigger_message_id)` |
| `ticket_case_state` | **one reading per inbound message on a ticket already read once** (04): what the message changed about the case — asked and answered, promised, which prior evidence may be reused; never a tool result. Keyed per trigger message like `ticket_investigations`: a trajectory, not a current value |
| `ticket_drafts` | **what the agent would send**: `body_text` (the model's, never edited) beside `approved_body_text` (a reviewer's rewrite), `source_verdict` (all three — `needs_human` gets an acknowledgement), `disposition` (`terminal` = sending closes the ticket \| `intermediary` = somebody still owes an answer; derived from the verdict + the case file's `handoff`, never model-chosen, and enforced by two check constraints), `level` (1–3; level 4 is never drafted), `status` (the human decision) kept apart from `checks_passed` (the machine outcome), `auto_send_eligible` (four conditions: level 1–2, customer not visibly unhappy, checks passed, verdict not `needs_human` — plus subject holds: `cosmetovigilance` never qualifying unless **both** `DRAFT_ONLY` and `DRAFT_ONLY_COSMETOVIGILANCE` are false, a customer naming a health condition, a situation marked `never_auto_send`), `auto_send_blockers` (every reason it is not, `[{ reason, detail }]`, migration 63; the subject holds are shown on the draft), `prompt_inputs`, `review_sent_at`, `approved_body_html` (a formatted rewrite as sanitised HTML; `approved_body_text` is its text, migration 52). **One row per case version** (migration 45): `unique(shop_id, ticket_id, case_version)`, with `trigger_event_id` (the message that produced the version) and `stale_reason` (`case_changed` \| `superseded_by_outbound`, present exactly when `status = stale`; set by the fold, never decided on, never mailed). `trigger_message_id` is indexed, no longer the key; rows from before carry no version. **Holds no recipient and cannot send.** Owned by `scripts/lib/draft-record.mjs`. `purpose`: `reply`, or `refund_notice` (a message of ours, unasked; never auto-sent — migration 72) |
| `outbound_actions` | **a reply we decided to send** (migration 47): `draft_id` (null exactly for a `manual` reply, migration 52), `case_version`, `mode` (`human_approved` \| `auto_send` \| `manual`: a person's own reply from « Create draft », `action_type` `manual_reply`, keyed on `client_key`, not on the version), `reply_to_message_id` (the recipient is its `from_email`, read at send time; **no address stored**), `body_text` (copied) + `body_html` (what is sent, sanitised by `reply-html.mjs`; the draft's `[[marker]]` is its link), `state` approved → draft_created → send_requested → sent_confirmed, or cancelled (`cancel_reason`) / failed, `provider_draft_id` (immutable: equals the Sent Items copy's `graph_message_id`), `provider_internet_message_id`, `sent_message_id`. **One live or sent action per `(shop_id, ticket_id, case_version, action_type)`** (unique index ignoring cancelled/failed). Owned by `scripts/lib/outbound-record.mjs`; carried out only by `agent/src/outbound/outbound-runner.mjs` |
| `ticket_draft_edits` | **append-only record of every human rewrite**, each carrying `model_body_text` — the agent's text as it stood when the edit was made, COPIED rather than referenced, because `ticket_drafts.body_text` is replaced by the next drafting run. `source` (dashboard / mailbox), `edited_by` (null until auth exists). Capture for Phase 7 memory; nothing reads it yet |
| `email_blocklist` | per-shop sender email/domain rules + hit counts |
| `sender_directory` | per-shop sender email/domain → `label` (internal, contractor, logistics, courier, retailer, distributor, supplier, partner, other) + free-text `note`. Read into the case file as context and by `cluster:tickets` to tell customer demand from our own mail. Replaces `INTERNAL_EMAIL_DOMAINS`. Rows are exceptions; an unlisted sender is a consumer |
| `spam_audit` | one row per gate decision. `outcome`, `decided_by`, `reason`, `label`, `model`, `failed_open`, sender, subject, and on a block `body_text` + `body_captured_at` + `body_expires_at` |
| `dropped_mail_clears` | blocked emails a person cleared from the dashboard's Irrelevant list, shop-wide (04). The `spam_audit` row is untouched; « restore » deletes these rows |
| `category_forwarding` | the old per-category address book. **Nothing reads it since 2026-09-29** (superseded by `forwarding_destinations`); left in place, to be dropped |
| `forwarding_destinations` | who receives mail the contact team does not own (migration 49): `label`, `forward_email`, `active_since` (**the destination's switch**: null = off, otherwise when it was switched on; it receives only mail received since then; needs an address — migration 51), `description` (the business's words; what the router reads), `categories`, `request_kinds` (empty = any), `match_description` (the agent checks even a lone destination), `timing` (`immediate` / `after_first_reply`), `acknowledge`, `public_name_fr/en` + `ack_note_fr/en` (the acknowledgement's wording), `position`. Validated by `scripts/lib/forwarding-destinations.mjs` |
| `forwarding_settings` | one row per shop: `forward_since` (**the master switch**: null forwards nothing; otherwise only inbound mail received since then — migration 50), `ack_enabled` (default false) and the FR/EN acknowledgement templates (null = the defaults in `forwarding-destinations.mjs`) |
| `agent_models` | the model an agent runs on, chosen in Settings (migration 53): `(shop_id, agent)` key, `agent` ∈ spam/categorise/situation/decompose/investigate/draft/chat/case_link/casework/closure (case_link from 61, casework and closure from 74), `model`, `updated_by`. **Overrides the env var**; no row = the env decides. Read by `scripts/lib/agent-models.mjs` — the worker every poll (`refreshModels` in `agent/src/index.mjs` rebuilds the model clients on a change), the test chat and the management chat (`currentChatModel`) |
| `ticket_routing` | the router's decision per ticket (migration 50): `outcome` forward/keep, `method` fixed/model, `destination_id` + `destination_label`, `reason`, `model`, the `category`/`request_kind` it was taken on (re-taken when they change); and the once-per-ticket acknowledgement: `ack_state` requested/sent/failed/skipped, `ack_at`, `ack_error`, `ack_attempts` |
| `ticket_forwards` | attempt ledger, `unique(ticket_message_id)`, `sent`/`failed` + attempt counter, snapshots `category`, `forward_email`, `destination_label` |
| `mail_jobs` | **the durable queue** (migration 46): `sync_mailbox` (a change notification asking for a folder read) , `send_outbound` (the attempts of one outbound action) and `sync_social` (a Meta / Google Ads sync asked for by Connect or Sync now; migration 70). `state` queued/running/done/dead, `retry_count`, `last_error`, `last_attempt_at`, `next_attempt_at`, `locked_until` (lease). Unique `dedupe_key` among **queued** rows only. RPCs `enqueue_mail_job()` + `claim_mail_jobs()` (SKIP LOCKED; an expired lease is reclaimable and counts as an attempt). Case processing is not a kind. Owned by `scripts/lib/mail-job-record.mjs` |
| `mail_subscriptions` | one Graph change-notification subscription per shop + provider + folder: `subscription_id`, `client_state_hash` (never the secret), `expires_at`, `needs_renewal`, `last_error`. Owned by `scripts/lib/mail-subscription-record.mjs` |
| `categorisation_review` | **testing artefact, not runtime**: hand-labelled sample scored against the agent |

### Projections

Views and functions for shapes that were being assembled client-side by reading
rows and discarding most of them. Joins and aggregates only — judgement stays in
tested JavaScript. Every view is `security_invoker`, or it would read past the
RLS on the tables under it.

| Object | Answers | Replaces |
| --- | --- | --- |
| `ticket_message_counts` | messages per ticket + inbound/outbound activity facts, soft-deleted excluded | a full read of `ticket_messages` to count in a Map |
| `ticket_first_inbound` | one row per ticket: its earliest inbound message, incl. `from_email` | a read of every inbound body in the shop, keeping one per ticket |
| `case_message_counts` | messages per case over every live thread (`thread_count`, `inbound_count`, latest inbound/outbound, `last_activity_at`) | — (61) |
| `case_facts` | **one row per case**: the earliest thread's subject, the highest level and worst mood, a folded status, the lead thread, first reply across threads (`reply_hours`). Read by the queue and the Insights support figures | counting tickets for support volume (61) |
| `ticket_queue` | the dashboard row: ticket + customer + count + `requester_email` (the address that opened the thread, so `sender_directory` can be asked whether it is a customer), soft-deleted excluded. Since 61 also the case: `case_id`, `is_case_lead`, `case_thread_count`, `case_message_count`, `case_inbound_count`, `case_waiting_since`, `case_level`, `case_status` (the queue shows lead rows and ranks them on these) | `TICKET_LIST_SELECT` + the count join, in `tickets-service.ts` |
| `dropped_mail_list` | the Irrelevant list: blocked `spam_audit` rows neither cleared (`dropped_mail_clears`) nor promoted (a `ticket_messages` row with the same `graph_message_id`), with `has_body` instead of the text |
| `order_number_range(shop)` | lowest and highest `order_number`, live orders only | an asc/desc pair of `limit 1` reads |

**The 21 Insights views (`06_analytics.sql`).** The all-time aggregates. The panels
now read the ranged functions below instead — only the Customers panel still reads
two of these (a snapshot has no range). The rest have no reader and are kept as the
all-time definitions, and the ranged functions build on `order_fulfilment_timing`.
Either way nothing is aggregated in the browser or the server, because
PostgREST caps a response at 1,000 rows and pages an unordered query in
overlapping slices — see `DECISIONS.md § Insights`.

| Group | Views |
| --- | --- |
| Fulfilment | `order_fulfilment_timing` (base, per order; also carries `total_refunded` + `return_status`) |
| Support | `ticket_reply_times` (base, per ticket) · `support_by_month` |
| Customers | `customer_ticket_facts` (read only through the 86 aggregates: `customer_vip_ticket_stats` / `_categories` / `customer_vip_call_list`) · `customer_segment_totals` |

The whole-book views (`fulfilment_summary`, `fulfilment_by_*`, `support_by_category`, `support_purchase_*`, `agent_pipeline_funnel`, `investigation_*`, `llm_usage_*`, 16 in all) were dropped by `93_drop_superseded_views.sql` (2026-10-12): the ranged functions below replaced them and nothing read them.

**The 28 ranged functions (`RANGED READS`, `06_analytics.sql`).** Every Insights
figure is now read over a date range: `insights_orders_summary` / `_series` /
`_by_channel`, `insights_customer_mix`, `insights_fulfilment_buckets` /
`_carriers`, `insights_product_sales`, `insights_country_product_sales`,
`insights_orders_by_country`, `insights_product_pairs`, `insights_orders_per_customer`,
`insights_marketing_summary` / `_series`, `insights_capture_series`,
`insights_support_summary` / `_series` / `_categories`, `insights_agent_funnel` /
`_verdicts` / `_blockers`, `insights_llm_usage` / `_series` / `_ticket_stats`, and
`insights_freshness` (when each source last moved), and — for Overview, Marketing
and the report — `insights_sales_overview` (paid units, discounts, discounted vs
full-price revenue), `insights_promotions` (per promotion name, plus full price)
`insights_inventory_exceptions` (active products out of stock, low on cover, or
under a unit floor; stock now, rate over a window) and `insights_collection_sales` (per collection, or
just the ranges `p_handles` names). One convention: the range as
wall-clock `timestamp`s plus `p_tz`, half-open; series take `p_grain` and return
only non-empty buckets; order functions take `p_channels` / `p_not_channels`.

**The VIP rule** is three functions in `06_analytics.sql`: `vip_customers()` (the rule: net spend AND orders in the window, both strictly above the shop's thresholds; Shopify orders only), and `vip_tickets()` / `vip_summary()` built on it, plus `open_orders()` — orders not fulfilled, cancelled or closed, each buyer marked VIP through it.

**The Orders page** is two functions in `06_analytics.sql`: `orders_list()` (one page of every live order, newest first, with buyer name, VIP through `vip_customers()`, units, normalised carrier, destination and `total_count` of the filtered set) and `orders_list_facets()` (each fulfilment status and country with its count, grouped on the same expressions the list filters on). The status in both is `order_fulfilment_display()` (Shopify's, or `CANCELLED` / `REFUNDED` for an unshipped order with 0 items left), the SQL twin of `fulfillmentDisplay` in `scripts/lib/order-list-query.mjs`.

They expose `rfm_group` and never `is_vip`: who counts as a VIP is a business
rule owned by `customer-segments.mjs` and applied at read time.

### Agent rehearsals

| Table | Holds |
| --- | --- |
| `agent_test_runs` | one run of the Agent Setup **test chat**: a message an operator typed, put through the real pipeline. References no ticket, message, investigation or draft — a rehearsal writes none of them (`agent/src/testing/`). `trace` jsonb is the record (every step, every tool's returned text, every model call's prompt and response); the flat columns beside it index it so a history list never parses one. Identity is `requester_email_masked` only — neither the address nor a hash. `ideal_body_text` is **the memory**: what the operator would have sent instead — the same capture `ticket_draft_edits` makes for real mail, except the situation can be invented. Cost is recorded here and deliberately not in `llm_usage` |

### Management chat

Migration 17. Two halves, on two connections — see `DECISIONS.md § Management chat`.

| Object | Holds |
| --- | --- |
| role `mgmt_chat_ro` | what the model's SQL runs as (`CHAT_DB_URL`). `USAGE` on `chat`, `SELECT` on its views, `EXECUTE` on `normalise_carrier` — nothing else. Read-only default, 10 s timeout, `search_path = chat`, 5 connections |
| schema `chat` | 13 **owner-rights** views, one per thing management asks about: `shop` · `orders` · `order_lines` · `fulfilment_timing` · `customers` · `products` · `promotions` · `tickets` · `ticket_reply_times` · `ticket_message_counts` · `ticket_investigations` · `ticket_drafts` · `llm_usage`; and `vip_customers` (migration 21), over the security-definer, argument-less `chat.vip_customer_rows()`, which applies `vip_customers()` with the shop's thresholds. **No names, emails, phones, addresses, subjects or message text.** Their `comment on` text is the schema description the model is given, read at request time |
| `storefront_session_months` | per shop and CLOSED month (shop clock): human sessions, pageviews, cart / checkout / converted sessions from ShopifyQL. Written nightly (every month rewritten), read by `analytics.ts`; the last two months are never read from here. No money — net sales and AOV are always live. Named in `STOREFRONT_T` |
| `chat_conversations` | one thread, owned by one dashboard user (`user_id` = auth id); title = first question |
| `chat_turns` | one question + answer: `status` (running / ok / step_limit / empty / error), `error`, `model`, `steps`, tokens, `duration_ms`. Spend here, **not** in `llm_usage` |
| `chat_queries` | every query tried: `sql`, `ok`, `error` (a refusal or a Postgres error), `row_count`, `truncated`, `duration_ms`, `columns`, the first 50 rows |

### Storefront advisor

Migration 76. Named in `STOREFRONT_CHAT_T` / `STOREFRONT_CHAT_RPC`. Not `chat_*` (that is the management chat). No FK to `shops`: the dev store has no row there; the proxy signature names the shop. See `docs/storefront-chatbot.md`.

| Object | Holds |
| --- | --- |
| `storefront_chat_sessions` | one anonymous widget conversation: `session_token` (minted server-side, handed back to the browser), `shop_domain` (as signed by the proxy), `source`, `status`, `locale`, `turn_count` (the per-session cap), `last_activity_at` (retention) |
| `storefront_chat_messages` | each customer message and reply: `role`, `content`, `action` (quick action), `context` jsonb (page type, handles, locale, optional country, path; product URLs and refs/resolution on replies; `trace.knowledge` records opening routes, retrieval stages, source IDs/versions and timing), `model` + tokens (null for the mock). Cascades with its session |
| `storefront_chat_user_messages_since` / `_record_turn` / `_purge` | service_role only: the per-shop daily count, the atomic turn increment, the retention delete |

Migration 80, named in `ADVISOR_T` / `ADVISOR_RPC`. Written by `npm run advisor:load` from `data/advisor/<brand>.json` (config) and by the storefront chat service (events); read by the storefront advisor only.

| Object | Holds |
| --- | --- |
| `advisor_playbooks` | the brand's routine playbooks, one row each (`key`, `position`, `status`, `definition` jsonb as authored). FK `shops` |
| `advisor_mappings` | `kind` + `key` → `definition`: families, slots, concerns, skin types, textures, areas, targets, labels (+ single sections under `_`). Makes playbooks executable without product ids |
| `advisor_merchandising` | priority entries: product / collection / family, tier, optional concern / slot, dates |
| `advisory_events` | channel-aware advice analytics: `channel` (storefront_chat, email reserved), `conversation_ref` (session id; ticket id later), `event_type`, `playbook_key`, `product_ids`, `payload` (codes and counts only). No FK, like 76 |
| `advisory_events_purge` | service_role only: the events retention delete |

### Klaviyo

Migration 39. Named in `KLAVIYO_T` / `KLAVIYO_RPC`, not `T` / `RPC`. See `DECISIONS.md § Insights → Klaviyo`.

| Object | Holds |
| --- | --- |
| `klaviyo_connections` | one row per shop: `secret_id` (the key, in **`vault.secrets`**), `key_hint` (last 4), `conversion_metric_id` (Placed Order), `saved_at` / `saved_by`, `last_sync_at` / `_status` / `_error` |
| `klaviyo_flow_days` | per shop, flow and day (Klaviyo account clock): recipients, delivered, opens_unique, clicks_unique, conversions, conversion_value — counts only. Last 59 days rewritten nightly |
| `klaviyo_campaigns` | per shop and campaign: name, channel, `send_time`, the same counts, for the campaign as a whole |
| `klaviyo_save_key` / `_read_key` / `_clear_key` | security definer, `search_path ''`, **service_role only** — the only way to touch the key |
| `insights_klaviyo_messages(p_shop, p_from, p_to, p_tz)` | flows summed over their days + campaigns by send time, in the Insights range convention |

### Social and paid media

Migration 70. Named in `SOCIAL_T` / `SOCIAL_RPC`. See `DECISIONS.md § Insights → Social and paid`.

| Object | Holds |
| --- | --- |
| `social_connections` | per shop and provider (`meta` / `google`): `secret_id` (the OAuth token, in **`vault.secrets`**), `token_expires_at`, `scopes`, `conversion_action` (Meta; null = `omni_purchase`), `last_sync_at` / `_status` (`ok` · `failed` · `needs_reconnect`) / `_error` |
| `social_accounts` | what a connection sees: `kind` (`instagram` · `facebook` · `meta_ads` · `google_ads`), `external_id`, name, handle, currency, `login_customer_id` (Google manager), `enabled` (the team's choice; reads skip disabled) |
| `social_account_days` | per organic account and day: followers (that day's count), follows, unfollows, views, engagement, profile visits, link taps, posts — additive counts only, null = not measured |
| `social_posts` | per post: published_at, type, 140-char caption, permalink, thumbnail, lifetime views / reach / likes / comments / shares / saves / follows / engagement, `insights_at` (81: when Meta last answered; null = never read, so the sync reads it once whatever its age) |
| `social_accounts.engagement_basis` | migration 82: `followers` · `reach` (default) · `views`, the denominator of that platform's engagement rate; `insights_social_post_totals` gained `engaged_posts`, `rated_views_engagement`, `rated_views` |
| `social_posts.non_followers_pct` | migration 84: percent 0-100 of non-followers reached, **typed in by hand** (Meta gives no per-post figure); never written by a sync; read live |
| `social_metric_bands` | migration 83 (`SOCIAL_BAND_T`): per shop, platform kind and post metric, `mode` (`off` · `absolute` · `followers` · `median`) + `low` / `high`; a metric with no row uses the suggestion in `social-bands.mjs`. Read live |
| `social_post_tags` · `social_post_tag_links` | migration 81 (`SOCIAL_TAG_T`): the team's own post labels (unique per shop, case ignored) and which post carries which; written only from the Posts table, through `social-tags-service.ts` |
| `social_audience` | per Instagram account and capture day: follower counts by gender / age / country / city |
| `social_audience_manual` | migration 89: the latest dated, person-entered percentage distribution per shop / platform / dimension. Provider snapshots stay separate and win for a whole dimension |
| `social_post_manual_metrics` | migration 88: values a person typed for post metrics the platform did not give. Provider counters stay in `social_posts`; a rate belongs to the denominator it was entered against |
| `ad_days` | per ad account, day and publisher: spend, impressions, clicks, conversions, conversion value, currency |
| `ad_campaigns` · `ad_campaign_days` | migration 71 (`CAMPAIGN_T`): per campaign name / status / objective, and the same counts per campaign and day. Read by `insights_paid_campaigns` (the Paid view's campaign table) |
| `social_save_token` / `_read_token` / `_clear_token` | security definer, `search_path ''`, **service_role only** |
| `insights_social_series` · `_followers` · `_posts` · `_post_totals` · `_audience` · `insights_paid_series` | the panel's reads; wall-clock range, enabled accounts only |

### Compliance and audit

| Table | Holds |
| --- | --- |
| `integration_events` | metadata-only sync/webhook log, idempotent on `event_key` |
| `privacy_requests` | Shopify compliance webhook lifecycle (hashed contacts, deletion counts) |
| `data_access_events` | personal-data access audit trail. Sync paths and the agent's customer lookup write here, and so does the dashboard: one row each time a signed-in user is shown customers by name (ticket list, ticket detail and thread, Conversations, Fulfilment's waiting orders, the Customers call list, the contacts CSV), with `actor_type = user` and `actor_id` the Supabase `auth.users.id` — counts in `metadata`, never names |

Dashboard accounts are **not** in this schema: they are Supabase Auth users (`auth.users`), with the role in `app_metadata.dashboard_role`. See Surfaces → Sign-in and roles.

### Analytics

Written by the worker and the CLIs, read only by the Insights panels.

| Table | Holds |
| --- | --- |
| `llm_usage` | one row per model call: `pass` (`spam`, `categorise`, `decompose`, `situation`, `investigate`, `draft`, `embed`, `other` — `USAGE_PASSES`), `model`, token counts, `ticket_id`, `succeeded`. Append-only, written through one sink in the OpenAI transport. **Tokens are stored; money is computed at read time** from `scripts/lib/llm-rates.mjs` |
| `cluster_runs` | one row per manual rebuild of the topic map: `built_at`, `threshold`, `min_size`, corpus counts. What the panel reads to state the map's age |
| `ticket_clusters` | one row per topic in a run: subject, size, cohesion, excerpt, `member_message_ids uuid[]` (GIN) |
| `carrier_aliases` | **configuration** (migration 94): how free-text carrier names fold into one canonical name — `pattern` (case-insensitive substring), `canonical`, `position` (first match wins). Read only by `normalise_carrier()` (security definer, so the chat role needs no grant). Edit rows to change carriers, never SQL |

### Migration files

**Applying one:** `npm run db:apply:migration -- supabase/migrations/<file>.sql`. Afterwards it runs the **management chat contract check** (`npm run db:check:chat`, `scripts/check-chat-contract.mjs`). As the chat role (`CHAT_DB_URL`), every `chat` view must run, and the schema text the model is shown must equal `supabase/chat-contract.snapshot.txt`. A change you meant is accepted with `npm run db:check:chat -- --update`, and the snapshot diff then shows up in review.

**Nine files, by domain, run in order against an empty database.** The order is a plain dependency chain, and every table is created *complete* — there is no `alter table … add column` anywhere in the baseline, and a test asserts that.

| File | Creates | Depends on |
| --- | --- | --- |
| `01_foundation.sql` | extensions, `set_updated_at()`, `shops`, `integration_events`, `privacy_requests`, `data_access_events` | — |
| `02_shopify.sql` | `is_valid_product_faqs()`, `customers`, `orders`, `products`, `shopify_metaobjects`, `promotions`, `shopify_content_sources`, `order_number_range()` | 01 |
| `03_knowledge.sql` | `knowledge_documents` (+ `product_ids`), `knowledge_chunks` (+ `product_ids`), `match_knowledge_chunks()`, `search_knowledge_chunks_text()` — both RPCs return `product_ids` | 01 |
| `04_support.sql` | `tickets`, `ticket_messages`, `email_blocklist`, `sender_directory`, `spam_audit`, `ticket_investigations`, `category_forwarding`, `ticket_forwards`, `forwarding_destinations`, `forwarding_settings`, `ticket_routing`, `categorisation_review`, the three views | 01, 02 |
| `05_exemplars.sql` | `support_exemplars`, `support_exemplar_phrasings`, `support_answers`, `match_support_exemplars()` | 01, 03 (`french_unaccent`) |
| `09_parameters.sql` | `support_parameters` | 01 |
| `06_analytics.sql` | `normalise_carrier()`, `llm_usage`, `cluster_runs`, `ticket_clusters`, the **21 Insights views**, and the **28 ranged functions** | 01, 02, 04 |
| `07_drafting.sql` | `ticket_drafts`, `ticket_draft_edits` | 01, 04 |
| `08_testing.sql` | `agent_test_runs` | 01, 03 |

**Incremental migrations** run on top of the baseline, and are deliberately not part of it — the invariants above (creates schema, never migrates data; final shape with no corrective re-work) are properties of the baseline alone. Each is idempotent, so applying one to a fresh install is a no-op.

| File | Does | Depends on |
| --- | --- | --- |
| `10_order_retention.sql` | order retention becomes a shop setting: adds the `shops` switch, rewrites `retention_rule` to reason-only names (reconciling a live/repo drift), sets this shop to `indefinite` and clears its delete dates | 01, 02 |
| `12_vip_rule.sql` | adds the `shops` VIP rule columns + check, and `vip_customers()` / `vip_tickets()` / `vip_summary()`, copied from 06 (its test asserts it, and that the rule is AND with strict comparisons). Sets no rule. Applied 2026-09-11 | 01, 02, 04, 06 |
| `11_insights_ranges.sql` | adds `shops.iana_timezone` and the 18 ranged Insights functions, **copied byte-for-byte from 06** (its test asserts it). Applied to the live database 2026-09-11 | 01, 02, 04, 06 |
| `14_fulfilment_waiting.sql` | replaces `insights_fulfilment_buckets()` with the version that also returns a `Not shipped yet` bucket, counted as `open_orders()` counts it — orders with no duration to bucket were previously drawn nowhere. Copied byte-for-byte from 06; supersedes 11's copy of that one function. Applied 2026-09-12 | 01, 02, 06 |
| `15_orders_list.sql` | adds `orders_list()` + `orders_list_facets()` for the Orders page, copied byte-for-byte from 06 (its test asserts it). No table, no data. Applied 2026-09-14 | 01, 02, 06, 12 |
| `16_orders_search.sql` | drops the 11-argument `orders_list()` and recreates it with `p_search` and an `awaiting_fulfilment` column (open_orders()'s waiting rule); copied byte-for-byte from 06, supersedes 15's copy of that one function | 01, 02, 06, 12, 15 |
| `17_management_chat.sql` | the management chat: login role `mgmt_chat_ro` (no password in the file), the `chat` schema of 13 owner-rights views with no personal data, and the log tables `chat_conversations` / `chat_turns` / `chat_queries` (named in `CHAT_T`, not `T`). Applied 2026-09-14 | 01, 02, 04, 06, 07 |
| `18_product_customer_mix.sql` | drops the draft six-argument `insights_product_customer_mix()` and creates the one-product version (`p_product_id`): distinct Shopify customers who bought only it / with other products / not at all, plus its top 7 co-bought products; free lines ignored. Copied byte-for-byte from 06. Applied 2026-09-14 | 01, 02, 06 |
| `19_product_mix_filters.sql` | drops 18's seven-argument `insights_product_customer_mix()` and recreates it with `p_country`, `p_vip_only` and the VIP rule arguments (through `vip_customers()`); both filters narrow the whole population. Copied byte-for-byte from 06, where the function now sits after `orders_list_facets()` because it calls `vip_customers()`. Supersedes 18's copy. Applied 2026-09-14 | 01, 02, 06, 12, 18 |
| `20_best_products_vip.sql` | drops and recreates `insights_product_sales()` and `insights_country_product_sales()` with `p_vip_only` + the VIP rule arguments (through `vip_customers()`, off by default); both now sit below `vip_customers()` in 06. Copied byte-for-byte from 06, supersedes 11's copies. Applied 2026-09-14 | 01, 02, 06, 11, 12 |
| `30_customer_mix_plan.sql` | replaces the body of `insights_customer_mix()` — same signature, same four numbers — grouping the range by customer before looking up each first order, because the old shape planned as a nested loop (~1 s on a year). Copied byte-for-byte from 06, supersedes 11's copy. Applied 2026-09-18 | 01, 02, 06, 11 |
| `31_orders_status_filter.sql` | adds `order_fulfilment_display()` and re-creates `orders_list()` + `orders_list_facets()` to filter and group on it, so the status filter selects what the pill shows (Cancelled / Refunded instead of Unfulfilled for emptied orders). Same signatures: `create or replace`, nothing dropped. Copied byte-for-byte from 06, supersedes 16's `orders_list` and 15's `orders_list_facets`. Applied 2026-09-18 | 01, 02, 06, 15, 16 |
| `40_customer_questions.sql` | widens `support_answers_ask_check` by five `MISSING_FIELDS` keys (postal_address, preferred_remedy, receipt_confirmation, skin_type, skin_concern). No data. Applied 2026-09-26 | 05 |
| `48_ticket_overrides.sql` | `tickets.overrides` + its check, `ticket_overrides`, `ticket_queue` gains `overrides` last (copied from 04). No data. Applied 2026-09-29 | 04 |
| `49_forwarding_destinations.sql` | `forwarding_destinations`, `forwarding_settings` (copied from 04). No data. Applied 2026-09-29 | 04 |
| `50_forwarding_routing.sql` | `forwarding_settings.forward_since`, `ticket_forwards.destination_label`, `ticket_routing` (copied from 04). No data. Applied 2026-09-29 | 04, 49 |
| `51_destination_switch.sql` | `forwarding_destinations.active_since` + its needs-an-address check (copied from 04); switches on the destinations that had an address. Applied 2026-09-29 | 49 |
| `60_sales_channels.sql` | `sales_channels` (copied from 02); `chat.vip_customer_rows()` reads its handles instead of a literal; the chat comments naming Amazon/Yves Rocher made generic. No data (this shop's two rows were inserted separately). Applied 2026-10-02 | 02, 17, 21 |
| `61_cases.sql` | `cases`, `case_links`, `issue_family_members` + `issue_family_transitions` (seeded per shop), `tickets.case_id` + `case_link_state`; **data**: one case per ticket (its own id), duplicates joined to their original's case (chains to the root, `backfill` rows), every ticket `decided`; `case_link` in the `agent_models` and `llm_usage` checks; `case_message_counts`, `case_facts`, `ticket_queue` (case columns appended), `customer_ticket_facts` + the three `insights_support_*` functions on `case_facts` (copied from 04/06), `chat.tickets.case_id`; trigger `tickets_open_case` (a ticket inserted without a case opens one). **Applied 2026-10-02**: 1015 tickets → 1003 cases, 12 `backfill` links (9 duplicates + 3 mutual pairs); then `npm run cases:targets` (agent/) | 04, 06, 17, 53 |
| `64_casework_usage_pass.sql` | widens `llm_usage_pass_check` by `casework` and `closure` (copied from 06), which the sink was recording as `other`. No data. **Applied 2026-10-03** — before the worker that emits them | 06 |
| `62_case_lead.sql` | `case_facts` re-stated, copied from 04: with nothing owed, a case's lead is its most recently active thread **still live**, not just the most recent. **Applied 2026-10-02** | 61 |
| `59_order_identity_situations.sql` | data only: rules whose `when_conditions.order_identity` names `none` also name its five replacements (`none` kept so old and new code agree). 16 rules. Applied 2026-10-02 | 05 |
| `65_inventory_stock_floor.sql` | drops 35's five-argument `insights_inventory_exceptions()` and recreates it with `p_max_stock_units`, so the stock card also lists every active product under the unit floor (`INVENTORY_MIN_STOCK_UNITS`, 50) whatever its cover. Copied from 06. No table, no data. **Applied 2026-10-04** | 01, 02, 06 |
| `73_automated_actor.sql` | `ticket_messages_actor_check` gains `automated` (an automatic reply; messages only, not `ticket_case_state` or `case_current`). Copied from 04. No data. **Applied 2026-10-05** | 04, 41 |
| `74_agent_models_casework.sql` | `agent_models_agent_check` gains `casework` and `closure`, so both can be chosen in Settings. Copied from 04. No data. **Applied 2026-10-05** | 53, 61 |
| `75_queue_closed_at.sql` | `ticket_queue` gains `resolved_at` and `closed_at`, appended last (the Closed section's order). Copied from 04. No data. **Applied 2026-10-05** | 61, 62 |
| `77_collection_range_axis.sql` | `advice_collections_axis_check` accepts `range` (a product line, « gamme »). Read by the storefront advisor only; `supportCollections` filters it out of the support intersection. No data. **Applied 2026-10-06** | 27 |
| `76_storefront_chat.sql` | `storefront_chat_sessions` + `storefront_chat_messages` and three service-role functions (daily count, turn, purge). New tables only. No data. **Applied 2026-10-05** | 01 |
| `72_refund_notice.sql` | `support_answers.notify_on` (`refund_recorded`; marks a notice template) + `ticket_drafts.purpose` (`reply` / `refund_notice`). Copied from 05 / 07. No data. **Applied 2026-10-05** | 05, 07 |
| `84_post_non_followers.sql` | `social_posts.non_followers_pct` + 0-100 check. No data. **Applied 2026-10-08** | 70 |
| `85_tiktok.sql` | TikTok provider/kind/band constraints, follower RPC widened; `social_refresh_token` rotates Vault bundle and expiry, service role only. **Applied and verified 2026-10-09** | 70, 82, 83, 84 |
| `87_tiktok_post_series.sql` | `insights_tiktok_post_series`: TikTok lifetime views/interactions of videos *published* in each bucket + follower-snapshot differences; service role only | 70, 85 |
| `88_manual_post_metrics.sql` | `social_post_manual_metrics` (shop/account/post/metric; rate carries its `basis`), unique key on `social_posts(shop_id,account_id,external_id)`, copies `non_followers_pct` across | 70, 84 |
| `89_manual_audience.sql` | `social_audience_manual` (latest dated distribution per shop/platform/dimension) + `valid_manual_audience()` | 70 |
| `90_non_followers_bands.sql` | `nonFollowersPct` added to the band metric check (no `followers` mode, absolute <= 100) | 83 |
| `83_social_metric_bands.sql` | `social_metric_bands` (`SOCIAL_BAND_T`). New table only. No data. **Applied 2026-10-08** | 01 |
| `82_engagement_basis.sql` | `social_accounts.engagement_basis` + check; `insights_social_post_totals` dropped and recreated with three more columns (same args and grants). No data. **Applied 2026-10-08** | 70, 81 |
| `81_social_post_tags.sql` | `social_posts.insights_at`; `social_post_tags` + `social_post_tag_links` (`SOCIAL_TAG_T`). New column and tables only. No data. **Applied 2026-10-08** | 70 |
| `71_ad_campaigns.sql` | `ad_campaigns` + `ad_campaign_days` (`CAMPAIGN_T`) and `insights_paid_campaigns()` (`CAMPAIGN_RPC`). No data. **Applied 2026-10-05** | 70 |
| `70_social.sql` | the six social tables (`SOCIAL_T`), the Vault token functions and six reads (`SOCIAL_RPC`), and `mail_jobs_kind_check` widened to `sync_social` (copied from 04 / 46). No data. **Applied 2026-10-05** | 01, 46 |
| `69_fact_drift.sql` | `tickets.fact_drift` jsonb (null until something moves; object check) + `outbound_actions.cancel_reason` comment gains `facts_pending`. Copied from 04 / 07. No data. **Applied 2026-10-04** | 04, 47 |
| `68_order_gift_stock_need.sql` | widens `support_exemplars.requirement_needs` by `order_gift_stock` (whether the order's gift lines are in stock now). Copied from 05; head of the needs check since. No data. Applied 2026-10-04 | 05, 67 |
| `67_sample_stock_need.sql` | widens `support_exemplars.requirement_needs` by `sample_stock` (whether the order's samples are in stock now). Copied from 05; head of the needs check until 68. No data. Applied 2026-10-04 | 05, 66 |
| `66_promotion_reward_stock_need.sql` | widens `support_exemplars.requirement_needs` by `promotion_reward_stock` (whether the free item is in stock now). Copied from 05; head of the needs check until 67. No data. Applied 2026-10-04 | 05, 58 |
| `58_promotion_outcome_need.sql` | widens `support_exemplars.requirement_needs` by `promotion_outcome` (why a promotion applied or not). Copied from 05; head of the needs check until 66. No data. Applied 2026-10-01 | 05, 56 |
| `57_describable_offers.sql` | adds `promotions.describable_in_replies` (default true), the automatic-offer counterpart of `offerable_in_replies`. Copied from 02. No data. Applied 2026-10-01 | 02 |
| `58_faq_articles.sql` | narrows `knowledge_documents_category_check`: `other` is no longer an article category (a ticket subject only); any article/chunk under it moves to `faq`. Copied from 03. None moved. Applied 2026-10-01 | 03 |
| `57_situation_choose_rule.sql` | `support_exemplars.choose_rule` (copied from 05): when to pick a situation and when not to, shown to the situation chooser. No data in the migration; the 40 rules were written from `Email-Example-Queries.md` after it. Applied 2026-10-02 | 05 |
| `56_policy_search_retired.sql` | Removes `policy_answer` from `support_exemplars.requirement_needs` (data: 20 situations) and from its check, adds `policy_attached`; narrows `knowledge_documents.core_topic` to `brand`. Copied from 03 and 05. Applied 2026-10-01 | 03, 05, 33 |
| `55_company_policies.sql` | `company_policies`, `company_policy_versions`, `company_policy_links` (copied from 05) + `ticket_investigations.company_policies`. No data (the library starts empty). Applied 2026-09-30 | 04, 05 |
| `54_ticket_snoozes.sql` | `ticket_snoozes` (copied from 04). No data. Applied 2026-09-30 | 04 |
| `53_agent_models.sql` | `agent_models` (copied from 04). No data. Applied 2026-09-30 | 01 |
| `52_manual_replies.sql` | `outbound_actions`: `draft_id` nullable, `client_key`, `body_html`; `manual` mode + `manual_reply` type + their shape check; the version key narrowed to `reply`, `client_key` unique. `ticket_drafts.approved_body_html`. Copied from 07. No data. Applied 2026-09-30 | 07, 47 |
| `47_outbound_actions.sql` | `outbound_actions` (copied from 07) and the new `ticket_drafts.status` comment. No data. Applied 2026-09-28 | 04, 07, 45 |
| `46_mail_jobs.sql` | `mail_jobs`, `enqueue_mail_job()`, `claim_mail_jobs()`, `mail_subscriptions` (copied from 04). No data. Applied 2026-09-28 | 01 |
| `45_draft_versions.sql` | `ticket_drafts`: `case_version`, `trigger_event_id`, `stale_reason`, `stale` status, key `(shop_id, ticket_id, case_version)` (the old key dropped by its columns). Copied from 07. No data. Applied 2026-09-28 | 07 |
| `44_rule_checks.sql` | `support_answers.checks` + its array check (copied from 05). No data. Applied 2026-09-27 | 05 |
| `43_case_actions.sql` | `ticket_case_actions` (copied from 04). No data. Applied 2026-09-27 | 04 |
| `42_case_state_every_message.sql` | `ticket_case_state`: nullable `case_relationship` + `actor`, `effect`, `asked`, `obligations_opened`, `obligations_cleared` with checks (copied from 04). No data. Applied 2026-09-27 | 04, 34 |
| `41_case_current.sql` | `ticket_messages.actor` + its check, and the `case_current` table (copied from 04). No data. Applied 2026-09-26 | 04 |
| `39_klaviyo.sql` | the three Klaviyo tables (`KLAVIYO_T`), the Vault key functions and `insights_klaviyo_messages()` (`KLAVIYO_RPC`). No data. Applied 2026-09-25 | 01 |
| `38_storefront_months.sql` | the `storefront_session_months` table (named in `STOREFRONT_T`, not `T`). Applied 2026-09-24 and backfilled (36 months) | 01 |
| `37_collection_handles.sql` | drops 36's seven-argument `insights_collection_sales()` and recreates it with `p_handles`, so the Collection mix card reports the six ranges rather than all 176 collections. Copied byte-for-byte from 06 (its test asserts it); supersedes 36. Applied 2026-09-23 | 01, 02, 06, 27, 36 |
| `36_collection_sales.sql` | adds `insights_collection_sales()`: per collection for a range, on `insights_product_sales` line rules, plus a null-id row for paid lines in no reported collection. Superseded by 37. Applied 2026-09-23 | 01, 02, 06, 27 |
| `35_sales_overview.sql` | adds `insights_sales_overview()`, `insights_promotions()` and `insights_inventory_exceptions()` for Overview, Marketing & funnel, the stock card and the monthly report, copied byte-for-byte from 06 (its test asserts it). No table, no data. Applied 2026-09-22 | 01, 02, 06 |
| `32_investigation_recommendations.sql` | adds `ticket_investigations.recommendations jsonb` — the shop's own product list, carried verbatim so the drafting stage reads what the tool said rather than a paraphrase of it. Idempotent, no data written. Applied 2026-09-20 | 04 |
| `23_agent_situations.sql` | adds `insights_agent_situations()`: tickets investigated in a range (latest run each) split by how the situation was picked — matched, tie settled by rules, near miss chosen by the model, chooser said none, not settled, no match, not recorded — from `ticket_investigations.exemplar_match`. Always one row. Copied byte-for-byte from 06. Applied 2026-09-15 | 04, 06 |
| `24_rule_tones.sql` | adds `support_answers.tones text[] not null default '{}'` and `support_answers_tones_check` (the keys of `scripts/lib/reply-tones.mjs`), with the column comment — all copied from 05, which its test asserts. Every existing rule takes `{}`. Applied 2026-09-15 | 05 |
| `29_order_promotion_need.sql` | widens `support_exemplars.requirement_needs` by one value, `order_promotion`, so a situation can declare "was the promotion applied to this order?". Copied from 05. No data. Applied 2026-09-17 | 05 |
| `28_order_discounts.sql` | adds `orders.discount_applications` (one entry per promotion: kind, name, percentage or amount, target) and `orders.discount_codes`. The order already stored how much came off; this stores WHAT came off, which is what answers « mon cadeau a-t-il été appliqué ? ». Copied from 02. No data — the values arrive with a re-sync. Applied 2026-09-17 | 02 |
| `27_advice_collections.sql` | adds `advice_collections`: one row per Shopify collection (175 on this shop), with `is_active` / `axis` / `note` owned by the team and `product_ids` refreshed from Shopify for active ones only. Copied byte-for-byte from 02. No data. Applied 2026-09-16 | 01, 02 |
| `26_product_order_frequency.sql` | adds `insights_product_orders_per_customer()`: for one product, how many of its buyers placed 1, 2, 3… orders carrying a paid line of it, on the same filters as `insights_product_customer_mix()`. Copied byte-for-byte from 06. No table, no data. Applied 2026-09-16 | 01, 02, 06, 12, 19 |
| `25_rule_links.sql` | adds `support_answers.link_url` / `link_label` (checks: https only; both or neither, label ≤ 120) with their comments, and `ticket_drafts.reply_link jsonb` (object check) — copied from 05 and 07, which its test asserts. All null. Applied 2026-09-15 | 05, 07 |
| `22_segment_finder.sql` | adds `customer_segment_find()`: customers matching OR-of-AND conditions over orders and net spend in the last N months and lifetime net spend, every customer on file except marketplace-synthetic records; always one totals row plus the top 25 by lifetime spend. Copied byte-for-byte from 06. Applied 2026-09-14 | 01, 02 |
| `21_chat_vip.sql` | VIP status for the management chat: `chat.vip_customer_rows()` (security definer, no arguments, fixed `search_path`) applies `vip_customers()` with the shop's thresholds and the marketplace handles `vipArgs` excludes; `chat.vip_customers` reads it (ids, windowed orders + net spend), `SELECT` for `mgmt_chat_ro` only. Updates the `chat.shop` comment. Applied 2026-09-14 | 06, 12, 17 |

`_shared.test.mjs` holds the cross-file invariants (no data statements, RLS on every table, every table and view documented, nothing referenced before it is created, every view `security_invoker` and revoked from the anon roles, every embedded table carrying the whole determinism quadruple, and `scripts/lib/tables.mjs` naming exactly what the baseline creates). Each file has a sibling test for its own contents.

`_live.test.mjs` is the only test that **runs** the SQL: it applies the baseline into a throwaway schema, seeds a handful of rows, asserts each projection returns what it claims, and drops the schema. Skipped unless `SUPABASE_TEST_DB_URL` (the dev project) is set, and refuses a value equal to `SUPABASE_DB_URL`, so `npm test` never builds schemas in the app database.

### Read-only reports

`scripts/report-*.mjs`. No writes, no model calls, every figure from a table the
pipeline already fills. Each exists because the question it answers was being
argued about rather than measured.

| Command | Answers |
| --- | --- |
| `report:knowledge-gaps` | what customers asked that the library could not answer — the commissioning list for new articles |
| `report:investigation-calls` | how much of an investigation the MODEL chose, against what the opening moves had already decided. An upper bound: `tool_calls` drops the ledger's `source`, so opening moves are reconstructed from `openingMoves()` and a decomposed ticket's extra moves count as the model's |
| `report:evidence-vocabulary` | whether `state` and `finding` agree with each other. They read the same ledger by different routes, so a disagreement means one is wrong — no labelled set needed. `--since` cuts the corpus to runs after a date, because a derivation fixed last week leaves its wrong rows behind for ever |
| `report:completeness-gate` | what a §7 completeness gate would downgrade, before one is enforced. Scores each stored run on `response_complete` / `decision_complete` / `mandatory_gaps` / `tool_errors_affecting_answer`, and splits the downgrades by whether the open gap could EVER be closed — `gapClosability` in `evidence-rules.mjs`. Measured 2026-09-03 over 91 fresh runs: 12 downgrades, of which **4 are on gaps nobody can ever close**. `--since` and `--subject` |
| `report:collection-planner` | what rule-directed collection would collect, per situation, before one is switched on. Replays `collection-planner.mjs` over stored runs. **A FLOOR, not an estimate**: `tool_calls` drops each tool’s `data`, so a chained call (`lookupPromotion` from an extracted code) reads as unassemblable even where a live run could make it. Measured 2026-09-03: **30 of 90** fresh runs would get a proposal. `--since`, `--situation` |
| `report:collection-replay` | what stopping collection early WOULD have cost, per situation, from `findings_trace`. Walks each traced run to the point both stopping conditions first held and counts calls saved, **established facts lost**, and `answerable` runs stopped with an open gap. State comes from `tool_calls`, findings from the trace — both are needed, and re-deriving findings from the ledger alone would flatter suppression. Measured 2026-09-03 over 47 traced runs: **13 calls saved, 7 facts lost**, so nothing is suppressed. `--situation` |
