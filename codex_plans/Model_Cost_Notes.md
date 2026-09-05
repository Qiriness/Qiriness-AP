# Model cost — where it goes, and what could move it

Working notes, started 2026-09-04. Every number here is measured from
`llm_usage`, not estimated. Where something is a guess it says so.

**Read this before optimising anything:** the last measured attempt to reduce
cost through the rules layer (suppression, §10 of the rule-guided plan) came out
negative — 11 lookups saved against 2 established facts lost. The cheap wins in
this file are in the *shape of the calls*, not in doing less investigation.

---

## The headline: input dominates, 3 to 1

Measured over a 50-ticket batch, 4 September:

| | per ticket | share of spend |
| --- | --- | --- |
| input tokens | 5,651 | **76%** |
| output tokens | 453 | 24% |

**12.5 input tokens for every output token**, and at gpt-4o list prices
($2.50/1M in, $10.00/1M out) that is still 76% of the bill on the input side —
output is 4× the unit price but nowhere near 4× the volume.

**So: anything that shortens or reuses the prompt is worth roughly three times
the same effort spent on shortening the answer.** Tightening the case-file schema
or asking for terser prose is close to pointless. Removing a turn, or getting a
prefix cached, is where the money is.

---

## Level 1 — the spam gate

**Not in `llm_usage` at all.** The second-pass gate is described as model-based,
but no pass writes a usage row for it, so its cost is invisible here.

**Action:** find out whether it makes a model call, and record it if so. A gate
that runs on *every* inbound message — including all the mail that never becomes
a ticket — could plausibly be a large share of total spend and nobody would
know from this table.

---

## Level 2 — categorisation

`gpt-4o-mini` · 1 call per ticket · **2,798 in / 48 out**

The largest single input of any pass, and on the cheap model, which is the right
trade. Nothing obviously wasteful — it reads the email once and returns a handful
of labels.

Worth noting it produces a **secondary subject** on ~21% of tickets, which is the
input to the idea below.

---

## Level 3 — decomposition ← **the biggest single lever found so far**

`gpt-4o-mini` · **1 call per ticket, on every in-scope ticket** · 1,339 in / 77 out
· **1,375 tokens per ticket, 23% of the per-ticket bill**

Its only job is to answer *is this one request or several?*

**And roughly four tickets in five carry a single subject.** So most of these
calls confirm there is nothing to split, at ~1,375 tokens each.

**The idea worth testing:** the categoriser has *already* answered a version of
this question, for free, on the pass before — it writes `secondary_category`, and
on the LED-mask ticket it correctly said `product / promotions` before the
decomposer ran at all. If a ticket has no secondary subject, is the decomposer
telling us anything the categoriser did not?

**If the answer is "rarely", skipping decomposition on single-subject tickets is
worth ~18% of total spend** — comparable to everything the floor change bought,
in a pass nobody has looked at.

**Before believing that number, measure:**
- How often does the decomposer return more than one task? *Not currently
  stored.* It logs `investigation.decomposed` when tasks > 1 and nothing persists
  it. Storing the task count on the investigation row is a one-line change and
  the prerequisite for the whole idea.
- On tickets where it DOES split, had the categoriser already flagged a secondary
  subject? If it always had, the decomposer is confirming rather than
  discovering. If it sometimes finds a split the categoriser missed, the saving
  has a real cost and the trade needs stating.
- What does a wrongly-skipped split cost? Half an email answered — the failure
  row 8 was built to fix. This is the risk that decides it, and it argues for
  skipping only where the categoriser is confident, not merely silent.

---

## Level 4 — investigation

`gpt-4o` · **2.5 calls per ticket** · 1,853 in / 145 out per call ·
**4,607 tokens per ticket, 75% of the bill**

The main cost, and the only pass that can spend more than one call on a ticket.

### Input grows per turn, but less than you would expect

| turn | avg input | runs reaching it |
| --- | --- | --- |
| 1 | 1,507 | 48 of 48 |
| 2 | 1,718 | 46 |
| 3 | 1,881 | 27 |
| 4 | 2,325 | 4 |

**The base prompt is most of it.** Turn 2 costs only 14% more than turn 1, so
trimming what gets re-sent recovers a few hundred tokens per run at best.

**Removing a whole turn saves ~1,700.** That is the lever, and it is the one the
floor already pulls: a lookup promoted from "the model asks for it" to "it runs
before the model speaks" removes a request-and-response round trip, not just a
lookup. `lookupCustomer` moving to the floor on 2026-09-04 is most of the 19%
drop measured that day.

