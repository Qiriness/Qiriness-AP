# VALIDATION LOG

Things that are **built and tested, but not yet proven against real data**.

This existed because the Shopify store behind Supabase was a dev fixture, not a
copy of the business: 16 products, 3 discounts, 12 orders numbered `#1001`-`#1012`
and 15 customers, while the support mail is from the live inbox and references
orders like `#4854`, `#6216` and `Q00 26200111`. Unit tests proved the logic;
they could not prove assumptions about data that did not exist here.

**That premise no longer holds, and neither does the follow-on claim that the
passes had not run.** Re-measured **2026-08-17**, read from the database:

| Table | Rows | Note |
|---|---|---|
| `orders` | 2052 | `#4716`–`#6770`, which **contains** every order the corpus quotes |
| `customers` | 58 201 | was 15 |
| `products` | 116 | was 16 |
| `promotions` | 327 | was 3 |
| `tickets` | 214 | **145** carry a `customer_id`; **52** carry a confirmed `shopify_order_number` and a populated `resolved_context` |
| `ticket_messages` | 451 | all 451 embedded |
| `ticket_investigations` | 80 tickets | 49 `needs_human` · 16 `needs_customer_input` · 15 `answerable` |

**`orders:resolve` and `context:build` have both run.** Outcomes across the 203
categorised tickets: confirmed **52** · no_candidate **138** · mismatch **8** ·
not_found **4** · name_match **1**. The 138 quote no order reference and their
sender matches no order — the resolver's designed answer, not an unrun pass. Any
item below that reads as "blocked until the resolver runs" is stale; what remains
is judging what it produced.

**The investigation has not caught up with it, and it cannot:** only **23 of the
52** resolved tickets carry a case file. The other **29 are closed**, and a closed
ticket is unreachable by both `claim` and `raiseFor` — see item 16. Conversely, 29
of the 52 investigated order-family tickets were read *before* they had an order
number, so their case files are weaker than the data now allows. **Do not read
`--backfill` as the fix**; it reaches 9 already-investigated tickets and none of
these.

**Three tables are empty where entries below assume rows**, and each is recorded
as its own item: `llm_usage` (item 14), `categorisation_review` (item 15), and
`category_forwarding` / `ticket_forwards` (item 1).

## 0a. The two new tools ~~have never been called by the model~~ — THE MODEL DOES CALL THEM; whether it calls them well is unjudged (re-measured 2026-08-17)

`verifyPurchase` and `checkPhotoEvidence` are wired into the registry, the
evidence vocabulary and the case file, and both were run directly over the whole
corpus — so their outputs are measured. **An investigation has since chosen to call
them**, which is what this item said had not happened. The full ledger across the
80 stored case files:

| tool | calls |
|---|---|
| `getOrderContext` | 52 |
| `lookupCustomer` | 49 |
| `searchKnowledge` | 24 |
| `lookupProduct` | 21 |
| **`verifyPurchase`** | **17** |
| `extractPromotionCodes` | 13 |
| `listActivePromotions` / `lookupPromotion` | 12 / 12 |
| `lookupStock` | 8 |
| **`checkPhotoEvidence`** | **3** |

**What that leaves open is the interesting half.** `checkPhotoEvidence` fired 3
times while 36 tickets are `mentioned_not_attached` — the population the tool
exists for — so it looks under-called rather than ignored. And `verifyPurchase` at
17 calls needs reading against the tool-budget concern below.

**To validate:** `cd agent && npm run investigate -- --dry-run --limit 10 --show`
over `product` / `return_exchange` / `delivery` problem tickets, and read for:

1. **Does it call `verifyPurchase` on a ticket that needs it, and does the
   `known_no_orders` wording survive into the case file intact?** The prohibition
   ("never say they are not a customer") is a caveat string; a model can
   paraphrase past it, and that is the failure worth catching early.
2. **Does `checkPhotoEvidence` get called on damage tickets, or only when the
   customer already mentioned a photo?** The 36 `mentioned_not_attached` tickets
   are the ones the tool exists for.
3. **Tool budget.** Both were added to `product`, which now allows five tools
   against a ceiling of six calls. If the agent spends calls verifying a purchase
   on a ticket that only needed `searchKnowledge`, the allow-list is too wide.

**What is already measured** (run directly, 2026-08-17):

| Figure | Value |
|---|---|
| purchase states over 214 tickets | 111 `known_buyer` · 34 `known_no_orders` · 69 `unknown` |
| photo evidence over 203 tickets | 7 `attached` · 36 `mentioned_not_attached` · 160 `none` |
| attachment backfill | 48 of 48 filled, 10 with a photo, 0 failed |
| tickets with a photo, by subject | delivery 2 · return_exchange 2 · order 1 · product 1 · partner 1 |

**Known weakness, not yet decided.** Several last orders are mostly
`- échantillon` sample lines, and the cross-check happily matches a customer's
wording to a free sample — the same failure `product-lookup` already solves for
the catalogue by excluding non-active products. An order's line items cannot be
filtered that way (the customer really did receive the sample), so the honest
options are to down-weight sample lines or to report them separately. Worth
deciding once a real investigation has shown whether it matters.

**Not measured at all: precision of the photo-mention regex.** 36 tickets fire it
and nobody has read them to see how many are `image de marque` in a b2b thread
rather than a customer promising a photo. The matched term is stored in the tool
result precisely so that audit is cheap.

## 0. The refund/returns tile needs its views re-applied (2026-08-17)

`fulfilment_summary` and `fulfilment_summary_by_channel` gained four columns —
`refunded_orders`, `fully_refunded_orders`, `returns_opened`, `refunded_amount` —
and `order_fulfilment_timing` now selects `total_refunded` and `return_status`.
**The deployed views do not have them yet**, so the `Returned or refunded` tile
in the Delivery section renders as a blocked tile naming the fix rather than as a
figure. That degradation is deliberate (`num`, not `count`, in `mapSummary`) and
is itself worth confirming once, because it is the guard against a stale database
reporting *zero orders were ever refunded*.

