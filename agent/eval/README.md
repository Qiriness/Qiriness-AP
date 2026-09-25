# `agent/eval/` — every measurement, in one place

Nothing here runs in production. Each script answers one question about how well
a layer works, and each says plainly what it measured against, because the
difference between a labelled set and a proxy is the difference between a result
and a hint.

**Read the "judged against" column first.** Three of these five score against a
hand-labelled set; two score against a *proxy* and can only ever show you shape.

| Command | Script | Judges | Judged against | Writes |
|---|---|---|---|---|
| `npm run eval:categorise` | `run-categorisation-eval.mjs` | Subject + level assignment | **Labelled** — `categorisation-cases.mjs` | nothing |
| `npm run eval:retrieval` | `run-retrieval-eval.mjs` | Knowledge chunk retrieval | **Labelled** — `retrieval-cases.mjs` | nothing |
| `npm run eval:diagnose` | `diagnose-retrieval.mjs` | Knowledge retrieval, per query | Live library, no labels | nothing |
| `npm run eval:exemplars` | `diagnose-exemplars.mjs` | Exemplar matching + band calibration | **Proxy** — subject agreement | nothing |
| `npm run eval:order-states` | `diagnose-order-states.mjs` | Which order/delivery/payment states real tickets reach | Live bundles, **no labels and no API calls** | nothing |
| `npm run eval:exemplar-needs` | `compare-exemplar-needs.mjs` | Does the corpus describe what tickets require? | Live rows, **independence** — excludes any row where the exemplar supplied the needs | nothing |
| `npm run eval:knowledge-gaps` | `knowledge-gaps.mjs` | Which questions the library keeps failing | Live rows — a demand report, not a quality one | nothing |
| `npm run eval:closure` | `run-closure-eval.mjs` | Does a customer's last message close their request? | **Labelled** — `closure-cases.mjs`, ids and booleans only; the bodies are read live | nothing |
| `npm run eval:casework` | `run-casework-eval.mjs` | At each message in a thread: what did it change, and what should the pipeline do next? | **Labelled** — `casework-cases.mjs`, written on the `cases:label` page and folded in by `cases:import`; ids and choices only, bodies read live | nothing |
| `npm run eval:audit-phrasings` | `audit-phrasings.mjs` | Phrasings filed under the wrong situation | Stored vectors against each other — **no API calls** | nothing |
| `npm run cluster:tickets` _(repo root)_ | `scripts/cluster-ticket-messages.mjs` | What customers actually write about | Nothing — it is the source of demand | nothing |

**None of them writes to the database.** That is deliberate and it is what makes
them safe to run on live data at any time. `diagnose-exemplars.mjs` goes furthest
to preserve it: it embeds the phrasings **in memory**, because approval gates the
vector and the numbers a reviewer needs in order to approve would otherwise only
exist after approving.

## Reading `eval:exemplars`

Six sections, and they answer different questions:

1. **WHERE THE BEST MATCH LANDS** — the score distribution, and what share of
   tickets clears each threshold. This is what sets `MATCHED` and `NEAR`.
2. **SUBJECT AGREEMENT** — the proxy. Does the winning exemplar's subject agree
   with the subject the categoriser assigned independently? The sweep beneath it
   is the one that actually chooses a band: `restraint` is how much of what
   clears the bar is right, `recall` is how much of what is right survives.
3. **MARGIN** — how far the winner beats the runner-up, which sets `minMargin`.
   A margin distribution that collapses toward zero is the corpus telling you two
   situations want merging, not a threshold that wants moving.
4. **BY LANGUAGE** — where a French corpus costs you, and, since 2026-09-09,
   how often a *translated* phrasing is the one that wins. The two are different
   claims: adding rows lifts a best-of median whether or not any of them wins.

   **Pair it with `--authored-only`, which drops the translations and scores the
   authored library alone.** A median read against a figure from an older run is
   measuring the corpus, not the library — the ticket count went 214 → 328
   between the two, which moved the numbers more than the translations did. Run
   it twice in one sitting or do not compare at all.
