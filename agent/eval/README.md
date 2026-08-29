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
4. **BY LANGUAGE** — where the French-only corpus costs you.
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
