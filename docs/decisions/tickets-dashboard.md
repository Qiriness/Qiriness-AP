<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Tickets dashboard

### Staff-sent threads are labelled in the queue, never routed out of it — reversing an earlier call

`sender_directory` says who a sender is: `internal`, `contractor`, `logistics`, `courier`, `retailer` and four more. Threads from the first four were briefly routed to a `/conversations` page of their own, on the reasoning that our own mail is not customer demand. **That was built, measured, and reverted the same day.**

**The measurement is why.** All 14 routed threads were customer work. The categoriser had already labelled them `return_exchange/problem` L3, `delivery/problem`, `order/problem`, team `logistics` — the back office coordinating real returns. Subjects like *"Appel cliente ce lundi 1er juin - Mme Chantal"* are a colleague logging a customer phone call: genuine demand with no customer-side email at all.

Worse, the routing hid work that could not be recovered from anywhere else:

- **3 of 14 were still open at L3** — needs-a-human — sitting behind a nav item nobody had opened.
- **1 was an orphan**: `TR: Retour Colissimo` names a consumer who has no ticket of their own. That forward is the only record of that customer's return.
- **7 quoted no consumer address at all**, referencing only order numbers, so whether they were covered elsewhere could not even be determined.

**The bug was reusing the wrong constant.** `NON_DEMAND_LABELS` was written for `cluster:tickets`, where excluding our own prose from a topic map is correct — internal wording would otherwise form clusters about how *we* write. Routing is a different question, and the label does not answer it: **a forward is a change of messenger, not a change of subject.** The customer's request is still inside it.

So the queue holds every ticket regardless of sender, and the label becomes two things that cannot hide anything:

- **A chip on the row**, next to the VIP crown and carrying the directory's `note` as its tooltip. `flex: none` for the same reason the crown has it — a long customer name must not push out the mark saying this row is not what it looks like. Teal for `internal` and `contractor`, neutral for the rest: our own people are the group worth telling apart at a glance, and a fourth loud thing in a column that already holds level, happiness and VIP would compete with the three that carry urgency.
- **A filter** — Anyone / Consumers only / Staff & partners only — so the queue can be narrowed on demand and never silently.

**The classification machinery was kept**, because it was never the problem: `ticket_first_inbound` still carries `from_email`, `ticket_queue` still exposes it as `requester_email`, and the service still resolves it to a label server-side so the address never reaches the browser. What changed is that the answer decorates a row instead of moving it.

**The agent was briefly stopped from investigating them too, and that was removed with the routing.** The skip was argued for as saved spend — "nobody is drafting a customer reply for these" — and the measurement says the opposite: they are L3 returns needing a human, and the case file is exactly the context that human wants. The sender still reaches the model through `buildInput`, as `senderDirectory.lookup()`, so the agent knows a colleague is writing and does not read them as the customer. **Context, not a gate** — which is what the directory was always for on this path.

**The general rule this leaves behind:** a signal good enough to *annotate* a ticket is not automatically good enough to *hide* one. Hiding needs evidence that nothing is lost, and here the evidence said the opposite.

### …and reversed again, deliberately, with the cost priced in (2026-08-19)

`/conversations` now exists and the fourteen threads are routed to it. **This is an owner's call taken against the measurement above, not a new measurement that overturned it** — the finding still holds, re-run today: all fourteen are L3 or L2 customer work, and **three are `awaiting_human` at L3**, the same shape that reversed it last time.

Two things are different, and neither is that the objection went away.

**The seam is a stored column now, not a reused constant.** The original bug was routing on `NON_DEMAND_LABELS`, which was written for `cluster:tickets` and answers "is this customer demand for a topic map". Routing keys on `tickets.sender_label` — set at ingestion, `internal`/`contractor` only. That matters concretely: the derived `senderLabel` on the list item covers every directory kind, so partitioning on it would move **30** threads and take a Nocibé purchase order off the queue with them. `TicketListItem` therefore carries both `senderLabel` (derived, all kinds, for the chip) and `isOwnSide` (stored, ours only, for the routing), and they are documented as non-interchangeable.

**The failure mode is answered rather than accepted.** What went wrong before was silence: three L3 threads behind a nav item nobody opened. `countOpenConversations` puts that number on the sidebar from **every** page in the shell, so the queue you are not looking at can still ask for you. It is the only loud thing in that nav, and `openConversationCount` swallows its own errors — a page must not fail to render because a decorative count could not be read.

**Update (2026-09-15): the badge is no longer the only loud thing, nor on the collapsed rail.** Tickets now carries its own open count (not `closed`/`resolved`) in the warning colour, and the Conversations count is grey — an owner's call that the queue to work is Tickets. Both come from one `countOpenThreads` read via `navBadgeCounts`. Both badges are hidden when the sidebar is collapsed, with the labels and chips; the count reappears on expanding. This weakens the mitigation above on purpose: Conversations still announces itself, just more quietly.

**One partition, not two queries.** `listTickets` and `listConversations` are both `partitionBySender` over one `queue()` read. Two independent filters could drift into a thread appearing on both pages or, far worse, on neither; a partition cannot. 234 = 220 + 14, asserted against the live view.

**What is still true and is now a real cost:** one of the fourteen (`TR: Retour Colissimo`) names a consumer who has no ticket of their own, so that forward remains the only record of that customer's return — and it is no longer in the queue. The badge does not help once it is closed.

### The middle section is not tickets

Dropped mail never reaches the `tickets` table — the gate runs before the ticket write — so the only trace is a `spam_audit` row. That row now carries the body, but it is still not a `ticket_messages` row, which is why "Add as ticket" was disabled rather than absent: hiding the button would have hidden that a drop is recoverable at all.

Filtered on `outcome = 'blocked'`, not `label = 'irrelevant'`: the blocklist pass writes no label, and every row currently carrying `irrelevant` was in fact *kept* (the label predates the change that made it drop). Blocked is the only field that reliably means "never became a ticket".

### "Add as ticket" writes, and it writes through ingestion (2026-08-19)

