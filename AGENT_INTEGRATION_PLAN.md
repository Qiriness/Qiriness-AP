# Agent Workflow — Phased Integration Plan

Status: **built through Phase 4.** Ingestion, both spam gates, categorisation, customer and
order resolution, the retrieval tools, the exemplar layer and the investigation agent all run
against the live store and the live corpus. **Phase 5 (drafting) is the next build**, and the
team-forwarding half of Phase 5 is already in place.

This file is the **phase plan and its status**. It deliberately does not restate rationale:

- **Why** a rule is shaped the way it is → `DECISIONS.md`, per section.
- **What exists and where** → `APP_SCHEMA.md`.
- **What is built but unproven** → `VALIDATION_LOG.md`.
- **What was built and how far proven** → `CHANGELOG.md`.

Realigned 2026-08-17 by reading the database rather than the previous version of this file,
which still described the whole thing as a proposal, cited migrations `011`–`014` that the
six-file baseline replaced, and called the order family blocked by a dev-store fixture that
has been gone since 2026-08-11.

---

## Measured state (2026-08-17, read from the live Supabase project)

| | Measured |
|---|---|
| Tickets | **214**, one shop, none soft-deleted. 203 categorised, 11 not |
| Messages | **451** (296 inbound), **451 embedded** — the corpus is fully vectorised |
| Level spread | L1 **16** · L2 **102** · L3 **85** · unset 11. No level 4 in the corpus |
| Status spread | closed 139 · awaiting_human 48 · awaiting_customer 13 · open 14 |
| Customer link | **145 of 214** carry a `customer_id` |
| Order link | **52** carry a confirmed `shopify_order_number`, and the same 52 carry a populated `resolved_context` |
| Order resolution outcomes | confirmed **52** · no_candidate **138** · mismatch **8** · not_found **4** · name_match **1** |
| Case files | **80** tickets investigated, **70 of them on tickets still live**; 113 flagged `needs_investigation` and **0 claimable** — all closed (see below) |
| Verdicts | needs_human **49** · needs_customer_input **16** · answerable **15** |
| Live drafting set | **22** — 9 `answerable` on open tickets + 13 `needs_customer_input` awaiting the customer |
| Cost ledger | `llm_usage` was empty because nothing constructed a sink; wired and verified 2026-08-17 |
| Knowledge | 16 documents (15 approved), **61 chunks, all embedded** |
| Exemplars | **31 approved**, **94 phrasings all embedded**. `support_answers` is **empty** |
| Tests | **1310** from the repo root · **771** in `agent/` |

**The order family is resolved where it is resolvable, and that is the correction that
matters most.** `orders:resolve` and `context:build` have both run: of 122 order-family
tickets, **52 carry a confirmed number and a built context bundle**. The 138 `no_candidate`
tickets are not a pass waiting to be run — they quote no order reference and the sender's
address matches no order, which is the resolver's designed answer, not a failure. Any earlier
claim that `shopify_order_number` is null on all 214 is stale by about a week.

**But the investigation cannot catch up with it, and that is the finding that reframes the
next step.** Only 23 of those 52 carry a case file; the other **29 are closed**, and
`record.claim('investigation')` requires `status = 'open'`. Auto-close retires a thread after
28 days of silence and leaves its `needs_investigation` flag raised, so on a corpus of
historical mail 139 tickets closed carrying a flag nothing can act on:

| | |
|---|---|
| flagged `needs_investigation` | 113 — **every one closed** |
| claimable by the pass | **0** |
| what `--backfill` would raise | 9, all of which already have a case file |

**This is a dev artifact, not an operational fault**, and the open-only queue is right for the
worker: in production a ticket is categorised, investigated and drafted within a poll of
arriving, so the 28-day window never comes near live work. What it blocks is a *backfill* over
imported history, which is a different job.

**Resolved by an opt-in** (2026-08-17): `npm run investigate -- --include-closed` drops the
status narrowing and nothing else, and **never moves the ticket's status** — 65% of verdicts
map to `awaiting_human`/`awaiting_customer`, and a backfill must not resurrect settled threads.
It reaches **91 investigable tickets, 28 of them carrying an order-context bundle no case file
has read**, at a measured **≈ $0.016 per ticket (≈ $1.45 for the lot)**. The other 22 are
subjects with no tools; the pass clears their flag as it skips them, draining the dead queue.

Symmetrically, 29 of the 52 investigated order-family tickets had no order number when they
were read, so their case files are weaker than the data now allows — and the same flag is how
to re-read them.

