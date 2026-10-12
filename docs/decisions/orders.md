<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Orders

### An Orders page replaced the "Knowledge — Soon" placeholder (2026-09-14)

Asked for by the owner: the Shopify admin's order list, inside the app, so looking an order up does not mean leaving it. The sidebar's Knowledge item never had a page; Orders takes its slot. Columns are the owner's: Order, Date, Name (crown when VIP), Total, Fulfilment status, Articles, Carrier, Destination. Filters: fulfilment status, Global / By country, VIP.

- **Paged in SQL, 50 rows a page.** 6,008 orders is past PostgREST's 1,000-row cap, and paging an unordered read overlaps (§ Insights). `orders_list()` orders totally (`processed_at desc, id desc`) and counts the filtered set with `count(*) over ()` before the page is cut, so the pager and the rows come from one statement. Measured 2026-09-14: pages 1 and 2 share no order, ~300 ms a page warm.
- **The URL is the state**, as on Insights: a filtered page is linkable and the server re-renders. A page past the end falls back to page 1 rather than an empty table with no count.
- **Facets come from the data, grouped on the list's own filter expressions**, so each option's count is exactly what selecting it returns — all 17 checked against the live table. Today that is only `FULFILLED` (5,977) and `UNFULFILLED` (31), plus 14 countries and one order with no destination (`??`); a status Shopify adds later appears without a code change.
- **VIP is `vip_customers()`**, never compared in TypeScript — the same rule as the queue, the Customers panel and `open_orders()`.
- **The carrier is `order_fulfilment_timing`'s derivation** (lowest tracking company through `normalise_carrier()`), so a row and the Fulfilment carrier table cannot name different carriers. A test pins both.
- **The ring also marks the Fulfilment panel's orders waiting to ship (2026-10-04, at the owner's request)**, from the same `loadOrderTicketMarks`, with the same tooltip and legend. An unshipped order somebody has written about is the one to ship first, and two colour rules for one order would contradict each other. On 2026-10-04, 2 of the 8 waiting orders had an open ticket.
- **Fulfilment status was drawn neutral, then given a light amber dot at the owner's request (same day).** The first version kept colour for the ticket ring alone. Amber marks an order not yet fulfilled; it is pale (#ffd98a on #e8a93a) so it does not read as the orange ring, and local to the page because gold belongs to VIP and `--warning` is the orange ramp.

### An order emptied before it shipped says Cancelled or Refunded, not Unfulfilled (2026-09-18)

**Asked for by the owner: orders with 0 articles were reading "Unfulfilled".** Cancelling or refunding every line takes each `current_quantity` to 0 but leaves Shopify's fulfilment status at `UNFULFILLED` for ever. Measured 2026-09-18: **all 14 `UNFULFILLED` orders in the shop have 0 items left**, 7 cancelled and 7 refunded without a cancel. No order that still has items is `UNFULFILLED` today, so every amber pill on the page was one of these.

- **The rule is `fulfillmentDisplay` in `scripts/lib/order-list-query.mjs`, one place for the list and the order page.** Not shipped (`FULFILLED`/`RESTOCKED` excluded) **and** 0 items left: cancelled → **Cancelled**, else `financial_status = REFUNDED` → **Refunded**, else Shopify's word stands.
- **Zero items is the gate, not the refund.** A partly refunded order with something still to ship is still waiting. A shipped order that was then returned (18 more zero-item orders, all `FULFILLED`) keeps **Fulfilled**, because it was.
- **Cancelled wins over Refunded** because it is the fuller answer (6 of the 7 cancelled were also refunded, the seventh voided).
- **Grey with a hollow dot**, not amber: the order is finished, like Fulfilled, but nothing went out.
- **The order page drops the pill from its header** for these, because the Cancelled chip or the Refunded payment chip beside it already says so. The Fulfilment card's aside carries the label.
- **The status filter selects what the pill shows (migration 31, same day).** At first the filter kept Shopify's value, so "Unfulfilled" returned these 14 rows labelled Cancelled / Refunded. Now `order_fulfilment_display()` in SQL holds the same rule, `orders_list()` filters on it and `orders_list_facets()` groups on it, so the options read Fulfilled 6,013 / Cancelled 7 / Refunded 7, and Unfulfilled appears only when an order is really waiting. This was first checked in a transaction that was rolled back, then applied the same day and confirmed through PostgREST.
- **The rule exists in two languages, pinned by a test.** The pill is labelled in JS (`fulfillmentDisplay`) and the filter runs in SQL. `31_orders_status_filter.test.mjs` asserts both carry the same branches in the same order and count items the way the `units` column does. Change one, change both.