**To validate:** re-apply the fulfilment views, then load `/insights/fulfilment`.
The views must be dropped first — the baseline uses `create view`, not `create or
replace`, and eight views depend on `order_fulfilment_timing`.

**The figures the tile should show, read straight off `orders` on 2026-08-17:**

| Figure | Value |
|---|---|
| live orders | 2 006 |
| orders with a refund | **3** (0.1%) — `#6398` in full at €32.03, `#6328` and `#6452` in part at €6.23 each |
| returns opened | **0** |
| `return_status` | `NO_RETURN` on all 2 006 — a recorded value, not a null |
| `cancelled_at` | 0 orders |

If the tile shows anything other than 3 and 0, the view is aggregating something
other than what a direct read of `orders` says, and that is the bug to chase.

**The open business question, which no check here can answer:** whether returns
are meant to be raised in Shopify at all. All three refunds were issued with no
return record, so the workflow may well be email-and-refund-by-hand — in which
case 0.1% is a floor on what came back, and the real number is in the support
mailbox. The panel says exactly this in a note rather than presenting the rate as
a fact; confirming it with the business is what would let that note be deleted.

**Each entry says what to check and how, not just that it is unchecked.** An
item is only removed once someone has actually run the check and seen the
result.

Last updated: 2026-08-17 (item 14 closed — the usage sink was never constructed,
now wired and verified; item 16 added — the investigation queue is unreachable,
113 flags stranded on auto-closed tickets; items 15 and the preamble re-measured.)

---

## 15. The categorisation review labels are gone

**`categorisation_review` holds 0 rows**, measured 2026-08-17 across all shops.
The real-mail accuracy figures quoted in `DECISIONS.md` and previously in
`AGENT_INTEGRATION_PLAN.md` — **subject 77%, kind 90%, level 73%** — were derived
from 30 hand-labelled rows in that table. They cannot be recomputed, extended, or
defended against a change to the prompt.

**What is not affected:** the synthetic set (`agent/eval/categorisation-cases.mjs`,
40 cases, 38–39/40) is in the repo and still runs. It guards against regressions
and says nothing about real mail.

**Most likely cause is a rebuild, not retention.** Retention on this table is 3
months and the sample was taken in late July, so it was not swept. The tickets and
messages survived while this table, `ticket_forwards` and `category_forwarding` did
not — which is what a rebuild plus a re-ingestion looks like.

**To close:** `cd agent && npm run review:sample`, label blind (the agent's columns
stay empty until after labelling), and sample toward **~100** rather than back to
30 — at n=30 the harness cannot resolve a change smaller than ~16 points. Then
`npm run review:compare`.

**And treat the old numbers as history, not as a baseline.** A re-sample draws
different emails, so the first re-run is a new measurement rather than a
comparison.

## 16. The investigation queue is unreachable: 113 flags on closed tickets

**Found 2026-08-17 while checking whether the "backlog" was real. It is not.**

| | |
|---|---|
| tickets flagged `needs_investigation` | **113** |
| of those, claimable by the pass | **0** |
| status of all 113 | `closed`, every one, `closed_reason: inactivity` |
| what `--backfill` would raise | **9** — all open, all in scope, and **all 9 already have a case file** |

**Why.** `PASSES.investigation.where` is `{status: 'open', needs_categorisation:
false}`, so `record.claim` only ever sees open tickets. Auto-close retires a thread
after 28 days of silence and **does not clear the pending flags it strands**. This
corpus is historical mail (`last_message_at` spans 2026-05-22 → 2026-08-08), so
139 tickets auto-closed for inactivity, taking their raised flag with them.

`raiseFor` cannot repair it either: it requires `status = 'open'` *and* the flag
already false, so a closed ticket is out of reach from both directions. The flag
now means "was queued once", not "is queued".

**The decision this needs** — it is a design call, not a bug fix, and all three are
defensible:

1. **Auto-close clears the flags it strands.** The queue then means what it says,
   and the closed tickets are honestly abandoned. Smallest change, and it makes the
   `agent_pipeline_funnel` view stop counting 113 tickets as pending forever.
2. **`claim` stops requiring `open` for investigation.** Reading a closed thread is
   harmless — the case file is a note, not a reply — but it spends the mid tier on
   mail nobody is waiting for.
3. **Leave it, and reopen deliberately** when a closed thread genuinely needs work.

**Do not "clear the backlog" before deciding.** `npm run investigate -- --backfill`
today re-runs 9 tickets that already have case files and reaches none of the 113.

**A related consequence worth its own line:** 6 `answerable` and 3
`needs_customer_input` case files sit on tickets that were then auto-closed for
inactivity. The agent worked out that a reply could be written, and 28 days later
the thread was retired without one. That is the cost of Phase 5 not existing,
measured — and a warning that auto-close does not know a draft was possible.

## 14. ~~Nothing has been recorded in `llm_usage`~~ — FIXED 2026-08-17

**Closed.** The cause was neither a broken sink nor a silent `catch`: **nothing
ever constructed a sink.** `usageSink` defaults to `noopUsageSink` in
`createOpenAIClient`, `createEmbeddingsClient` and `createInvestigationStack`, and
the worker's poll and every CLI took the default. Only the three `embed:*`
reconcilers passed one, via `createUsageRecording` — so the table could only ever
have been filled by a manual embedding run.

Every piece downstream was correct and tested: the transport records one entry per
HTTP call, all four call sites pass their `pass` and `ticketId`, and the store maps
and bulk-inserts. The chain was complete except for its first link.

