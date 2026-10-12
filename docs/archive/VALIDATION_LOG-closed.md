# VALIDATION_LOG archive: closed items

Moved verbatim from `VALIDATION_LOG.md` on 2026-10-12, in their original order. Open items: `VALIDATION_LOG.md`.

## 20. ~~The translated library is written but unproven~~ — RESOLVED 2026-09-09, end to end (built 2026-09-09)

562 translations over 140 phrasings, generated, imported, embedded and measured
the same day. See `CHANGELOG.md` 2026-09-09 and `DECISIONS.md` § "Translate the
library, not the query".

**Every check this item asked for has been run.**

- **Imported.** `support_exemplar_phrasings` holds **706** rows — 702 from the
  document plus P-21's 4, dashboard-authored and correctly untouched. Approval
  unchanged at 38, 0 stale rows removed.
- **The language column tells the truth.** It read `fr` on all 144 rows before,
  including the eleven that are not French. It now reads en 6 / es 3 / nl 2 on
  the authored variants, and the target language on all 562 translations.
- **The forward step is applied, before the embeddings.** The multiplier is
  **64** in the database. The SQL was extracted from `05_exemplars.sql` rather
  than retyped, asserted to be one `create or replace function` carrying no
  `drop`/`truncate`/`alter table` and a multiplier above the 60-row ceiling, and
  applied through `db:apply:migration`. The script was discarded.
- **Embedded: 696 of 706.** The 10 without a vector are O-11's, which is
  soft-deleted — the reconciler excludes deleted exemplars deliberately. D-33 is
  the largest exemplar at 40 embedded phrasings, inside 64.
- **Measured on a same-corpus A/B**, since the historical figures were taken over
  214 tickets and the corpus is 328. `--authored-only` scores the French library
  alone: **125 → 133 tickets clear MATCHED**, Italian 0 → 4 of 6 on a +0.132
  median, English +0.032 and no band movement, Spanish unchanged and winning
  nothing with a translation because it already carries real Spanish phrasings.
- **The prediction was 14 tickets and ~7%. The answer is 8 and 6.4%** — recorded
  as the smaller number.
- **Confirmed against the live RPC**, which is what the eval could not do:
  12 non-French tickets through `match_support_exemplars()`, **3 exemplars
  returned on 12 of 12**, none starved.
- Tests: 2061 root, 1299 agent, typecheck and lint clean.

**Two findings this closed out, both recorded rather than silently fixed:**

1. **The eval scored 38 exemplars where the RPC scores 37** — `deleted_at` was
   filtered on tickets and not on exemplars. Fixed. It changed no per-language
   median, because O-11's phrasings sit verbatim under O-09 which absorbed them;
   only the overall median moves 0.626 → 0.627.
2. **O-11 is merged away but still in `Email-Example-Queries.md`.** The importer
   re-creates it on every run and the translator paid to translate it 8 times,
   for a situation that can never be retrieved. Inert, not broken.

**What is left, and none of it blocks anything.**

- **Delete O-11 from the document**, or accept an exemplar that is re-created and
  re-translated on every import and can never win.
- **P-21 is never translated.** It exists only in the database, so the
  translator — which reads the document — cannot see it. Either write it into
  `Email-Example-Queries.md` or accept one French-only approved situation.
- **~130 of the translations are unread.** Four sources were spot-checked across
  all four targets; the rest were not. The register rule fails quietly — a
  translation that tidies « jai pas recu ma commande » into correct English
  rebuilds the mismatch the variants exist to remove, and it looks fine to a
  reviewer skimming for meaning. A 240 KB diff, and a reading job for whoever
  reads the target language.
- **The bands were calibrated on the French-only library.** `MATCHED` 0.65 and
  `NEAR` 0.55 predate 562 rows landing in the pool, and the score distribution
  has shifted under them. Worth re-reading the sweep in section 2 of
  `eval:exemplars` before trusting the bands on non-French mail.

## 18. ~~The case-file tool caches in a probe, not yet in a real batch~~ — RESOLVED 2026-09-09 on a real batch (built 2026-09-07)

