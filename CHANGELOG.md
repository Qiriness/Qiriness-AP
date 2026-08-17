# CHANGELOG

**What has been built, and how far each piece has actually been proven.** Append-only; entries are not deleted as things move on.

Three sibling files carry the other halves, and this one deliberately does not duplicate them:

- **`DECISIONS.md`** — *why* each thing is shaped the way it is. The measurements quoted below are the evidence; the rule they produced lives there.
- **`VALIDATION_LOG.md`** — what is built but **not yet proven against real data**, with the check to run for each. Items are closed only once someone has run the check.
- **`README.md`** — what the project is, how to run it, and what is next.

---

## Contact rate per carrier (2026-08-16)

- **The carrier table has a `Contacted support` column.** Per carrier: how many
  of its shipments produced at least one ticket, as a count and a share, with
  the raw thread count beside it when the two differ.
- **Counted per order, not per thread.** One parcel chased four times is one
  unhappy delivery; threads-over-shipments would have put `AUTRE` (6 shipments,
  4 threads) past 100%. `fulfilment_by_carrier` gained `orders_with_ticket` and
  `tickets`, joined through `tickets.shopify_order_number` — the only confirmed
  link between a thread and a parcel.
- **The rate ships with its denominator.** New `fulfilment_ticket_coverage` view
  (one row per shop) reports that **52 of 214 tickets carry a resolved order
  number**, and the panel states it under the table. Every figure in the column
  is a lower bound; a `1.2%` cell with nothing beside it would be the exact
  plausible-but-wrong number these views exist to prevent. It is a view rather
  than copy so the caveat shrinks by itself when the resolver next runs.
- **What it shows.** **GLS is contacted about 4.1× as often as Colissimo** —
  5.1% of its 198 shipments against 1.2% of Colissimo's 1,311 — despite a
  slightly *faster* median dispatch (23.3h vs 24.5h) and a lower past-3-days
  rate (13.1% vs 16.1%). The under-counting hits both carriers alike, so the
  ordering survives the caveat even though the absolute rates do not. The note
  ranks only carriers with 100+ shipments, since a 6-shipment carrier tops any
  ratio.
- **Validated:** views applied forward to the dev database in one transaction
  and read back through PostgREST; carrier shipment counts unchanged at
  1,311 / 198 / 6 after the ticket join was added (the lateral does not multiply
  rows); `/insights/fulfilment` rendered the column and the note; `web`
  typecheck, lint and build passed; root `npm test` passed (**1271 pass**).

---

## Fulfilment per sales channel — Amazon (2026-08-16)

- **The Fulfilment panel now measures Amazon on its own, directly below the
  store-wide figures.** Same tiles, same six bucket boundaries, same 72-hour
  line, same monthly trend — reused from one `FulfilmentBreakdown` component
  rather than copied, so the two blocks cannot drift into measuring subtly
  different things.
- **Three additive views** (`fulfilment_summary_by_channel`,
  `fulfilment_by_channel_month`, `fulfilment_by_channel_bucket`) cut the
  existing three by `orders.sales_channel_handle`, which
  `order_fulfilment_timing` now carries alongside the display label. The
  store-wide views keep their one-row-per-shop shape untouched. The views group
  by every channel and filter to none; `fulfilment-service.ts` names `amazon` in
  a constant, so a second channel costs a constant and no migration.
- **What it shows.** Amazon is 467 of 2,006 orders (23.3%), median 23.0h against
  the store's 23.8h, p90 69.1h against 78.1h, and 8.4% past three days against
  13.8% — marginally *better* than the book as a whole, which was not the
  expected answer. July 2026 is its outlier at 31.7% past three days and a p90 of
  137h, the same month the store-wide trend degrades.
- **The finding worth acting on is not speed.** 402 of 467 Amazon orders (86%)
  carry no tracking number, against 4 of 1,487 on the online store. The panel
  states this as a marketplace data gap and `VALIDATION_LOG.md` item 12 carries
  the check that would confirm it — it is inferred, not verified.
- **Validated:** views applied forward to the dev database in one transaction
  and read back through PostgREST; channel counts sum to the whole book
  (1500 + 467 + 36 + 3 = 2006) and the Amazon histogram sums to its measured
  467; `/insights/fulfilment` rendered 200 with both figures populated; `web`
  typecheck, lint and build passed; root `npm test` passed (**1271 pass**).

---

## Supabase new-key REST auth fix (2026-08-16)

- **Fixed server-side Supabase REST requests for `sb_secret_*` keys.** The shared
  REST client now sends new Supabase API keys as `apikey` only, and keeps
  `Authorization: Bearer ...` only for legacy JWT-shaped keys.
- **Updated the Support topic-map corpus count** to use the same header helper,
  so the direct `HEAD` request cannot drift from the rest of the client.
- **Validated:** direct Supabase REST probe with server user-agent returned 200;
  fresh network-enabled dev server on port 3002 rendered `/insights/support`
  without the Supabase panel error; browser check found `Message volume by
  cluster`, one cluster table, and 46 topic-map tiles; focused REST-client test
  passed; `web` typecheck, lint and build passed; root `npm.cmd test` passed
  (**1271 pass**).

---

## Topic map cluster tiles (2026-08-16)

- **The Support heatmap now renders actual clusters, not category buckets.** Each
  tile is one persisted `ticket_clusters` row; category remains visible only as
  context and as the source of the existing subject-level happiness colour.
- **Cluster labels are less query-shaped.** `clusterLabel()` now strips common
  greeting/query frames and order-number fragments from the representative
  excerpt before truncating, so tiles start closer to the recurring issue.
- **Validated:** `npm.cmd run typecheck`, `npm.cmd run lint`, and
  `npm.cmd run build` in `web/`; root `npm.cmd test` (**1269 pass**).

---

## Insights dashboards, token accounting and a persisted topic map (2026-08-16)

Four analytics panels behind `/insights`, plus the two things that had to start being recorded before they could be read. Rationale in `DECISIONS.md § Insights`.

### The measurement that shaped it

Read from the live database before any code was written. **Fulfilment timing was already fully computable and had never been looked at**: `processed_at` → first `fulfillments[].created_at` is populated on 1,993 of 2,006 orders, giving a median of 23.8h, a p90 of 78h, and 276 orders (13.8%) past three days. Broken down by month it shows **July 2026 at 30.7% past three days with a p90 of 149h**, against 4–14% and ~70h in every other month — the worst fulfilment month on record, and also the heaviest support month (85 new threads). Nobody had seen it.

Delivery timing, by contrast, is genuinely unavailable: `delivered_at` is set on **1 order in 2,006** and `in_transit_at` on none, because no carrier feeds scan events back to Shopify here. Treating those two durations as one blocked lump is what had kept the measurable half unbuilt.

### `06_analytics.sql`

Three tables and **fifteen views**, all `security_invoker` and revoked from the anon roles like the rest.

- **`llm_usage`** — one row per model call. Nothing recorded what the agent spent; OpenAI returns `usage` on every response and `completeWithTools` already handed it to a caller that ignored it, while `completeJson` discarded it before the caller could see it.
- **`cluster_runs`** + **`ticket_clusters`** — the topic map, which previously printed to a terminal and persisted nothing.
- **`normalise_carrier()`** — the live table holds `COLISSIMO`, `Colissimo` and `LA POSTE COLISSIMO`; a raw breakdown reports three carriers.
- Applied forward to the dev database and **each view checked against an independent JavaScript computation of the same figure** over the same rows. All fifteen agree.

### Token accounting

- Captured at the **transport** — one `usageSink.record` in `request()` covers every call from every pass. The sink defaults to a frozen no-op, so every existing caller is unchanged.
- **Retries within one call are not separate rows** (a retried 429 was never billed) but a call that exhausts its retries **is** one, because the last attempt may have been served and charged.
- The store is best-effort and swallows its own failure: a poll that categorised twenty tickets and then failed to write cost rows has still categorised twenty tickets.
- **Tokens are stored; money is applied at read time** from `scripts/lib/llm-rates.mjs`, overridable with `LLM_RATES`. `estimateCost` returns `rated: false` rather than 0 for an unpriced model. **The default prices are list prices recorded so the panel has a number, and are explicitly not authoritative.**
- Wired into the spam gate, categoriser, decomposer, investigation and all three `embed:*` reconcilers.
- **Nothing can be backfilled** — usage exists only on the response — which is why this shipped before the panel that reads it.

### Topic map persistence

`cluster:tickets` stays print-only; **`cluster:tickets:save`** persists a run. A rebuild is a deliberate act — the 0.68 threshold is hand-tuned and corpus-specific — so the map records its own age rather than refreshing behind the reader. Runs are pruned to the last 10, an orphaned run row is deleted if its clusters fail to insert, and a zero-topic run is still written because "nothing repeated above the threshold" is a real result.

### Verified

- Root `npm test`: **1269 pass**. `agent/` `npm test`: **732 pass**. Includes 37 new tests over the sink, the store and the rate table, and 26 over the cluster store.
- All 15 schema invariants in `_shared.test.mjs` pass with the sixth baseline file.
- Every column the two new stores write confirmed to exist against the live schema.
- `cluster:tickets:save` run once for real: 248 messages, 13 subjects, 46 topics persisted.

### Support route completion