**The fix:** `createShopUsageRecording({supabase, shopId, logger})` hands out the
sink and its flush together, so a caller cannot take one and forget the other.
Wired into `agent/src/index.mjs` (one buffer per process, drained at the end of
every poll, outside `--stop-after` like retention) and into
`agent/src/tools/run-investigation.mjs` — the most expensive pass, and the one
about to be run over a backlog. The eval harnesses keep the no-op on purpose:
re-running the same 40 cases would pollute per-pass cost with measurement.

**Verified end to end** against the live project: one real cheap-tier
categorisation call produced exactly one row —
`pass: categorise · model: gpt-4o-mini · 2415 in / 44 out / 2459 total ·
succeeded: true`. The table went from 0 rows to 1.

Four regression tests pin the pairing, `write: false` (dry runs total the spend and
store nothing), and that a failed write still drains so the next flush cannot
double-count. Agent suite 775 pass, root 1314 pass.

**One row in the table is a test row** — the synthetic call above, no `ticket_id`.
It is left in deliberately: the money was really spent, and a ledger that omits
real spend is worse than one carrying a 2 459-token curiosity.

**Still open from this area:** the default prices in `scripts/lib/llm-rates.mjs`
have not been checked against current OpenAI pricing, so any figure on
`/insights/agent` is only as good as those constants. And the categoriser's prompt
measures **2 415 input tokens per ticket**, which is the first real input to the
cost questions in items 4b and 9.

---

## 13. The per-carrier contact rate is a floor, and its ordering is unconfirmed

**Built and arithmetically verified; the number itself is not yet trustworthy.**
The carrier table now reports how many of each carrier's shipments produced a
ticket. Verified: shipment counts unchanged after the ticket join
(1,311 / 198 / 6 — the lateral does not multiply rows), orders counted rather
than threads, and the panel renders the coverage caveat from
`fulfilment_ticket_coverage` rather than from copy.

**Why it is a floor.** A thread reaches a parcel only through
`tickets.shopify_order_number`, and **52 of 214 tickets carry one**. So the
column under-counts by an unknown factor.

**The claim on the panel that is not yet proven:** *GLS is contacted 4.1× as
often as Colissimo* (10 of 198 against 16 of 1,311). The reasoning is that the
under-counting hits both carriers alike, so the **ordering** survives even though
the absolute rates do not. That assumption has not been tested, and the
numerators are 10 and 16 — small enough that a handful of misattributed threads
would move the ratio.

**The check to run, in order:**

1. Run `orders:resolve` over the ticket backlog, then re-read the column. If
   coverage rises from 52/214 and GLS stays several times Colissimo, the
   ordering is real.
2. Test the even-bias assumption directly: of the 52 attributable tickets, is
   the GLS/Colissimo split materially different from the split among tickets
   that quote no order number but do carry a `customer_id`? A carrier whose
   customers happen to quote order numbers more often would produce this gap on
   its own.
3. Only then is it worth asking whether GLS deliveries are actually worse. Note
   what the panel already shows: GLS dispatches *faster* (23.3h vs 24.5h) and is
   late less often (13.1% vs 16.1%), so whatever drives the contact gap is not
   dispatch — it is the half of the journey the Delivery section cannot see.

---

## 12. ~~The per-channel fulfilment views have never been applied or read~~ — APPLIED 2026-08-16

**Closed.** `order_fulfilment_timing` now carries `channel` /`channel_label` and
three channel-cut views exist beside the store-wide three. Applied **forward**
to the dev database the same way item 10 was — the block was sliced out of
`06_analytics.sql` itself, not retyped, run in one transaction after a
`drop view ... cascade` that only reached the four dependent fulfilment views,
then `pgrst reload schema`; the scratchpad script was discarded. No table was
touched. Verified after the fact:

| Check | Result |
|---|---|
| four channels present, summing to the whole book | web 1500 + amazon 467 + connect-dev-1 36 + shop-72 3 = 2006 |
| `fulfilment_summary` unchanged (still one row per shop) | yes |
| Amazon p50 / p90 / past-72h | 23.0h / 69.1h / 39 of 467 (8.4%) |
| Amazon monthly series | Feb–Aug 2026, July the outlier at 31.7% |
| Amazon bucket histogram sums to `measured` | 93+156+114+65+22+17 = 467 |
| read through **PostgREST**, not just SQL | yes — the panel renders from it |
| `/insights/fulfilment` renders the section | 200, tiles and both figures populated |

**What this surfaced, and what is not yet checked:** **402 of 467 Amazon orders
(86%) carry no tracking number**, against 4 of 1,487 on the online store. The
panel states this as a marketplace data gap rather than a dispatch failure —
that reading is *inferred, not confirmed*. The check: open two or three of those
Amazon orders in Shopify Admin and see whether a tracking number exists there
and is simply not on the fulfilment record we sync, or whether none was ever
captured. Those are different problems and only one of them is ours.

---

## 11. ~~Local dashboard validation is blocked by recurring Supabase fetch failures~~ -- FIXED 2026-08-16

**Closed.** Two separate things looked like one recurring Supabase issue:

- A dev server started inside the restricted Codex environment could not reach
  Supabase at all, so server-side reads ended as `fetch failed`.
- With network access allowed, the configured key reached Supabase but old client
  headers sent `Authorization: Bearer sb_secret_...`, which new Supabase secret
  keys reject because they are not JWTs.

The user-visible symptom was the app shell rendering while server-side Insights
reads fell into the panel error state with:

```text
Supabase request failed after 4 attempts: fetch failed
```

