# VALIDATION LOG

Things that are **built and tested, but not yet proven against real data**.

This existed because the Shopify store behind Supabase was a dev fixture, not a
copy of the business: 16 products, 3 discounts, 12 orders numbered `#1001`-`#1012`
and 15 customers, while the support mail is from the live inbox and references
orders like `#4854`, `#6216` and `Q00 26200111`. Unit tests proved the logic;
they could not prove assumptions about data that did not exist here.

**That premise no longer holds.** The project points at `qiriness.myshopify.com`
and the syncs have run — measured 2026-08-11:

| Table | Rows | Note |
|---|---|---|
| `orders` | 2052 | `#4716`–`#6770`, which **contains** every order the corpus quotes |
| `customers` | 58 201 | was 15 |
| `products` | 116 | was 16 |
| `promotions` | 327 | was 3 |
| `tickets` | 214 | 141 carry a `customer_id`; **0 carry a `shopify_order_number`** |

So the items below are no longer blocked by absent data — they are simply
**unrun**. That is a better problem and a different one: every check named here
can now actually be executed, and the answer it gives will mean something.

**The one that gates the rest:** `orders:resolve` has never run against this
data, so no ticket carries a confirmed order number and every order-context
lookup still reports `not_resolved`. Run it before reading anything below as
evidence about the order family.

**Each entry says what to check and how, not just that it is unchecked.** An
item is only removed once someone has actually run the check and seen the
result.

Last updated: 2026-08-11 (environment corrected: the dev-store premise in this
preamble was stale, and row counts were re-measured against the live store. No
item closed — none of the checks below has been run.)

---

## 1. Forwarding has never actually sent a message

**Status:** 42 messages queued at `attempts=2`, 0 sent.

Every attempt returns `ErrorMailboxMoveInProgress` — Exchange is migrating the
mailbox between databases, which is transient and Microsoft-side. `Mail.Send` is
granted and verified working: a direct `sendMail` test to
`onouailhetas@lap-groupe.com` returned HTTP 202 and arrived. Only the `/forward`
action is blocked, because it reads an item from the store being moved.

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

1. **Is `not_attempted` ever non-zero?** This is the number the whole thing was
   built for — a tool was allowed, the budget was there, nothing called it. If it
   is always 0, the loop is already doing its job and step 2's steering is not
   worth building. If it is high, that is the agent, not the library.
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

## 6b. The order family was enabled with 15 mismatches unexamined — OPEN AUDIT

**Opened 2026-08-13, by decision rather than oversight.** `ENABLED_SUBJECTS` now
contains `order`, `delivery`, `payment` and `return_exchange`. The 15 `mismatch`
tickets from `orders:resolve` had **not** been reviewed when that happened.

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

1. Read the 15. For each, decide whether the requester genuinely owns the order.
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

**The order-context bundle is now built** and verified by assembling the real
`#1006` order — correct delivery state, tracking number and carrier, refund
totals, RFM group, no street address or phone. What it has never done is run over
*live* tickets, because none carry a confirmed order number yet; `context:build`
currently considers zero. It unblocks the moment the resolver starts producing
values.

**Still blocked entirely:** tracking, which needs live parcel status — see the
open question in `AGENT_INTEGRATION_PLAN.md` about whether that tool can report
what a parcel is *doing* or only what its number is.

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

## 8. Automatic customer resolution has never run over the live ticket table

**Status:** built and unit-tested (`agent/src/resolution/customer-resolution-runner.mjs`),
never executed against the 565 real tickets.

The dev store holds 15 customers while the corpus is live support mail, so the
match rate here says nothing: almost every real requester is an address the dev
`customers` table has never seen. What the dry run *can* establish is the shape
of the answer, and three things are worth reading off it.

**To validate:** `cd agent && npm run customers:resolve:dry-run`.

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

**Then check against production-like data:** once real customers are synced, the
same dry run should link a substantial share of the 565, and any ticket linked
to a customer whose address does not match the requester is a bug worth chasing
immediately — it would mean a hash collision or a denylist gap.

## 9. The investigation agent has run, and what it produced is not yet judged

**Status:** run for real on **40 of the 65 in-scope tickets** — 9 `answerable`,
6 `needs_customer_input`, 25 `needs_human`, 0 failures. Its guardrails were
checked against what was actually written: **0 unsourced claims stored, 0 claims
dropped, 0 internal handoffs reaching a drafting projection, and a maximum of 3
tool calls in any run against a ceiling of 6.** Those are mechanical properties,
and they hold.

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

**Also unvalidated:** the whole order family. `order`, `delivery`, `payment` and
`return_exchange` have complete tool policies, opening moves and escalation
rules — including the ten-day stale-parcel trigger that four of the seven level
disagreements in the review set point at — and every one of them is dormant,
because `ENABLED_SUBJECTS` excludes them until real orders are synced (item 6).
Turning them on is one array edit **plus** `npm run investigate -- --backfill`:
their existing tickets were skipped and their flag cleared, so nothing re-queues
them on its own.

**And the cost is not yet measured.** 40 runs on `gpt-4o` at 1-3 tool calls each
is cheap; 565 tickets re-investigated on every customer reply is a different
number, and nobody has looked at it. Check the OpenAI usage for these runs before
the worker is left running unattended.