- **`/insights/support` is now routed.** The support service and view existed, but the App Router page was missing, so the Support tab could link to a 404 and the substantial `SupportView`/`TopicMap` code was outside the compiled route graph.
- **Added the missing CSS module** for the support panel's figures and wide tables, matching the restrained Insights table/figure vocabulary and keeping horizontal overflow inside the panel.
- **Finished the panel polish pass:** the Insights tab order now matches the `/insights` landing route, unmeasured fulfilment months render as missing rather than zero, uncategorised mail cannot become the "sore subject" callout, and a saved zero-topic map gets an explicit measured-empty state.
- **Removed side-stripe note/banner styling** from the Insights kit and topic-map provenance banner; state is now carried by full borders, tint and text colour instead.
- **Validated:** `npm.cmd run typecheck`, `npm.cmd run lint`, `npm run build` in `web/`, the local design detector over Insights, HTTP 200 checks for all four panel routes, and root `npm test` (**1269 pass**).

---

## Backlog auto-close window (2026-08-15)

- **Auto-close now waits 28 idle days instead of 21.** That gives tickets at least two weeks in the Backlog before automatic closure, while still using `last_message_at` so a new customer reply or desk reply keeps the thread open.
- **Updated lifecycle docs and tests** for the 4-week boundary.
- **Validated:** `node --test .\agent\src\lifecycle\auto-close.test.mjs` and root `npm.cmd test`.

---

## Tickets backlog section (2026-08-15)

- **Added a Backlog section** between Irrelevant and Closed. It uses the same `TicketTable` format and close action as Queue, and derives membership client-side from open tickets waiting 14 days or more (`waiting_since`, falling back to `first_message_at`).
- **Open-ticket filters now cover Queue + Backlog together.** Level tabs, search, category and sort apply once to open tickets, then the result is split into the two sections.
- **Validated:** `npm.cmd run typecheck` and `npm run build` in `web/`.

---

## Queue priority scorer module (2026-08-15)

- **Priority scoring is now a tested pure function**, not a stored column: `scripts/lib/ticket-priority.mjs` scores level, customer wait, inbound contacts, `awaiting_human`, and VIP at read time.
- **Wired into the Tickets UI:** `ticket_queue` now supplies `inbound_count` and `waiting_since`, the server maps `priorityScore` and `priorityBand`, and the table shows a Priority column before mood/subject.
- **Priority owns row borders:** high/medium/low rows get restrained red/orange/green outlines. The VIP gold row border is gone; VIP remains a crown beside the requester name.
- **Weights tuned:** level 1/2/3 are `10 / 18 / 25`, level 4 stays a hard `1000` band, and customer wait is the strongest ordinary factor at `35`, logarithmic and capped at 14 days.
- **Applied to the dev database forward** with the same `CREATE OR REPLACE VIEW` definitions now in the baseline; verified `ticket_queue` exposes `inbound_count` and `waiting_since`.
- **Tests:** 22 focused root tests cover the hard level-4 band, the new wait-over-level behavior, the wait curve, priority bands, uncategorised fallback, explanation parts, and stable sorting.

---

## VIP is a gold ticket (2026-08-15)

- **The whole row, not a chip.** A VIP was a teal pill under the requester's name; it is now a gold rule on all four edges of the row, with a crown beside the name. Eight rows are visible at a time and a chip in the fourth column is missed — knowing you are about to open a champion's ticket is worth seeing from the row.
- **This reverses a recorded call, and the reasoning it reversed was sound**: teal is the app's one accent, and a VIP is a fact about the customer rather than a warning about the ticket.
- **Filled first, then pulled back to a border.** The first version washed the row gold as well and put the crown in its top-right corner. **75 of 214 tickets are VIP (35%)** — a third of the queue tinted is more of the screen than the fact deserves, and it is exactly the competition with level and mood the old rule warned about. The border carries it; the crown reads as the person's rather than the ticket's next to the name.
- **The rules are inset box-shadows, not borders, and that is load-bearing.** Drawn as borders, a VIP row measured 68px against its neighbours' 67 and its mood face sat 2px right — a visible limp down a column of 214 rows. Shadows paint in the same place and take no space. The bottom edge stays a real border, since every row already has one and a border paints over an inset shadow.
- **Gold is its own token pair** (`--gold-strong`, `--gold-100`), not `--warning` — that ramp is orange and owns "something is wrong". Two steps, not the usual three: dropping the fill orphaned the wash and the text-on-tint colour, and they went with it rather than sitting unused.
- **The crown is the set's only filled icon.** At the 14px it renders, a 1.6px outline turns to mush; it has to read as a crown at a glance or it is a gold smudge. The requester cell is a flex row so the NAME truncates and the crown never does — the one thing worth spotting must not be what a long name pushes out — and the name is `flex: 0 1 auto`, since letting it grow shoves the crown to the far side of the cell where it reads as its own column.
- **The pictogram announces nothing on its own**, so it is `aria-hidden` with visually-hidden "VIP customer" beside it — it replaced a chip that literally read "VIP", and the RFM segment is still on the `title`.
- **Verified in the browser, not just typechecked:** collapsed and expanded, with the gold carried around the detail panel (which paints its own background and teal rule over the cell, so the panel root is overridden); row heights and the mood-face position confirmed identical to ordinary rows.

---

## The database layer gets owners (2026-08-15)

Four refactors, chosen from an architecture review of everything that touches Supabase. No behaviour was intended to change; the tests that encode the behaviour were kept and extended.

- **`tickets` had eight writers and no owner.** Ingestion, categorisation, investigation, three resolution passes, auto-close and the dashboard each held a private store over the same row, each naming its own columns and building its own patch — and the investigation's backfill wrote past its own store with a raw `supabaseUpdate`. **`scripts/lib/ticket-record.mjs` is now the only writer**, in `scripts/lib` because `web/` cannot import `agent/src` and the dashboard's status write touches the same three lifecycle columns auto-close does.
- **The two flagged passes turned out to be one protocol.** Categorisation and investigation run the identical cycle, so it is written once — `claim / complete / skip / retry / abandon` over a descriptor naming the flag, the flag it raises, the stamp and the metadata trail. **9 raw column patches, 3 copies of the queue predicate, 2 copies of `mergeMetadata` and 2 of `attemptsSoFar` became 5 methods and 2 descriptors.** The crash-safety rule ("clear the flag LAST, in the same patch as the result") was a comment repeated beside each site and is now a thing the code does once, with a test.
- **Four projections moved into SQL.** `ticket_message_counts`, `ticket_first_inbound`, `ticket_queue` and `order_number_range()`. The queue was counting messages by reading **every message id in the shop**; order resolution was reading **every inbound body in the shop** to keep one per ticket and discarding the rest; the order-number range was two round trips. Joins and aggregates only — `shouldAutoClose`, the level ratchet and the evidence rules did not move, and `ticket_queue` deliberately omits VIP because that is derived at read time.
- **Every view is `security_invoker`, and that is the load-bearing part.** A view created without it runs as its owner and reads straight past RLS — and every table here has RLS on with no policies precisely so only the service role can read. An owner-rights view over `tickets` would have been the one way an anon key could read the whole support mailbox. Asserted on every view, along with the revokes.
- **The baseline is now applied by a test rather than only read by one.** Every other assertion in `supabase/migrations/` is a regex over the `.sql` text, which cannot tell whether a join is right. `_live.test.mjs` applies all five files into a throwaway schema, seeds the smallest population that distinguishes each projection, asserts the output and drops the schema. Skipped without `SUPABASE_DB_URL`, so `npm test` still needs no database. It makes permanent the catalogue check that proved the 8→4 split, which had been run once from a terminal.
- **Three embedding reconcilers became one loop and three descriptors.** ~490 lines of copied loop around a 133-line tested gate. The copy had already drifted: **the knowledge and exemplar orphan sweeps used a plain `supabaseSelect`**, which PostgREST caps at 1000 rows with a 206 and no error — past a thousand embedded rows they stopped seeing orphans. The message reconciler had been fixed for this; now all three page. The three `embed:*` commands and their reports are unchanged.
- **The schema is named once.** 217 table-name literals across 65 files and three packages, with no compiler and no test behind a rename. `scripts/lib/tables.mjs` holds the 24 tables, 3 views, 4 RPCs and the projections asked for in more than one place; `_shared.test.mjs` asserts it against the DDL **in both directions**, so a table the baseline creates and the module does not name also fails.
- **Two live defects found on the way, both fixed.** The raw write past the investigation store, and `ticket_messages` having copied the embedding determinism quadruple from `knowledge_chunks` without its `embedding_dimensions = 1536` check. The constraint is now inline in the baseline, and `_shared.test.mjs` asserts the **clause** — not merely the constraint's presence — on every table holding a vector, so a fourth embedded table cannot permit something else.
- **Applied to the dev database forward, not by rebuilding.** The baseline is a definition and re-applying it means an empty database, which would have cost the 214 ingested tickets every measurement here was taken against. The three views, `order_number_range()` and the check were applied in one transaction, with the SQL **extracted from the baseline files rather than retyped**, and the script discarded afterwards — a forward step checked in beside the baseline is how a baseline turns back into a history. Verified after: all four objects present, `security_invoker` on every view, no `anon`/`authenticated` privileges, 0 rows violating the new check, row counts unchanged (214 / 451 / 2014 / 58 201), `ticket_message_counts` summing to the live message count exactly (451), `ticket_first_inbound` at one row per ticket with inbound mail (203), the queue readable **through PostgREST** at 214 rows with 141 customers linked, and `orders:resolve:dry-run` running end to end (159 considered, 6 confirmed).
- **One behaviour change worth naming:** `order_number_range()` excludes soft-deleted orders, which the asc/desc pair it replaces did not. No effect today — the store holds 0 soft-deleted orders — so it is a guard for when retention starts deleting, not a correction. The range now reads `#4771`–`#6790` against the `#4716`–`#6770` recorded on 2026-08-11; that is four days of store drift, not this change.
- **Tests:** +109 (1161 root, 691 agent), including the first executed-SQL test and the first tests the embedding reconcile loop has ever had.