The tight repro captured before the fix:

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:3001/insights/support
```

Result before the fix: HTTP 200, `Support` shell present, and the rendered payload contains
`Supabase request failed after 4 attempts: fetch failed`.

**Fix:** `scripts/lib/supabase-rest-client.mjs` now builds headers through
`supabaseHeaders()`: new `sb_*` keys are sent as `apikey` only, while legacy
JWT-shaped keys still get `Authorization: Bearer ...`. The direct
`countCorpusMessages()` HEAD request in the Support panel uses the same helper.

**Verified after the fix:** a fresh dev server with network access on port 3002
rendered `/insights/support` with no Supabase panel error. Browser check found
`Message volume by cluster`, one cluster table caption, and 46 topic-map tiles.

**Tests:** `node --test .\scripts\lib\supabase-rest-client.test.mjs`,
`npm.cmd run typecheck`, `npm.cmd run lint`, and `npm.cmd run build` in `web/`,
and root `npm.cmd test` (**1271 pass**).

---

## 10. ~~The new schema objects have never been applied~~ — APPLIED 2026-08-15

**Closed.** The three views, `order_number_range()` and the `ticket_messages`
dimension check are live on the dev database, applied **forward** rather than by
rebuilding from empty — so the 214 ingested tickets, 451 messages, 2014 orders
and 58 201 customers are untouched. Verified after the fact:

| Check | Result |
|---|---|
| all four objects present | yes |
| `security_invoker=true` on all three views | yes |
| `anon` / `authenticated` privileges on the views | none |
| `ticket_messages_embedding_dimensions_check` present | yes, 0 rows violated it |
| row counts before vs after | 214 / 451 / 2014 / 58 201, unchanged |
| `ticket_message_counts` sums to live messages | 451 = 451 |
| `ticket_first_inbound` rows vs tickets with inbound mail | 203 = 203 |
| `ticket_queue` rows / with a customer | 214 / 141 — matches the documented link rate |
| read through **PostgREST**, not just SQL | 214 rows; schema cache reloaded |
| `orders:resolve:dry-run` end to end | 159 considered, 6 confirmed, 9 mismatch |

**How, and why it is not in the repo.** The forward statements were extracted
from the baseline files themselves (not retyped), applied in one transaction
from a scratchpad script, and the script was discarded. Checking a forward step
in beside the baseline is how a baseline turns back into a history — the thing
the 8→5 split was done to stop. The baseline remains the definition; this was a
one-off to avoid paying for it with the corpus.

**What is still deferred:** nothing about the schema. The remaining reason to
rebuild from empty is unrelated to this refactor.

---

## 1. Forwarding has never actually sent a message — and its ledger is now empty too

**Status, re-measured 2026-08-17:** `ticket_forwards` holds **0 rows** and
`category_forwarding` holds **0 addresses**. So the pass cannot route anything at
all today: a null address is the off switch, and every category is off.

**What the ledger used to say**, and what the failure was: 42 messages queued at
`attempts=2`, 0 sent, every attempt returning `ErrorMailboxMoveInProgress` —
Exchange migrating the mailbox between databases, transient and Microsoft-side.
`Mail.Send` is granted and verified working: a direct `sendMail` test to
`onouailhetas@lap-groupe.com` returned HTTP 202 and arrived. Only the `/forward`
action was blocked, because it reads an item from the store being moved.

Those 42 rows are gone with the same rebuild that emptied item 15's table, so the
`unique(ticket_message_id)` guard no longer has a backlog behind it — **a first
real run would forward from scratch**, which changes the blast radius of the "42
messages, some dating to January, going out at once" warning below rather than
removing it.

**Before anything else on this item:** set at least one address, and note that
`/forward` addresses the original message by Graph id, so it is also gated on the
mailbox decision (`README.md` step 3).

**To validate:** once the move completes, `cd agent && npm run forward:dry-run`
then `forward:once`. Confirm the recipient receives the original mail **with its
attachments intact** — a CV arriving as a CV is the entire reason `/forward` was
chosen over composing a new message, and it is the one thing no test covers.

**Also unvalidated:** the three configured addresses all point at the support
mailbox itself (fine for a smoke test). Before real colleagues receive anything,
confirm the first run's backlog behaviour is acceptable — 42 messages, some
dating to January, going out at once.

## 2. ~~Abandoned-checkout lookup~~ — VALIDATED 2026-08-01

**Closed.** Tested against a real abandoned checkout in the dev store.

- **The tool works end to end.** Found the checkout by email over a 90-day
  window, matched case-insensitively, returned a clean negative on an unknown
  address, and fed the basket into the promotion checks.
- **`discountCodes` is populated** — the record carried `["QIRINESS10"]`, which
  had been applied (244.30 gross, 24.43 off).
- **The free-text email filter DOES work.** `query:"<email>"` returned exactly
  the matching row and `query:"zzz-no-such-person@..."` returned none, so it
  filters rather than being ignored. `email:<address>` also works. This is now
  a live optimisation opportunity: the date-window scan can be replaced by a
  direct filtered query. Left as-is for now because the current path is proven
  and the optimisation is not yet needed at this volume.

**A real bug fell out of it.** `subtotalPriceSet` comes back **net of discount**
— 244.30 in line items, 24.43 discount, 219.87 reported. Minimum requirements are
evaluated by Shopify on the *pre-discount* subtotal, so measuring against 219.87
would have told a customer with a qualifying basket that they were 20 € short.
`normaliseCheckout` now reconstructs `subtotalBeforeDiscount` from the line
items, the minimum check uses it, and the wording says "(avant remise)".
Regression tests carry the real numbers.

**A second correction, 2026-08-01.** Shopify keeps **one abandoned-checkout
record per checkout session and mutates it in place**. Observed live: the same
id went from `["QIRINESS10"]` / 1 item / 219.87 to `[]` / 2 items / 82.25, with
`createdAt` unchanged at 18:38:03 and only `updatedAt` moving to 18:57:33. The
record is therefore a snapshot of *now*, not a log of the attempt. Consequences:
the basket recovered may not be the basket at the moment the code failed, and
dating a reply from `createdAt` would have shown the session's start time beside
contents from twenty minutes later. The tool now carries `updatedAt` and dates
the basket from it ("état du …").

**Still open from this area:**

- **Whether a *rejected* code appears in `discountCodes`.** The tested checkout
  had a *successfully applied* code, so this is untouched. The expectation
  remains that Shopify records applied codes only, and the tool already treats
  absence as `unknown` rather than evidence. **To validate:** abandon a checkout
  with a deliberately invalid code and inspect the record.
- ~~**When an abandoned checkout is created.**~~ **Answered 2026-08-01** (by the
  store owner, not measured here): Shopify creates one once the customer has
  entered their **email** and then leaves the basket unattended for about **10
  minutes**. So the tool can only ever return something for customers who got as
  far as identifying themselves at checkout — which is also the population that
  could have been trying a discount code, so the overlap with "why doesn't my
  code work?" is favourable. A shopper who never entered an email leaves no
  trace, and for them the basket stays invisible.

## 3. Promotion eligibility has never seen a real minimum requirement

All three dev discounts have `minimum_requirement: null` — the thresholds come
from `customer_buys` on the BXGY code instead. The subtotal and quantity branches
of `describeMinimum` and of the basket evaluation are covered by unit tests with
synthetic rows only.

**To validate:** create (or sync) a discount with a real minimum-spend
requirement and confirm `rule_snapshot.minimum_requirement` populates as
`{ type: 'subtotal', amount, currency }`.

**Also unvalidated:** `customer_selection` has only ever come back as
`{ scope: 'all' }`. The `segments` and `customers` branches are untested against
real data.

## 4. Knowledge retrieval bands are calibrated on a small, general library

**Re-derived 2026-08-09** against the labelled retrieval set on 61 chunks:
`ANSWERABLE = 0.60` unchanged (no irrelevant chunk in the run reached it),
`WEAK` moved 0.45 → 0.50 because 0.45 sat below the irrelevant p75 of 0.458.
That is a real improvement on real measurement — restraint 30% → 70%, band
accuracy 44% → 69%, at no recall cost — but it rests on **16 labelled cases**,
and the library is still general: mostly policies and brand pages, with no
delivery or promotions article yet.

**To validate:** after specific content is written and approved, re-run
`npm run eval:retrieval` and `npm run eval:diagnose` and re-do the threshold
sweep. The expectation to test is that *relevant* scores rise as content gets
specific, which would make `WEAK = 0.55` (restraint 90%, band accuracy 81%)
affordable — today it costs a real answer. The bands are named constants in
`retrieval-rules.mjs` precisely so they can be moved.

**Two known gaps in the harness itself**, both making entity accuracy read worse
than the pipeline is: the eval measures the raw code regex rather than the real
`extractCodes` (which filters against the live store list), so precision reads
11%; and product-entity matching returns 0/0, which has not been diagnosed.

## 4c. Evidence needs: step 1 is built, STEP 2 IS NOT

**Status:** the report exists and is stored (`ticket_investigations.evidence_gaps`).
Nothing acts on it. This is deliberate, and it is not finished work.

**What step 2 is**, once the numbers below say the vocabulary can be trusted:

1. **Enforce.** An `answerable` verdict that left a declared need open gets
   downgraded, the same mechanism that already forces `needs_human` on an empty
   `established`. Any open `other_fact` forces it outright.
2. **Steer.** The prompt says *"you still do not have X"* instead of restating
   the whole per-subject checklist every turn.
3. **Exit early.** When every need is satisfied after the opening moves, skip the
   exploration turn entirely — one `gpt-4o` call saved on the common case.

**Do not start step 2 on unvalidated numbers.** A vocabulary that over-declares
would downgrade good case files for reasons about the list rather than the
ticket, and an early exit on an under-declared list would stop an investigation
that should have continued. Step 1 cannot make the agent behave worse; step 2
can.

**To validate, then decide:** run `npm run investigate:dry-run` over a real batch
and read the `Preuves attendues vs obtenues` summary. Four questions:

1. ~~**Is `not_attempted` ever non-zero?**~~ **Answered 2026-08-17: 3.** Across the
   80 stored case files the need states are satisfied **109** · attempted **100** ·
   unavailable **39** · `not_attempted` **3**. The loop is very nearly always
   calling the tools it was allowed, so **step 2's steering is not worth building**
   — the remaining value in step 2 is enforcement and the early exit, and those
   depend on questions 2 and 3 below, which are still open.
2. **Is the model over-declaring?** Needs it names "just in case" inflate the
   denominator and would make step 2's enforcement punitive. Read a sample
   against the emails.
3. **How often is `other_fact` declared, and on what?** That log is the evidence
   for growing the vocabulary. See item 4d.
4. **How often is `checkout_state` needed?** It always resolves `unavailable`
   because the abandoned-checkout tool is not in the registry. A high count is
   the argument for wiring it; a low one settles that it was right to leave out.

## 4d. The 19-fact vocabulary is a first guess and needs revisiting

Written 2026-08-09 from reasoning about the corpus, not from measurement. It will
be wrong somewhere — one gap (`checkout_state`) was spotted while writing the
list itself.

**Revisit once a few hundred tickets have run.** The `other_fact` log says what
could not be named; the per-need satisfaction rates say which needs are declared
constantly and never met (either a missing tool or a need drawn too broadly).

**Costs are not symmetrical, so treat them differently:**

- **Adding a need type is cheap.** Old rows never declared it; old measurements
  stay valid for what they measured.
- **Changing what *satisfies* a need is cheap.** The ledger is stored in
  `tool_calls`, so re-run the predicate over historical rows — no model calls.
- **Changing what a need *means* is medium.** Historical rows carry the old label
  under the old meaning, but the emails are stored, so re-running the decomposer
  re-declares them at one `gpt-4o-mini` call per ticket.
- **The expensive one is trust.** Once an operational decision has been made on a
  number derived from these, redefining the type means that decision rested on a
  different basis than its label implies. That cannot be re-run away.

**And a churning vocabulary means no baseline** — every redefinition resets the
"before". So: let it move freely until the first few hundred tickets have run,
then freeze it before drawing any conclusion from the numbers.

## 4b. Task decomposition has never seen a real email

Built and unit-tested 2026-08-09; **not run against live mail.** 35 tests cover
the pure rules, the model call and the wiring, including a no-regression check
that a single-task ticket produces identical opening moves and an identical
prompt to the pre-decomposition path. But no real ticket has been split yet.

**To validate:** `cd agent && npm run investigate:dry-run -- --show` over tickets
that are known to contain two requests, and check three things:

1. **Is it splitting mail that should not be split?** The prompt says one request
   is the normal case, and the gate (`≥320 chars`, `≥2 ?`, or a second subject
   from the categoriser) fires on plenty of ordinary long emails. Count how often
   a decomposition returns 2+ tasks and read a sample. Over-splitting spends
   model calls and dilutes the case file; it is the failure to watch for.
2. **Are the sub-questions faithful?** A paraphrase that drops the product name
   is handed to the IDF-weighted matcher and matches worse than the raw text
   would have. The verbatim `entities.products` are prepended to defend against
   exactly this — check they are actually being extracted.
3. **Does the skipped-task declaration reach the case file?** A `delivery` half
   of a `product` email must appear under `## Non vérifié` or force
   `needs_human`, not vanish. This is prose in the prompt, not a code guarantee,
   so it is the part most likely to be ignored by the model.