### Orders carries a badge for orders waiting to ship (2026-09-18)

**Asked for by the owner, "like Tickets and Conversations".** The number is **`open_orders()`'s waiting rule** (not fulfilled or restocked, not cancelled, not closed), counted with a `count=exact` HEAD by `countOrdersAwaitingFulfilment`. So it counts the same orders as the Delay column and the Fulfilment panel's waiting list, and not the 14 orders that read `UNFULFILLED` only because they were cancelled or refunded (all are closed). Measured 2026-09-18: **0 orders waiting**, so the badge is hidden until one arrives. Without the closed condition the same count finds the 7 refunded orders, which confirms the filter reaches real rows.

- **Grey, like Conversations.** The warning colour stays with Tickets, the queue that is worked. A late order has its own red on the page itself.
- **Each badge fails on its own.** An orders count that cannot be read shows no Orders badge and leaves the ticket badges alone, and the other way round.

### Delay and search (2026-09-14)

**Delay is whole days since the order was placed, shown only while the order waits to ship**, and "waits" is `open_orders()`'s rule copied condition for condition into `orders_list().awaiting_fulfilment` — not fulfilled or restocked, not cancelled, **not closed**. The last condition is the one that matters: six orders read UNFULFILLED for ever because they were refunded instead of shipped (§ Insights, "Orders waiting to ship"), and a Delay column counting them would show them as the most delayed orders in the shop. A test asserts the two functions share the four conditions. SQL decides *whether*, JavaScript counts *how long* (`delayDays`, floored), because the count moves every minute and the rule does not. Three days or more is red ink, the same line the dispatch figures and the waiting-orders list use; ink rather than a filled pill so it does not compete with the ring.

**Search runs in SQL over the whole table, not over the page on screen.** A filter over 50 rendered rows would report "no match" for an order on page 40. It matches the order name, the buyer's name and email (searched, never displayed on the list), and a tracking number compared in `orders.tracking_numbers`' stored normalised form, so `6C 2072 3002 488` finds `6C20723002488`. LIKE wildcards are stripped in `normaliseSearch` rather than escaped in SQL; nothing a person searches for contains them. The box debounces 350 ms and owns its text while typing, so a slow render for "mar" cannot overwrite "martin".

**Migration 16 drops the old signature before creating the new one.** `create or replace` cannot add an argument or a return column, and adding `p_search` beside the old function would leave two overloads PostgREST refuses to choose between — the page would fail on its first read.

### The destination ring is the queue's band, not a second score

The customer's name is ringed red / orange / green when an **open** ticket is confirmed against the order. It first shipped on the Destination cell and was **moved to the name the same day at the owner's request**: the ticket is about the person who wrote, and the name is where a reader of the row looks for them — the same reason the queue's VIP crown sits beside the name rather than on the row. The colour is the `priorityBand` the ticket already carries on `/tickets` — read through `listTicketsWithOrders` (the list's own projection, both halves of the sender partition) and folded per order by `ticketMarksByOrder`, which only picks the most urgent open band. Re-scoring here would give one ticket two colours the first time either rule changed. The ring is an inset shadow so a ringed cell keeps its neighbours' height, the same reason the queue's bars are.

