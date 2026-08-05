# VALIDATION LOG

Things that are **built and tested, but not yet proven against real data**.

This exists because the dev Shopify store is a fixture, not a copy of the
business: 16 products with thin merchandising fields, 3 discounts, 12 orders
numbered `#1001`-`#1012`, 15 customers, and zero abandoned checkouts — while the
support mail is from the live inbox and references orders like `#4854`, `#6216`
and `Q00 26200111`. Unit tests prove the logic; they cannot prove the assumptions
about data that does not exist here yet.

**Each entry says what to check and how, not just that it is unchecked.** An
item is only removed once someone has actually run the check and seen the
result. Expect this list to grow as more is built against the dev store.

Last updated: 2026-08-05 (item 9 added: the investigation agent).

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

## 4. Knowledge retrieval bands are calibrated on 11 chunks

`ANSWERABLE = 0.60` / `WEAK = 0.45` come from measurements against a library
that is one approved document — 11 `faq` chunks. Measured on 12 real
product/account tickets: 1 answerable, 8 weak, 3 nothing, with most weak matches
landing on a single generic "conseils sur les produits" chunk.

**To validate:** after real product content is written and approved, re-run the
same 12 tickets and check that (a) the bands still separate correct from
incorrect matches, and (b) the generic FAQ chunk stops dominating. The bands are
provisional and named constants precisely so they can be moved.

## 5. Product tools run against a thin catalogue

Of 16 products: 5 have `usage_instructions`, 3 have `active_ingredients`, 3 have
`product_faqs`. The tools return what exists, so a usage question finds nothing
for 11 of 16 — a merchandising data gap, not a code one.

**To validate against a real catalogue:** that IDF weighting still separates
products when there are hundreds rather than sixteen (the `creme`-vs-`led`
weighting is a function of catalogue size), and that `ambiguityMargin = 0.12`
still reports genuine ambiguity without flagging every near-name.

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

**The order-context bundle is now built** and verified by assembling the real
`#1006` order — correct delivery state, tracking number and carrier, refund
totals, RFM group, no street address or phone. What it has never done is run over
*live* tickets, because none carry a confirmed order number yet; `context:build`
currently considers zero. It unblocks the moment the resolver starts producing
values.

**Still blocked entirely:** tracking, which needs live parcel status — see the
open question in `AGENT_INTEGRATION_PLAN.md` about whether that tool can report
what a parcel is *doing* or only what its number is.

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