**And the cost has not been measured.** Decomposition adds one `gpt-4o-mini`
call to every long ticket. Check OpenAI usage before the worker runs unattended,
alongside item 9's unmeasured investigation cost.

## 5. Product tools run against a thin catalogue

Of 16 products: 5 have `usage_instructions`, 3 have `active_ingredients`, 3 have
`product_faqs`. The tools return what exists, so a usage question finds nothing
for 11 of 16 — a merchandising data gap, not a code one.

**To validate against a real catalogue:** that IDF weighting still separates
products when there are hundreds rather than sixteen (the `creme`-vs-`led`
weighting is a function of catalogue size), and that `ambiguityMargin = 0.12`
still reports genuine ambiguity without flagging every near-name.

## 6b. The order family was enabled with mismatches unexamined — OPEN AUDIT, and the count has fallen to 8

**Opened 2026-08-13, by decision rather than oversight.** `ENABLED_SUBJECTS` now
contains `order`, `delivery`, `payment` and `return_exchange`.

**Re-measured 2026-08-17:** the resolver now records **8 `mismatch`** (down from 15,
after the `message_email` rule rescued 6), plus **4 `not_found`** and **1
`name_match`** — 13 refusals in total, against 52 confirmed. Read the 8; they are
the cases where the number is real, the sender does not own it, and no address in
the message text ties them to it.