**The join is `tickets.shopify_order_number`, and that makes the ring a floor.** Only a confirmed match is written there (§ Order resolution), so an order whose ticket never quoted a number stays unringed: a ring can be trusted when present and says nothing when absent. Keys compare through `orderNumberKey` (`#7008` == `7008`), and a non-Shopify reference (`Q00 26200111`) matches nothing rather than its digits. Measured 2026-09-14: **58 of 172 tickets** carry one (an earlier reading of 0 was a probe bug — VALIDATION_LOG 24).

Closed tickets leave no ring: a mark for a finished conversation would say somebody is waiting when nobody is. The detail page still lists them, open first.

### The detail page is cards, and names only what the list already did

Articles, Fulfilment, Payment on the left; Tickets, Customer, Destination, Tags on the right — Shopify's order page shape, with Tickets leading the right column because they are why this page lives in a support app. Personal data matches the Fulfilment panel's waiting orders: name and email, with the email withheld for marketplace buyers (placeholder addresses), and the masked address where no customer is linked. No street address exists to show (§ Data handling). Both pages write a `data_access_events` row. Ticket entries link to `/tickets`, not to the ticket: that page had no deep link when this was written, and it does now (`?ticket=`) — the Order block on a ticket uses it in the other direction.

**The two pages now link both ways (2026-09-18).** A ticket's order number is a link to `/orders/[id]?ticket=<ticket>`, and the order page reads that parameter to offer **← Back to the ticket** rather than dropping the reader on the queue. The id is checked against a UUID pattern before it becomes a link, so the parameter can only ever name one of our own tickets. `TicketDetail.orderId` is one small read by order name — the bundle stores the NAME and the page is addressed by id.

**The Promotions card reads the same builder as the agent** (`buildPromotions`, exported from `order-context.mjs`), so the page and the case file cannot disagree about whether a gift was given. It adds money labels and nothing else: the gift/sample judgement stays in one place.

### Refund notice: a refund recorded in Shopify is told to the customer, by a person's approval (2026-10-05)