**So the ranked levers here are:**
1. Promote near-certain lookups to the floor — removes turns. Use
   `report:collection-planner` to see which facts the rules keep reaching for.
2. Get the prefix cached (below) — removes input cost without removing anything.
3. Trim the re-sent conversation — smallest of the three.

### On being smarter about what is re-sent

The conversation grows by appending: the user prompt, then each turn's assistant
message and tool results, all re-sent every turn. Candidates for trimming, in
rough order of value:

- **A superseded tool result.** When the same tool runs twice, only the later
  result is read by the findings derivations (`lastByTool`). The earlier one is
  still in the conversation being paid for every turn.
- **The full email body.** Capped at 3,000 characters and sent whole on every
  turn. The model has read it by turn 2.
- **`promptText` of tools whose need is already satisfied.** Careful: the model
  cites `[t1]` ids in its claims, and a claim citing a result that is no longer in
  the conversation is a claim it cannot support. **Anything removed must keep its
  id and a one-line summary**, or `verifyFindings` will delete the claim that
  rested on it. This is the constraint that makes trimming fiddly rather than
  free — and the reason it ranks below the other two levers.

---

## Level 5 — the prompt cache ← **free, and currently invisible**

**`prompt_tokens_details.cached_tokens` is never read.** `usage-sink.mjs` maps
`prompt_tokens` and `completion_tokens` and nothing else, so there is no way to
tell from `llm_usage` whether any prompt caching is happening or what it saves.

Given input is 76% of spend, this is the highest-value unknown in the file.

**What to check, in order:**
1. **Record it.** Add `cached_tokens` to the usage row. One field, no behaviour
   change, and it turns this whole section from speculation into measurement.
2. **Are prompts over the threshold?** Caching applies above ~1,024 tokens.
   Investigation turn 1 is ~1,507 and decomposition ~1,339 — both over, but not
   by much. If a prompt drifts under, the discount silently vanishes.
3. **Is the prefix stable?** Caching keys on an exact prefix. Within one
   investigation the prefix (system + user prompt) is stable across turns, so
   turns 2+ should hit. **Across tickets it will not** — the user prompt diverges
   immediately after the system prompt, and the system prompt alone (~600 tokens)
   is below the threshold.
4. **Which implies a cheap structural win:** anything static that currently sits
   *after* something ticket-specific should move *before* it. The longer the
   shared prefix, the more of every prompt is cached. Worth auditing the prompt
   builders for ticket-specific content placed early out of habit rather than
   necessity.

### The counterintuitive one: a prefix can be too SHORT to be worth caching

OpenAI documents a minimum-cacheable-length trap. Where a stable prefix sits
*just below* the threshold and is reused often, **adding genuinely useful stable
content to push it above can cost less than repeatedly sending the shorter
uncached version** — because the discount then applies to the whole prefix.

Measured, this system is exactly in that position:

| stable prefix | size | over the ~1,024 threshold? |
| --- | --- | --- |
| investigation system prompt | **~566 tokens** | no |
| decomposition system prompt | **~552 tokens** | no |

Both are byte-identical on every ticket, and both are too short to cache. Across
the 943 recorded investigation calls that is **~530,000 tokens of identical text
paid for at full price**.

**The arithmetic, and it gives a narrow target rather than a free hand.** Writing
`P` for the padded prefix and assuming cached input bills at half rate:

```
today:        566 tokens, full price, every call
padded:       P tokens, ~half price on a cache hit  →  0.5 × P
worth doing while:   0.5 × P  <  566      →      P < ~1,132
```

So the useful window is roughly **1,024 to 1,132 tokens** — about **460 to 570
tokens of additional content**. Below 1,024 nothing caches; above ~1,132 the
padding costs more than it saves. That narrowness is the point: **every added
token has to earn its place twice**, once on quality and once on the budget.

**Which is also why filler is the wrong move**, quite apart from quality. There is
only room for ~500 tokens, so they should be the most useful 500 available —
candidates being worked examples of a good case file, the established-versus-
unverified distinction spelled out with a real pair, or the `MISSING_FIELDS`
vocabulary with a line each. All stable, all arguably improving the output.

### Working the numbers — and the loop reverses the answer

Modelled against the **measured turn distribution**, because how often the agent
loops turns out to decide the sign of the whole thing.

**Assumptions, all of them arguable:**