**The premise that disabled it is gone.** The button waited on the agent re-fetching the message from Graph, which the mailbox-id mismatch blocks — and that requirement only ever existed because the body was not stored. It has been since `spam_audit` started keeping it: the row now holds sender, subject, body and conversation id, which is everything `ticket_messages` is written from. Measured on this corpus, **all 49 blocked rows carry a body and a conversation id**, so the Graph round trip buys nothing that is not already in hand. Promotion is a write from stored data and needs no mailbox.

**It goes through `writeIngestedMessages`, not around it.** `promote-dropped-mail.mjs` owns one thing — turning a `spam_audit` row into the shape `mapGraphMessage` produces — and hands it to the ordinary ingestion writer. Threading on `conversationId`, idempotency on `(shop_id, graph_message_id)`, the first/last message window, `needs_categorisation`, reopening a closed thread and backfilling the requester are all ingestion's rules, and a promoted email is an ingested email that took a detour. Reimplementing them behind a button would have been a second ingestion path drifting from the first. **2 of the 49 belong to a conversation that already has a ticket** — the blocklist matches senders, so it blocks replies into live threads too — so joining an existing ticket is a normal outcome here and not an edge case.

**The workflow is applied by the ticket's state, not by the click.** Every pass drains a queue defined by ticket state rather than by what the poll just wrote, so setting `needs_categorisation` is the whole handover: the next poll categorises, resolves the customer, investigates, resolves an order number and builds the context bundle. Nothing had to be added to make the agent pick it up, and nothing about the button needs the worker to be running at the moment it is pressed. Drafting stays a separate pass.

**Promoted is derived, never stored.** No `promoted_at` column, for two reasons that agree. The first is the baseline's: a column here is an `alter table … add column` by hand on a populated table, which is exactly what the drafting queue avoided by deriving `withoutDrafts()`. The second is this table's own: `spam_audit` records **what the gate decided**, and rewriting the row to say a person disagreed would edit the audit trail rather than add to it. A blocked row whose `graph_message_id` now exists in `ticket_messages` was promoted; that is one query over 49 rows and it cannot disagree with itself.

**The click is about this email, not this sender.** Nothing here touches `email_blocklist` or the classifier, so the next email from the same address is dropped again. That is deliberate — one email being wrongly dropped is evidence about one email — and both surfaces say so rather than letting the operator infer that they have fixed the gate. Turning a sender into a permanent exception is a blocklist edit or a `sender_directory` row.

**Two things the promoted message cannot carry, both left empty rather than guessed.** Recipients, reply-chain headers, the body preview and the attachment flag are not in the audit row; `attachments` stays null, which already means "never fetched" on that column, so the photo check reads the row as unasked rather than as answered *no attachment*. And `received_at` is the **decision** time, not the arrival time — within a poll of arrival for live mail, but the import date for the backfilled corpus. It drives `first_message_at`, so a promoted historical email enters the queue as recent work, which is the honest reading: it is being started now.

**No body, no promotion.** Never captured and captured-then-expired are one answer here, because the agent reads bodies: a ticket made from a subject line is one every pass downstream would skip. The button is disabled for the same reason the write would refuse, so the dashboard never offers an action that fails when used.

### Clearing dropped mail is a browser fact, not a row (2026-09-20)

**Asked for by the owner: a way to select several irrelevant emails and clear them.** Reviewing the Irrelevant tab is reading a run of obvious junk with the occasional real customer in it, and until now the only thing a reviewer could do with the junk was scroll past it again tomorrow.

**It writes nothing.** No route, no service, no column, no row — `localStorage` under `tickets.clearedMail`, subtracted from the list and from the tab count in `TicketsView`. `spam_audit` records **what the gate decided**, which is the same sentence that kept `promoted_at` out of the table; clearing says less than promotion does — not "this decision was wrong" but "I have read this one" — so it has even less business editing the audit trail. The bodies expire on their own clock either way, so the list is hiding what is already on its way out.

**The cost is per browser and is stated rather than hidden.** Another machine, another profile or cleared site data shows the full list again, and nothing about it is visible to the worker or to a colleague. That is the honest shape of the fact being recorded: one person's reading position, not a decision about the mail.

**Select is a mode, not a button per row.** A control that hides things, sitting on every row of a list somebody scrolls fast, gets the mis-tap it is asking for. So the row click still previews until **Select** is pressed, then ticks; **Cancel** leaves without touching anything, and leaving the tab ends the mode rather than carrying ticks back into it.

**Reversible, in the header where it happened.** **Restore N** brings every cleared row back, and an emptied list says which kind of empty it is. A hiding action with no way back would be a delete in everything but name, which is not what a UI-only clear is allowed to be.

### Search belongs to a table; level, category and sort belong to the page

One box above four tables re-cut every section at once, and the row you were looking for was as likely to be in a collapsed one — so a search that found nothing looked like a search that matched nothing. Each section now searches only its own rows, from its own header, and the section count follows the filtered set.

**The toolbar keeps level, category and sort.** Those describe the whole open set — Queue and Backlog are one set split by age, and a level tab that applied to only half of it would be a different filter with the same name.

**The box appears only when the section is open.** A control that filters rows nobody can see gives no feedback, and four collapsed headers exist to be scanned rather than typed into.

**The header stopped being a single button to allow it.** An `input` inside a `button` is invalid and would toggle the section on every keystroke, so the button now covers the chevron, title, count and description while the search sits beside it; the card's border and background moved up to the container so the row looks unchanged.

**Closed and Irrelevant became searchable in the process** — neither ever was. Dropped mail matches on subject, sender and the gate's reason: it has no customer and no order to match on.

**One focus ring, painted on the wrapper.** The old box drew two on every click — the wrapper's teal ring, plus `--shadow-focus` from the global `:focus-visible` rule in `globals.css`, which lands on the inner `input` as well. `outline: none` never suppressed it because that global rule uses a **box-shadow**, not an outline; the input needs `box-shadow: none` under `:focus-visible` specifically. Anything else that puts a bare input inside a styled wrapper will hit this.

### Where the reviewer was lives in the address (2026-09-15)