**Two tables are still empty where prose elsewhere implies rows.** `ticket_forwards` and
`category_forwarding` (0 — no address is configured, so the forwarding pass has never routed
anything here), and `categorisation_review` (0 — the 30 hand-labelled rows behind the
77% / 90% / 73% figures are gone from this database). Both are `VALIDATION_LOG.md` items, not
plan items. `llm_usage` was the third and is fixed: nothing had ever constructed a usage sink,
so every model call fell back to the no-op. Wired into the poll and the investigate CLI and
verified against the live project — item 14.

---

## Locked decisions

| Area | Decision |
|---|---|
| Email source | **Microsoft 365 / Graph API**. `SUPPORT_MAILBOX` currently points at `onouailhetas@lap-groupe.com`; the stored corpus was ingested from `contact@qiriness.com`, and Exchange item ids are mailbox-scoped — see the open question below |
| LLM provider | **OpenAI**, one provider across embeddings, classification and drafting |
| Agent runtime | **Separate Node worker** (`agent/`), self-hosted, reusing `scripts/lib/` directly. Not in `web/` |
| Human channel | **The Next.js dashboard** — `/tickets` is built, drafting has a slot waiting in it |
| Ingestion | **Delta polling** is the engine and the source of truth; subscriptions, if ever added, are a trigger that pokes the same engine |
| Send behaviour | **Draft-only to start.** `config.mjs` already carries `draftOnly: env.DRAFT_ONLY !== 'false'` |

### Model tiers, as actually configured

- **Spam gate · categoriser · decomposition** — cheap tier, `gpt-4o-mini`, structured outputs.
- **Investigation** — `gpt-4o` with tools, 6 tool calls and 4 model turns per run.
- **Drafting** — mid tier, to be pinned in `config.mjs` with the others when Phase 5 lands.
- **Level 4** — no model call at all. `allowedTools` hands level 4 and the `contact` kind an
  empty registry, so those tickets reach a person untouched.

Cost is now recordable rather than estimable: `llm_usage` takes one row per call from the
transport, and `/insights/agent` reads it. It has 0 rows, so no figure quoted anywhere yet
rests on it.

---

## Phases

### Phase 1 — Ticket data model + email ingestion — **BUILT**

Graph delta polling with a persisted cursor, messages mapped and threaded by
`conversationId`, contact-form identity unwrapped, inline best-effort embedding at write
time. Idempotent: dedupe on Graph `message.id`, and `unique(shop_id, graph_conversation_id)`
on the ticket.

Schema landed in `04_support.sql` (the six-file baseline; the old `0XX_tickets.sql` /
`011`–`014` numbering is history). 214 tickets and 451 messages are the proof it runs.

**Exit met.** Reprocessing is a no-op; every stored message carries a vector.

### Phase 2 — Spam / triage gate — **BUILT, and it drops `irrelevant` too**

Gate 1 is the deterministic `email_blocklist`, matched before any write. Gate 2 is one
cheap-tier structured call on new conversations only, fails open, and **drops `irrelevant` as
well as `spam`** — which supersedes this file's earlier "store, don't categorise" design for
`irrelevant`. Every decision writes a `spam_audit` row carrying sender, subject, reason, and
on a block the body under a 90-day expiry.

The dashboard's Irrelevant section reads `spam_audit`, so a dropped email is reviewable
without a ticket row ever existing. See `DECISIONS.md § Spam gate` for why the body is kept
and why the earlier retention design was replaced.

**Exit met.** Still open: the `Add as ticket` action is disabled, because re-fetching a
dropped message addresses it by Graph id — the mailbox question below.

### Phase 3 — Categorising agent — **BUILT; accuracy partly proven**

Two axes, never composed (`scripts/lib/support-taxonomy.mjs`): 14 subjects × 4 request kinds,
plus a secondary pair with its own kind. Level is derived from the pair and may only be
escalated, never lowered. Level 4 is a severity judgement with three named triggers and no
subject implies it — the corpus contains **zero** level 4, which is the intended shape.

The categoriser sees no tools, no database and no sender address. Three layers keep it inside
the taxonomy: generated enums, `normaliseCategorisation()` for the pair rules, and the check
constraints. `categorisation_confidence` is a known-untrustworthy marker only — the model is
never asked how sure it is (`DECISIONS.md § The categoriser is never asked how confident it is`).

