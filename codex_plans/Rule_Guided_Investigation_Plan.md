# Rule-Guided Investigation — plan

**Status: PROPOSED 2026-09-01. Nothing here is built.** Read
`APP_SCHEMA.md § Agent Worker` for the pass order this sits inside, and
`DECISIONS.md § Investigation`, `§ Exemplars` and `§ Drafting` before changing
any rule it touches. Where this file and the code disagree, the code wins — this
is the reasoning that produced the plan, not a description of a built thing.

## The problem

`support_answers` is applied **after** the investigation. It reads the tool
ledger, derives findings, selects one rule, and that rule may tighten the
verdict, name what to ask, and hand a skeleton to the drafting pass. It has no
say in what the investigation *goes and looks up*.

The machinery for the other half already exists and is not wired to anything:
`nextNeed()` in `answer-selection.mjs` picks the need that best splits the live
rules and walks the dependency graph back to its first unmet prerequisite. It is
tested. Nothing calls it.

The goal is to use it — **without letting a rulebook written for routing decide
that a fact is unnecessary.**

## The governing choice: arbitration per call, never per pipeline

Three collection modes, chosen one call at a time:

| Mode | What it is | When it runs |
| --- | --- | --- |
| **A — Floor** | the deterministic opening moves | always, unchanged |
| **B — Rule-directed** | `nextNeed` over the live rules | only for a situation explicitly marked rule-directed |
| **C — Model** | today's loop | whenever B has nothing to propose |

**In v1, Mode B may add and reorder calls. It may never remove one.** Suppression
is a separate switch, per situation, earned by replay evidence (§10).

That single restriction is what makes the rest safe. The existing rules were
authored under the contract *this decides where a ticket goes*. Turning them into
the evidence plan changes what every one of them means — a rule that omits a
condition on `delivery_state` would now also be asserting « nobody needs to check
the delivery ». Additive-only collection keeps the old meaning intact while the
new one is measured.

### Why not per ticket

"The rule takes over when a situation is linked" does not survive contact with
the run. At the start there are no findings, so *every* rule naming the situation
is live — the takeover unit is the situation's rule **set**, not a rule. And the
live set can empty mid-run when findings contradict all of it, at which point
control has to go back to the model in flight.

Arbitrating per call gives that for free: when the set empties, `propose()`
returns null and the next turn is the model's. There is no hand-back path to
write because there is no hand-over to undo.

## 1. Floor — unchanged, and keyed to CATEGORY

`openingMoves()` stays exactly as it is. It switches on **category**, not answer
set, and the mapping is many-to-one: `products` covers `product` and
`product_stock`, which have different moves. Keying the floor to the answer set
would regress the stock path.

After the moves and before the first proposal, derive findings once from the
ledger. Free — it reads what already ran — and it is what stops the planner
re-requesting what the floor just fetched.

## 2. The planner — `investigation/collection-planner.mjs`

New module. Pure, like `answer-selection.mjs`: findings in, a proposal out. No
database, no model, no clock.

```text
propose(rules, findings, available, { situationKey })
  -> { need, tool, args, reason } | null
```

It wraps `nextNeed()` — which already does the discriminating-need choice **and**
the backwards prerequisite walk — and adds the one thing missing: turning a need
into a callable tool.

**Prerequisite chains are already solved, and this is the part most likely to be
rebuilt by mistake.** A rule branching on `promotion_validity` cannot fire until
the code has been extracted; one branching on `order_state` cannot fire until the
order is identified. `firstUnmetPrerequisite` walks down `DEPENDENCIES` to the
first unmet requirement, which is why `promotion_identity` gets collected at all
— no rule branches on it. `isMoot()` closes the other end: once
`promotion_validity` is `expired`, `promotion_eligibility` is struck out rather
than chased forever.

**The graph is thin and that is the real work.** `DEPENDENCIES` has nine entries,
five of them marked *dormant with the order family*, and none at all for the
product needs. Filling it in is authoring, not engineering, and it is the highest
value hour in this plan.

### Turning a need into a call