The closing investigation call stopped carrying `response_format` and now returns
the case file as a forced `finalize_investigation` tool call, to keep it in the
same prompt-cache partition as the loop turns. See `CHANGELOG.md` 2026-09-07 and
`codex_plans/Model_Cost_Notes.md` § SOLVED 2026-09-07.

**Closed by `npm run investigate -- --backfill --include-closed --limit 12` on
2026-09-09**: 12 considered, 10 investigated, 2 skipped, **0 failed**, 45 model
calls and 78 740 tokens, 45 rows in `llm_usage`.

**Check 1 — PASSED, 10 of 10.** Every ticket's LAST investigate call now reports
a non-zero `cached_input_tokens` (1 152 – 3 840), where it was 0 on 8 of 8.
`report:prompt-cache --since 2026-09-09`: the investigate pass caches **61%**
against 21% in the last pre-fix window (2026-09-05), and per turn within a run:

| turn | calls | avg cached | share | before the fix |
| --- | --- | --- | --- | --- |
| 1 | 10 | 0 | 0% | 0% — expected, a run cannot hit on its first call |
| 2 | 10 | 1 792 | **87%** | 56% |
| 3 | 7 | 2 066 | **93%** | **0%** |
| 4 | 2 | 1 920 | **91%** | — |

Turn 1 caching nothing is the designed shape, not a residual fault: two tickets
share too little prefix for the cache to engage before their first call.

**Check 2 — PASSED, and it can only ever be answered in aggregate.** The pass
**upserts one row per ticket**, so these 10 runs overwrote their own predecessors
and a per-ticket before/after comparison is no longer possible for them. Note
that for the next comparison of this kind: snapshot the rows first. In aggregate
the case files are not worse but better, on 10 runs against the 127 that remain:
mean established facts **3.00 vs 1.88**, and higher in every category present —
delivery 3.67 vs 2.00, order 3.25 vs 1.93, product 2.00 vs 1.53. All 10 parsed
as tool arguments with no `argsError`, which is the thing `strict` on a function
rather than on a response format had to be shown to do.

**Most of that rise belongs to the rules layer, not to this change.** The cache
fix is behaviour-neutral by construction; what it had to prove was the absence of
a regression, and 0 failures with richer case files is that.

**Check 3 — the one that was to decide it — ANSWERED, and the answer is "always,
harmlessly".** `investigation.model_finalised_in_loop` fired on **10 of 10**
tickets, and `alongsideLookups` was **0 every time**: the model never asked to
finish in the same breath as a lookup, so no lookup was dropped. On several runs
it finalised on its very FIRST turn, immediately after `openingMoves()` had run
the floor's lookups — `afterCalls` equals the floor's ledger length, and the run
made no discretionary call at all.

**No collection was lost, because the break is where it always was.** A finalise
is mapped onto the "no tool calls" signal, and the closing call is made
unconditionally after the loop — there is no path that skips it. The suppression
trade `DECISIONS.md` records as measured and reversed is therefore not what this
fires; the model finalising and the model going quiet are the same event.

**What it does cost, and what is now worth re-examining.** The CHANGELOG says the
model "can reach for it mid-loop, and it does"; the measurement says it does so on
every single ticket. Its arguments are a complete case file that is discarded, and
then the closing call generates the case file again — so the project pays output
tokens twice per ticket, on every ticket. The code comment declines to use those
arguments on the grounds that it is the suppression trade, and **on this evidence
it is not**: collection has already stopped either way, and the only real
difference is that a mid-loop finalise has not seen `closingPrompt(run)`.

**The cheap experiment, if this is picked up:** on the same run, compare the
discarded mid-loop arguments against the closing call's output — verdict,
established facts, dropped claims. If they agree, the closing call is one model
call per ticket bought for nothing. If they do not, the closing prompt is doing
real work and this is settled for good, in writing. Either answer is worth having;
neither blocks anything today.

## 16. ~~The investigation queue is unreachable~~ — RESOLVED 2026-08-17 with an opt-in