**Exit partly met, and the evidence for that judgement is currently unreadable.** The
synthetic set (`agent/eval/`, 40 cases) scores 38–39/40 and guards against regressions. The
real numbers — subject 77%, kind 90%, level 73% — came from 30 hand-labelled rows in
`categorisation_review`, and that table is now empty, so they cannot be recomputed or
extended. Re-sampling and re-labelling is a `VALIDATION_LOG.md` item.

The two boundaries that were unsettled then are still unsettled: `order` vs `delivery`
mid-thread, and whether a pure status chase is level 2 or 3.

### Phase 4 — Tools layer — **BUILT; the Tool Runner is not**

Every tool exists, is typed, is unit-tested and is reachable from the investigation agent's
own registry: order-number resolver, order-context bundle, customer/CRM lookup, product
lookup and matching, stock, promotion lookup and eligibility, abandoned checkout, knowledge
retrieval, exemplar retrieval, purchase verification, photo evidence. `allowedTools(category,
kind, level)` is a table tested across all 56 pairs; the model never sees outside it.

**What the tools produced on the real corpus:**

| | Measured |
|---|---|
| Case files written | 80 tickets, one per inbound reading |
| Evidence needs scored | satisfied **109** · attempted **100** · unavailable **39** · **`not_attempted` 3** |
| Median case file | 3 established claims on an `answerable` verdict, 2 across all verdicts |
| Case files with 0 established | 12 — every one forced to `needs_human`, which is the rule working |
| Unsourced claims stored | 0 |

`not_attempted: 3` is the first real answer to the question `VALIDATION_LOG.md` item 4c was
built to ask: the loop is very nearly always calling the tools it was allowed, so the
"steering" half of that item is worth little and the enforcement half is now measurable.

**What is not built: a general Tool Runner.** There are no typed tool schemas outside the
investigation registry, no dispatch for another caller, and no approval gate — the plan's
"side-effecting tools return *needs approval* instead of executing" does not exist, because
no tool with a side effect has been exposed to a model yet. Drafting does not need it (it
reads the case file, not the tools), so this is now a Phase 5-adjacent item rather than a
blocker.

**Retrieval is calibrated but its library is thin.** 61 chunks, all embedded, bands
`ANSWERABLE = 0.60` / `WEAK = 0.50` re-derived against a 16-case labelled set. The coverage
gap is the problem, not the mechanics:

| chunks | legal_privacy 18 · faq 11 · brand_story 9 · other 8 · cosmetovigilance 5 · return_exchange 5 · product 4 · account 1 |
|---|---|
| **zero chunks** | **delivery · order · promotions · payment · product_stock** |

Those five carry the majority of demand. A level 1 ticket is defined as answerable from the
library alone, and for the highest-volume subjects the library holds nothing — which is the
single largest cap on what Phase 5 can auto-answer.

**The embedding and retrieval design in this file is now implemented**, and its rationale
moved to `DECISIONS.md § Embeddings`, `§ Knowledge` and `§ Exemplars`: quote stripping before
composition, `subject → stripped body` for mail and `title → section_heading → chunk_text`
for chunks, the determinism quadruple on both, one reconciler with three descriptors, inline
best-effort writes that never fail ingestion, first + latest as two searches merged on raw
cosine score, `faq` eligible for every subject, and top-k rather than a similarity threshold.

Two pieces of that design remain **forward-looking**, and stay here:

- **Two-topic emails produce one blended vector**, and the category filter — not the vector —
  does the discriminating. It degrades when one topic dominates the text. The upgrade is a
  one-line restatement per topic from the categoriser, embedded separately. **Trigger: a
  high-volume subject passing ~100 chunks.** Today the largest holds 18, so ranking barely
  matters yet.
- **Clustering the corpus** to decide what to write and what to promote to an exemplar. One
  run exists (2026-08-16, threshold 0.68, min_size 2) and is persisted in `cluster_runs` /
  `ticket_clusters`. Re-tuning the threshold against the larger corpus is cheap now that two
  runs can be compared instead of argued about.

### Phase 5 — Response generation + level-gated automation & team routing — **NEXT**

**Team forwarding is already built** — `routing/forward-rules.mjs` + `forward-runner.mjs`,
`category_forwarding` as a per-subject address book with a null address as the off switch,
`ticket_forwards` as an attempt ledger unique on `ticket_message_id`, and a `/settings`
surface to edit the addresses. It has never routed a message here: no address is configured,
and the one live attempt series returned `ErrorMailboxMoveInProgress`
(`VALIDATION_LOG.md` item 1).