Leaving `/tickets` used to throw away the open ticket, the tab and every filter, so checking an order mid-investigation meant finding the ticket again. **The tab, level, category, sender, sort, the active tab's search and the selected ticket (or dropped mail) are now query parameters**, as on Orders: Back, refresh and a pasted link all land on the same ticket. Defaults are omitted, so an untouched page is still plain `/tickets`.

- **`replaceState`, never a push.** Each click would otherwise be a Back-button entry, and Back should leave the page, not undo a filter.
- **The address alone does not survive the sidebar**, whose link is a bare `/tickets`. So the last address is also kept in `sessionStorage` (`tickets.lastSearch`), and a bare `/tickets` restores from it once on mount. **Session, not local**: it lasts for the browser tab, so the app opened days later does not start on a stale ticket. An address that carries its own state always wins over the saved one.
- **A restored ticket is followed, not trusted.** It may have been closed, aged into Backlog, or be hidden by the filters it was saved with; `reconcilePageState` moves to the tab that holds it now and clears the filters or search that would hide it, because restoring the filters without the ticket renders an empty panel. A ticket no longer on this page is dropped.
- **Only the active tab's search is kept.** The per-section boxes are separate state, but one `q` is enough to come back to what you were reading.
- **Unsent draft edits are not part of it.** That is an unsaved-changes problem, not a navigation one.

### Two scrollers on the tickets page, and the document is not one of them

**One per table, one for the page, and nothing above that.** The app is a fixed frame: the sidebar and topbar stay put while `AppShell`'s `.content` scrolls under them. A scrollbar on the document itself moves the whole frame, navigation included, which is the one thing the frame exists to prevent.

`.shell` pinning itself to `100dvh` with `overflow: hidden` is not enough on its own — it stops the shell spilling, not the document from acquiring its own scrollbar. So `html, body` are pinned too, in `dvh` so they cannot disagree with `.shell` by the height of a mobile browser's chrome. Every page renders inside `AppShell` (`/` only redirects), so every page already has a scroller and none needs the document's.

**All four tables share one height** (`min(62vh, 50rem)`), replacing a 50vh queue and a 26rem default for the rest. The split existed to keep a collapsed "Closed" header on screen without scrolling; the page scroller already handles that, and the cost was making Backlog and Closed read as lesser tables when they are the same table with a different filter. Capped in rem as well as vh because a table past ~50rem stops being scannable.

### The draft/conversation split is the reviewer's to move (2026-09-15)

A handle sits between the conversation and the draft panel: dragging it up gives the draft room and takes it from the thread, dragging it down does the opposite; arrow keys step it, double-click or Enter resets to the default 35%. A fixed 35% with an 11rem cap on the draft text meant a long reply was read through a letterbox while the thread above had room to spare.

- **The height is kept per browser in `localStorage`** (`tickets.draftPanelHeight`) and survives switching tickets — it is a reading preference, not data about a ticket, so it does not belong in the database.
- **A dragged height may still shrink.** The conversation keeps an 80px floor, so a height saved on a tall screen cannot push the thread off a short one.
- **Once sized, the draft text drops its cap** and uses the room it was given; the default split keeps the cap.

### The expanded row is three blocks and no more

**Results** (a headline read off the verdict, plus the `established` claims), **Order**, **Action** (one sentence). The case file's other lists — `unverified`, `do_not_claim`, the tool ledger — are written for the drafting stage; pouring them in here would bury the three lines somebody opened the row to read.

- **The summary is derived, not stored, and there is deliberately no summary column.** A model asked for prose *beside* the evidence lists writes a fourth account of the ticket that can disagree with all three — the failure `do_not_claim` and the derived `replyIntent` already exist to prevent. What the agent established **is** the result.
- **The action sentence is looked up from the verdict**, the same rule that makes `case-file.mjs` own the wording of a question to a customer. Only `needs_human` shows model prose — `handoff.action`, which is that verdict's whole output and internal by construction.
- **The latest run only.** A ticket is investigated once per inbound message, so a thread holds a row per reading; the panel answers "where does this stand now".
- Fetched per ticket on expand, not joined into the list: 565 rows, one open at a time. **No case file is a normal state** — uncategorised, out of `ENABLED_SUBJECTS`, or not yet reached — and reads as "not investigated", never as an empty result.

### The open panel keeps its row's priority colour

The row's left bar is red, orange or green by priority band, and it runs down the open panel too — the pair is one ticket, so it wears one mark.

That was the intent from the start and the panel did not honour it: `TicketDetailPanel.module.css` drew `border-left: 3px solid var(--teal)`, a fixed green, while `TicketTable.module.css` was already handing `--priority-edge` down to the detail row. `.detailCell` carries `padding: 0`, so the panel's border sat exactly on top of the cell's priority inset and won. **A high-priority ticket therefore turned green at the moment somebody opened it to read it** — the one moment the colour is doing work.

The rule is now `var(--priority-edge, var(--teal))`. The fallback is a floor rather than a second design: every ticket has a band, so nothing in the table should ever reach it.

The lesson is narrower than "don't hard-code colours". The variable already existed and already inherited; what was missing was that the panel is a *continuation of the row* rather than a component with its own accent. Anything drawn inside `.detailRow` that wants the ticket's identity should read `--priority-edge` and not pick a colour of its own.

### The Order block reads `resolved_context`, not the case file

Two sources, two projections in `ticket-detail.ts`: order facts exist for tickets the agent never investigated, and a case file exists for tickets with no order at all, so neither read can stand in for the other. `summariseOrderContext` **labels what `buildOrderContext` stored and derives nothing** — re-deriving delivery state in the dashboard would give the app a second opinion about the same parcel, and the two would disagree the first time either changed.