---

## Two agent judgements corrected (2026-08-14)

- **Level 4 narrowed to two triggers**, on the merchant's definition: an explicit **legal** threat (court, complaint, lawyer, formal notice), or **grave harm to the person** (hospitalisation, or a life-threatening condition). **A threat to go to the press or post on social media no longer qualifies** — it is neither a legal exposure nor an injury, it is a very unhappy customer, which `happiness` already measures on its own axis. Conflating them put reputational annoyance in the same queue as hospitalisation. Costs nothing retroactively: no ticket in the corpus has ever been labelled 4.
- **`VALIDATION_LOG` 6c was filed with the wrong root cause, and reading the email corrected it.** The entry blamed `CODE_PATTERN` for matching a capitalised product name. The source message contains **no all-caps run of four characters anywhere** — the customer wrote « votre Masque LED visage » in ordinary case, and extraction correctly found nothing. **The model composed the argument**, calling `lookupPromotion({ code: 'MASQUELEDVISAGE' })` itself. Tightening the regex would have fixed nothing.
- **The fix is a guardrail on the argument, not the parser.** When a code is not found in the shop AND does not appear as a word the customer typed, `lookupPromotion` reports `no_code_in_message` instead of `not_found` — so a fabricated argument settles no finding at all. Only the `not_found` branch is reinterpreted: a real code resolves however it was punctuated, and a genuine typo the customer typed still gets suggestions.
- **Reading the whole email corrected a second guess.** 6c also called the routing suspect — a *product* ticket split into a `promotions` task. It was not a mis-split: the customer's last paragraph asks « avez-vous une offre ou une remise en cours sur ce masque, ou un code promotionnel ? ». Binding the promotion tools was right, and **`listActivePromotions` answered it well**, establishing `UKLED20` — 20 % off that exact mask. The fault is one spurious extra call, not a misrouted ticket, and nothing a customer would see changed.
- **The first version of that guard was wrong and its own test caught it.** Flattening both sides and asking whether the message contained the code passes `MASQUELEDVISAGE` against « Masque LED visage » — with the spaces gone, that *is* the string, and any multi-word product name collapses into exactly the code a model would invent from it. Comparing **token by token** keeps `qiriness-20` matching `QIRINESS20` while a three-word name matches nothing.
- **Tests:** +8 (1052 root, 689 agent).

## The queue learns to wait, and every family gets facts a human can read (2026-08-14)

- **A single tool result was 259,874 characters, and it failed an investigation outright.** `listActivePromotions` answered per REDEEM CODE rather than per offer: this shop's 25 active offers carry **3,619 codes**, and one 284-character promotions email produced a 68,771-token request against a 30,000 TPM ceiling. Found by instrumenting `fetch` and tracing the request bodies, after a spend measurement turned up a 1-in-5 failure rate.
- **It was not only cost — 3,614 of those were single-use codes belonging to other customers**, handed to the model in one blob, one turn from a drafted reply. The size was hiding the shape. `listActive` now reads the unflattened rows: one entry per offer, a code named only where the discount has exactly one (which is what an advertised code looks like), and `(code personnel, 600 générés)` otherwise. **259,874 → 1,991 chars, bulk codes exposed 3,614 → 0.** The flattening stays correct for `lookupPromotion`, which needs per-code usage to answer "you have already used this one".
- **Measured spend, since the question was asked and the answer was not guessable:** ~10,100 gpt-4o prompt tokens and 2.6 calls per investigated ticket, ~$0.029 each, **~$5 for all 174 in scope**. The constraint is not money — at 30,000 TPM the org can sustain about three tickets a minute, so a full pass is an hour of steady 429s and wants batching.
- **`getOrderContext` was serialising the UI's data structure into the model's prompt**, and `context.promptText || JSON.stringify(context.order)` was not a fallback — **0 of 44 stored contexts carried a `promptText`**, so the dump was the only path that had ever run. `toOrderContextText` now renders it: 515 chars median against 1,693, withholding `sku` and `productId` (join keys, not facts a customer recognises) and naming money only where a reply turns on it.
- **The general rule behind that is now stated once and enforced across every tool:** a structure with several audiences owns a projection for each. One test runs all eight tools over four subjects and asserts no `promptText` begins with `{` or `[`.
- **`namedSample`** caps the one remaining unbounded renderer — `describeItemRestriction` enumerated every product a discount covers. Dormant on this data (no promotion carries an item scope), which is exactly why it was capped now: nothing will announce when it wakes up. `buildVariants` was deliberately left alone — variants top out at 3 per product, and a cap that can never fire is machinery pretending to be a safeguard.
- **The verdict now decides where a ticket waits.** `needs_customer_input` → `awaiting_customer`, `needs_human` → `awaiting_human`, `answerable` stays `open` because nothing sends yet — that is drafting's hook, not the investigation's.
- **Setting that alone would have stranded every replying ticket for ever.** The categoriser *and* the investigation runner both select on `status = 'open'`, so a ticket parked `awaiting_customer` would never be re-read once the customer answered. `ticket-writer` now returns **any** non-open status to open on an inbound message — reversing an earlier rule that was correct while nothing set those states.
- **`awaiting_human` is exempt from auto-close.** Silence there means nobody did the work, not that it resolved; closing it files a service failure as a completed ticket. Before this, **67 level-3 tickets** would have closed that way. The backlog is counted separately from `exempt` so it is visible rather than deleted.
- **`orders.customer_email_masked`** — `j***l@orange.fr`, derived beside the hash from the same input. A hash answers "is it the same address?"; the desk's question is "which address is this?", and **all 15 order mismatches are now reviewable**. Several point at `@example.com`, which is a different cause than assumed: placeholder addresses no requester could ever match. Never sent to a model.
- **Evidence gaps now carry `details`** — which product, which code, why it was refused — declared per need beside the finding derivers, extending `evidence_gaps` rather than adding a column. `summariseFacts` renders them in the ticket panel for **every family**, closing the gap where only orders could be judged without opening Shopify.
- **P2 caught two bugs by refusing to be a formality.** The first attempt returned zero details because all three tickets matched nothing — a verification that can only pass is not one. Re-run against tickets naming a real product or code, it found (a) the customer extractor reading `account` where the identity lives in `profile`, storing `{name: null, isVip: null, ordersCount: null}`: an object that passes every existence check and says nothing; and (b) `MASQUELEDVISAGE` looked up as a discount code on a *product* ticket. **The finding alone read as unremarkable; only the detail showed the subject was nonsense**, which is the argument for the whole feature. Filed as `VALIDATION_LOG` 6c — ~~blaming the extraction pattern~~, **which the entry above corrects: the pattern never matched it, the model composed the string itself.**
- **Order sync re-run** to populate the mask: 2,714 orders synced, 700 purged by retention (0 of the 44 confirmed-order tickets lost their row), **1,969 of 2,014 carrying a masked address**.
- **Tests:** +26 (1048 root, 685 agent), plus the dashboard typechecks, lints and builds.

## Exemplars reach the agent, and the order family is switched on (2026-08-13)