**Why it was judged safe.** A mismatch is an order number that parsed correctly
against a real order and was refused because the requester's email hash does not
own it. `isSafeToWrite()` gates the column, so a refused resolution leaves
`tickets.shopify_order_number` **null**. The agent cannot answer about the wrong
order because it never learns which order that was. The failure mode is not a
wrong answer.

**What it does cost.** On those 15, `getOrderContext` reports `not_resolved`, the
`order_identity` need goes unsatisfied, and the agent asks the customer for an
order number they already sent. Annoying, and visible to the customer.

**The working hypothesis is that the check is too strict** — a gift, a partner
ordering for someone else, a customer writing from a second address. Subjects
like *"RE: remboursement commande #5229"* point that way. If that is right, the
fix is in the resolver's identity rule, not in the data.

**To close this item:**

1. Read the 8. For each, decide whether the requester genuinely owns the order.
   `metadata.order_resolution` holds `status`, `candidates`, `email_status` and
   `suggested_action` per ticket.
2. If most are second-address customers, loosen the rule — `message_email`
   already rescued 6 of the original 15 by hashing every address in the body, so
   the remaining ones are those where no address in the text matches either.
3. Count how many tickets asked a customer for an order number they had already
   supplied. That number is the real cost of having enabled early, and it is the
   one to quote when deciding whether the trade was worth it.

**Do not close this by observing that nothing broke.** Nothing breaking is the
predicted outcome; the open question is how often the agent looked foolish.

## 6. Order-number resolver: logic validated end to end, live matching blocked

**Validated 2026-08-01 with a real-data fixture.** Real dev orders and customers,
real corpus email text with the order number substituted, the real store (so the
order lookup and range check genuinely queried Supabase), run dry. All five
scenarios behaved as expected:

| scenario | result |
| --- | --- |
| right owner, right order | `confirmed` via email |
| someone else quoting that order | `mismatch`, not written |
| no email on the ticket, names agree | `name_match`, not written |
| different email, same name | `name_match`, not written, asks for purchase email |
| different email, different name | `mismatch`, not written |
| order number the shop never had | `not_found` |
| untouched corpus text (`#4009`) | `not_found` |

**The range wording was refined off the back of it.** The check had concluded
that anything outside the synced span was "likely not an order number at all",
which it said about `#4009` — a real order, absent only because the dev store
holds twelve rows. `not_found` was the correct status; that explanation was not
something the data could support, since `max` is always somewhat stale (orders
are created continuously, the sync runs on a schedule).

Now proportionate, per the shop owner's call that the max is genuinely useful for
catching typos while orders older than ~6 months are out of scope:

| candidate vs. synced range | wording |
| --- | --- |
| below `min` | "likely older than the ~6 months of orders we keep" |
| just above `max` (within 25%, floor 500) | "may simply be too recent to have synced" |
| far above `max` | "most likely a typo or a reference that is not an order number" |
| inside the range | "no record, though it falls within the orders we hold" |

The absolute floor matters on a small or freshly seeded catalogue, where 25% of
twelve orders is three. Four regression tests hold these apart.

