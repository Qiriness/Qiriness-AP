<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Data handling

### Personal data boundaries

- `orders` stores contact fields as hashes and `shipping_destination` coarse only (no street/postcode).
- `tickets` stores only `requester_email_hash` + `requester_name`.
- `resolved_context` holds PII but never billing or street address.
- `categorisation_review` reduces the sender to `from_domain`.
- `spam_audit` keeps sender, subject and (on a block) the body under its own expiry.
- The customer bundle's `toPromptText` **withholds the email by default** — the drafting step is replying *to* that address, so restating it in the prompt adds a personal identifier for no gain.
- `orders.customer_email_masked` holds `j***l@orange.fr` beside the hash — see below.

### A masked address, because a hash cannot be looked at

`orders` deliberately holds no raw contact address. But a hash answers exactly one question — *is it the same address?* — and the desk's actual question is the one `orders:resolve` keeps failing: **15 tickets quote a real order number from an address that does not own it**, and a person must decide whether that is a gift, a partner, or the same customer's second mailbox.

So the mask is derived **beside `hashIdentifier`, from the same input, on adjacent lines in the mapper** — the two can never describe different addresses. The local part is destroyed at map time and never stored, so it cannot be reversed or used to reach anyone.

**The domain is kept whole**, deliberately: *"same person, second address at the same provider"* is the mismatch question and the domain is what answers it. A provider domain is not personal data, which is the line this codebase already draws — `sender_directory` stores company domains as context for the same reason. Local parts of two characters or fewer collapse to `**` rather than being half-masked, since `b***o@x.fr` is longer than `bo@x.fr` and hides nothing.

**Never sent to a model.** It reaches `resolved_context.order.contactEmailMasked` for the panel, and `toOrderContextText` omits it: the agent never needs to know which address placed the order. A test asserts both halves.

It repaid itself immediately. All 15 mismatches became reviewable, and several point at `@example.com` — placeholder addresses on orders the desk or a retailer created, which no requester could ever match. That is a different cause from the one assumed, and it argues the check is not too strict for those: the data simply cannot satisfy it.

### `data_access_events` fails open

Sync paths write service events, and so does the agent's customer lookup — reading a customer to answer a ticket is access, whether a human or the worker did it. The write fails open because the data has already been read by then, so an audit outage must not also cost the answer.

**Future dashboard user views must write human access events here.** This is currently unsatisfied: the thread and dropped-mail dialogs render full email bodies with no audit event, because there is no dashboard user identity to attribute one to yet.

### Retention

`orders`: **a setting, not a constant** — `shops.order_retention_mode` is `months` (with `order_retention_months`) or `indefinite` (with none), read by `scripts/lib/order-retention.mjs`. **This shop is set to `indefinite`**, recorded in `order_retention_reason` with the date it changed. `retention_rule` names only WHY the clock started (`delivered`, `undelivered`, `return_refund_open`, `return_refund_completed`); the period arrives applied, as `retention_delete_after`, and a **null there means kept indefinitely** — the purge selects `lte now`, so a null is never matched and needs no special case. The order sync skips the purge entirely while the mode is indefinite, so a row stamped under an older policy is not deleted before a backfill catches up.

The duration used to live in the rule name (`delivered_plus_3_months`), enumerated in a check constraint and compared literally in `deriveOrderStatus`. That is what made the period unswitchable: every new window multiplied the enum and needed a branch in code that only ever cared why. It is also how the live constraint drifted — a 3→6 month change was applied to the database by hand and never written down here, leaving the mapper emitting a value the constraint would refuse. Migration 10 reconciles both vocabularies.

The fetch window is **derived** from retention (`orderSyncMonths` = period + 1 month margin, unbounded when indefinite) rather than set beside it. They were two independent constants, and a fetch window shorter than retention is a table that can never fill — the setting would look broken rather than misconfigured.

Reading the setting **fails safe, not open**: an unreadable or unknown value resolves to 6 months, never to indefinite. This is the opposite of `parameters.mjs`, where a null makes a reply decline to quote a number. A typo that silently became permanent retention of personal data is the one outcome nobody would notice. For the same reason the switch is not a `support_parameters` row: there null means "not decided yet", and indefinite retention must not be reachable by leaving a field blank.

**Raising retention is not retroactive.** The purge hard-deletes, so anything already removed is gone locally and only a backfill restores it, and only while Shopify still holds it. Lowering it deletes on the next sync. `tickets` mirrors it (`resolved_at`/`closed_at`/`archived_at`/`retention_delete_after`); `deleted_at` is the separate compliance soft-delete. `categorisation_review`: 3-month default. `spam_audit.body_text`: 90 days from capture, purged per poll.

### Supabase REST client

Every request sends `cache: 'no-store'` — Next's Data Cache otherwise pins the first response for a year, which made saved changes appear to vanish on reload. `export const dynamic = "force-dynamic"` does not prevent this; only the explicit fetch option does. The option is inert outside Next, so the sync scripts and agent worker are unaffected.