- **The whole exemplar layer is live end to end.** 31 exemplars approved, **94 phrasings embedded**, and `match_support_exemplars()` answering from the investigation loop. Verified against a real ticket: « pourquoi je n ai pas reçu de code pour les -20% » → **P-15 at 0.824**, P-18 second at 0.693.
- **Wired reported-not-enforced, and that is the design.** The match reaches `ticket_investigations.exemplar_match` and nothing else — `investigate()` is never told, and a test asserts the key never appears in its input. Two independent declarations of what a ticket requires now exist, and comparing them is only meaningful while neither feeds the other. `npm run eval:exemplar-needs` is the report, and it excludes rows where the exemplar supplied the needs.
- **It costs no extra API call and cannot break a run.** `findInboundMessages` now selects `embedding`, so matching reuses the vector ingestion already wrote (`"embedded":false` on every live run). Every failure path returns `{}` and logs `investigate.exemplar_failed`.
- **The one place the exemplar does act:** when the decomposer's call *fails*, its authored needs stand in. `decompose.mjs` invents nothing on failure by design; a list a person wrote for a matched situation is not that guess. `caseFile.needsSource` records which source spoke so the comparison stays honest.
- **Storing only the committed match was wrong, and the first dry run said so.** Both live tickets came back `near`, so `exemplar_key` was null and the row said nothing — while *which situation nearly won* is the entire diagnostic on a near miss. Added `closest`, populated whatever the verdict.
- **`ENABLED_SUBJECTS` now contains every subject that has tools** — `order`, `delivery`, `payment` and `return_exchange` joined the five already there. Before this, **21 of 31 exemplars and 116 of 158 messages of measured demand were unreachable**: two-thirds of the corpus we had just approved and embedded could never be retrieved.
- **Enabled with 15 mismatches unexamined, knowingly.** `isSafeToWrite()` gates the column, so a refused resolution leaves `shopify_order_number` null — the agent cannot answer about the wrong order because it never learns which one it was. The cost is asking a customer for a number they already sent. Tracked as an open audit in `VALIDATION_LOG.md` item 6b, which closes by *counting* how often that happened rather than by observing that nothing broke.
- **A test now asserts the enabled set and the tool table agree exactly.** They deliberately disagreed until today and the gap was the mechanism; with it closed, the invariant worth protecting is the agreement — dormant tools nobody notices, or a subject routed nowhere.
- **Three phrasings were carrying two situations each**, found by a new audit that scores stored vectors against each other and costs no API calls. P-18's split half moved to P-15, R-22's drop-off question to R-21, and PR-28's « Avant de me décider, je… » was a truncated fragment carrying no situation at all. The eval structurally cannot see this class of error: a bad phrasing still wins the ticket it was lifted from.
- **P-18 was a question invented from its own answer.** Across 296 stored messages and a curated review folder, no customer has ever asked whether codes stack — every "cumulable" sentence is one the desk wrote. Rewritten as « mon code promotionnel ne fonctionne pas » with five real phrasings, and it went from never winning a ticket to **7 at median 0.740**.
- **The P-16 merge was reversed on a better axis.** Reading all 21 promotions tickets end to end: **14 are "no code arrived", 3 are "the code will not apply"** — different *observations*, not two diagnoses of one. P-15 sharpened from 21 tickets at 0.696 to **14 at 0.773**. Both sides rose, which is the tell that a split is right.
- **Two new situations from a curated review folder:** `D-33` (which countries do you ship to — split out of D-07, which was asking two questions behind one vector) and `S-34`, the **first exemplar for `product_stock`**, a subject that had been switched on the whole time with nothing to match against.
- **Order numbers stay in the phrasings, measured.** Three variants of all 92 phrasings scored against unchanged ticket vectors: as-is 0.633, stripped 0.635, placeholder 0.634. Differences inside noise, so kept literal — a placeholder is a token no real email contains, which moves the library *away* from the query side.
- **Tests:** +12 (1011 root, 656 agent).

## A forwarded order confirmation now resolves the order (2026-08-12)

- **6 of the 15 `mismatch` tickets become `confirmed`**, taking order-number coverage from 44 to 50 of 214 tickets. Each had parsed its number correctly against a real order and been refused because the *envelope* sender did not own it — while the address that order is registered to was sitting in the message the customer sent. Merchant decision recorded in `DECISIONS.md`: an email mismatch here is ordinary (a gift, a partner, a second mailbox), not a security concern.
- **`confirmation-evidence.mjs` parses no template, and that is the design.** It hashes every address in the text and asks whether one equals `orders.customer_email_hash`. The received mail is the notification template after the customer's client re-rendered the forward, after `htmlToText` flattened it, and possibly after a merchant reworded it — every step moves the labels, and there are no tags to anchor on because Liquid (`{{ order.name }}`, `{{ email }}`) renders before the mail is sent. A label-reading parser would have been built against a document we never receive.
- **Measured against the corpus first.** 18 messages across 10 tickets carry the full confirmation; the order number was already extractable from **18 of 18** — the number was never the missing piece, the identity was. Only hashes leave the module, so third-party addresses reach no caller, log or metadata column.
- **Named `message_email`, not `confirmation_email`, because the data said so.** Of the 6 rescued tickets only **3** carry a recognisable confirmation; the other 3 quote the address another way. A layout parser would have found 3 and called the rest mismatches. `metadata.order_resolution.confirmation_markers` records the template-marker count as a diagnostic — never a gate — so a reviewer can tell the two cases apart.
- **Known gap, deliberately not closed:** the order-status URL, the one identifier that is a platform invariant rather than a template choice, survives in **0 of 296** stored messages — `htmlToText` drops every `href` and the raw body is not retained. Using it needs the href kept at map time plus a token column on `orders`; the hash check needs neither.
- **Not built:** attachment reading. 38 inbound messages carry attachments and **29 of those have no order number anywhere in the text**, but nothing fetches `/messages/{id}/attachments` — `has_attachments` is a boolean and always has been.
- **Tests:** +18 (645 agent), covering hash comparability, punctuation and `mailto:` normalisation, a bounded address count, both confirm paths and their ranking, and a reworded template still yielding the address.

## Exemplars merged, and the language gap given somewhere to live (2026-08-12)

- **Three merges, 32 exemplars → 29.** `O-09/O-10` and `D-03/D-04` each resolved to a *single shared answer* in `Email-Example-Responses.md` — the split was simply wrong, and the eval agreed from the other side (O-10 and D-04 never won a ticket). `P-15/P-16` spans three answers and was merged anyway, on the stronger claim that which of the three applies is a **finding, not a question**: the customer knows only that they were promised 20% and do not have it. Merging exemplars does not merge answers, because answers are keyed by evidence position.
- **The retired rows were not inert, and that is the lesson.** The importer upserts and never deletes an exemplar that leaves the document, so `O-10`, `D-04` and `P-16` survived as drafts holding *copies of the phrasings that had just been merged into their survivors*. Median margin fell 0.037 → **0.032** and ambiguity rose to **23%** — the merges looked actively harmful until the three rows were deleted.
- **Cleaned up, the merges did what they were meant to.** Median margin **0.040** (from 0.037), ambiguity **17%** (from 19%), subject agreement **63%**, silent exemplars **6 → 3**. `MATCHED` and `NEAR` did not move.
- **`diagnose-exemplars.mjs` now says WHY a silent exemplar is silent** — the rival that beat it, the median gap, and the language of its closest tickets — because "never wins" has causes wanting opposite fixes. `COLLISION` wants a merge and more phrasings would only sharpen the tie; `ABSENT` wants leaving alone; `MID-PACK` means the field already covers it; and a gap of exactly **0.000** is `DUPLICATE`, the signature of a retired key still in the table. Post-merge, P-18 and R-23 lose *clearly* (0.130 and 0.162) rather than narrowly, so neither is a merge candidate — they are under-phrased.
- **R-22 was neither rare nor mis-worded: it was measured somewhere it cannot appear.** Pulling the source message out of the corpus found *"RE: RE: PROBLEME MASQUE LED"* — the **fourth message of a thread**, and the eval scores only first inbound messages, so its one real phrasing is never a query. The truncated quote had also cut the load-bearing clause: « je ne suis pas responsable si le produit a un problème » makes it a **defective-goods** return, a different answer to the same sentence. Restoring the full quote was enough for it to start winning tickets. Recorded as a general property — return costs, refund timing and "any news?" are follow-up questions by nature, and this eval is blind to all of them.
- **`support_exemplar_phrasings.language` + `translated_from_index`, and `translated` as a third phrasing kind.** French tickets match at median **0.637** and English at **0.476** — a gap wider than the whole distance between `NEAR` and `MATCHED`. Nothing writes anything but `fr` yet; the column exists because none of that is reportable or regenerable without knowing what language a row is in. `match_support_exemplars()` now reports which language matched and still **never filters on it**: an English email matching a French phrasing weakly beats not matching it.
- **Translations live at `phrasing_index >= 100`, and the database enforces it.** `import-exemplars.mjs` prunes by position — anything past the end of the authored list is text nobody wrote — so a translation appended after the authored phrasings would be destroyed on the next import. Two index spaces, a check constraint rather than two scripts agreeing by habit, and `TRANSLATION_INDEX_BASE` asserted from the module in the migration test.
- **The translate-the-query recommendation is reversed.** Its premise was already false — R-21 is English, D-08 and R-23 Spanish, so the library has been mixed-language since it was written — and query translation trades one mismatch for another, since machine-translating a messy email produces *tidy* French against variants that exist precisely to be messy. Library-side instead: real non-French phrasings where the corpus has them, translation to fill the rest. Suggestive: `es` median **0.814**, highest of any language, on n=2, and D-08 is the one carrying a real Spanish phrasing. **Deliberately not built yet** — translating before every question has its full verbatim set means paying for the same work twice.
- **Applied to the live database as a hand-written delta**, because the migrations are a baseline and cannot be re-run over populated data. `05_exemplars.sql` is the definition and was edited to match; verified after: 79 phrasings, all `fr`, all authored, max index 4.
- **`agent/eval/README.md`** — every measurement in one table, with the column that matters most: *what it is judged against*. Three are labelled sets, two are proxies, none writes to the database.
- **Tests:** +7 (983 root, 628 agent), covering the language vocabulary element-wise against `REPLY_LANGUAGES`, the two index spaces, and the translation shape constraint.

## Order family unblocked, and the exemplar bands measured (2026-08-11)

