# Database map

Every table and view by domain, the migration files, and the read-only reports. Part of the schema map; the index is `APP_SCHEMA.md`. Why things are this way: `DECISIONS.md`.


Every table has RLS on with no policies: **service-role access only**. Shopify stays source of truth; all syncs idempotent.

### Shopify snapshots

| Table | Holds |
| --- | --- |
| `shops` | shop records, environment, app settings, `sync_cursors` (incl. mail delta link), `storefront_url` (Shopify `primaryDomain.url` — where customers go, unlike `shop_domain` which is the *.myshopify.com identity webhooks key on; the base for `/account/login`), `customer_accounts_version` (`CLASSIC` — decides whether a password exists at all), `iana_timezone` (Shopify's `ianaTimezone` — where a day starts on the Insights charts; null until a sync runs the current `mapShop`), `sync_cursors` (mail keys `mail_ingest_delta_link` · `mail_ingest_resume_link` · `mail_sent_delta_link` · `mail_sent_resume_link` · `mail_ingest_cutover_at` (written once) · `mail_id_type` (`immutable` after `ids:translate`), all owned by `ingestion/delta-poller.mjs` `CURSOR_KEYS` — **never written by `mapShop`**), **order retention switch** `order_retention_mode` (`months`/`indefinite`) + `_months` + `_changed_at` + `_reason` — read by `scripts/lib/order-retention.mjs`, never written by `mapShop`; **the VIP rule** `vip_min_spend` + `vip_min_orders` + `vip_window_months` (all or none) + `vip_rule_changed_at` — set on the Customers panel, read by `scripts/lib/vip-rule.mjs`; **who its automatic mail comes from and goes to** — `report_sender` + `report_recipients` (the monthly sales report; recipients default to the management role) and `stock_alert_sender` + `stock_alert_recipients` (the stock alert; empty: off). Recipients are `[{role} | {email}]`. Set on Settings → Integrations, read by `scripts/lib/shop-mail-settings.mjs` and the worker, never written by `mapShop` (migrations 02 and 03, applied 2026-10-27) |
| `customers` | lean support snapshot: contact, marketing state, coarse location, lifetime totals, last order, `rfm_group`. No addresses or notes |
| `orders` | identity, links, channel, derived `order_status`, totals, line items, fulfillments, returns, refunds. Contacts hashed, plus `customer_email_masked` (`j***l@orange.fr`) for the one question a hash cannot answer; `tracking_numbers text[]` (GIN) lifted out of fulfillments so a ticket can be resolved from a parcel number; `advisor_conversation_id` (migration 07) from the cart attribute `_advisor_conversation` the storefront advisor's widget sets, the conversation that order is assisted by; destination coarse; `retention_rule` names only WHY the clock started, `retention_delete_after` carries the period and is **null when kept indefinitely** |
| `order_lines` | **one row per element of `orders.line_items`** (migration 96), derived by trigger (after insert; after update only when `line_items` changed; cascade on delete). Scalar columns are the exact text `->>` gave (`quantity`, `discounted_total`… cast where read); `line_index` is the JSON position. What the line-item analytics and `chat.order_lines` read; `line_items` stays the snapshot |
| `products` | snapshots + first-class metafields, `variants` jsonb, `available_stock` |
| `stock_alerts` | the stock alert's record (migration 03): one row per check that changed the set of out-of-stock / critical products, per shop. `status` `baseline` (recorded, nothing sent: the first check, or a product left the set) · `sent` · `failed`; `out_product_ids`, `critical_product_ids` (Shopify ids at the check), `new_product_ids` (what made it send), `recipients`, `error_summary`. The latest `baseline`/`sent` row is what « newly » is measured against. Written by `agent/src/reports/stock-alert-mail.mjs` |
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
| `company_policies` | **the company's policies** (migration 55): `policy_key` (fixed once created; the `getPolicy` tool's argument), `name`, `purpose` (the agent reads it to decide whether to fetch), `content` (plain text, may quote `{parameter}` placeholders), `active`, `storefront` (migration 99: the storefront chat may read and quote it; off by default, the support agent ignores it), `version` (raised on every change of text), `updated_by`. Not the rulebook: says what the company's rule is, never what happens in a case. Screen: **Agent Setup → Policies** (`PolicyLibrary`) |
| `company_policy_versions` | every version of every policy's text, append-only (`policy_id`, `version`, `content`, `saved_by`) |
| `company_policy_links` | a policy made available to a whole situation (`situation_key`) or one rule (`answer_id`, cascade), exactly one; unique per target. A reference, never a copy. Edited on the rulebook's « Linked policies » blocks |
| `support_answers` | the policy rules. Two axes: `situation_key` (what the customer wants, from the matched exemplar; null = any) and `when_conditions jsonb` = `{need: [findings]}` (what is true). A matched rule carries an `answer_skeleton`, and may `route` to `needs_human`/`needs_customer_input`, hand out **`offer_code`** (a live discount code, picked by an operator from the promotions cleared on `/agent-setup/promotions`; no FK because `promotions` is Shopify-synced, so it is re-checked at drafting time and dropped if it stops being ACTIVE + offerable), and name **`ask text[]`** (`MISSING_FIELDS` keys — a list since 2026-08-30, because a reaction with no product named needs the product *and* the batch number) — **never to `answerable`**, enforced by a check constraint, so a rule can only ever tighten. A rule may also pin **`knowledge_document_id`** — the approved article it answers from, chosen in the editor like a code and carried into the drafting prompt under its own heading, separate from what retrieval found. A real FK (`on delete set null`) unlike `offer_code`, because no sync rewrites these rows; approval is still re-checked at drafting and the article dropped if it is no longer approved. **`tones text[]`** (keys of `scripts/lib/reply-tones.mjs`, check-constrained, `{}` = Brand voice alone) reach the drafting prompt as `## Ton de cette réponse`; unioned across requests. **`link_url` + `link_label`** (https only, both or neither): the prompt gets only the label and asks for one `[[ici]]` marker; the address is copied to `ticket_drafts.reply_link` and put on the marked word wherever a draft is rendered (`TrackingText`, marker rules in `scripts/lib/reply-link.mjs`); checks `link_placed` / `no_orphan_link_marker`. **`checks jsonb`** (`[{owner, need}]`, migration 44): the checks the rule opens on a case, in order; copied onto `exemplar_match.policy.check_sequences` and walked by the fold (`casework/rule-checks.mjs`). One `is_fallback` per `answer_set`. Selected by `answer-selection.mjs` (situation outranks condition depth), which also derives the next need to collect. **119 approved rules, counted 2026-09-21 — 63 in `orders`, 20 in `products`, 8 each in `cosmetovigilance`, `returns` and `promotions`, 6 each in `accounts` and `payments`**, beside 11 drafts (5 `orders`, 5 `products`, 1 `promotions`) that no run can reach, loaded per ticket by `loadAnswers` (approved only) and selected after the tool loop closes. **Live: a matched route tightens the verdict in `buildCaseFile`, never loosens it**, and the selection is recorded on `ticket_investigations.exemplar_match.policy` with `verdict_before_policy` beside it. `answer_skeleton` travels into the drafting prompt as `## Ce que cette réponse doit faire` — read out of `exemplar_match.policy` **by name**, so the diagnostics beside it cannot reach a model. `notify_on` (`refund_recorded`): the rule is the template for the refund notice; its answer set is the notice's scope (migration 72). Set from the rule editor's « Tell the customer when a refund is recorded » box, shown only in a set whose rules read `refund_state` (returns); one rule at a time, locked on the others |
| `support_parameters` | the numbers the desk runs on — returns window, dispatch delays, free-shipping threshold — held once so a rule, an article and a skeleton cannot disagree (09). Read by code through `scripts/lib/parameters.mjs`; never retrieved as prose |