5. **WHICH EXEMPLARS EARN THEIR PLACE** — win counts.
6. **WHY THE SILENT ONES LOSE** — the diagnosis behind section 5, since "never
   wins" has causes that want opposite fixes:
   - `DUPLICATE` (median gap **0.000**) — not a close call. The same text is in
     the table twice, which is what a merge leaves behind: the importer upserts
     and never deletes an exemplar that has left `Email-Example-Queries.md`.
     **Delete the retired row; until you do, it drags every margin down.**
   - `COLLISION` — genuinely two rows competing for one situation. Merge them.
     More phrasings would only sharpen the tie.
   - `ABSENT` — never within `NEAR` of anything. Rare here, not mis-worded.
   - `MID-PACK` — never in the top two, but not far off. No single rival to merge
     with; the field already covers it.
   - `language, not phrasing` — its closest tickets are all non-French.

## What none of these can see

**Follow-up questions.** `diagnose-exemplars.mjs` scores the **first inbound
message** of each ticket, because later messages are replies to us and would
pull our own vocabulary into the query corpus. But some questions only ever
arrive mid-thread — *"are the return costs refunded?"*, *"any news on my
refund?"* — so those exemplars cannot win here no matter how they are worded.
R-22 is the worked example. Silence about them is not evidence against them.

## Reading `eval:knowledge-gaps`

The one report here that produces a **task list** rather than a judgement. Every
investigation records, per need, whether the knowledge search answered; this
groups the failures by subject and ranks them by how often the desk was asked.

The two columns want different work and must not be added together:

- **missing** — the library holds nothing on the subject. Write it.
- **near-miss** — an article exists and did not match well enough. `closest` is
  how near it came, against a floor of 0.55; anything above ~0.50 is usually a
  retitle rather than a rewrite.

It says nothing about whether the answer would have been *good* — only that the
agent had nothing approved to answer from. Pair it with `cluster:tickets`, which
measures the same demand from the customer's side rather than the agent's.

## Reading `eval:audit-phrasings`

Costs no API calls: it scores stored vectors against each other. It exists
because the exemplar eval structurally cannot see this class of error — a
mis-filed phrasing still wins the ticket it was lifted from, so the win counts
look healthy. Two passes: **MISFILED** (a phrasing that retrieves a situation
that is not its own — mostly adjacency, read the margin) and **MULTI-INTENT** (one
phrasing carrying two questions, which can only ever be filed half-wrongly).

## Closure: the labels are the author's own, and the failure modes are not symmetric

`eval:closure` scores every thread where a customer wrote after our reply — all
16 as of 2026-09-21, the whole population rather than a sample, because that is
the only population a closure can occur in.

**It is the one eval whose corpus is real mail.** `closure-cases.mjs` holds ticket
ids and booleans; the message bodies are read from the database at run time. Ids
and labels are not personal data, and the alternative — inventing sixteen
closing emails — would measure the invention rather than the corpus.
`diagnose-exemplars.mjs` already scores live tickets the same way.

**The labels were written by the author of the check they score**, which is the
weakest kind of labelled set there is. Read a score as a regression signal, not
as an accuracy claim, and disagree with `closure-cases.mjs` in a diff.

**Two layers are scored separately.** `closureAllowed` is pure code and stops 11
of the 16 before any model call; only the remaining 5 reach the model. A case
where the message alone reads as a closure but the dossier is still open —
`d6d0d1c3` — is expected to produce NO closing reply, because what is being
scored is what production does, not what a model reading one message would say.

**`--repeat N` asks each open case N times**, and the worst answer is the one
reported rather than the majority: a false closure that fires one run in seven
still reaches a customer one time in seven. Measured 2026-09-21 at `--repeat 8`,
0 of 5 open cases were unstable — after one flip observed earlier on
`fcf4ca11` that 45 subsequent calls did not reproduce.

**A false closure fails the command; a missed one does not.** A missed closure
sends a full reply to somebody who wanted a line, and the reviewer sees it. A
false closure sends three lines to somebody who needed help.