- **`orders:resolve` has now run against real data** — the pass `VALIDATION_LOG` item 6 was waiting on. 203 tickets considered, **44 confirmed**, 15 `mismatch`, 4 `not_found`, 140 `no_candidate`. Then `context:build`: **44 of 44 resolved, 0 missing**. `getOrderContext` can finally answer, which was the last thing standing between the order family and `ENABLED_SUBJECTS`.
- **15 mismatches want a look before the subjects are enabled.** That is item 6's own check (b): a mismatch is a confirmed-looking order number whose requester hash does not match the order, which is either a customer writing from a second address or a thread that is not theirs. Subjects like *"RE: remboursement commande #5229"* suggest the former.
- **`npm run eval:exemplars`** — calibration without approval. Embeds the 79 phrasings **in memory** and scores them against the first inbound message of **190 real customer tickets**, whose vectors ingestion already wrote. Approval gates the vector, so this breaks what would otherwise be a deadlock: the numbers a reviewer needs to approve are the ones that only exist after approving.
- **The relevance signal is a proxy and is labelled as one:** whether the winning exemplar's subject agrees with the subject the categoriser independently assigned. Overall agreement **62%**; the distributions separate cleanly (agreeing p25 0.629 vs disagreeing p75 0.621).
- **`MATCHED` 0.62 → 0.65, `NEAR` 0.52 → 0.55.** The sweep put the knee at 0.65 — restraint 80% → 88% for the recall it costs, where 0.70 buys 7 more points at nearly half the remaining recall.
- **`minMargin` 0.03 → 0.01, and this one was simply wrong.** The median margin is 0.037, so 0.03 would have called **45% of all matches ambiguous**. At 0.01 it is 19%, and that residue is a corpus problem — the source document already names O-09/O-10 and P-15/P-16 as merge candidates.
- **The variants thesis held.** Six exemplars never win a ticket; two of them are D-07 and P-18, exactly the two with no real phrasing. Predicted by the importer, confirmed by the eval.
- **Still not proven:** nothing is approved, nothing is embedded in the database, and no exemplar has reached the investigation loop. The bands rest on a proxy, not a labelled set.

## Exemplar layer, part 1 — storage, embedding, retrieval (2026-08-11)

- **`05_exemplars.sql`, the first new baseline file since the reorganisation.** `support_exemplars` (canonical question, `exemplar_key`, subject + kind, `requirement_needs text[]`, `approval_status`, measured `demand_message_count`) and `support_exemplar_phrasings` (one row per real phrasing, each with its own vector and the determinism quadruple). `requirement_needs` is constrained to the `evidence-rules.mjs` vocabulary, held in step by a migration test — the same device that keeps `knowledge_documents.category` from drifting off the taxonomy.
- **`match_support_exemplars()` returns one row per exemplar, not per phrasing**, scored by its best phrasing. Five phrasings of one situation are five ways of saying the same thing, and without the grouping a caller asking for three matches gets one exemplar three times. The phrasing pool is over-fetched ×8 because the inner limit counts phrasings while the caller counts exemplars.
- **A phrasing is embedded alone** — the only composer in the codebase that adds no context. `buildExemplarEmbeddingInput` collapses whitespace and stops; a phrasing is already a complete question and the query it meets is a bare email, so prefixing the canonical question would pull variants of *different* exemplars together via their least discriminating text.
- **`exemplar-rules.mjs` — one exemplar or none, never a shortlist.** A near-tie (margin < 0.03) resolves to `ambiguous` rather than to the higher score, and the margin is reported because a persistent near-tie is the corpus saying two situations want merging. Bands are `MATCHED 0.62` / `NEAR 0.52`, **separately calibrated from knowledge and currently unvalidated** — the knowledge numbers came from a prose library and do not transfer. Subject filter only, deliberately the opposite of `categoriesToSearch()`.
- **`exemplar-retrieval.mjs` reuses the stored message vector** when the ticket carries one, so the usual cost is a single RPC and no embedding call at all; it falls back to embedding on demand because that ingestion write is best-effort.
- **`npm run embed:exemplars[:dry-run]`** — the reconciler, mirroring the knowledge one. Clears vectors from phrasings whose parent left `approved` **or was soft deleted**; on this corpus a missed clear is a reachability bug rather than a quality one, because approval *is* the retrieval gate.
- **`npm run import:exemplars[:dry-run]`** — reads `Email-Example-Queries.md` into the tables. The parser is pure (`scripts/lib/exemplar-import.mjs`) and the script is a shell, so every judgement is unit-tested: two categories on one entry keeps the first and notes the second, a need outside the investigation vocabulary is dropped loudly rather than failing a check constraint at insert, and the one "variant" that quotes *our own reply* is skipped by name — embedding an answer into a corpus of questions is what the separate-tables decision exists to prevent. Idempotent: phrasings upsert on `(exemplar, index)` so unchanged text keeps its vector, and phrasings past the end of a shortened list are deleted rather than left orphaned. **It never approves anything** — approval gates the vector, so nothing imported is retrievable until a person has reviewed it, which is also where the order numbers inside real phrasings get looked at.
- **Measured on the real document:** 32 exemplars parsed, 0 skipped, **79 phrasings** (32 canonical + 47 real variants). By subject: delivery 8, order 8, product 5, promotions 4, return_exchange 3, payment 3, account 1. Two exemplars (D-07, P-18) carry no real phrasing and will match a messy email worst — reported by the importer rather than left to be discovered.
- **Answers are shared, not nested** (`support_answers`). Nesting a variant set inside each exemplar multiplies to 100–160 drafts, most of them duplicates — « pas encore expédiée » answers both D-01 and O-09. Because a `when` clause is a conjunction over *closed* findings enums, the space of distinct evidence positions is bounded by the vocabulary rather than the question count: the promotions family collapses to four positions serving five questions, and the estimate across all four families is 10–15 answers. An exemplar names its `answer_set`; conditions pick the state within it.
- **`answer-selection.mjs` — selection and the stopping rule are the same computation.** Most-specific wins with `priority` breaking ties (never first-match-wins, which makes authoring order silently load-bearing); an unbreakable tie reports `ambiguous` rather than resolving by sort order; no match with no fallback routes to a person. `nextNeed()` picks the need the live answers most *disagree* on, then walks the dependency graph back to what must come first — which is how `promotion_identity` gets collected even though no answer branches on it. Collection halts when one answer remains, before the tool budget rather than by exhausting it.
- **Applied and imported.** `SUPABASE_DB_URL` still pointed at the retired IPv4 direct host (`db.<ref>.supabase.co`, now IPv6-only, and this machine has no IPv6 route); repointed at the session pooler `aws-0-eu-north-1.pooler.supabase.com:5432`. `05_exemplars.sql` applied, then **32 exemplars and 79 phrasings imported** — all `draft`, so nothing is retrievable yet. Re-running the import produced no duplicates.
- **Not built yet:** the answer *content* (0 rows in `support_answers`; `answer_set` is null on every exemplar), the dashboard editor, and the band calibration. Nothing calls exemplar retrieval from the investigation loop yet.
- **Tests:** +56 (944 root, 601 in `agent/`), covering the vocabulary constraints against their source modules, the retrieval function's grouping/over-fetch/gates, the band-and-margin decision table, and the parser's forgiving-shape/strict-vocabulary split.

## Evidence findings — the value a need took (2026-08-11)

- **Needs now resolve to a value, not only to a state.** `resolveNeeds()` gains a `finding` alongside `state`: `promotion_validity` is no longer just *satisfied*, it is `active` / `expired` / `not_yet_started` / `inactive` / `not_found` / `unknown`. Nine needs carry a vocabulary — the ones the 32 questions in `Email-Example-Queries.md` actually branch on; the rest resolve `finding: null`, which reads as "no answer depends on the value" and is deliberately distinct from `'unknown'`.
- **Derived from structure, never prose.** `promotion-rules.mjs` checks gained an optional machine-readable `reason` (`expired` / `not_yet_started` / `open`, `active` / `inactive`), because expiry and a future start date were both `FAIL` on the same check and separable only by reading French. `tool-registry.mjs` now passes `checks` through as `{id, status, reason}` triples — never the `detail` sentences, which stay in `promptText` where the model reads them. Existing check shapes are unchanged when no reason applies.
- **A universal dependency graph.** `requires` and `moot` sit beside `satisfiedBy`: eligibility requires validity requires identity, and eligibility is *moot* once validity is `expired` / `not_found` / `not_yet_started` / `inactive` — there is nothing to be eligible for. `orderNeeds()` is a stable topological sort over a declared set; a prerequisite that was not declared does not block its dependent. The order family's edges are written and dormant with it.
- **Nothing consumes any of this yet.** No verdict, prompt or stored column changes: `evidence_gaps` simply carries an extra field. This is the axis the exemplar answer-variants will branch on, landed first because conditions cannot be authored against values the tools cannot produce.
- **Tests:** +15 (888 root, 584 in `agent/`), covering derivation totality (every deriver returns a value inside its own vocabulary, across nine ledger shapes), the expired/not-yet-started split, `satisfied` co-existing with `unknown` when the tool is too coarse, and the sort's stability and completeness over the whole vocabulary.

## Environment correction (2026-08-11)

- **The dev-store premise was stale across seven files.** `SHOPIFY_STORE_DOMAIN` is `qiriness.myshopify.com`; measured against Supabase: **2052 orders spanning `#4716`–`#6770`** (was 12, `#1001`–`#1012`), 58 201 customers, 116 products, 327 promotions. That range contains every order number the mail corpus quotes, so the "zero overlap" blocker recorded throughout is over. Customer resolution has run and links **141 of 214** tickets.
- **The order family is still gated, for a new reason.** `shopify_order_number` is null on all 214 tickets because `orders:resolve` has never run, so `getOrderContext` reports `not_resolved` regardless. Enabling `ENABLED_SUBJECTS` before that pass reproduces the old empty answer. Corrected in `investigation-rules.mjs`, `DECISIONS.md`, `VALIDATION_LOG.md`, `README.md`, `AGENT_INTEGRATION_PLAN.md`, `order-resolution-runner.mjs` and `abandoned-checkout.mjs`. **No validation item was closed** — none of the checks has been run.