**What still cannot be exercised** is a real confirmed match on live mail: a dry
run over 488 tickets gives 139 `not_found`, 349 `no_candidate`, **0 confirmed**,
because the corpus quotes 101 distinct numbers from 302 to 70853 and the dev
store holds twelve.

**The digit cap is gone.** Order numbers start around four digits and keep
counting as a store sells, so the original `{3,6}` would have silently stopped
parsing once the store passed 999,999 orders — a failure that reads as "we
cannot find your order" rather than as a bug. Length is no longer treated as
evidence: the parser accepts 3-10 digits behind a `#` or `commande`, and the
**database decides** what could be an order. The store's real
`min(order_number)`-`max(order_number)` is read once per pass and used to say
"70853 is outside this shop's issued order numbers (1001-6300)" instead of a
flat "not found".

**To validate once real orders are synced:** run `npm run orders:resolve:dry-run`
and check (a) the confirmed rate, (b) that no `mismatch` is a false alarm caused
by a customer legitimately writing from a second address, and (c) that the range
check does not call genuine orders out of range while the orders table is still
partially synced — a half-synced catalogue reports a narrower range than the
shop has really issued, which would mislabel real numbers.

**Check (b) answered, 2026-08-12, and it was a false alarm 6 times out of 15.**
Each of the six quoted the order's *registered* address somewhere in the message
while writing from another one — three by forwarding the Shopify order
confirmation, three quoting it another way. Those now resolve as `confirmed` via
`verified_by: message_email` (see `DECISIONS.md` → Order resolution), taking
coverage to 50 of 214 tickets. **The remaining 9 are still unreviewed** and are
the real question: a `mismatch` now means the number is real, the sender does not
own it, and nothing in the message ties them to it.

**Still open on this item:** the six writes are validated only by the dry run and
the unit tests. Nobody has yet read the six tickets to confirm the order written
is the order the customer is actually asking about.

**The order-context bundle has now run over live tickets.** Re-measured
2026-08-17: **52 tickets carry a populated `resolved_context`**, one per confirmed
order number, and `getOrderContext` is the most-called tool in the whole ledger (52
calls across 80 case files). The earlier note that `context:build` "currently
considers zero" is retired.

**Two things are still unread.** Whether the bundle each of those 52 tickets got is
the order the customer was actually asking about — the same human check as the six
`message_email` writes above, over a larger set. And 28 of the 52 have no case file
at all yet, so most of this data has not been exercised by the agent (see the
preamble).

**Tracking is settled rather than blocked:** Shopify has no live parcel status here
(`delivered_at` on 1 order in 2 006, `in_transit_at` on none), so the tool can
report a number and never a state. See `AGENT_INTEGRATION_PLAN.md` § Open questions
for the four ways forward.

## 6c. A product name is being looked up as a discount code — KNOWN BUG

**Found 2026-08-14**, on the third ticket after evidence `details` were switched
on. A `product` ticket produced:

```
promotion_validity   satisfied   not_found   { code: "MASQUELEDVISAGE", found: false }
```

**FIRST DIAGNOSIS WAS WRONG, corrected 2026-08-14 by reading the email.** It
blamed `CODE_PATTERN` (`\b[A-Z][A-Z0-9]{3,}\b`) for matching a capitalised
product name. The source message contains **no all-caps run of four characters
anywhere** — the customer wrote « votre Masque LED visage » in ordinary case, and
`extractPromotionCodes` correctly found nothing, which is why
`promotion_identity` reads `none`.

**The model invented the argument.** With no code extracted, it called
`lookupPromotion({ code: 'MASQUELEDVISAGE' })` — a code-shaped string it composed
from the product name in the text — and the tool dutifully reported `not_found`,
which `evidence-rules` recorded as `promotion_validity: satisfied`.

So the regex is innocent and tightening it would fix nothing. The fault is a tool
argument that quotes the customer without being the customer's words.

**It found itself.** The finding alone reads as unremarkable; only the detail
shows the subject is nonsense. That is the argument for details generally, and
it is why this is filed rather than forgotten.

**Harm today is small and not zero.** The verdict was `answerable` either way, so
nothing wrong reached a customer. But a satisfied need is a need the loop stops
collecting, and `promotion_validity: not_found` is a branch answers key on — an
answer set could select "your code does not exist" for someone who never quoted
a code.

**THE FIX, and it generalises past promotions:** a tool argument that purports to
quote the customer must actually appear in the customer's message.
`lookupPromotion` now refuses a code absent from the ticket text and reports
`no_code_in_message` rather than looking it up, so a fabricated argument produces
no finding at all instead of a false one.

That rule is already the codebase's instinct elsewhere — the decomposition's
`entities` are "the one part the model was told to copy rather than rewrite", and
`promotion-lookup.mjs` says outright that when no code is named the tool "says so
rather than guessing which of three active promotions was meant". Guessing was
still reachable, just from the model's side of the boundary rather than the
tool's.

**What it deliberately does not do:** block the model from asking what offers
exist. `listActivePromotions` is the honest path for "is there something else I
could give this customer", which is a real support move and stays available.

**A second wrong guess, corrected by reading the whole email 2026-08-14.** This
entry previously called the routing suspect — "the decomposer split a *product*
ticket into a `promotions` task at all". It did not mis-split. The customer's
last paragraph asks outright: « avez-vous une offre ou une remise en cours sur ce
masque, ou un code promotionnel dont je pourrais bénéficier ? » Binding the
promotion tools was correct.

**And the agent answered that question well.** `listActivePromotions` found
`UKLED20` — 20 % off this exact mask — and the case file established it. That is
the propose-an-alternative-code case working on real mail.

**So the fault is one spurious call, not a misrouted ticket.** Having already
answered the promotion question, the model made an extra `lookupPromotion` with a
code name invented from the product. It cost a tool call and left a junk
`promotion_validity` finding; nothing a customer would see changed. The guardrail
above removes the finding. Whether the extra call is worth chasing further is a
budget question, not a correctness one.