`NEEDS[].satisfiedBy` already names the tool per need. The argument shapes are
derivable in code: most tools take none, `question`/`text` take the raw customer
message, and `lookupPromotion`'s `code` chains from `extractPromotionCodes`
output.

**Two tools are not code-callable, and this is a scope boundary rather than a bug
to discover later.** `identifyReactionProduct` requires `product` + `reaction`,
which *are* the model's reading of the email — the same reason it is already
excluded from opening moves. So **cosmetovigilance is never rule-directed for
collection**, and loses nothing by it: that subject is blanket-routed to a person
whatever the evidence says.

## 3. Readiness — a per-situation opt-in

New column on `support_exemplars`:

```sql
collection_mode text not null default 'model'
  check (collection_mode in ('model', 'rule_directed'))
```

A person sets it, per situation, in the rulebook. **Never inferred from how many
rules exist.**

A set with 8 rules of which 3 are approved is worse than no rules at all: the
live set converges faster because there is less to separate, so collection stops
earlier while looking like it decided something. Per-set readiness is too coarse
to see that and per-rule is too fine to mean anything.

The baseline forbids `alter table` — every table is created complete and a test
asserts it — so this column goes into `05_exemplars.sql` itself.

## 4. Arbitration

```text
after the opening moves, derive findings, then loop until the budget closes:

  1. Mode B active and propose() returns a need  -> call it, re-derive, continue
  2. else a response-completeness need is open   -> call it, re-derive, continue
  3. else                                        -> hand the turn to the model
```

Mode B is active when **the situation matched AND that situation is
`rule_directed` AND its set loaded approved rules**. Any one missing and the
ticket runs exactly as it does today.

**An errored call marks its need `unavailable`** — excluded from further
proposals, retained for the gate. Without this the planner re-proposes forever,
because the candidate filter only excludes needs whose finding is *defined*.

**Budget is reserved, not shared.** Floor calls stay where they are. The planner
gets a cap; the model keeps a guaranteed remainder of at least two calls.
Otherwise a chatty planner starves the fallback on exactly the multi-task tickets
that need it most.

## 5. Two stopping conditions, not one

```javascript
// answer-selection.mjs — renamed, behaviour unchanged
policyDecided(live)   // live.length <= 1: collection for SELECTION is done
```

`nextNeed` returning null currently reads as *investigation complete*. It is not
— it is *the rule is decided*. The reply still needs facts no rule branches on,
because a rule branches only on what changes the routing.

Both conditions must hold before the loop ends: **policy decided AND response
complete.**

## 6. Response needs — subject default, rules add only

Not a new list. `planEvidence()` already produces the per-subject checklist of
what a complete dossier establishes; promote it from prompt text to a checked
list over `NEED_KEYS`.

A rule may carry `response_needs` that **adds** to the subject default and can
never shrink it. So the tickets with no rule, no situation, or a fallback — the
ones a rule-carried list would leave with nothing — keep the full subject floor.

**v1 restriction, deliberate: response needs use the existing needs vocabulary
only.** `order_date` and `expected_dispatch_date` are not needs — they are fields
of the order bundle, with no finding enum and no `derive`. Mixing *which finding
did this resolve to* with *is this field present in the dossier* in one list is
how a closed vocabulary rots. Dossier-field completeness, if wanted, is a
second, separately named check — later.

## 7. The completeness gate — reported first, enforced per set

Computed from what exists. `evidenceGaps` already scores every declared need as
`satisfied` / `attempted` / `unavailable` / `not_attempted`, and errored ledger
entries map back to needs through `satisfiedBy`.

```text
decision_complete · response_complete · mandatory_gaps · tool_errors_affecting_answer
```

When enforced — and note the verdict is `needs_human`, there is no
`human_required`:

| Gap | Result |
| --- | --- |
| Internally retrievable | keep investigating |
| Customer-only (`asksCustomer`) | `needs_customer_input` |
| Human action required | `needs_human` |
| Material tool failure | never `answerable` |
| **Nothing can ever close it** | **the gate must not fire** |