### Agent email workflow

| Table | Holds |
| --- | --- |
| `tickets` | one per Graph `conversationId` — a THREAD. **`ticket_number`** (not null, unique per shop: the running number shown as `T-<n>`, taken from `shop_ticket_counters` by the `assign_ticket_number()` insert trigger; existing rows numbered oldest first — migration 04). **`assigned_to`** + `assigned_at` + `assigned_by` (the dashboard user a ticket is with, auth ids as text; set only by a person, kept through close and reopen — migration 05). **`case_id`** (not null: the case above the thread, migration 61) + **`case_link_state`** (`pending` until the `link` pass decides, once; `decided` after). Taxonomy axes, `level`, `responsible_team`, `customer_id`, `shopify_order_number`, signals (`language`, `happiness`, `categorisation_confidence`), `resolved_context` jsonb, `duplicate_of_ticket_id` + `duplicate_reason` + `duplicate_detected_at` (**linked, never merged** — set by deterministic rules only; the drafting *and* investigation queues skip a linked ticket. **Since migration 61 a new duplicate joins its original's case instead**, and the existing links were folded into cases), `sender_label` (`internal`/`contractor` when one of OUR addresses opened the thread — stamped at creation from `sender_directory`, skips drafting, investigation still runs), `related_ticket_id` + `related_score` + `related_detected_at` (**no longer written since migration 61**: a similar message is a candidate for the `link` pass instead; the old rows stay, shown only on a thread with no case of several threads), lifecycle + retention timestamps, `overrides` jsonb (a person's corrections per field: `{value, ai_value, set_by, set_at, source}`; the column of an overridden field holds the person's value — migration 48), `fact_drift` jsonb (the change router's record of order states that moved under the latest case file: `{changed, outcome, reason, case_file_at, checked_at}`; hashed into the case version by the fold — migration 69) |
| `ticket_overrides` | **every correction and reset** made in « Edit case »: `field`, `action` (`set` / `cleared`), `value`, `ai_value`, `source`, `set_by` (user id), `set_at`. Append-only audit; the active values are `tickets.overrides` (migration 48) |
| `ticket_snoozes` | **a case hidden from the queue until something happens** (migration 54): `source` (`auto`: the fold, after a message of ours was sent / `manual`), `waiting_for` (customer / colleague / partner / date), `reason` (a person's note), `wake_at` (**never null**: the deadline), `trigger_message_id` + `case_version` (auto), `snoozed_by`, `woke_at` + `wake_reason` (a new message by actor, `deadline`, `manual`, `case_changed`, `resolved`, `order_update`) + `woken_by`. One open row per ticket (`woke_at` null); one automatic snooze per message of ours. Not a ticket status. Written only by `scripts/lib/snooze-record.mjs` |
| `ticket_notes` | **the team's notes on a ticket** (migration 04): `body` (1–5000 chars), `author_id` (dashboard user id) + `author_name` (their name when they wrote it), `created_at`, `deleted_at` (soft delete, by the writer only). Never sent, never read by the agent. Written only by `web/lib/server/ticket-notes-service.ts` |
| `ticket_assignments` | **every assignment and unassignment** of a ticket (migration 05): `assigned_to` (null: unassigned), `assigned_by`, `assigned_at`. Append-only; the current value is `tickets.assigned_to`. Written only by `assignTicket` in `tickets-service.ts` |
| `shop_ticket_counters` | the last `tickets.ticket_number` handed out per shop (migration 04). Written only by the `assign_ticket_number()` trigger; the row lock is what keeps two concurrent inserts from sharing a number |
| `case_current` | **the current state of each case**, one row per ticket, overwritten in place (migration 41). Folded in code by `casework/case-fold.mjs` from the messages (with their actor), the Case Manager readings and the latest case file: `pending_customer_inputs`, `commitments`, `contradictions`, `obligations` (each `{id, owner, need, quote, status, opened_at, cleared_by}`, stage 5; a rule step adds `rule`, `step`, `steps`, and `status: queued` until its turn), `last_actor`, `next_actor` (customer / support / colleague / partner / nobody), `resolved`, `version` (raised only when `material_hash` changes), `folded_at`. No model writes it. `next_actor` sets the ticket's status (5c, `casework/case-status.mjs`; the move is recorded in `tickets.metadata.case_status`). Shown on the ticket's **Case** block |
| `ticket_case_actions` | **a person settled an open check** from the ticket page: `obligation_id`, `action` (`fulfilled` / `cancelled`), `acted_by` (user id), `acted_at`. Append-only; the fold applies the latest per check (migration 43) |
| `cases` | **the customer's problem, above its threads** (migration 61). A ticket inserted without one gets one from the trigger `tickets_open_case`. Several tickets share a `case_id`; nothing is merged. `latest_actionable_inbound_message_id` + `reply_thread_id` (**the reply target**: the newest customer message no later outbound answers, on any thread — `case-reply-target.mjs`; plain uuids, not FKs; recomputed after the fold and on every link; `target_computed_at` null = never computed, which turns the case gates off), `case_key` (`requester hash \| order \| family`), `issue_family`. **No address stored.** Written only by `scripts/lib/case-record.mjs` |
| `case_links` | **every linking decision**, append-only, a new case included: `ticket_id`, `from_case_id` → `to_case_id`, `decision` (`link` / `new_case`), `method` (`first_contact`, `reply_chain`, `identical_body`, `tracking`, `order_family`, `unique_match`, `model`, `model_off`, `no_candidates`, `excluded_sender`, `backfill`), `candidates` (`[{case_id, reasons}]`), `model` + `model_answer` |
| `issue_family_members` · `issue_family_transitions` | **configuration**, per shop: subject or situation → family (DELIVERY, ORDER_CHANGE, REFUND_RETURN, PAYMENT, PROMOTION, PRODUCT, ACCOUNT, COSMETOVIGILANCE), and which family may continue as which (directed; a family is always compatible with itself). Seeded by migration 61; read by `case-link-rules.mjs` |
| `ticket_messages` | one per Graph message. **`internal_only`** (migration 06: outbound with every To/Cc address on our own domains — a forward to colleagues; set at ingestion by `graph-message-mapper.mjs`; skipped by the fold, `answeredSince`, `caseReplyTarget`, the pre-send « already answered » check, `after_first_reply` and the waiting-time views; false on rows from before 06). **`actor`** (customer / support / colleague / partner, migration 41; **`automated`** for an out-of-office, migration 73, marked in `raw_graph_payload.autoReply` by `ingestion/auto-reply.mjs` and skipped by the reopen, the wake, the fold and the reading queues) is stamped at arrival from the direction and the sender directory through `AGENT_ACTOR_BY_LABEL`, and moves with a re-filed direction. Envelope, cleaned `body_text`, sanitised payload, `embedding vector(1536)`, the RFC 5322 reply chain (`in_reply_to` + `reference_ids[]`, captured for deduplication — only those two headers are kept, the rest is `Received` chains carrying relay IPs), and `attachments jsonb` -- part METADATA only (name, contentType, size, isInline), never bytes. **NULL means never fetched**, `[]` means fetched and empty |
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
| `ticket_manual_forwards` | **a person forwarding a ticket's whole thread to colleagues from the dashboard** (migration 06): `recipients` jsonb (`[{email, name, kind}]`, internal only), `note`, `forwarded_by` + `forwarded_by_name`, `state` (`queued` → `draft_created` → `send_requested` → `sent` \| `held` \| `failed`), `source_message_id`, `provider_draft_id`, `internet_message_id` (matches the Sent Items copy), `attachments_sent`, `attachments_skipped`, `error`, `client_key` (unique per shop). Written only by `scripts/lib/manual-forward-record.mjs` |
| `mail_jobs` | **the durable queue** (migration 46): `sync_mailbox` (a change notification asking for a folder read) , `send_outbound` (the attempts of one outbound action) and `sync_social` (a Meta / Google Ads sync asked for by Connect or Sync now; migration 70). `state` queued/running/done/dead, `retry_count`, `last_error`, `last_attempt_at`, `next_attempt_at`, `locked_until` (lease). Unique `dedupe_key` among **queued** rows only. RPCs `enqueue_mail_job()` + `claim_mail_jobs()` (SKIP LOCKED; an expired lease is reclaimable and counts as an attempt). Case processing is not a kind. Owned by `scripts/lib/mail-job-record.mjs`. Trigger `mail_jobs_notify`: `pg_notify('mail_jobs', {shop_id, kind})` when a row becomes queued (insert, dedupe, failure back-off; not a claim), which the worker LISTENs for |
| `mail_subscriptions` | one Graph change-notification subscription per shop + provider + folder: `subscription_id`, `client_state_hash` (never the secret), `expires_at`, `needs_renewal`, `last_error`. Owned by `scripts/lib/mail-subscription-record.mjs` |
| `categorisation_review` | **testing artefact, not runtime**: hand-labelled sample scored against the agent |

### Projections

Views and functions for shapes that were being assembled client-side by reading
rows and discarding most of them. Joins and aggregates only — judgement stays in
tested JavaScript. Every view is `security_invoker`, or it would read past the
RLS on the tables under it.

| Object | Answers | Replaces |
| --- | --- | --- |
| `ticket_message_counts` | messages per ticket + inbound/outbound activity facts, soft-deleted excluded; since 06 `latest_outbound_at` ignores `internal_only` mail (so does `case_message_counts`) | a full read of `ticket_messages` to count in a Map |
| `ticket_first_inbound` | one row per ticket: its earliest inbound message, incl. `from_email` | a read of every inbound body in the shop, keeping one per ticket |
| `case_message_counts` | messages per case over every live thread (`thread_count`, `inbound_count`, latest inbound/outbound, `last_activity_at`) | — (61) |
| `case_facts` | **one row per case**: the earliest thread's subject, the highest level and worst mood, a folded status, the lead thread, first reply across threads (`reply_hours`). Read by the queue and the Insights support figures | counting tickets for support volume (61) |
| `ticket_queue` | the dashboard row: ticket + customer + count + `requester_email` (the address that opened the thread, so `sender_directory` can be asked whether it is a customer), soft-deleted excluded. Since 61 also the case: `case_id`, `is_case_lead`, `case_thread_count`, `case_message_count`, `case_inbound_count`, `case_waiting_since`, `case_level`, `case_status` (the queue shows lead rows and ranks them on these). Since 04 also `ticket_number` and `language`, and since 05 `assigned_to` and `assigned_at`, as its last columns | `TICKET_LIST_SELECT` + the count join, in `tickets-service.ts` |
| `dropped_mail_list` | the Irrelevant list: blocked `spam_audit` rows neither cleared (`dropped_mail_clears`) nor promoted (a `ticket_messages` row with the same `graph_message_id`), with `has_body` instead of the text |
| `dashboard_team()` | the people a ticket can be assigned or forwarded to (`email` since 06, read on the server only): every `auth.users` account with a dashboard role that is not banned, as id, display name (the address before @ when none is set) and role. SECURITY DEFINER, execute for `service_role` only (migration 05) | the Auth admin API, which needs the secret key the web app must never hold |
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
| role `qiriness_worker` | the worker's and the nightly's direct connection (`WORKER_DB_URL`, migration direct_worker_connection). `noinherit`, member of `service_role`, and logs in acting as it (role settings `role`, `search_path = public, extensions`): the service key's access, no more. 8 s statement and lock timeouts, 10 connections. Password: `scripts/set-worker-db-password.mjs` |
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
| `advisor_knowledge` | one row per `npm run advisor:load`, numbered (`version`), one `active` per shop: `products` (the knowledge spreadsheet's Products tab as the rules keep it, by handle) and `routines` (main concerns, the day and night steps, age ranges, moments, modules, concern map… assembled from its Routines and Rules tabs and `<brand>-routine-settings.json`), plus the load's `warnings`. With it, the storefront advisor runs the foundation engine (`advisor-knowledge.mjs`) |
| `advisory_events` | channel-aware advice analytics: `channel` (storefront_chat, email reserved), `conversation_ref` (session id; ticket id later), `event_type`, `playbook_key`, `product_ids`, `payload` (codes and counts only). No FK, like 76 |
| `advisory_events_purge` | service_role only: the events retention delete |
| `storefront_agent_turns` | **the storefront agent's analytics, one row per turn** (migration 07, named in `STOREFRONT_AGENT_T`): `conversation_id` (the chat session id, no FK: it outlives the 30-day chat purge), `user_message_id` (unique: one turn per question, live or backfilled), `status` (`answered`/`failed`) + `error_code` (`timeout`, `model_error`, `no_reply` from the backfill), `route` (`llm` / `rules` = the code answered with no model call / `mock`) + `rule` (the trace's `model_skipped`), `intent` (`routine_building` · `reordering` · `customer_service` · `faq` · `product_discovery` · `other`, a rule over the trace), `model`, `model_calls`, `model_ms`, tokens, `tool_calls`, `tool_failures`, `fallbacks` (`source_unavailable` · `forced_answer` · `lexicon_backup`), `unanswered` (a policy/FAQ lookup found nothing), `escalated` (sent to customer service), `product_ids` shown, `latency_ms`, `backfilled`. No words, no customer, no purge. Written by `turn-metrics.mjs` from the chat service; history by `npm run storefront:backfill-turns` |
| `storefront_agent_opens` | one row per opening of the chat panel (migration 07); `id` minted by the widget (a repeated beacon is one row), `conversation_id` when the browser already had one |
| `storefront_agent_dashboard(p_shops, p_from, p_to, p_tz, p_grain)` | the Storefront Agent dashboard over one window as one jsonb: conversations started in it, turns and opens in it, assisted orders placed in it (`orders.advisor_conversation_id`, net of refunds, cancelled out), series, top products, tokens by route/intent/model (priced by the dashboard). Named in `STOREFRONT_AGENT_RPC` |
| `advisor_routines` | one row per personalised routine the builder finished (migration 98): `id` (the routine number), `ref` (uuid, carried in the chat flow so « Ajouter au panier » sets `added_to_cart_at`), the answers as codes (`main_concern`, `primary_concern`, `secondary_concerns`, `skin_type`, `eye_concern`, `age_band`, `routine_time`, `answer_sources`), `product_handles`, `total_price`. Anonymous: no customer, no session, no words (`routine-record.mjs`) |

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

**One baseline, generated from production** (since 2026-10-13; why: `DECISIONS.md` → Migrations).

| Path | What |
| --- | --- |
| `supabase/migrations/00_baseline.sql` | the whole schema (`public` + `chat`): extensions, the chat role and its settings, text search, functions, tables, views, indexes, foreign keys, triggers, RLS, privileges, comments. **Generated** by `npm run db:generate:baseline`; never edited by hand. Builds a NEW database; production never runs it |
| `supabase/migrations/00_baseline.catalog.json` | the comparable description of that schema, generated with it. What a fresh build must equal, and what the schema tests read |
| `supabase/migrations/00_baseline.test.mjs` | the schema's invariants, read from the catalogue: every check constraint that mirrors an app constant equals it (taxonomy, actors, usage passes, outbound/snooze/case states, social and advisory vocabularies…); every `tables.mjs` name and `COLUMNS` projection exists; RLS everywhere; public views `security_invoker` and closed to anon; chat views readable by the chat role only; vector columns complete; `updated_at` triggers |
| `supabase/migrations/00_baseline.behaviour.test.mjs` | the projections asserted on seeded rows, on a fresh build (PGlite, in every `npm test`) |
| `supabase/migrations/NN_*.sql` | a change **not yet applied** to production (none at rest) |
| `supabase/migrations/archive/` | the old chain, 01_foundation … 96_order_lines: history and prose only, never run (8 of its files fail on a fresh database) |
| `supabase/seeds/` | data a new deployment needs: `issue_families.sql` (per shop, after its first sync), `carrier_aliases.sql` (once). Idempotent; `seeds.test.mjs` |

**Changing the schema:**
1. Write `supabase/migrations/01_<change>.sql` (next free number), idempotent. Prove it on production data first where it touches analytics: `node scripts/db-fingerprint.mjs out.json before.json --prelude 01_<change>.sql`.
2. `npm run db:check:baseline`: the pending file must apply on top of the baseline (PGlite).
3. `npm run db:apply:migration -- supabase/migrations/01_<change>.sql` (then runs the chat contract check).
4. `npm run db:generate:baseline`, then **move `01_<change>.sql` to `archive/`**: the regenerated baseline already contains it.
5. `npm run db:check:baseline -- --production` and `npm test`; commit the change, the baseline and the catalogue together.

**Building a new database:** run `00_baseline.sql` on an empty Supabase project (as `postgres`), set the chat role's password (`alter role mgmt_chat_ro password …`, for `CHAT_DB_URL`) and the worker role's (`node scripts/set-worker-db-password.mjs`, for `WORKER_DB_URL`), sync the shop, then the seeds.

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