## Agent worker staged ingestion (2026-08-09)

- **Backlog ingestion can now stop after categorisation.** `npm run ingest:once -- --limit=500 --stop-after=categorise` runs ingestion, customer resolution and categorisation, then deliberately skips investigation, order resolution, context assembly, forwarding and auto-close. Retention still runs. The same `--limit` now caps the categorisation batch too, so the intended 500-message review run does not stop after the normal 25-ticket daemon batch. A bad stage name fails closed and logs the reason; the worker error paths on this route now use the logger-safe `error` field instead of the reserved `message` field.
- **The staged backlog run has now been executed against the real mailbox.** Command: `node .\src\index.mjs --once --limit=500 --stop-after=categorise` from `agent/`, completed 2026-08-09. Result: 451 messages ingested, 214 tickets created, 451 message embeddings written, 25 blocklisted spam drops, 24 LLM spam/irrelevant drops, 175 spam audit decisions flushed, and the Graph limit was reached. Customer resolution ran before categorisation. Categorisation labelled 203 tickets, skipped 11 outbound-only/unclassifiable tickets, and had 0 failures / 0 fallbacks. The staged stop held: no investigation, order resolution, context assembly, forwarding, or auto-close pass ran.

## Dashboard

- **Agent Setup** (`/agent-setup`) — two-pane knowledge workflow: article library with search, status filters, a 6-slot core-topic checklist and category grouping; a workspace editor with Shopify page/policy import, resync, save/approve/delete, and a dedicated brand-voice workspace. Full state and a11y coverage. "Optimize" is still a local placeholder with no AI behind it.
- **Knowledge API** (`web/app/api/knowledge/*`) — exercised end-to-end through the real browser UI, not just curl: page import, policy import, edit-converts-to-manual (Resync correctly disappears), and delete.
- **Tickets dashboard** (`/tickets`) — four header cards over three collapsible sections: Queue (565), Irrelevant (260) and Closed. Level tabs, search, category filter and sort apply to the queue. **Every row opens with a traffic-light mood face** read from `tickets.happiness`: green 1-2, amber 3, red 4, dashed where unscored. Neutral (2) is folded into green on purpose — it is the commonest score, and an amber row for every ordinary email would turn the whole column amber and signal nothing. Drawn on the app's own icon grid rather than as a Unicode emoji, which would render as each operator's OS artwork and ignore the palette. **Close** and **Reopen** work end-to-end; the round trip was exercised against the live dev database and the row verified moving between sections both ways. Every card figure and row count matches a direct Supabase query.
- **A queue row expands into the agent's reading of it** — Results / Order / Action, fetched per ticket on expand rather than shipped with all 565 rows, always the latest run. **Not yet exercised against the live database**: the investigation pass has run over 40 real tickets from the CLI, but this panel has only been type- and lint-checked.
- **The Order block carries Shopify's own status and tracking**, read from `tickets.resolved_context` rather than the case file, so it fills in for tickets the agent never investigated. Order status, tracking number (linked to the carrier where the fulfilment has a URL) and tracking status appear **only when there is data**. **Not yet seen against real data** — type- and lint-checked, build passes.
- **Clicking a ticket's subject opens the conversation in the app** (`GET /api/tickets/:id/thread`): a draft-reply section, then the full email chain, both directions, oldest first. It exists so an operator stops flicking to Outlook to read a case; **sending still happens in Outlook**. A deep link into the mailbox was considered and is not buildable — see `DECISIONS.md`. The **draft section is a placeholder and says so** (drafting is Phase 5). The route returned 200 against the live dev database for two real tickets; the rendering has not been checked field by field.
- **A ticket row shows the matched Shopify customer and badges VIPs.** The queue embeds the customer over `tickets.customer_id` in the same request (no extra read) and marks a **VIP** where the RFM segment is `CHAMPIONS` or `LOYAL`. Verified end to end by temporarily linking one ticket to a `LOYAL` customer, confirming the badge and resolved name rendered, and reverting.
- **But nothing is linked yet, and the reason is the dev store.** `customers:resolve:dry-run` reports **500 considered, 0 linked, 500 `no_match`** — the pass had in fact never run against this data (0 of 565 tickets carried a `customer_id`, and 0 carried the `metadata.customer_resolution` record it writes on *every* outcome). Zero address overlap between the 15-customer dev store and the live inbox.
- **The Irrelevant section's subject opens the dropped email itself** — the message and nothing else, since verdict/gate/reason/timing are already columns in the row. `failed_open` is the one exception, kept as a banner.
- **Dropped mail keeps its body** (`08_spam_audit_body.sql`, applied to dev), reversing 02's "never the body". Kept only on a `blocked` outcome and under its own 90-day expiry, purged per poll by a PATCH rather than a DELETE. Migration applied and the dashboard's read of the new columns verified against dev; **no email has been ingested since, so nothing has yet written a body through the live path.**
- **The backfill for pre-existing rows exists and currently cannot run here.** It stops immediately with `ErrorInvalidMailboxItemId`, because every `graph_message_id` was captured from `contact@qiriness.com` while `SUPPORT_MAILBOX` now points at `onouailhetas@lap-groupe.com`, and Exchange item ids are mailbox-scoped. Verified as a mailbox mismatch and not deleted mail by probing ids of *kept* messages, which fail identically. **Not specific to the backfill** — no stored id can address a message today, so Graph's `/forward` cannot work for the existing corpus either.
- **Saved changes survive a reload.** The dashboard used to show pre-edit values after F5 while Supabase held the correct data. Next.js patches global `fetch` in Server Components and Route Handlers and was storing every Supabase REST response in its Data Cache with a one-year revalidate, keyed on URL. `export const dynamic = "force-dynamic"` does not prevent this; only an explicit `cache: 'no-store'` does. Now set on every request in the Supabase and Shopify clients.

## Sync and schema

- **Shopify sync scripts** — products/metaobjects, customers, orders, promotions, the unified page+policy content catalog, and nightly orchestration.
- **Support taxonomy pinned** — one shared vocabulary in `scripts/lib/support-taxonomy.mjs`. The rename of the 9 existing articles and 54 chunks ran once against dev; the constraints on both the knowledge and ticket sides are applied and their enforcement verified live.
- **Level 4 means severity, not subject.** The database column comments carry this rule; an earlier version had shipped a subject-implied one, and the correction is applied to dev.
- **Schema fully applied to dev.** The migrations are a **baseline** run in order against an empty database, replacing the 15 numbered files that built dev incrementally (kept in git history). The baseline was verified to reproduce the live dev schema exactly: 384 columns, 147 constraints and 136 indexes, zero differences.
- **The baseline is now four files by domain, not eight by history** (2026-08-07). The eight had accreted as a changelog — 05 patched 04, 07 mirrored a flag 03 created, 08 rewrote a comment 02 wrote, and `tickets` was created in 01 then altered twice more — so reading one table meant reconstructing it from up to four places. Now `01_foundation` → `02_shopify` → `03_knowledge` → `04_support`, with **every table created complete**: there is no `alter table … add column` in the baseline, and a test asserts it. **Proved rather than reviewed** — both sets were applied into throwaway schemas on the dev Postgres and the catalogue diffed: 425 columns, 172 constraints, 152 indexes, 17 triggers, 3 functions, 20 RLS tables, 20 table comments and 139 column comments, **identical**. The 89 old tests became 110, reorganised so the cross-file invariants (RLS everywhere, nothing referenced before it is created) are asserted once in `_shared.test.mjs` rather than partially in each file.

## Ingestion (agent Phase 1)

- **Verified against the real mailbox** — cursor idempotency, delta cursor persisted in `shops.sync_cursors` — then end-to-end against the live `contact@qiriness.com` inbox: 500 messages → 125 blocklisted, 27 LLM-filtered, 348 stored as 171 threaded tickets, all categorised with no failures.
- **Four defects found by running it on real mail**, none visible on synthetic data:
  - *Direction.* 123 of 348 messages were sent by the support address and stored as customer mail, putting Qiriness's own reply at the end of 43% of threads.
  - *Contact-form identity.* 53% of support mail arrives through the Shopify form. 95 tickets shared 2 `requester_email_hash` values. After the fix, distinct requesters went from 76 to 108 and the worst collision from 73 tickets to 8.
  - *`first_message_at`.* Late on 93 of 171 tickets (5 days on average, 24 at worst), and the categoriser queue sorts on it.
  - *Queue starvation.* 11 unclassifiable threads took 11 of every 25 slots on every pass.
- **Quoted reply history is stripped** before embedding and classification. **104 of 348 messages carry a reply chain and it is 53% of the stored text.** Every cut comes from an unambiguous structural marker; the loose `>`-line heuristic fires on none of them.

## Spam gate

- **Pass 1** — the `email_blocklist` check inside the poller; blocking a sender live dropped their 5 messages and purged their stored mail.
- **Pass 2** — the LLM classifier on new-conversation mail, failing open on any error. The first 100-message pass filtered 91 as spam, correctly: the inbox is flooded with DMARC aggregate reports. Adding the report senders to the blocklist moved them off the LLM path entirely (91-per-100 down to 27-per-500).
- **`irrelevant` now drops, not just labels.** Guard-railed by a measurement: 17 of the 20 purely internal threads turned out to be *customer work forwarded between colleagues*, so the prompt states explicitly that internal mail about a customer is not irrelevant. Only 1 ticket in the corpus was genuine ERP coordination.
- **Spam audit trail** — every gate decision writes a `spam_audit` row. The write path was exercised against the live table: idempotent re-flush, one-line reason collapsing, and the `unsure` default all confirmed, then the test rows removed.