New Supabase API keys (`sb_publishable_*` / `sb_secret_*`) are sent as `apikey`
only, not as `Authorization: Bearer ...`. They are not JWTs; the hosted API
Gateway verifies the `apikey` and mints the database token itself. Sending
`Bearer sb_secret_*` returns 401 even though the same key is valid, which is why
`supabaseHeaders()` adds the Bearer header only for legacy JWT-shaped keys.

`supabaseSelectAll` pages past PostgREST's silent 1000-row cap.

### The schema is named once, in `scripts/lib/tables.mjs`

It was quoted as string literals in 65 files across all three packages — 217 table names, plus a column list at almost every call site. Nothing checked them: PostgREST answers a request for a column that does not exist with a runtime error, on the one code path that asked, whenever that path next runs. A rename was a codebase-wide sweep with no compiler and no test behind it.

`tables.mjs` holds two things and no more: every table, view and RPC the baseline creates, and the projections that are asked for in **more than one place**. A projection used once stays at its call site next to the comment explaining it — this is not an index of every select in the codebase, it is the set of names that would otherwise drift.

`_shared.test.mjs` asserts both halves against the `.sql` files, in both directions: every name in the module is created by the baseline, every relation the baseline creates is named by the module, and every column in a projection exists on the relation it projects.

### `tickets` has exactly one writer

Eight modules held a private store over the same row — ingestion, categorisation, investigation, three resolution passes, auto-close, and the dashboard — each naming its own columns and building its own patch, and the investigation's backfill wrote past its own store with a raw `supabaseUpdate`. `scripts/lib/ticket-record.mjs` is now the only writer. It lives in `scripts/lib` because `web/` cannot import from `agent/src`, and the dashboard's status write touches the same three lifecycle columns auto-close does; leaving it out would have kept two owners of exactly the columns the module exists to own.

It owns the `needs_*` flags, the `deleted_at`/`archived_at` filters, the lifecycle timestamps, the `metadata.<pass>` trail, and the shop scope — bound once at construction rather than remembered at 60 call sites. It does **not** own `ticket_messages` writes (ingestion's upsert), `ticket_investigations` (the case file's own contract), or policy: `shouldAutoClose`, the level ratchet and the verdict mapping stay where they are and hand it columns.

### The two flagged passes share one protocol, and the descriptors are the difference

Categorisation and investigation run the identical cycle — claim a batch, then complete / skip / retry / abandon each ticket — so it is written once and parameterised by a descriptor naming the flag, the flag it raises, the stamp, the metadata trail, the projection and the extra selection.

This is what put the crash-safety rule in one place instead of five comments: **`complete` clears this pass's flag and raises the next one in the same patch as the result**, so a failure anywhere before it leaves the ticket in the queue rather than marked done with nothing behind it. `skip` clears the flag and writes nothing else. `retry` touches no flag. `abandon` clears the flag and never raises the next — investigating a guess would spend tool and model calls on a subject nobody chose. `attemptsSoFar` and the trail merge existed twice, character for character, before this.

---

### What nothing reads is not kept (2026-10-06)

The database stood at **314 MB of the free plan's 500**. `79_unread_data.sql`, then a `VACUUM FULL` of customers, orders and `data_access_events`, took it to **151 MB**. Every item removed was stored or indexed and never read:

- **`raw_shopify_payload` on customers (39 MB) and orders (12 MB).** No code read either, and every field is a typed column. The mappers write `{}` (the column's object check refuses null). The column stays, so an ad-hoc reader that names it does not break.
- **Eight indexes with zero scans since statistics began (2026-08-07), 41 MB.**
  - The two HNSW vector indexes: `ticket_messages` and `support_exemplar_phrasings`. **The vectors are kept** (decided by the user). The exemplar search scans 927 rows directly, as the planner already chose to, and the index is rebuilt in the migration that ships retrieval.
  - GIN on `orders.line_items` and `orders.fulfillments`, `products.structured_facts`, `promotions.rule_snapshot`, `shopify_metaobjects.fields`.
  - Btree on `customers.amount_spent`.
  - **Kept:** GIN on `tracking_numbers`, which order resolution's `ov` uses.
- **The nightly syncs logged one `data_access_events` row per page of 50**: 47,134 customer rows, 14 MB, and about 1,240 more a night. Each said the same thing: « the nightly sync read customers ».
  - The access is the run, so a sync now writes one row (`createSyncAccessLog`, `*_sync_run`) with its page and record counts, from a `finally`, so a run that fails part way is still logged.
  - The history was collapsed the same way, in one statement: 53,807 page rows became 91 run rows with every page and record count kept.
- **A leftover `tmp_baseline_*` schema (2.4 MB)** from a `_live.test.mjs` run that died before its cleanup.

**One side effect.** Rewriting the payloads moved `updated_at` on every customer and order once. Insights' « customers synced » read as the migration time until the next nightly sync.

**Not done: the nightly customer sync still rewrites all 62k rows.** Postgres keeps the old copies until autovacuum reuses their space, so `customers` (33 MB after the `VACUUM FULL`) will settle back towards twice its live size. Skipping unchanged rows needs a stored hash per customer and a nightly read of the hashes, and `insights_freshness` reads « customers synced » from `max(updated_at)`. Worth it if the table grows, not at today's size.