| | |
| --- | --- |
| cache threshold | 1,024 tokens |
| cached input billed at | 50% of full rate — **the load-bearing assumption**, tested at 25% below |
| cache warm | yes: a 50-ticket batch reuses the prefix within seconds |
| prefix matching | exact, longest-prefix, no 128-token rounding |
| turns reaching 1 / 2 / 3 / 4 | 48 / 46 / 27 / 4 runs per 50 tickets (measured) |
| investigation system prompt | 566 tokens (measured) |
| turn inputs | 1,507 / 1,718 / 1,881 / 2,325 (measured) |

**What caching is worth before any padding at all:**

```
investigation input per ticket, no caching   4,229
                       with caching as-is    2,997      −29%
```

That is the prize, and it may already be being earned — nobody can tell, because
`cached_tokens` is not recorded.

**Padding the INVESTIGATION prompt, at a 50% cached rate:**

| system prompt | effective input/ticket | vs today |
| --- | --- | --- |
| 566 (today) | 2,997 | — |
| 1,024 | 3,298 | **+301** |
| 1,050 | 3,330 | **+333** |
| 1,366 | 3,725 | +728 |

**It loses at every size.** The reason is the loop, and it is worth stating
plainly: from turn 2 onward the prompt already rides a cached prefix covering the
*entire* previous prompt — 1,507 tokens, comfortably over the threshold. So the
padding is already inside a cached region on later turns and buys nothing there,
while adding billable length to **77 later calls per 50 tickets** against only
48 first calls that gain.

**Padding a SINGLE-CALL pass wins, because there is no later turn to ride on:**

| decomposition system prompt | effective input/ticket | vs today |
| --- | --- | --- |
| 552 (today) | 1,339 | — |
| 1,024 | 1,299 | **−40** |
| 1,104 | 1,339 | break-even |

Break-even is `0.5 × P < S`, so `P < 2S = 1,104`: a usable window of **80 tokens**
and a saving of ~3% on that pass. Real, but small enough that the quality risk
probably outweighs it.

### The sensitivity that decides it

Re-running with **cached input at 25%** instead of 50% reverses the investigation
result:

| | at 50% cached | at 25% cached |
| --- | --- | --- |
| investigation, caching as-is | 2,997 | 2,381 |
| investigation, padded to 1,024 | +301 **worse** | −121 **better** |
| decomposition, padded to 1,024 | −40 better | −296 better |

**So the sign of the investigation answer depends entirely on a rate this file
cannot see.** Do not pad anything before the actual cached-input rate is
confirmed against current pricing.

### MEASURED 2026-09-05 — the cache is real, and the arithmetic above rests on a false premise

`cached_input_tokens` now exists and `npm run report:prompt-cache` reads it.
Over 9 investigation runs (24 calls):

| turn | calls | avg input | avg cached | share |
| --- | --- | --- | --- | --- |
| 1 | 9 | 2,316 | 0 | **0%** |
| 2 | 9 | 2,780 | 1,550 | **56%** |
| 3 | 6 | 3,418 | 0 | **0%** |

**Investigation overall: 21% of input served from cache.** Decomposition, which
I had written off as uncacheable, comes in at **53% across a batch** and 0% on a
single ticket — so it already caches whenever tickets arrive close together, and
needs no padding at all.

**Turn 1 caching nothing is expected** — two tickets share only the 566-token
system prompt, which is under the minimum.

**Turn 3 caching nothing is not explained.** Its prompt is a strict superset of
turn 2's, which did cache. Two hypotheses were tested against the API directly
and **both are wrong**:

- *The closing call changes the request shape* (`tool_choice: none` + response
  schema, breaking the cache key). Tested: tools-only, tool_choice-only,
  schema-only and both-together all cached at **96–97%**. Not the cause.
- *Consecutive calls outrun the cache write.* Tested: three back-to-back appends
  with no pause cached **0% / 95% / 95%**. Not the cause.

Re-bucketing the production rows by burst rather than by hour — in case two runs
of one ticket were being merged — gives the same table. The effect is real and
its cause is unknown.

**Four hypotheses tested and all four disproved.** Each was tested against the
real API, not modelled:

1. *The response schema changes the cache key.* A shared prefix sent as loop
   shape twice, then as closing shape, cached 94% then **88%** — the closing call
   inherited the loop's prefix. Not the cause.
2. *`max_tokens` 800 vs 900 changes the key.* Same test with production's real
   values: the closing call cached **82%**, and dropping it back to 800 changed
   nothing meaningful. Not the cause.
3. *Cache-write latency.* Back-to-back appends cached 0% / 95% / 95%. Not the
   cause.