**The fifth row was added after the report ran, and is the reason it ran first.**
The four rows above route a gap by WHO closes it and assume somebody can. Measured
over 91 fresh runs, the gate would downgrade 12 — and on **4 of them every open
gap is one nobody can close**: `checkout_state` has no tool wired at all,
`other_fact` is unsatisfiable by design, `product_recommendation` comes back
`unavailable`, and `promotion_eligibility: undetermined` is the vocabulary's own
honest gap because the basket is invisible. Downgrading those hands a ticket to a
person who can do no more about it than the agent could. `gapClosability` in
`evidence-rules.mjs` is the classifier, and its READ ORDER matters as much as its
result — `not_attempted` outranks `asksCustomer` (never ask for what we did not
look for), and `asksCustomer` outranks `unavailable` (a cosmetovigilance ticket
has no tools by design and CV-01 still asks which product was used).

**Report-only until the vocabulary is validated.** `product_property` was derived
wrong until 2026-08-31 — of 13 product investigations reported unanswered, 8 were
satisfied and the finding said otherwise. Enforcing this gate over that bug would
have converted 8 correct `answerable` verdicts into handovers. A gate is worth
exactly as much as the derivations under it.

## 8. Never ask for what is already known

Before a rule's `ask` reaches `missing`: check the need is not already
established, and not still internally retrievable.

**This is a live hole, independent of everything above.** `policyAsks` gates on
the verdict and never on the findings, so a situation-only rule carrying
`ask: [shopify_order_number]` will ask for a number the run already resolved.

One decision to make explicitly: `asksCustomer` is many-to-one — five needs
declare `shopify_order_number` — so define which need's satisfaction retires
which question.

## 9. Capture findings, not data

New column, `ticket_investigations.findings_trace jsonb`: the derived findings
snapshotted after each tool call, in call order.

**Neither existing store can replay a run, and the replay in §10 is what gates
suppression.** `tool_calls` persists `{id, tool, argsHash, outcome}` — `data` is
deliberately dropped. Eight of the thirty finding derivations read `data`:
`buyer_type`, `product_identity`, `promotion_validity`, `promotion_eligibility`,
`customer_account_state`, `product_availability`, `photo_evidence`,
`checkout_state` — which is the whole discriminator for promotions and for
accounts. Rehearsal traces are no better: `toolEntry` keeps a human-readable
allow-list of `data` fields, chosen precisely so a column added later cannot leak
into a stored trace.

A replay over either store would score those findings as absent, which means
fewer live rules, which means earlier stopping. **It would flatter rule-guided
collection exactly where it is most likely to under-collect.**

The fix is not to widen either store. Findings are a closed enum carrying no
personal data — a few dozen bytes — which is why they are safe to persist where
`data` was correctly dropped.

## 10. Shadow, then suppression, per situation

Replay from `findings_trace`. Compare calls actually made against calls a
rule-guided run would make, and track three numbers:

- tool calls saved
- material established facts lost
- `answerable` cases that would have shipped with a mandatory gap open

Suppression is enabled per situation, only where the replay shows no meaningful
evidence loss. A kill switch at two levels: an env flag disabling the planner
globally, and the `collection_mode` column, so one bad situation is turned off by
a person in the dashboard without a deploy.

---

## Multi-request emails: the decomposer and the rules

**The decomposer runs on every investigated ticket.** One `gpt-4o-mini` call,
against the two `gpt-4o` calls the investigation already makes. It used to be
gated on structural signals — a second subject, ≥320 chars, ≥2 question marks —
and the gate was deliberately removed on 2026-08-09 when the same call started
declaring the ticket's **evidence needs**: those must exist for every investigated
ticket or the completeness report has a hole exactly where the short, ordinary
tickets are, which is most of them.

It returns three things: `tasks` (the separate requests), `entities` (order
numbers, products, codes the customer *wrote*), and `needs`. `planTasks` then
clamps the split — one task keeps the ticket's own labels, extra tasks are kept
only if their subject has tools, and anything dropped is reported to the model as
a part it must declare unhandled.