**Closed by decision, not by a fix to auto-close.** The queue being open-only is
**correct for the worker**: in production a ticket is categorised, investigated and
(once Phase 5 lands) drafted within a poll of arriving, so the 28-day auto-close
window never comes near live work. What was actually being measured is an artifact
of importing a historical corpus into a dev database — mail from May–August landing
in a queue that then retires it on schedule.

**So the flag is not stranded, it is just behind a filter a person can lift.**
`npm run investigate -- --include-closed` widens `record.claim` by dropping the
status narrowing and nothing else — the flag, the categorisation requirement,
`archived_at` and the soft-delete all still apply.

**A widened run never moves the ticket's status.** 65% of verdicts map to
`awaiting_human` / `awaiting_customer`, so letting the verdict act on a closed
thread would resurrect settled threads into the live queue by the dozen. The case
file is a note about the thread; writing one is not a reason to reopen it.

**Verified live on 3 tickets:** 1 investigated (`promotions/problem` →
`needs_customer_input`), 2 skipped as out-of-scope subjects, the ticket still
`closed` with `closed_at` untouched, its flag cleared, and 4 rows in `llm_usage`.

**What it reaches, measured:** 113 claimable with the flag lifted, **91 of them
investigable** (the other 22 are `b2b`, `careers`, `partner_collaboration`,
`cosmetovigilance`, `legal_privacy` — no tools by design, and the pass clears their
flag as it skips them, which drains the dead queue as a side effect). **28 of the
91 carry an order-context bundle no case file has read.**

**Cost, now that it is measured rather than guessed:** one investigated ticket is
4 model calls, 5 464 in / 520 out, **≈ $0.016** at the repo's current rate card. The
remaining 90 are therefore **≈ $1.45** — and re-run before the rate card is checked
against OpenAI's current pricing, that figure is only as good as
`scripts/lib/llm-rates.mjs`.

**The original finding, kept because the numbers are still the numbers:**

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

**`--backfill` is not the same tool and does not substitute.** It raises the flag on
**open** tickets only, so run today it reaches 9 that already have case files and
none of the 113.

**Nine case files sit on threads that later auto-closed** (6 `answerable`, 3
`needs_customer_input`). Read as a dev artifact rather than a failure: the agent
read a three-month-old imported thread and the auto-close window then retired it on
schedule. On live mail the same thread would have been read minutes after arrival.
Worth remembering only as a reason not to judge the verdict mix from this corpus
alone.

**Still genuinely open here:** `agent_pipeline_funnel` counts a flagged-but-closed
ticket as pending, so until the widened run drains them (or they are skipped) the
panel overstates the queue. That is a reporting question, not a pipeline one.

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

## 11. ~~Local dashboard validation is blocked by recurring Supabase fetch failures~~ -- FIXED 2026-08-16 (dashboard reads only — see 11b)

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

- **The lookup is now an agent tool, and no investigation has called it.**
  Wired into the registry 2026-09-16 as `lookupAbandonedCheckout` (order and
  promotions subjects) so that `checkout_state` can be branched on — P-17's
  three rules turn on it. Everything above was measured through the retrieval
  module directly; what has never run is the whole path: an investigation
  resolving the customer from the ticket's hash, calling the tool, deriving
  `retrieved` / `unavailable`, and selecting the rule. The unit tests cover each
  link and `selectAnswer` was checked against the live rule set, which is not
  the same thing. **To validate:** run `npm run investigate` over a real P-17 or
  promotions ticket from a customer who abandoned a checkout in the last 30
  days, and check three things — that the tool was offered and called, that the
  finding matches what Shopify actually holds, and that the case file carries
  neither the recovery URL nor the address. Until then the rules stay `draft`.
- **What a miss costs on a busy day.** The lookup cannot filter on email, so it
  walks a 30-day window at 50 a page, up to 6 pages, for every ticket that calls
  it. Never measured against live volume. Item 2 above records that
  `query:"<email>"` **does** filter, which would remove the walk entirely —
  worth doing before this runs on the poll rather than by hand.
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