## Embeddings and retrieval

- **Embedding pipeline, built and run end to end.** `text-embedding-3-small` at 1536 dims across two corpora sharing one determinism gate. **Knowledge chunks:** 11 of 54 hold vectors — exactly the chunks of the one `approved` document, the invariant holding on real data. **Ticket messages:** all 351 embedded. Both verified idempotent, and verified working together: clearing six vectors, the ingest pass refilled three inline and the reconciler swept up the rest. Retrieval sanity-checked by hand: an account login question matches the password-reset FAQ at 0.624, and "commande le 17 mai, montant débité" matches "Ma commande 5669 du 17 mai n'est toujours pas partie" at 0.859 across two different tickets.
- **Topic clustering over the embedded inbox** (`cluster:tickets`) — read-only, no model calls. Average-link, not single-link: single-link chained and put 52 of 55 `order` messages in one blob. Threshold 0.68, tuned by eye.
- **Two faults surfaced once the corpus reached 1111 messages**, both invisible at the ~225 it was built on. **It was reading 1000 of them:** PostgREST silently caps a response at `db-max-rows`, returning 1000 rows and a 206 with nothing for the caller to notice — `supabaseSelectAll` now pages by the rows actually returned. **And 30% of "customer demand" was us:** 331 messages from our own domain counted as inbound and dominated the topics; five of the top ten `delivery` clusters were staff chasing the carrier. Net effect: 4 of the top 8 "write this next" suggestions were internal threads; now none are. The same cap was also truncating **`embed:tickets`**, whose redaction sweep clears vectors from redacted and soft-deleted messages — past row 1000 it was not looking. It now considers all 1383 (0 stale, 0 to clear, so nothing had slipped through; the safety net was blind, not breached).
- **Knowledge retrieval** — one embedding call plus one HNSW-indexed `match_knowledge_chunks()` RPC. Three bands, not a boolean: **answerable ≥ 0.60, weak ≥ 0.45, otherwise nothing** — calibrated on the measurement that a genuinely correct match scored 0.62 while topics with *no article at all* still scored 0.38-0.48. **Measured on 12 real product/account tickets: 1 answerable, 8 weak, 3 nothing.** That is the library being empty, not the tool failing.

## Hybrid retrieval and the eval set (2026-08-09)

- **A labelled retrieval set exists, so retrieval changes are now measured rather than argued.** `npm run eval:retrieval` scores 16 cases — 6 answerable, 10 that must return *nothing* — on recall@k, precision@k, MRR, band accuracy, **restraint** (scored separately from recall, because a retriever that answers everything scores 100% recall) and **entity precision/recall/F1**, micro-averaged. Labels are at DOCUMENT level, not chunk: chunk ids regenerate on every re-chunk and a chunk-level label set would rot silently. `npm run eval:diagnose` reports the relevant-vs-irrelevant score distributions and how often the two retrievers agree.
- **Lexical search alongside the vectors, fused by rank.** `knowledge_chunks` gained a generated `tsvector` (`setweight` A on the heading, B on the body) over a custom `french_unaccent` configuration — `unaccent` + `french_stem` — with a GIN index, and `search_knowledge_chunks_text()` beside the existing HNSW RPC. Results are combined by **Reciprocal Rank Fusion at k=20**: rank-based, never score-based, because cosine sits at 0.45–0.60 here while `ts_rank_cd` runs 0.1–4.6 and normalising them would invent a relationship that does not exist. A chunk found by *both* retrievers accumulates both contributions.
- **The lexical half was returning zero results for every real query, and the diagnostic is what caught it.** `websearch_to_tsquery` **ANDs** its terms, so a nine-word French support question required all nine stems in one chunk — 0/80 retriever agreement, and "hybrid" search that was silently dense-only. It now ORs the lexemes. The earlier claim that fusion had produced three new `answerable` cases was wrong and is retracted: that improvement came from the user adding 7 chunks, not from the fusion.
- **`brand_story` is searched again.** The rule excluding it claimed those chunks were never embedded. They were — the embedding gate is `core_topic !== 'brand'` (the singleton brand-voice row), not `category !== 'brand_story'` — so the exclusion left 9 real vectors permanently unreachable. Two different things had been conflated: the drafting *voice*, which now has its own mechanism, and the brand *category*, which is ordinary knowledge answering real questions.
- **The `weak` floor moved 0.45 → 0.50, re-derived against the labelled set** on a 61-chunk library. Measured: relevant chunks 0.298–0.662 (median 0.517), irrelevant 0.171–0.578 (**p75 0.458**) — so 0.45 sat *below* the irrelevant p75 and a quarter of the noise was reaching a model. Swept: 0.45 → restraint 30% / band accuracy 44%; **0.50 → 70% / 69%, at no recall cost**; 0.55 → 90% / 81% but loses a real answer. `answerable` stayed at 0.60, which no irrelevant chunk in the run reached. **16 cases is a small set** — the sweep is to be re-run as the library grows, and 0.55 revisited once specific content lands.

## Task decomposition (2026-08-09)

- **An email that contains two requests is now investigated as two.** The investigation splits a ticket into at most 3 tasks, each clamped to the existing (subject, kind) taxonomy, and takes the **union** of their tools, opening moves and evidence checklist. This is what `tickets.secondary_category` was always for; nothing downstream had ever read it. Chosen over multi-query rewriting because this corpus has a routing problem, not a vocabulary one — see `DECISIONS.md`.
- **Bounded so it can only add, never re-route or widen.** A one-task result keeps the ticket's own labels (the categoriser stays the authority); a task landing on a subject outside `ENABLED_SUBJECTS` is dropped from routing and *declared* to the model rather than silently ignored; a failed or unusable decomposition degrades to exactly the pre-decomposition behaviour. The tool budget grows +2 per extra task and the turn budget does not, because tool calls here are cached database reads and model turns are the expensive bound.
- **It only runs when the email looks like it needs it** — a second subject from the categoriser, ≥320 characters, or ≥2 question marks — so an ordinary one-question ticket costs nothing. `AGENT_DECOMPOSER_MODEL=` (empty) turns it off entirely.
- **Not yet run against real mail.** 35 tests cover the pure half, the model half and the wiring, including that a single-task ticket produces byte-identical moves and prompt to the pre-decomposition path. The eval case `two-questions-at-once` is what will measure it.

## Evidence needs — step 1, measurement (2026-08-09)

- **The system can now tell "there was nothing to find" from "the agent never looked".** It could not before, and both produced a case file that read as complete. `evidence-rules.mjs` holds a closed vocabulary of **19 facts** a reply might rest on; the model declares which ones a ticket requires (in the same call that splits it), and code scores each against the tool ledger as `satisfied` / `attempted` / `unavailable` / **`not_attempted`**. Stored on `ticket_investigations.evidence_gaps`, summed per batch by the CLI, logged per ticket by the runner.
- **A documentation claim was found to be false and corrected.** `DECISIONS.md` stated that `requiredEvidence` was *"stated in the prompt **and** checked afterwards"*. A grep showed it appears in exactly one place outside its own tests — the prompt builder. It was never checked. That per-subject checklist is also static (two `product` tickets asking different things get the same list) and its `other` entry — *"the knowledge base was consulted"* — cannot fail. It remains a guideline; the new mechanism is what does the checking.
- **Closed enum, not free text**, because scoring free-text needs against the ledger would take a second model call — a judge marking its own homework. The model picks *which*; code owns *what satisfies*. Same split as `MISSING_FIELDS`.
- **`other_fact` can never be satisfied, by design.** A closed vocabulary's real risk is a false green — a ticket whose actual requirement is unnameable declaring two easy needs and reading as complete. It is logged so the vocabulary grows from real tickets. `checkout_state` is the same shape for a different reason: `abandoned-checkout.mjs` exists and is validated but is not in the investigation registry, so it always resolves `unavailable`, and counting how often it is *needed* is the argument for wiring it.
- **Deliberately reported, not enforced.** The verdict is untouched. Downgrading an `answerable` that left a need open, and ending the loop early when the set is complete, are **step 2** — both depend on this vocabulary being trustworthy and nothing has measured whether it is. A list that over-declares would downgrade good case files for reasons about the list rather than the ticket.
- **The decomposition call lost its gate as a direct consequence.** It used to skip short tickets; needs must exist for every investigated ticket or the report has a hole exactly where the ordinary tickets are. Now one `gpt-4o-mini` call per investigated ticket, against the two `gpt-4o` calls already made.
- **Not yet run against real mail** — the new Supabase holds 0 tickets until ingestion is unblocked. 37 new tests (858 total), and `evidence_gaps` applied to the live database and verified present with its check constraint.

## Retrieval tools (Phase 4)