### Where it collides with the rules, today

The rules layer is **singular where the investigation is plural**:

| | Per task | Per ticket |
| --- | --- | --- |
| Opening moves | ✅ `planMoves` iterates tasks | |
| Tool budget | ✅ +2 per extra task | |
| Evidence checklist | ✅ `planEvidence` per task | |
| Answer set | | ❌ `answerSetFor(ticket.category)` |
| Situation | | ❌ one `matchExemplar` on the whole message |
| Rule selection | | ❌ one `selectPolicy` over one findings map |

So the LED-mask-plus-order email — the decomposer's own worked example — is
investigated as two tasks and answered by **one rule from one set**. The order
half is investigated (the opening move ran, the facts are in the ledger) and **no
`orders` rule can ever fire on it**, because the ticket categorised as `product`.
The selected rule's skeleton describes the product half and says nothing about
the parcel.

There is a subtler failure underneath it. Findings from *both* tasks land in one
map. `needsNamedBy` limits scoring to needs the loaded set branches on, which
contains most of the damage — but where two sets share a need (`policy_answer`,
`customer_identity`), a finding derived from the **other** task's tool call can
select this task's rule. That is not a wrong answer today because no set is
rule-directed; it becomes one the moment a rule's route depends on it.

### The shape that fixes it

**Rules go per task for collection and for the skeleton. They stay per ticket for
the verdict.**

- **Per task:** `answerSetFor(task.category)`, its own situation, its own live
  rules, its own planner proposals. A situation per task is already within reach
  — match on `task.question`, the decomposer's one-sentence restatement, which is
  what `focusedText()` already feeds the semantic matchers for exactly this
  reason.
- **Per ticket:** one verdict, one email. Combine the tasks' routes by taking the
  **strictest** — `answerable < needs_customer_input < needs_human`. That
  preserves tighten-only for free: the strictest of several tightenings is still
  a tightening, and a task whose rule wants to answer can never clear a task whose
  rule wants a person.
- **`ask` unions across tasks**, deduplicated by `MISSING_FIELDS` key, then
  filtered through §8 so nothing already established is asked for.
- **Skeletons concatenate in task order**, each labelled with its question, so
  the drafting prompt says what each half of the reply must do rather than
  describing one half and leaving the other to improvisation.

Scoping findings per task requires one thing that does not exist: a ledger entry
does not record which task it was called for. `run.call()` takes a `source`
(`opening_move` / `model`) and would need a `taskIndex` beside it. Small, and it
is the prerequisite for everything in this section.

**Ordering:** none of this is needed for v1, because v1 has no suppression and
one rule tightening a verdict is already correct behaviour. Build it when a
second answer set is marked `rule_directed` — at that point two sets can be live
on one ticket, and the singular selection becomes a real defect rather than a
missed opportunity.

---

## Measured 2026-09-01, before any of this was built

Two read-only reports now exist: `npm run report:investigation-calls` and
`npm run report:evidence-vocabulary`. What they found changes where this plan
starts.

**The corpus is 93 investigations, 2026-08-13 to 2026-08-21, and nothing has been
investigated since.** Every number below describes a pipeline eleven days old.
The `product_property` fix of 2026-08-31 has never run against a ticket.

**No rule has ever fired on real mail: 0 of 93 investigations carry a policy
record.** The whole rules layer has only ever run in the test chat. 44 of 93
matched a situation, so the input to it exists; the rules simply postdate the
corpus.

**There is discretionary space, and it is not evenly spread.** Median 1 call
beyond the opening moves, p90 2, and 69% of investigations make at least one.
Per subject, the share making any discretionary call: `promotions` 100%,
`payment` 100%, `return_exchange` 100%, `order` 80%, `product` 53%, `delivery`
39%, `account` 33%. So the payoff is not purely consistency — but the biggest
single reach was a promotions ticket that spent **six** calls beyond its opening
moves, walking through seven different tools.

**Live rule counts, from the database rather than the doc:**