**The gap, on a real ticket.** `75419781` (#6886): our last reply on 2026-09-07, the ticket closed (`next_actor = nobody`), then a partial refund (24.43 €) recorded in Shopify on 2026-09-25. Nobody told the customer. The change router could not catch it: it acts only when we owe the next step, and never on a closed ticket. "Completed" here means **recorded in Shopify** (a refund record on the order), as the owner defined it.

**A message we send unasked, so the router's gates do not apply.** A separate check (`noticeDue`, `change-router.mjs`) runs first in the `route` stage, on tickets in any status but `spam` / `forwarded`. A refund counts when it was created after the ticket's first message (one from before is not news to this case), after our last message on the case (we have not told them since), and within `refund_notice_window_days` of the ticket's last message (45, set by the owner on 2026-10-05, replacing the 60 first discussed). The same refunds are never noticed twice; a later one is. One notice per case, on the thread written last. "Informed" is exactly « a message of ours went out after the refund ».

**Which rule and which tickets is data.** `support_answers.notify_on = 'refund_recorded'` marks the template (migration 72). The owner chose `remboursement_deja_parti` for its structure. The rule's answer set is the scope: a ticket qualifies when its category or second subject maps to that set (`answerSetFor`). Unset parameter or no marked rule: nothing happens. Nothing in code names the rule, the set or the category.

**Switched on from the dashboard (asked for by the owner, 2026-10-05).** The rule editor has a « Tell the customer when a refund is recorded » checkbox; the window is on Parameters. **Only in the returns set, one rule at a time** (owner, 2026-10-05). The box appears only on rules in a set whose rules branch on `refund_state` — read from the rulebook, so it is `returns` today without the code naming it — and saving refuses the flag anywhere else. While one rule holds it the box is locked on every other rule of the set, naming the holder; saving a second is refused too. A database index was proposed for this and declined: the editor and the save are the only writers. Saving a rule makes it a draft, as any edit does, so the template must be put live again before the router uses it. `NOTICE_EVENTS` lives in `scripts/lib/notice-events.mjs` so the editor and the router read one list.

**Reopened for a person, closed again once told** (decided with the owner). The router records `fact_drift.notice` and reopens a `closed` or `resolved` ticket to `awaiting_human`, clearing both timestamps as ingestion does. The fold then keeps `next_actor = support` while no message of ours is newer than the notice (`noticePending`), and the notice joins the version hash, so the version rises once and the draft key has room. After the notice goes out, the ordinary reading resumes: nobody owes anything → `resolved`, or an open check keeps the case open.

**Drafted in the `draft` stage whatever `DRAFT_IN_POLL` says.** Every notice is approved by a person (decided with the owner), and only a recorded notice queues one, so it cannot draft or send on its own. `runDrafting` with `gates: 'notice'` reuses the composer, the checks and the row:
- the template's skeleton and tones replace the case file's own rule; nothing is asked, offered or linked;
- every claim resting on `getOrderContext` alone is dropped, because the order has moved since;
- a « Message à notre initiative » section says the customer asked nothing new, not to answer their last message twice, and to read « le client demande » as « nous l'informons ». It closes when nothing is outstanding (no open check, no pending input; `disposition = terminal`), otherwise it says in a sentence what is still to come;
- `purpose = 'refund_notice'`, never auto-send eligible (`refund_notice` hold, shown to the reviewer). `actionFromDraft` refuses `auto_send` for a notice as well.

**The send check counts only what we wrote after the notice.** A notice is threaded under the customer's last message, which we have already answered. For a notice, `already_answered` counts our messages after `drafted_at`; the customer writing again still refuses it.

**Known gap.** Shopify refund records are synced without their lines (`mapRefund` keeps amount, dates and currency), so the notice cannot name the refunded products the skeleton asks for. The prompt says to name them only where the case file establishes them. Fixing it means syncing `refundLineItems`.

### Change router: a change is routed to the cheapest action that keeps the reply true (2026-10-04)

**The problem, on a real ticket.** `c3efeb4e` (#7093): the bundle was built on 2026-09-28 reading `UNFULFILLED` / `not_dispatched`, and a draft saying « pas encore expédiée » was sent that day. The order was fulfilled on 2026-09-29 (tracking `6C21247957209`). On 2026-10-04 the ticket was re-investigated against the same bundle, still reading not dispatched. Three things were missing: the bundle was built once (`context_resolved_at IS NULL`) and only `context:build --refresh` rebuilt it; an order update only woke partner snoozes; `orderChangedSince` compared order *numbers*, never states. So even a new customer message was answered from the old order.

**Refresh broadly, re-investigate narrowly, redraft stale answers, check before sending.** Decided with the owner:

| What moved | Action |
|---|---|
| the rule the case file followed would no longer be chosen | re-investigate |
| the rule holds, a fact the reply states moved | redraft only |
| nothing the case's rules read, nothing it states | nothing (the bundle is still rebuilt) |
| our reply has gone and the case waits on the customer, a colleague or a partner | nothing: their reply re-investigates, or closes the case |
| what a partner's snooze waits for | wake (unchanged: `snooze-order-wake.mjs`) |

New mail, an order linked and a person's correction still re-investigate whatever moved. Their writers predate the router and stay where they are; `ALWAYS_REINVESTIGATE` writes the table down.

**The bundle is rebuilt whenever Shopify has a newer version, at no model cost.** The bundle records the `shopify_updated_at` it was built from (`sourceUpdatedAt`) and is rebuilt when the order carries another. Compared for equality, not as "newer than the build": a sync can land after the build carrying a change Shopify made before it. Not `orders.updated_at` either: the nightly sync rewrites all 6,133 orders, which would rebuild every bundle every night. Bundles from before the stamp are rebuilt once.

**Decided in code, because the investigation already stored the decision.** `exemplar_match.policy` holds the answer set, the situation, the chosen `answer_key` and the findings it was chosen on (`per_request` on a multi-request ticket). `findings_trace` holds the full state vector the case file saw. `selectAnswer` is pure: swap the new states in, choose again, compare. Not the Case Manager: it reads messages, and an order state is a fact with one right value (the reasoning of § Human overrides). A case file with no stored selection was decided by the model alone, so whether it holds cannot be computed: an `order_state` change re-investigates it, any other change does not.

**Only when we owe the next step** (`next_actor = support`, status `open` or `awaiting_human`, no pass pending). Asked for by the owner: once our reply has gone, working ahead of the next message is spent for nothing. The customer's reply re-investigates anyway, and a colleague's or a person's reply is most likely a closing one. This also means the router never reopens an `awaiting_*` status, which `reinvestigationColumns` would.

**`awaiting_human` is redrafted, never re-investigated (decided with the owner, 2026-10-04).** The dry run found 17 of the 18 live tickets with an order `awaiting_human`, 14 of them with the next step ours. Drafting still writes those a draft for the person to review, and leaving « pas encore expédiée » in front of them after the parcel left is the stale output this exists to stop. A re-investigation would reopen the status and take the case back from the person. So for these tickets a moved rule is downgraded to a redraft, named `rule_changed:held_for_person` (or `order_state_without_rule:held_for_person`). The redraft still follows the old rule's skeleton, with the contradicted order claims dropped and the current order section. `c3efeb4e` folds as waiting on the customer (`next_actor = customer`, after our 2026-09-30 message), so the router leaves it alone; its bundle already reads `FULFILLED` for whoever writes next.

**A move to `unknown` is not a change.** It means « could not tell ». A parameter that failed to load turns every time state into it, and acting on that would redraft every open case for knowing less. For the same reason the pass is skipped, not run on an empty parameter map, when the parameters fail to load.

**The drift is a column the fold hashes** (`tickets.fact_drift`, migration 69). Its `changed` + `case_file_at` join `materialHash` only when present, like `overrides`, so applying the migration moves no version. A drift raises the version once. From there the existing machinery takes over: open drafts go stale (`case_changed`, approvals withdrawn), `needingDraft` drafts the new version, and `preSendCheck` refuses the old approval (`case_moved`). `checked_at` is not hashed, so re-finding the same drift moves nothing. The drift is never cleared: after a re-investigation the new case file reads the new states, so the router finds nothing to write, and clearing would bump the version a second time and stale the draft just written.

**The redraft leaves out the claims the order contradicted.** 67 of 71 case files on tickets with an order state order facts in prose (« La commande #6273 … expédiée il y a 74 jours »). A redraft without a new investigation would hand the model both the old sentence and the new « Commande concernée » section. Decided with the owner: while the drift was measured against the case file being drafted from, the established claims whose evidence is **only** `getOrderContext` calls are dropped (`dropped_order_claims` in `prompt_inputs`). A claim that also cites another tool is kept, since its other half may still hold.

**The clock is now for routed work.** Amends § *The clock is the customer's message* for live tickets only. The router measures at `now`, because the reply goes out today. A re-investigation it queues runs at `max(latest inbound, metadata.change_router.at)`. Otherwise the run would measure « within window » at the message time and the router would queue it again every poll. Replays and evals carry no `change_router` and keep the message clock. « Delivery is now late » is therefore just a state that changed: the time trigger needs no machinery of its own.

**Checked again at send, on what a customer would notice.** The version check cannot see an order that moved after the last poll, or one the sync-only worker (`--stop-after=ingest --also=send`) never routes. The bundle also records `sourceSignature`, a hash of fulfilment, payment, cancellation, parcel numbers and parcel states (`order-signature.mjs`, the set the snooze wake already used). `preSendCheck` refuses `facts_pending` when the order's own differs. Not `shopify_updated_at`: a tag or a note moves that stamp, and must not cancel an approved reply. A bundle with no signature never refuses: the check refuses on evidence, not on its absence. The refused action is cancelled like any other. The next full poll rebuilds, routes and, if the case moved, stales and redrafts. If it did not, the approval stands and a person approves again.

**Out of scope, named.** Promotion and catalogue changes, rule edits, and a carrier or 3PL feed (blocked on DERET API access). Shopify's fulfilment status is the only tracking signal today, and the bundle refresh covers it.