So Phase 5's remaining work is **drafting, and the level gate around it**.

#### What is already in place for it

| Piece | State |
|---|---|
| `DRAFT_ONLY` | exists — `config.mjs`, default on. Nothing auto-sends while true |
| Case file → prompt | `toDraftingPrompt` (model) and `toHumanBrief` (person, = the first plus the internal `handoff`) already split |
| Prohibitions | `do_not_claim` derived from tool caveats, never asked for. Median 2 per case file, present on 10 of the 15 `answerable` |
| Withholding | the model reads renderings, never rows: no SKUs, no product ids, money only when the reply turns on it, customer email withheld by default |
| Tone signal | `happiness`, independent of `level` by design |
| Exemplars | 31 approved situations, 94 embedded phrasings, matched per ticket and **recorded without being acted on** — `exemplar_match` never enters the investigation prompt |
| Dashboard slot | `TicketThreadDialog` renders a `Draft reply` section; `tickets-service.ts` returns `draft: null` and says why |
| Closing hook | `answerable` deliberately does not advance the ticket — "the sent reply is what should close it" is reserved for this phase |

#### What has to be built

1. **Somewhere to store a draft.** No column or table holds one. Proposal: a `ticket_drafts`
   table mirroring `ticket_investigations` — `unique(shop_id, trigger_message_id)`, so a
   draft belongs to the *reading* it was written from and a new inbound reply produces a new
   draft rather than silently overwriting the one a human is reviewing. Body, subject,
   language, the case file id it was written from, model, token counts, and an approval
   lifecycle (`pending` → `approved` / `edited` / `rejected` / `sent`).
2. **The drafting call.** Mid-tier model, input = `toDraftingPrompt` + the order-context
   rendering + brand voice in full + knowledge chunks at or above `ANSWERABLE` + the matched
   exemplar. Output is prose, not a decision: **the verdict already decided what kind of
   reply this is**, and the wording of a question to a customer is looked up from the field
   key, not invented.
3. **The verdict gate, which is the actual routing:**
   - `answerable` → draft a reply. **15 case files, 9 of them on tickets still open** (L1 3 ·
     L2 10 · L3 2 across all 15).
   - `needs_customer_input` → draft the question, using the stored `MISSING_FIELDS` wording.
     **16 case files, 13 still `awaiting_customer`.**
   - `needs_human` → **no customer-facing draft at all**; the human brief already exists and
     is what the dashboard shows. **49 case files, 48 still `awaiting_human`.**
   - no case file → nothing to draft from. That is a normal state, not an error.
4. **The level gate on top of it**, all of it inert while `DRAFT_ONLY` is on: L1 auto-send ·
   L2 auto-send + suggested action · L3 human-approved · L4 never drafted. Graduating L1 then
   L2 is a config flip, not a rebuild. **Gate on `level` + `happiness`, never on
   `categorisation_confidence`** — it is only ever written by failure paths.
5. **The send path**, which is a separate, gated step and is currently blocked — see the
   mailbox question below.

#### Rules this phase inherits and must not break

- **A commercial gesture is a merchant decision the model may never invent.** Either it is
  handed a bounded gesture it may offer, or the ticket routes to a person.
- **Nothing in `do_not_claim` may be paraphrased past.** These are strings in a prompt, which
  is the weakest kind of guardrail in this codebase — so the draft needs a mechanical check
  against them, not just an instruction.
- **Never quote an identifier the tool layer withheld.** The drafting prompt is narrower than
  the human brief on purpose.
- **The answer skeletons are not usable yet.** `support_answers` is empty and `answer_set` is
  null on every exemplar, so `answer-selection.mjs` has a mechanism and no content. Drafting
  can ship without it; the skeletons are what would later make a reply's *structure*
  deterministic rather than model-chosen.

**The slice to build against is small and that is fine.** 22 tickets are live today (9
`answerable` and open, 13 awaiting the customer), and `--include-closed` can raise the corpus
to ~91 case files for about $1.45 whenever a bigger sample is wanted. Neither number is the
production shape: on live mail the agent reads a thread minutes after it arrives, so what
matters for the design is the *verdict mix*, not this corpus's queue state.

The ceiling on how much of that mix is auto-answerable rises with knowledge coverage on the
five empty subjects, not with prompt work.

**Exit:** with `DRAFT_ONLY` on, every ticket carrying a case file produces either a stored,
reviewable draft or an escalation, nothing auto-sends, and the flag is the single switch that
later graduates L1/L2.