| Set | Approved | Draft |
| --- | --- | --- |
| orders | 17 | |
| cosmetovigilance | 8 | |
| returns | 8 | |
| promotions | 7 | |
| accounts | 6 | |
| products | | 9 |
| payments | | 6 |

`loadAnswers` reads approved only, so the 15 product and payment rules written
last week are invisible to the agent. That is authoring state, not a fault — but
it means those two sets are not candidates for anything here yet.

**The vocabulary audit found 11 contradictions in 294 need entries (3.7%)**, in
four groups: `promotion_validity` satisfied-but-empty (4), `product_property`
satisfied-but-empty (4), `product_property` unsatisfied-but-found (2),
`product_identity` unsatisfied-but-found (1). Every group's most recent
occurrence is between 2026-08-17 and 2026-08-20 — **which proves nothing, because
the corpus ends on the 21st.** A backfill has to run before that number means
anything about today.

### The backfill ran the same day, and these are the numbers to plan against

**39 fresh investigations, every ticket in an enabled subject.** 186 model calls,
~332k tokens. Four tickets hit OpenAI's 30k TPM ceiling on `gpt-4o` mid-run and
were retried; one exhausted its three attempts and was routed to a person with
the reason recorded, which is the documented fallback working rather than a loss.

| | |
| --- | --- |
| verdicts | `needs_human` 20 · `answerable` 10 · `needs_customer_input` 9 |
| situation matched | **12 of 39 (31%)** — `near` 13, `none` 13, `ambiguous` 1 |
| a rule was selected | **18 of 39 (46%)** |
| a rule changed the verdict | **1 of 39** |

**The gap between 12 and 18 is the situation-less rules earning their keep**, and
it is the strongest argument in this plan's favour: a rule keyed only to
conditions fires whatever the matcher does, so coverage does not depend on
recall. `delivery` matched a situation twice and got a rule ten times.

**One verdict changed, and that is not a disappointing hit rate.** The layer only
tightens, so agreement is the expected case; the number to watch is that it never
loosened one, which it did not.

| subject | runs | situation | rule |
| --- | --- | --- | --- |
| delivery | 16 | 2 | 10 |
| order | 9 | 5 | 4 |
| return_exchange | 3 | 0 | **0** |
| product | 3 | 1 | 1 |
| account | 2 | 1 | 1 |
| product_stock | 2 | 1 | 0 |
| payment | 2 | 0 | 0 |
| promotions | 2 | 2 | 2 |

**`return_exchange` is the finding worth acting on: 8 approved rules and not one
fired.** R-21 was the closest exemplar on all three tickets and matched none of
them, and no condition-only returns rule caught them either. That is a coverage
hole in the authored set, not a mechanism failure — and it is invisible without
this table.

**The vocabulary audit on the fresh corpus: 118 need entries, 2 contradictions,
5 coarse.** The `promotion_validity` fault is gone from new runs and no
`product_property` satisfied-but-empty entry appeared, which is the first
evidence the 2026-08-31 fix holds. What remains:

- `photo_evidence` — `attempted` + `mentioned_not_attached`, the finding claiming
  a value nothing satisfied. `DECISIONS.md` already calls this need "two signals,
  and they disagree".
- `product_property` — one `attempted` + `weak`, the same last-wins/any-wins
  divergence.
- `return_eligibility` — 4 coarse entries, satisfied without a value. Worth
  reading before any rule branches on it.

**The audit reported two false positives before it reported a real one**, and
both are now encoded: `attempted` + `undetermined` is `promotion_eligibility`'s
designed honest gap, and `refund_state: none` means THE ORDER HAS NO REFUND —
a positive fact, unlike `product_property: none` which means the library was
silent. Same word, opposite epistemic status; the classifier now lists the
exceptions explicitly.

### The pilot was P-18, and it turned out to be dormant (corrected 2026-09-03)

**`extractPromotionCodes` has returned `found` on zero runs in the corpus**, so every P-18 ticket resolves its validity without a code, keeps one live answer, and has nothing left to collect. The reasoning below is still right — it is about a chain no ticket has walked. **D-02 is the live pilot**: opted in, a real ticket went from 1 tool call to 3 and closed its unsearched gap.