## 7. Two sync gaps that would each close a real check

- **Order-level discount codes.** `orders` stores `total_discounts` (an amount),
  never which codes were applied, so `applies_once_per_customer` can be stated as
  a rule but never verified. Fixable in the orders sync query.
- **The live basket.** Not fixable: there are no cart tables and the Admin API
  does not expose an in-progress cart. The abandoned-checkout lookup is the
  partial substitute, and only for customers who reached checkout.

## 8. Automatic customer resolution HAS run — the link rate is 145 of 214, and nobody has spot-checked it

**Status, re-measured 2026-08-17:** it has run for real against the live table.
**145 of 214 tickets carry a `customer_id`** (68%), against 58 201 synced
customers. The premise this item was written under — a 15-customer dev store making
the match rate meaningless — is gone.

**What is now worth checking is correctness, not coverage.** Any ticket linked to a
customer whose address does not match the requester is a hash collision or a
denylist gap, and it is the kind of bug that quietly puts one customer's order
history in front of another's email. Spot-check a sample of the 145 by comparing
`ticket_first_inbound.from_email` against the linked customer's address.

**The three questions below are still worth reading off a dry run**, which now
reports on the 69 unlinked rather than on all of them: `cd agent && npm run
customers:resolve:dry-run`.

1. **How many tickets are refused as `not_a_customer_address`.** These are the
   contact-form messages whose body did not parse, leaving Shopify's mailer as
   the requester. The count is a direct measure of the parser's blind spots on
   live mail — the ingestion fix took the worst hash collision from 73 tickets
   to 8, and this number should be in that neighbourhood. If it is large, the
   fix is in `contact-form.mjs`, not here.
2. **That `no_match` dominates and that this is expected.** A form-entered
   address is frequently not the address the Shopify account was created with,
   which is unresolvable by design — the tool can only match what the customer
   typed. Worth measuring before anyone treats an unlinked ticket as a fault.
3. **That the daily retry does not thrash.** After a real (non-dry) run, a
   second pass minutes later must report every ticket as `deferred` and write
   nothing. That gate is what keeps a 60-second poll from rewriting a metadata
   row per unmatched ticket per minute.

**The "565 tickets" this item was written against no longer exists** — the live
table holds 214. Read the counts above rather than any figure quoted from that
larger corpus.

## 9. The investigation agent has run, and what it produced is not yet judged

**Status, re-measured 2026-08-17:** run for real on **80 tickets** — 15
`answerable`, 16 `needs_customer_input`, 49 `needs_human`. **70 of those 80 sit on
tickets that are still live** (48 `awaiting_human`, 13 `awaiting_customer`, 9 open
and `answerable`); the other 10 were auto-closed. The 113 tickets still carrying
`needs_investigation` are **not a backlog** — every one is closed and unreachable
(item 16).

| Shape of the 80 case files | |
|---|---|
| median `established` claims | 2 overall, **3** on an `answerable` verdict |
| median `unverified` / `missing` / `do_not_claim` | 2 / 0 / 2 |
| case files with **0** established | 12 — every one forced to `needs_human`, which is the rule working |
| `answerable` by level | L1 3 · L2 10 · L3 2 |
| `answerable` by subject | promotions 5 · product 4 · delivery 3 · order 3 |
| `answerable` carrying prohibitions | 10 of 15 |

Its guardrails were checked against what was actually written: **0 unsourced
claims stored, 0 claims dropped, 0 internal handoffs reaching a drafting
projection, and a maximum of 3 tool calls in any run against a ceiling of 6.**
Those are mechanical properties, and they hold.

**`needs_human` is 49 of 80 (61%), up from 25 of 40.** The expected cause is
unchanged and is now measurable: retrieval has **zero chunks** in `delivery`,
`order`, `promotions`, `payment` and `product_stock`, so for the highest-demand
subjects there is genuinely nothing to answer from. If it stays this high after
that content is written, the cause is the agent.

**What has not been checked is whether the case files are any good.** Nobody has
read a set of them against the emails that produced them and said "yes, a writer
could reply from this". That is a human judgement and it is the only one that
matters here — every mechanical check above can pass while the content is thin.

**To validate:** `cd agent && npm run investigate -- --dry-run --limit 10 --show`
and read the ten dossiers next to the original emails. Three questions:

1. **Is anything in `## Établi` actually false?** This is the one failure that is
   worse than no case file at all, because the drafting agent will treat it as
   ground truth. The ledger check proves a tool *ran*; it cannot prove the model
   read the tool's answer correctly.
2. **Is `needs_human` being used as a shrug?** 25 of 40 is high, and the expected
   cause is the knowledge library — retrieval reports `weak` or `none` on most
   product questions today, so there is genuinely nothing to answer from. If it
   stays this high *after* the ~46 messages' worth of product content is written,
   the cause is the agent, not the library, and the prompt needs the work.
3. **Do the `## Non vérifié` entries belong there?** The line between "the
   customer asserted this" and "a tool established this" is the agent's core
   discipline, and a model putting real tool output under *non vérifié* is
   throwing away evidence as surely as the reverse is inventing it.

**The order family is no longer dormant.** `order`, `delivery`, `payment` and
`return_exchange` are in `ENABLED_SUBJECTS` and all 52 tickets carrying a confirmed
order number have been investigated. **The ten-day stale-parcel trigger still
cannot fire**, and that is now settled rather than pending: `delivered_at` is set
on 1 order in 2 006 and `in_transit_at` on none, so there is no timestamp to do the
arithmetic on. See `AGENT_INTEGRATION_PLAN.md` § Open questions.

**And the cost is not yet measured.** 40 runs on `gpt-4o` at 1-3 tool calls each
is cheap; 565 tickets re-investigated on every customer reply is a different
number, and nobody has looked at it. Check the OpenAI usage for these runs before
the worker is left running unattended.