**The block opens with the name on the order.** A confirmed order means the requester's address *hashes* to the order's — it does not mean the two names agree, and a disagreement is the shape of both an innocent case (a gift, a partner's account, a married name) and one worth investigating. Until now the panel showed the number, the status and the parcel but never who the order belonged to, so that check meant opening Shopify.

**One line, not two — the envelope name is not restated here.** The first version paired it with `requester_name` off the email, on the reasoning that the queue row cannot supply that half: the requester column shows the *linked Shopify* name where a ticket has one (`customer_display_name`, falling back to `requester_name`), which is the same source as the order's own name, so reading the row against the panel can compare Shopify with itself and agree by construction. Overruled deliberately: two name lines made a four-line block about identity rather than about the order, and the row above it is where a reader already looks for the requester. The cost is worth knowing rather than hiding — on a ticket that *is* linked to a customer the row-against-panel check is weaker than it looks, and the masked address under the name is then the line that actually discriminates.

The name comes from `resolved_context.customer`, not from the order: `orders` stores **no name at all** — only `customer_email_hash` and `customer_email_masked` — so the account the order points at is the only name there is. The masked address sits under it, which is what `customer_email_masked` was added for: a hash cannot be looked at, and deciding whether a second address is a gift, a partner or the same buyer's other mailbox needs a human to *see* it. A guest order with no account shows the address alone.

**The panel states the two names and judges neither.** `compareNames` in `order-verification.mjs` already does an accent- and case-insensitive comparison during resolution; repeating it in the dashboard would be the second opinion this section exists to forbid, and the two would disagree the first time either changed. Note that this pair will often differ for reasons of *casing* alone — nothing normalises names on the way in, by design.

**Order status, tracking number and tracking status appear only when there is data**, as text lines rather than a fixed row of fields. Reserving a slot per field fills the block with dashes, and a dash beside "Tracking number" reads as *there is no tracking* rather than *nothing has been resolved yet*. Order status and tracking status are deliberately **two axes**: Shopify's `order_status` says whether the warehouse dispatched, `delivery.state` says whether the carrier has moved it, and "Fulfilled / Dispatched, no carrier scan yet" is the largest delivery cluster in the corpus.

### The subject opens the conversation; the chevron expands the reading

They were one control while there was only one thing to reveal. Both are real buttons, so the keyboard reaches either without the row. A `tr` cannot be tabbed to or given `aria-expanded`, which is why the chevron carries both.

**In-app rather than a deep link into Outlook, because the link cannot be built.** Ingestion stores no Graph `webLink` (`sanitizeGraphPayload` keeps ids and addresses and nothing that is a URL into a mailbox), and the mailbox is read with an *application* credential — so a URL assembled from a message id resolves only for someone with that shared mailbox mounted, and is a dead end that looks like a bug for anyone else.

**Both directions, oldest first.** The Inbox holds the desk's own replies too (123 of 348 messages measured), and a thread showing only the customer's half is exactly what makes flicking to Outlook necessary.

**The draft section is a placeholder and says so.** `TicketThread.draft` is always `null` — drafting is Phase 5 and no column or table holds one. The field exists so the section renders where it belongs and the wiring point is one named thing rather than a redesign.

### The thread shows a sender's address, but only when it is not already the name

Every message block in the conversation dialog prints the display name and the address behind it. Identity is the first thing read off a support thread — two people at one company, a personal address writing about a shop account, a colleague forwarding a customer's mail — and the name alone does not settle any of them.

**The address is suppressed when it *is* the name.** Graph reports a display name only when the sender's client supplied one, so `from_name` is often the address itself; printing both unconditionally renders `poline4@wanadoo.fr poline4@wanadoo.fr`. Measured over 451 stored messages: **444 carry a name that differs from the address and 7 do not**, so the duplicate is rare — and rare is exactly what makes it worth handling, because seven odd-looking rows in a thread read as a bug rather than as a pattern.

The comparison is trimmed and **case-insensitive**. An address is case-insensitive in practice, so `Jean@Qiriness.com` sitting in the name field is the same sender as `jean@qiriness.com` in the address field; matching case-sensitively would print the duplicate this rule exists to remove.

`senderIdentity()` returns the pair rather than a formatted string, so the two parts can be styled and wrapped separately — the name at body weight, the address at caption. A single pre-joined `"name <email>"` string would have forced one weight on both and made the address compete with the person.

### The Irrelevant dialog shows the message and nothing else

Verdict, gate, reason and timing are already columns in the row it was opened from, so repeating them would turn the one thing the table cannot show into a footnote on data that is on screen anyway. The single exception is `failed_open`, kept as a banner because it has no column and it changes how the text should be read: a fallback, not a judgement about the email.

**A missing body gets one of three sentences, never a blank**: purged, never captured, or genuinely empty. "No body" alone reads as a bug in all three cases and is only actionable in one.

### VIP is derived at read time, never stored

Shopify recomputes `rfm_group` as a customer buys, so a flag copied onto a ticket would be a snapshot of the day the mail arrived — a customer who became a champion last week would still read as ordinary on their open thread.

**Superseded 2026-09-11 — see "VIP is the shop's rule" below.** The read-time principle stands; the RFM definition does not.

**`CHAMPIONS` + `LOYAL` only**, and that array is the one line to edit: `ACTIVE` merely means "has ordered recently", which is most of the table, and a badge nearly every row carries signals nothing. The label map is deliberately **partial** — Shopify owns this vocabulary and can add to it, so an unrecognised segment is simply not VIP and renders from its own text rather than vanishing.

`TICKET_LIST_SELECT` is shared by the list read **and** `setTicketStatus`, which passes it to PostgREST as the PATCH's `select`. The row a mutation returns replaces a row the list rendered, so without the embed closing a ticket would silently strip the VIP badge off it.

### A VIP is a gold row, not a chip — reversing an earlier call

The badge was a teal chip under the requester's name, on the reasoning that teal is the app's one accent and a VIP is a fact about the **customer** rather than a warning about the **ticket**, with level and mood already owning "this needs attention". That reasoning was sound and was overruled deliberately: eight rows are visible at a time and a chip in the fourth column is missed, whereas knowing you are about to open a champion's ticket is worth seeing from the row itself. The row now carries a **gold border**, and a crown sits **beside the requester's name**.

**A border, not a filled row.** The first version washed the whole row gold as well. **75 of 214 tickets are VIP (35%)**, and a third of the queue tinted is more of the screen than the fact deserves — exactly the competition with level and mood that the old rule warned about. The border says the same thing and stays out of the way. The crown moved off the row's corner for the same kind of reason: next to the name it reads as belonging to the person, in the corner it read as a property of the ticket.

That 35% is the number to watch. If this ever pulls attention off a level 4, it is too strong — turn the tokens down rather than turning the feature off.

**The rules are inset box-shadows, not borders.** An ordinary row carries only a bottom border, so giving a VIP row a top and two sides made it 1px taller than its neighbours and pushed the mood face 2px right — measured at 68px against 67px, a visible limp down a column of 214 rows. The bottom edge stays a real border, because every row already has one and a border paints over an inset shadow.

Gold is its own token pair, not `--warning`: that ramp is orange and owns "something is wrong". Two steps only — a rule colour and a hairline — because a border needs no wash and no text sitting on one.

### VIP is the shop's rule: spend AND orders inside a window (2026-09-11)

**Replaces CHAMPIONS + LOYAL.** Shopify's RFM grouping did not match who the business treats as a VIP, and it could not be tuned — it is Shopify's formula. The owner now sets the rule on the Customers panel as three numbers: **net spend MORE THAN €X AND MORE THAN N orders, both inside the last M months.** Both conditions, never either: at > €300 and > 2 orders in 12 months the rule admits **97** customers, where "either" would admit **288** (measured 2026-09-11, 2,738 customers ordered in that window). Strict on both, because the screen says "more than".

**The numbers are data, the rule is one SQL function.** Three columns on `shops`, all set or none (`shops_vip_rule_check`), read by `scripts/lib/vip-rule.mjs` and passed to `vip_customers()`, where the comparison is written once. The ticket queue (`vip_tickets()`, one call per read), the Customers panel (`vip_summary()` and the call list) and the agent's customer lookup all ask it, so a VIP border on a ticket, a VIP on the panel and `isVip` in a case file cannot disagree. `vip_tickets` and `vip_summary` call `vip_customers` rather than restating it, and `12_vip_rule.test.mjs` asserts that.

**This moves a judgement into SQL, deliberately**, against the Insights rule that judgement stays in JavaScript. The rule is now a comparison over windowed order aggregates, which only SQL can count without paging, and the part that changes with the business — the three numbers — is data rather than code. What would have been the second definition (a JS `isVip(spend, orders)`) does not exist.

**Still read-time, more so than before.** The window rolls forward every day, so a stored flag would go stale overnight on top of going stale when the rule is edited.

**No rule, no VIPs.** The columns shipped null and nobody chose a default: until the numbers are set, no ticket has a gold border and the call list says to set a rule. A VIP threshold written into a migration would be a business decision made by whoever wrote it.

**Net spend, uncancelled orders, Shopify only.** Spend is `total_price - total_refunded`, the same net figure Sales reports. Marketplace channels are excluded — they mint one customer per order, so no marketplace buyer can ever repeat. The agent's `isVip` comes back **null, not false**, when the check cannot run, so "we could not check" never reads as "not a VIP".

**Shopify's segments stay, as Shopify's.** The segment table on the Customers panel is titled "Shopify segments (RFM)" and no longer highlights VIP rows; the ticket context pane labels the field "Shopify segment".

### A parcel number is the second way into an order

Somebody chasing a delivery usually has the **tracking number** and not the order number: it is what the dispatch mail put in front of them and what the carrier's site asks for. Until now such a ticket resolved to no order at all, which put every order tool out of reach of exactly the questions the corpus asks most.

**It is a column, not a jsonb reach.** `orders.tracking_numbers text[]`, lifted out of `fulfillments` by the order mapper and GIN-indexed. `fulfillments` stays the record; this is the index. One `&&` overlap query answers "which orders carry any of these numbers?" for a whole pass of tickets at once — confirmed against the live table as a Bitmap Index Scan at 0.2 ms — where reaching inside the jsonb would scan 2,006 rows per lookup.

**Both sides normalise through one function** (`scripts/lib/tracking-number.mjs`), and that is load-bearing rather than tidy. Shopify hands back numbers with punctuation attached — `6A06497617561.` is stored today — carriers print them in groups, and customers type in lower case. Two copies of the rule drifting by a hyphen would give a lookup that silently never matches, which reads to everyone as "we have no record of that parcel".

**The patterns come from what this store actually issues**, counted over 815 numbers: Colissimo `6C20723002488` (717), GLS `ZWLGF5DA` (97), UPU `CJ123456789FR` (1). Two guards earn their place — the GLS pattern demands a digit in sixth position, because without it the shape is eight letters and `COMMANDE` matches; and a candidate glued to a file extension is dropped, because `image001.png` sits in the signature of a large share of business mail and `IMAGE001` is exactly the GLS shape. Over 296 inbound messages the parser proposes 20 candidates, 10 resolve to a retained order, and none is junk.

**Finding the order is not vouching for the sender.** A tracking match runs through the same `verifyOrder`, so ownership is still decided by the email hash and `isSafeToWrite` still governs the column. Possession of a 13-character carrier number is tempting to treat as proof — it is far less guessable than a sequential order number — but the measurement says otherwise: of the 8 tickets quoting a real tracking number, **6 were staff threads about other people's parcels** (two senders, already recorded as `mismatch`). Confirming on possession alone would have written six wrong order numbers. Only 2 tickets resolve today, and that is the honest yield.

**The order number wins where both appear**, which is precedence and cost control at once: it is the reference the rest of the pipeline is built on, and a message carrying both must not spend a second lookup. Tracking candidates are collected only for tickets that yielded no order number, so the common case costs nothing and the whole feature adds **one query per pass and no model tokens** — this pass has no LLM in it.

### Queue priority should be derived at read time

The scorer lives in `scripts/lib/ticket-priority.mjs`, not in a column and not in the `ticket_queue` view. The view supplies facts (`inbound_count`, `waiting_since`); the weights are judgement and need unit tests and cheap tuning, not a migration.

### The current action window chooses the band (2026-09-26)

**Supersedes the additive band rules below, including VIP +2 and High at 70.** High / Medium / Low remain the visible labels, but their meaning is now categorical: **High** is an intervention window that can close, **Medium** is an unresolved service failure or overdue commitment, and **Low** is routine assistance without either. Numeric bases are 200 / 100 / 0. Wait, inbound contacts, level below 4, `awaiting_human`, and excess delay order work only inside the selected band; their sum is clamped below 100, so none can promote the ticket into another band. VIP contributes nothing. Level 4 remains a High safety/legal override.

The action rules branch on the current synced order, not on the category alone. O-12/O-13/O-14 are High while the order is `not_dispatched`, with wording that says to check whether Deret can still intervene rather than claiming it can. A missing order or unreadable state is provisionally High. `dispatched`, `delivered`, `cancelled`, or a resolved/closed ticket removes that original urgency and lets any remaining service failure be assessed on its own. This is why the service re-reads live order rows at queue time instead of trusting `resolved_context`, which is a rebuildable snapshot and can be stale.

Delivery age is not a diagnosis. O-09/O-11 use excess working days beyond `dispatch_days`; D-01 uses excess beyond `france_delivery_days` or `abroad_delivery_days`, from the fulfilment timestamp, and only because the situation is already an unresolved delivery/non-receipt case. The formula is `max(0, elapsed working days - threshold)`. Defaults are 3 / 3 / 6 when a setting has no row. An old fulfilled order in an unrelated situation stays Low; lateness never asserts loss. Missing timing data keeps the relevant unresolved case Medium rather than manufacturing reassurance. D-02/D-03/D-05/D-06/D-08/D-36/D-37/P-20 are service-failure situations directly, and their remedy still follows the Deret-before-support workflow recorded in the case rules.

The scorer is deterministic **given its stored inputs and evaluation instant**: no model call occurs while the queue is read. The stored situation may itself have come from the investigation/Case Manager, so “deterministic” does not mean situation recognition has become rule-based. The latest recorded situation wins, and a newer case-state `null` clears an older situation rather than leaving its urgency stuck.

Level 4 is still a hard band at 1000: legal threats and grave personal harm cannot be overtaken by ordinary urgency. Levels 1-3 are normal weights (`10 / 18 / 25`), so the queue is not strict tiering below the emergency band.

Customer wait is the largest ordinary factor (`35`, logarithmic, capped at 14 days). That is deliberate: once the customer is waiting, age should move a ticket harder than one severity step, while still avoiding a linear age score where very old backlog dominates forever. Contacts (`0 / 7 / 11 / 14`), `awaiting_human` (`6`) and VIP (`2`) remain smaller nudges.

This supersedes the VIP row-border treatment above: VIP remains a crown beside the requester name, while row edge colour now belongs to priority. Two border systems on one row would make VIP compete with the operational signal the queue is built around.

**Priority shows as two marks and no more: the score, and a 3px bar on the row's left edge.** The first version ringed the whole row in its band colour, which turned a queue of 214 rows into a grid of coloured boxes and fought the table's own hairlines. The bar is the header cards' accent moved from the top edge to the side, so one visual device carries severity in both places; the row keeps its ordinary neutral divider. **Left, not right**, reversing the first attempt: the bar then sits against the score it belongs to instead of ten columns away from it, and the table scrolls horizontally — a right-edge bar can be scrolled out of sight, the left one cannot.

**Band colours are the saturated primaries, not the semantic ramp.** The `-100` tints read as grey-pink and grey-amber at 3px, and the darkened ramp colours put a dark red one row above a dark orange, which is the same colour at a glance. Each band now sits as near its own pure hue as contrast allows — `#e81010` / `#ff8c00` / `#00a651` on the bar, one step darker on the score so it clears 4.5:1 on white. They are local to the table rather than new global tokens: they are tuned against each other for this one three-way comparison, and folding them into `--error`/`--warning`/`--success` would drag every chip and card along with them. Medium stays orange rather than shifting yellow, because gold belongs to VIP.

**The score is set a step larger and bold** (`--text-md`, 700). It is the number the whole queue is ordered by; at body size and weight it read as one more field in the row.

### Stats and filters

**The four header cards** recompute from the same array the tables render (`summariseTickets`, isomorphic and pure), so a card can never disagree with the rows under it.

**"High priority" is the red band** — `priorityBand === "high"`, now an urgent action-window branch (or the level-4 safety/legal override), not a score that age can cross. The band needs no column; it is derived at read time by `scorePriority`, so the card counts exactly the rows a reader sees marked red instead of approximating them by level.

**All three queue cards count the LIVE set — everything not resolved or closed — and two of them did not.** Both errors were visible on screen:

- `open` counted `status === "open"` only, dropping the 20 tickets at `awaiting_human` and 2 at `awaiting_customer` from both the numerator and the closed pile. The card read **53** while Queue + Backlog rendered **75** rows. Dropping `awaiting_human` was the worst of it: that status means the agent has explicitly said a person must act.
- `highPriority` and `levelThree` counted closed tickets too, so "High priority" read **84** against a live set that cannot exceed 75. With no level 4 anywhere in the book it also read *identically* to "Level 3", which is what made the row of cards look broken rather than merely wrong.

Measured after the change: 75 open, 5 high, 30 level 3, and the live band split `{high 5, medium 43, low 27}` sums to 75.

**The denominator moved from "of N categorised" to "of N open".** Categorised was honest while high priority meant level 3 + 4 and an uncategorised ticket had no level to be counted by. Every ticket carries a priority score — an uncategorised one earns weight *for* being unread — so the set to read it against is simply everything still open.

**The band colours are tokens in `globals.css`, not private values in the table's stylesheet.** The card and the rows it counts must be the same red, and while they were two separate hex values they were two different reds.

**Volume windows are rolling (now −24h / −30d), not calendar day and month.** Ingestion runs in bursts; on any day without a poll the calendar figures both read zero and the card looks broken rather than idle. Counted on `first_message_at`, so reviving an old thread does not inflate today's intake.

**Level, not status, is the primary filter.** Every ticket is `open` today because nothing closes them, so status tabs would be one tab holding everything. Filtering, search and sort all run client-side — 565 rows is far too few to justify a round trip per keystroke.

**Backlog is a section split, not a status.** Tickets waiting 14 days or more move below Irrelevant visually, but the row remains an open ticket with the same close action and table format. Storing this as a status would fight the worker-owned statuses (`awaiting_customer`, `awaiting_human`, `forwarded`), and putting it in SQL would duplicate the read-time wait judgement that priority scoring already keeps in JavaScript. It uses `waiting_since` where the view can supply it, then `first_message_at` as the fallback for rows without an inbound wait anchor.

Soft-deleted rows are excluded in the query, not the mapper, so a compliance delete cannot reach the UI via a caller that forgot to filter.

### Mutations are deliberately narrow

`PATCH /api/tickets/[id]` accepts only `open`, `resolved`, `closed`. The rest (`awaiting_customer`, `forwarded`, `spam`…) are the worker's to set from what it observed — an operator asserting them by hand would put the UI and the pipeline in disagreement. `closed_at`/`resolved_at` are maintained alongside the status and cleared on reopen, since retention reads them.

### Both dialogs share one shell

`components/ui/Dialog.tsx`, extracted when the second consumer arrived rather than up front. It owns only the overlay mechanics that must not drift per copy — Escape to close, body scroll frozen, focus landing inside, and a backdrop click that does not fire when the drag started on the panel — and no layout below the header, so a conversation and a one-screen record share it without either bending to the other's shape.

---

### Tracking numbers are links, and only where we hold the link

A tracking number is the one string in a support thread that has an obvious next action — open the carrier's page — and until now only `TicketDetailPanel`'s Order block did anything about it. The same number in the customer's own email, in the draft, or in a rehearsal transcript was text to be selected and pasted by hand. It is now a link on all four surfaces.

**A number is linked only where we hold a real fulfilment URL for it.** The alternative was inferring the carrier from the number's shape — the parser already classifies Colissimo, GLS and UPU — and building a search URL from it. That was rejected: 84% Colissimo is a good guess and a wrong guess sends a reviewer, or a customer, to a page saying the parcel does not exist. **A visibly missing link is recoverable; a confidently wrong one is not.** So a number with no URL renders exactly as it did before, which is also the rule `TrackingList` has always followed.

**Two sources, and the second is the one that matters.** The confirmed order's parcels come free with `resolved_context`. But the ticket worth linking is the one where the customer writes « mon colis 6C20723002488 n'est pas arrivé » and no order was ever confirmed — precisely the ticket where a reviewer most wants one click. Those numbers exist only in the text, so `parcelsInText` parses them with the agent's own parser and looks them up in one `ov` query against the `orders.tracking_numbers` GIN index. Measured over a 600-message sample of inbound mail: **60 messages quote a tracking-shaped number.**

**The splitting lives in `scripts/lib/tracking-number.mjs`, beside the normaliser, and for the same reason.** Matching is by normalised form, never string equality: Shopify stores `6C20723002488`, the carrier prints `6C 2072 3002 488`, and the customer pastes whichever they were looking at. A second copy of that character class in TypeScript would drift, and the failure shape of drift is a number that silently never matches — which reads as "we have no record of that parcel". `web/lib/tracking-links.ts` is the single point where that module crosses into the browser bundle.

**The draft is one of the four surfaces, and it is why the model is never given a URL** — see « The reply names the parcel; the number is the link » under Drafting.

**One component, because this codebase has already paid for the alternative.** `TicketDetailPanel` records having had two copies of the parcel rendering, the second of which dropped the link. Four copies would be worse, so every surface goes through `TrackingText`. In the transcript it is reached by context rather than a prop: `Verbatim` is called from eleven places, all of them views of the same French text the order tool produced.

---

### The ticket workspace is two panes and a sheet (2026-10-28)

The owner's brief was that the page showed a great deal that was not helping anyone answer a ticket. An interactive prototype (`HTML_DROPFILE/qiriness-ticket-redesign.html`) set the direction. It was used for its visual language only: its data model is a mock and does not reflect what exists here. The top view tabs and the filter toolbar are unchanged.

**The priority score is no longer shown on /tickets. A dot says the band.** This supersedes « Priority shows as two marks: the score, and a 3px bar » above, for this page only. The score still ranks the queue and still exists on the row. What a reviewer acts on is the band, though, and a 0–299 number beside it was the busiest thing on every card. The dot uses the same `--priority-*` tokens as the bar did. The tooltip names the band, and says « set by a person » when it was pinned in « Edit case ». The context panel shows the band too, without the number.

**The card's left edge now belongs to the category, not to priority.** One edge, one meaning, as before. With the score gone, the dot carries urgency in its own place (top right, by the age), which frees the edge for the subject. The category hues are `--cat-<key>` tokens chosen away from the priority red, orange and green, so that an edge is never read as urgency. The category list is the fixed taxonomy, not per-shop data, so a map from category to token is correct here. A re-skin changes tokens, not components.

**States are icons with their meaning in the tooltip and the accessible name**: needs a human (with the level), waiting for the customer, forwarded, snoozed, linked threads, VIP. The text badge « L3 Needs a human - Awaiting human » was the widest thing on the card. From 2026-10-28 the level is an icon too, at the owner's request: a robot (teal, « the agent can handle it ») for L1/L2, since those are usually the agent's tickets, beside the person icon for L3/L4. The header drops any chip an icon already says: the level, « awaiting human », « awaiting customer », a forward. The toolbar's Level and Category filters show the same marks and category colours (`FilterMenu.tsx`), so a filter reads like the cards it leaves on screen; a native select cannot draw them.

**The queue collapses to a rail when a ticket opens.** The conversation needs the width more than the list does once a ticket is chosen. The rail keeps every ticket one click away (initials, category edge, priority dot), and the chevron restores the cards until the next ticket is opened. Below 1023 px the single-pane switch is unchanged.

**The right rail became a sheet at every width.** It was a permanent third column above 1440 px and a sheet below that. The rail held the facts a reviewer checks once per ticket, but it cost the conversation a third of the screen all the time. The facts a reviewer needs while reading moved into the header's context strip. The rest opens on demand: the panel button, « ] », or the order link in the header. **Focus** hides both the queue and the sheet.

**The context strip replaces the « Next action » line and the per-message reference chips.** `contextStrip` in `web/lib/ticket-context-strip.ts` is pure and tested. It always shows the next action and how an approval leaves (sends / Outlook draft / records only), so the reviewer knows what « Approve » will do before reading the draft. What else it shows depends on the subject (`STRIP_PROFILES`):
- delivery: order, state and parcel;
- order, payment and stock: order and state;
- returns: order and state;
- anything else: the order if there is one, otherwise the language and « no order linked ».

A marketplace channel is shown whatever the subject, because it changes what « no parcel » means. The `Q00…`, invoice and shipment references are gathered once across the thread, de-duplicated and capped. Chipping them under every message repeated the same reference on each reply.

**Case events sit between the messages, with their real time.** The dossier was only readable in the Activity tab, so what the agent did read as separate from what was said. Only the moments that change a reviewer's reading are inline:
- the case analysed;
- a draft written;
- a person's correction;
- a snooze and its wake;
- a check opened.

Individual tool lookups stay in Activity, because inline they would outnumber the messages. « Case events » hides them, and the choice is per browser.

**Earlier messages fold behind « Show N earlier messages ».** What is read first is the latest message from outside and everything after it.

**Warnings fold, but blocking problems do not.** Failed checks, auto-send holds, a stale draft and a refused send change whether or how the reply goes, so each stays visible as one red line, with the full text on hover. Everything else folds into one amber « N things to check » line: warnings, the before-sending action, duplicate, case and outbound notes. Before this, each was a full-width bordered paragraph, and a draft with three warnings pushed its own text below the fold.

**The reply language is on the To line.** It turns red when the draft's language differs from the ticket's. `tickets.language` and `ticket_drafts.language` already existed; the dashboard had never shown them.

### Ticket numbers are `T-<n>`, per shop (2026-10-28)

Tickets had only a uuid, which nobody can say aloud or type into a search box. `tickets.ticket_number` is a per-shop running number. An insert trigger takes it from `shop_ticket_counters`, and the row lock there serialises concurrent inserts, so two inserts can never share a number. A failed insert rolls its step back. The existing 1,089 rows were numbered oldest first by `first_message_at`.

**The `T-` prefix is the point.** Shopify order numbers are shown as `#NNNN` and the two ranges overlap: we are at about #9,900, and a busy month of tickets is in the hundreds. A bare `#1042` in the header would read as an order. Search accepts `T-1042`, `t1042` and a bare `1042`. A bare number also finds order #1042, which is what someone searching by a number wants.

**Per shop, not one global sequence**, because the code is meant to run for other companies (see the reusable-across-companies rule). One sequence would number shop B's first ticket after shop A's thousandth.

The number is not yet put in outgoing mail. `docs/decisions/cases.md` already lists an internal reference in replies as future work, and the ticket number is the obvious candidate.

### Internal notes are the team's, and the agent does not read them (2026-10-28)

`ticket_notes` holds what the team writes for each other on a ticket. Notes appear amber, with a lock, in the conversation and in their own tab, and are written from the composer's « Internal note » mode.

- **Never sent, and not read by the drafting agent, for now.** A note is often a guess (« I think this is the second parcel ») or a remark about the customer. Feeding it into the case file would turn a colleague's aside into evidence the agent cites. If notes become an input, that is a decision about the investigation, not a UI change.
- **The writer's name is stored with the note.** Snoozes and overrides store only the user id, because nothing on those screens needs to say who acted. A note is read as « who said this ». Nothing resolves an id to a name, and these are staff names, not customer data.
- **Soft-deleted, and only by the writer.** A note is someone's word on the case; it should not vanish from the timeline because a colleague clicked the wrong thing.

### Assignment: any active account, by a person only, kept through close (2026-10-28)

This reverses « assignee: left out by decision » in `docs/decisions/human-overrides.md`. That decision rested on there being no user list, and inventing one was refused. **The list is read, not invented**: `dashboard_team()` reads `auth.users`, the accounts `npm run users` already manages, and returns every account with a dashboard role that is not banned.

**Through a database function, not the Auth admin API.** Listing users through the API needs the secret key, and `scripts/lib/dashboard-user-admin.mjs`, the only code that holds it, must never be imported into the web app. The function is SECURITY DEFINER, executable by `service_role` only, and returns id, name and role. It returns no address unless an account has no display name.

Decisions taken with the owner:

- **Who can be assigned: every active account, whatever its role.** The team is a handful of people. Excluding developers would only remove the people most likely to test the feature. Accounts are not per shop, so neither is the team.
- **Kept through close and reopen.** A customer who writes again lands back with the person who knows the case. Nothing clears an assignment except a person.
- **Manual only.** Approving a draft or sending a reply does not assign. « Assign to me » is the one-click path. Auto-assigning on approval would have silently moved tickets between people whenever someone helped out.
- **Mine / Unassigned / All, default All**, in the URL like the other filters. A page that opened on « Mine » would look empty to someone with nothing assigned, and would hide the unassigned work the team has to share out. A link to a ticket the filter would hide resets it to All, as the level and category filters do.

**The assignee must be an active account when it is set.** A menu left open can offer someone since disabled, so the server checks against `dashboard_team()` again. A ticket held by a since-disabled account still shows that it is assigned (« a former team member ») rather than looking free.

**`ticket_assignments` keeps the history; the timeline shows the current assignment only.** « Who had this before » is answerable from the table. Putting every handover in the conversation would add noise the owner asked to remove.

### Forwarding sits in the composer, and is purple (2026-10-28)

« Transférer » is the composer's third mode, beside the reply and the internal note, because forwarding is also « what we do with this ticket now ». It is purple: everything that stays inside the company is purple, colleague mail included. The forward shows in the conversation from the moment it is queued (sending / sent / in Outlook Drafts / failed with « Retry »). Its copy from Sent Items is folded inside the card behind « See what was sent », because it repeats the whole thread the reader is already looking at.

**Earlier messages now fold at the customer's latest message, not the latest inbound one.** A colleague answering a forward would otherwise fold away what the customer wrote. Details and the backend rules: `forwarding.md` § Manual forwards.