- **Forwarding non-customer mail to the right colleague.** Measured, that is **38 of 330 customer-facing tickets (12%)** — careers 11, partner_collaboration 14, b2b 13. Configured at `/settings`; a category with no address forwards nothing, the default for all 14.
- **Running it for real found two bugs the tests could not.** The first live pass forwarded **0 of 42** — Exchange was mid-mailbox-move and every send returned `ErrorMailboxMoveInProgress`. **Failures were not actually retryable:** selection excluded any message with a ledger row regardless of status, so 42 genuine emails were permanently locked out by a transient error. **And the retry cap fought the poll interval:** 5 attempts against a 60-second poll would have burned every attempt in five minutes. Transient Graph errors no longer consume an attempt. **A third came from counting the real pending set:** 9 of 51 messages were colleagues forwarding things *into* the inbox with `TR:` subjects. Net: 42 messages across 38 tickets, matching the measured figure exactly.
- **Product lookup and stock tools** — matching runs on the **title column only**, folding accents and typographic punctuation, weighting tokens by **IDF across the catalogue** so `creme` (a third of titles) barely counts while `led` (one title) is nearly decisive. **Ambiguity returns every candidate's full context, not a refusal.** Running it on real tickets caught a live failure: the `unlisted` sample *"Caresse Temps Sublime Nuit - échantillon"* beat the real €89.50 coffret at 0.88; only `active` products are candidates now. Required a **Shopify rich-text flattener** — `product_faqs[].answer` is a nested rich-text document stored as a JSON *string*. Stock reads `purchasable` rather than the raw count: Shopify allows overselling and one real row sits at **-1**.
- **Promotion tool.** Targets 34 `promotions` tickets, 29 of them level 2; the biggest single cluster in the inbox is the newsletter welcome code (20 messages). **The verdict is three-valued — `blocked` / `undetermined` / `eligible` — never a boolean.** The promotions sync was extended to make eligibility real: `minimumRequirement`, `customerGets`, `customerBuys` and `customerSelection` were fetched as `__typename` only, so the snapshot recorded *that* a discount had a minimum but never what it was.
- **Abandoned-checkout lookup** — carts are not synced and the Admin API does not expose an in-progress cart, but `AbandonedCheckout` does. Fetched **live per ticket, never synced**; addresses dropped on the way in. See `VALIDATION_LOG.md` item 2 for what validating it uncovered (a real discount-subtotal bug, and that Shopify mutates one record per session in place).
- **Order-number resolver.** The prerequisite for 172 of 330 customer-facing tickets (52%). **Parsing is deliberately narrow**; over the corpus that is 1152 `#NNNN` plus 225 written-out forms, and the 911 `Q00` references are classified rather than dropped. **Measured on the corpus: 488 tickets, 139 with a parsed order number, 0 confirmed** — the corpus quotes 101 distinct numbers from 302 to 70853 while the dev store holds twelve. Validated end to end with a real-data fixture across six scenarios.
- **Order-context bundle** — verified by assembling the real `#1006`: a 1.7 KB bundle with tracking number, carrier, Colissimo link, `daysSinceDispatch: 17`, full-refund detection and the customer's RFM group, with no street address or phone.
- **Customer/CRM lookup — the first tool that needs no order number.** Two ways in, one bundle out: `findByEmail` and `findByEmailHash`. The customer shaping was **extracted, not copied** — `buildCustomerContext` backs both this tool and `tickets.resolved_context.customer`, with a test asserting the two produce the identical object. Every lookup writes a `data_access_events` row with the customer id hashed, and that write **fails open**.
- **The CRM lookup now runs by itself, on every ticket.** A pass runs immediately after ingestion and before any LLM stage, because identity is what a ticket has from its first message. Built, and now run for the first time: 500 considered, 0 linked, 500 `no_match` (see the dashboard section).

## The investigation agent (Phase 4b)

- **The first thing that actually calls the tools.** Six retrieval tools existed and nothing invoked them. **Measured on 40 live tickets: 9 answerable, 6 needs_customer_input, 25 needs_human, 0 failures, 0 unsourced claims stored, 0 handoff leaks**, and a maximum of 3 tool calls in any run against a ceiling of 6. The `needs_human` share is the knowledge library being nearly empty, not the agent being cautious. Scope is deliberately `product, product_stock, promotions, account, other`.

## Categorisation (Phase 3)

- **Run on real mail:** 171 tickets categorised across two passes with no failures and no fallbacks. Measured twice. Against 40 invented cases: ~38-39/40 on all three axes. Against **30 hand-labelled real emails**: subject 70%, kind 93%, level 77% (re-scored 2026-07-27 after the review bodies were normalised to match what ingestion now stores; the previous 77/90/73 was measuring input the pipeline no longer produces). Those movements are 2 cases or fewer on n=30 and sit well inside the noise — the set is too small to resolve changes of that size, which is itself the finding. Five of the nine subject errors are the `order`/`delivery` boundary Phase 4 order data should settle; four of the seven level errors are `delivery/problem` L3-vs-L2.
- **Re-categorisation as threads grow** — re-flagged on a new *inbound* message, re-read **blind**, level ratcheted so it may rise but never fall.
- **Two per-ticket signals** — `language` (on live mail it correctly caught 5 English, 1 Italian and 1 Spanish among 163 French) and `happiness` 1-4.
- **A third signal was built, measured, and removed.** The categoriser was asked how confident it was and answered `high` on 171 of 171 live tickets and 40 of 40 review cases. The per-band accuracy report added to the eval is what caught it.
- **Human review set on real mail** — 40 emails randomly sampled from the live inbox (Nov 2025 / Dec 2025 / Jan 2026, 40 of 1,027) sit in `categorisation_review`. The sampler is read-only on the mailbox and the agent's own labels stay empty until after review, so the labelling is blind.

## Not built

Dashboard authentication, deployed webhook routes, and the agent's drafting stage (Phase 5). Backend/deploy config is still pending.

## Agent panel: cost leads the page (2026-08-17)

- **`What it costs` moved to the top of `/insights/agent`**, above the pipeline funnel and the blocker ranking. A pure reorder — the section moved verbatim, no markup or logic changed.

## Fulfilment panel: a returns/refunds tile in the Delivery section (2026-08-17)

- **`Returned or refunded` is the first measured figure in an otherwise blocked section: 3 of 2,006 orders, 0.1%, €44.49.** One refunded in full (`#6398`, €32.03) and two in part (€6.23 each). Counted per order, not per refund line.
- **Returns and refunds are reported separately and never summed, because they disagree: 3 refunds, 0 returns.** `return_status` reads `NO_RETURN` on all 2,006 orders — a value Shopify recorded, not an empty column — so the zero is real. But all three refunds were issued with no return record, which is what a return agreed over email and settled by hand looks like. The tile never takes a `good` tone and a note beside it says 0.1% is a floor until someone confirms whether returns are meant to be raised in Shopify at all.
- **Four columns added to `fulfilment_summary` and its per-channel twin** (`refunded_orders`, `fully_refunded_orders`, `returns_opened`, `refunded_amount`), fed by `total_refunded` and `return_status` newly selected in `order_fulfilment_timing`. Added to both summary views deliberately: they back the same TypeScript type, and a column on one alone is a channel section silently reporting zero.
- **Read with `num`, not `count`, so a database whose views predate this renders a blocked tile naming the fix rather than "0 orders were ever refunded".** Verified in that state — the deployed views still need re-applying, and the drop-and-recreate is required because the baseline uses `create view` with eight views depending on `order_fulfilment_timing`. See `VALIDATION_LOG.md` item 0.

## Fulfilment panel: carriers moved under Delivery, outcome columns stubbed (2026-08-17)

- **The carrier table now renders after the Delivery section rather than before it.** Dispatch timing barely varies by carrier (Colissimo 24.5h, GLS 23.3h); what the table is asked at is a delivery question. It is a peer section, not nested inside Delivery — the blocked delivery tiles keep their own section so a working table does not read as broken tiles among them.
- **Three new columns — `Lost`, `Damaged`, `Delivered late` — ship empty on purpose.** They are wired to the table and to no data source. Nothing in the system can fill them today: no carrier scan events reach Shopify, and a ticket stores only that its subject was `delivery`, so a lost parcel, a broken bottle and a late one are the same row.
- **Typed `number | null` and mapped to `null`, never through `count()`.** A coerced `0` would print "COLISSIMO: 0 lost", which is an unmeasured claim about a carrier. The cells render as em dashes over the same hatch used for a missing bar, with a note under the table explaining the gap. Wiring a real source later is one `read` per column in `mapCarrier`.

## Support panel: tickets per month as a contact rate (2026-08-17)

- **Every bar on *Tickets per month* now carries its share of that month's orders in brackets**, and it reverses the reading. The bare counts make July the worst month at 85 tickets; against 450 orders that is **18.9%**, while June's 76 over 324 is **23.5%**. Measured on the dev store: May 7.5%, June 23.5%, July 18.9%, August 20.8% so far.
- **No migration.** The denominator is `fulfilment_by_month.orders`, joined to `support_by_month` in `support-service.ts` rather than in SQL — the two views group on different clocks (`first_message_at` against `processed_at`), so a join either way drops the months the other side owns. See `DECISIONS.md § Insights`.
- **The first month of mail is marked as a floor.** Orders start Feb 2026 and the synced mailbox starts May 2026, so May's 7.5% is a partial mailbox over a whole month of trading — the lowest bar on the chart, and indistinguishable from a genuinely quiet month. The panel derives this from the two series rather than hard-coding a date, the same way the current month is already marked partial.
- A month with no order row prints the count with no rate, never `(0.0%)`.

## Dashboard fixes (2026-08-16)

- **Insights dev page no longer depends on Google Fonts.** The root layout stopped using `next/font/google` because the local dev environment blocks the font fetch with `EACCES`, which can leave the dev page behind a blank/error overlay. The app now uses the existing system/Satoshi fallback stack from CSS with no network font request.