### Phase 6 — Human-in-the-loop dashboard surface — **PARTLY BUILT**

`/tickets` exists: four stacked sections (Queue · Irrelevant · Backlog · Closed) over
`ticket_queue`, level tabs, category filter, per-section search, the expanded reading panel
(Results · Order · Action), the conversation dialog and the dropped-mail dialog. `/insights`
adds four analytics panels including the agent's own funnel and cost.

Missing: **approve / edit / send for a draft** (waiting on Phase 5's storage), and
**authentication**. The second is the blocking one — `/insights/customers` names individual
customers and their lifetime spend, and the thread dialog renders full bodies and sender
addresses, all with no user identity to attribute a `data_access_events` row to.

**Exit:** a human can clear an L3 ticket end to end. Not met.

### Phase 7 — Memory — deferred

Per-customer / per-ticket memory. Out of scope until 1–6 are stable.

---

## Cross-cutting (every phase)

- **Audit + personal-data minimisation** per `AGENTS.md` and `SHOPIFY_PERSONAL_DATA_PROTECTION.md`.
  A redact request must clear `ticket_messages.embedding` and its determinism metadata, not
  only `body_text` — an embedding is a derived representation of personal data.
- **Role guardrails** — each ticket's agent gets only the tools its (subject, kind, level)
  allows. Guardrails are code; only guidelines are prose.
- **Idempotency** on ingestion and on every side-effecting pass.
- **Tests** beside each module, Node built-in runner.

---

## Open questions

### Which mailbox and which store this environment is for — **blocks anything addressing a message by id**

The corpus was ingested from `contact@qiriness.com`; `SUPPORT_MAILBOX` points at
`onouailhetas@lap-groupe.com`. Exchange item ids are mailbox-scoped, so every stored
`graph_message_id` is unusable against the configured mailbox — proven by
`spam:backfill:dry-run`, which Graph rejects with `ErrorInvalidMailboxItemId`.

Consequences, all of them downstream of one decision: the spam-body backfill cannot run,
`/forward` cannot fetch the item it forwards, the dashboard's `Add as ticket` stays disabled,
and **Phase 5's send path cannot exist**. Drafting itself is unaffected — it reads stored
rows — so this gates the last step of Phase 5, not its build.

### Live parcel status — **ANSWERED: Shopify does not have it**

Previously open here as "not yet investigated". It has since been measured against the live
store: **`delivered_at` is set on 1 order in 2 006 and `in_transit_at` on none.** No carrier
feeds scan events back into Shopify, so the tracking tool can report *what a parcel's number
is* and never *what the parcel is doing*.

That settles the level 2 / level 3 question it was raised for: the stale-in-transit rule
(`IN_TRANSIT` with no movement for ~10 days → level 3) is pure arithmetic and cannot run,
because there is no timestamp to do arithmetic on. Those tickets keep routing to a human,
which is today's behaviour.

Options, in order of preference:

- **A delivery feed from the 3PL / dispatch** posting delivery confirmations onto the Shopify
  fulfilment. Best buy: it needs no new table, and it also fills the carrier table's `Lost` /
  `Damaged` / `Delivered late` columns, which are placeholders nothing writes.
- **Carrier APIs directly** — Colissimo, Chronopost, Mondial Relay, GLS, DHL. Accurate, one
  integration each.
- **An aggregator** — one API across carriers, but it sends tracking numbers to a third-party
  processor, so it needs documenting under `SHOPIFY_PERSONAL_DATA_PROTECTION.md` first.
- **A new classification axis on the ticket** instead of real data — a migration plus a
  prompt change plus a re-categorisation backfill plus eval cases, and it measures what
  customers *said*, not what happened.

Note for whichever wins: `orders.tracking_numbers` is populated and GIN-indexed, so a feed
has a join key waiting. 402 of 467 Amazon orders (86%) carry no tracking number at all, which
bounds what any of this can cover.

---

## Deferred (deploy-time, not design-time)

- **Where the worker runs + secrets management.** Always-on Node process; production needs a
  host that keeps it alive (recommendation: Azure, same tenant as the mailbox) and a secret
  store for the Graph / Supabase / OpenAI credentials. `.env` locally; never in git.
- **Separate Supabase development and production projects.** Pointing a worker at a fresh
  mailbox triggers a full unordered delta enumeration — decide before go-live whether to
  ingest the backlog or seed the cursor and start clean. The empty `categorisation_review`,
  `ticket_forwards` and `category_forwarding` tables are what having one shared project has
  already cost.