### The original P-18 argument, kept because the mechanism is what it explains

Fourteen approved situations already carry more than one rule. P-18 carries four,
and all four branch on the same need, covering every value it can take:

```text
promotion_validity: unknown                          -> needs_customer_input
promotion_validity: expired | not_yet_started | inactive
promotion_validity: active
promotion_validity: not_found                        -> needs_customer_input
```

Four distinct value-signatures on one need is maximum discrimination — `nextNeed`
would select `promotion_validity` immediately, and `firstUnmetPrerequisite` would
then walk *back* to `promotion_identity`, because the code has to be extracted
before the promotion can be looked up. That is exactly the "collect the key
before a path can be taken" case, on a live situation, with the rules already
written and approved.

## Sequencing

Measurements first, because two of them are prerequisites rather than validation.

| # | Step | Why here |
| --- | --- | --- |
| 0 | **Run a backfill** — `investigate --backfill` | DONE FOR STEPS 1–2 BY THIS MEASUREMENT, and it found the blocker: the corpus ends 2026-08-21, so no stored run has ever loaded a rule or exercised the 2026-08-31 fix. Steps 1 and 2 cannot be *concluded* on it, only started |
| 1 | ~~Count model-initiated calls~~ — **done** | Median 1, p90 2, 69% reach beyond the floor. Promotions reaches on 100% of tickets |
| 2 | ~~Re-run the vocabulary audit after the backfill~~ — **done 2026-09-03** | **0 contradictions in 279 fresh entries.** Both `satisfied_but_empty` faults are history; the four that remained were one class of false positive and are encoded |
| 3 | ~~Ship `findings_trace`~~ — **done 2026-09-03** | Written from 2026-09-03; the 137 rows before it read NULL and can never be filled, so §10 is restricted to mail investigated from today |
| 4 | ~~Ship §8 — never ask for what is known~~ — **done 2026-09-03** | `fieldsAlreadyAnswered` filters a rule's `ask` on the findings. The not-attempted half is deliberately left: the answer there is to run the tool, not to drop the question |
| 5 | ~~Fill in `DEPENDENCIES`~~ — **done 2026-09-03** | Nine entries became thirteen; the product family has one for the first time. A cycle test guards it |
| 6 | ~~Gate as a report (§7)~~ — **done 2026-09-03** | `npm run report:completeness-gate`. 12 downgrades in 91 runs, split **4 right / 4 mixed / 4 where nothing can ever close the gap**. The last four are why §7 gained a fifth row |
| 7 | ~~Planner, additive only (§§2–5)~~ — **done 2026-09-03** | Opt-in per situation, default `model`. §2 understated it: `nextNeed` proposes nothing on a real findings map, and `available` had to become the rules’ needs plus prerequisites. **30 of 90** runs would collect. §6 deliberately left — its keys are not needs |
| 8 | ~~Per-task rules~~ — **done 2026-09-04** | Per REQUEST, from the decomposer’s tasks and the categoriser’s `secondary_category` — 21% of tickets carry a second rulebook. Strictest route wins; skeletons concatenate. `taskIndex` deliberately not built: a model-initiated call cannot be attributed to a request |
| 9 | Suppression, per situation — **replay built, suppression NOT enabled 2026-09-03** | `report:collection-replay` over 47 traced runs: **13 calls saved, 7 established facts lost**. Every situation that saves anything also loses something. The mechanism ships off; re-run the replay after the rules improve |

Steps 4 and 5 are worth doing whatever is decided about the rest.

## What this must never be able to do

- Make an incomplete investigation look complete.
- Let a rule's silence mean a fact is unnecessary.
- Let a rule clear a ticket the investigation did not clear (already guaranteed
  by the `route` check constraint and the rank check in `buildCaseFile`, and
  nothing here touches either).
- Put rule text in front of a model. The only field from this layer that reaches
  one is `answer_skeleton`, at drafting time, and that stays true.