4. *My own run bucketing.* Re-bucketing by burst rather than by hour reproduced
   the table exactly. Not the cause.

**The instrumented run is what settled the shape of the question.** `CACHE_DEBUG=1`
hashes every message the client actually sends, beside what the API served:

```
turn 2  input 3099  cached 2944   tool_choice=auto  rf=none  max=800
        0:system:d4e6b42e 1:user:63cf0a55 2:assistant:ebdca479 3:tool:c177bfcc
turn 3  input 3311  cached    0   tool_choice=none  rf=53d1   max=900
        0:system:d4e6b42e 1:user:63cf0a55 2:assistant:ebdca479 3:tool:c177bfcc 4:user:55a48147
```

Turn 3's prefix is **byte-identical** to turn 2's plus one appended message, with
the same system and the same tools. It still caches nothing. The three request
fields that differ have each been cleared above. **The closing call's 0% is real,
reproducible, and unexplained — and it is roughly 30% of the investigation's
input tokens.**

### The padding test: run, and it LOSES

The prediction was that a system prompt past the 1024 minimum would let the
closing call cache. It was lengthened from 566 to ~1,120 tokens with real content
(every `MISSING_FIELDS` key with its label; the four field-confusion rules that
until now lived only in code comments; worked established/unverified contrasts;
verdict tie-breaks) — no filler, so quality could only improve.

**Turn 3 still cached exactly 0.** And turn 1, which shares no prefix with
anything, simply grew: **3,032 → 3,588 tokens, +556 paid in full on every call of
every ticket.** The mechanism the padding was meant to exploit does not exist here,
so the padding is pure added cost.

**Do not pad the investigation prompt.** The change is reverted. The prompt content
itself is genuinely better instruction and is kept in
`codex_plans/system-prompt-padding.patch` — re-apply it if it is ever wanted for
answer quality, but never for cost.

The instrumentation is worth rebuilding if this is picked up again: a hook in
`request()` in `agent/src/llm/openai-client.mjs` printing a sha1 per message plus
`cached_tokens`, behind `CACHE_DEBUG=1`. It turned three days of inference into one
run.

### Test in this order, and do not skip the first

1. **Record `cached_tokens`.** Everything above is arithmetic over an assumption
   until this exists. `prompt_tokens` already includes cached tokens, so no
   number currently in this file distinguishes a working cache from none at all.
2. **Confirm the cached-input rate and the TTL.** The rate decides the sign for
   the investigation. TTL decides whether any of this applies to live polling at
   all: a batch reuses the prefix within seconds, a poll trickling one ticket
   every few minutes may expire it between tickets and earn nothing — which would
   make the saving a property of *scheduling* rather than of prompt design.
3. **Only then consider extending a prefix**, single-call passes first, with
   content chosen for the output it improves and measured on quality as well as
   cost.

---

## Level 6 — drafting

`gpt-4o` · **1.94 calls per ticket** · 2,346 in / 121 out

Two calls per drafted ticket is worth understanding — the second is presumably a
retry or a check pass, and if it is a retry then the retry rate is the thing to
look at rather than the token count.

Drafting also grew this week: rule skeletons, pinned articles and offer codes all
lengthen the prompt, and per-request rules concatenate two skeletons instead of
one. That growth is deliberate — it is the fix for replies that answered half an
email — but it should be measured rather than assumed small.

---

## Level 7 — embeddings

`text-embedding-3-small` · 1,226 tokens per call · **122 tokens per ticket**

**2% of the bill.** Situation matching is effectively free, and the per-request
matching added on 2026-09-04 roughly doubled it — from 67 to 122 tokens a ticket,
which is noise.

Do not spend effort here. Noted because it is easy to assume the semantic
matching is expensive; it is not.

---

## The order I would work it

1. **Record `cached_tokens`.** One field. Turns the largest cost centre from
   guesswork into data, and may show a discount already being earned — or a
   simple prompt reordering that would earn one.
2. **Store the decomposer's task count.** One field. The prerequisite for the
   18% idea, and worthless to argue about without it.
3. **Find out whether the spam gate calls a model**, and record it if so. It runs
   on more messages than anything else in the pipeline.
4. **Keep promoting near-certain lookups to the floor.** Proven: 19% in one day.
   `report:collection-planner` is the instrument.
5. Only then look at trimming the conversation, and only with the evidence-id
   constraint above firmly in mind.

Nothing in items 1–3 changes behaviour. They are all measurement, and this file
exists because the two cost ideas that looked most obvious — suppression, and
trimming output — were both measured and turned out to be wrong.
