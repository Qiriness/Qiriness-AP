<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Order resolution

`shopify_order_number` is written **only** by a confirmed resolution, and there are three ways to reach one: the order's `customer_email_hash` equals the ticket's `requester_email_hash` (`verified_by: email`), or it appears among the addresses in the customer's own message (`verified_by: message_email`, below), or the order is a marketplace order whose buyer Shopify only knows as a placeholder (`verified_by: marketplace_order_number`, below). A name-only agreement, or an order belonging to someone else, is recorded in `metadata.order_resolution` and left off the column.

The parser recognises `#NNNN` / "commande n° NNNN" only, and classifies the `Q00` ERP references (911 in the corpus) as **not** Shopify order numbers.

### An address quoted in the message counts, and it is checked by hash not by layout

Customers routinely forward their order confirmation, and the desk's position is that **an email mismatch is not a security concern here** — ordering for a partner, a parent or as a gift is ordinary, and answering the person holding the order details is the correct outcome. So when the order's registered address appears anywhere in the customer's text, the number is written.

This closes 6 of the 15 mismatches that `VALIDATION_LOG` item 6 flagged for review: the number parsed, the order existed, the address it is registered to was sitting in the message, and the old rule refused it because the *envelope* did not match.

**Nothing parses the confirmation's layout**, which is the load-bearing part. The obvious build is a parser for the template — find "N° de commande", find the "Client" block, read the address under it. That reads a document we never receive. What arrives is the template after the customer's mail client re-rendered it as a forward, after `htmlToText` flattened it, and possibly after a merchant reworded it in Shopify's notification settings; each step moves the labels. There is nothing stable to anchor on either: the notification templates do carry fixed Liquid variables (`{{ order.name }}`, `{{ email }}`, `{{ order.order_status_url }}`), but Liquid renders on Shopify's side, so the received mail holds their values and never the tags.

Instead `confirmation-evidence.mjs` hashes **every** address in the text and asks whether any equals `orders.customer_email_hash`. It reads no structure, so it survives a reworded label, a translated template and a paste with the layout gone. Only hashes leave the module, so third-party addresses never reach a caller, a log line or a metadata column.

It also catches more than it was built for, and that decided the naming. Of the 6 tickets it rescues, **only 3 carry a recognisable confirmation**; the other 3 quote the address some other way. A layout parser would have found 3 and called the rest mismatches. `verified_by` is therefore `message_email`, not `confirmation_email`, and `metadata.order_resolution.confirmation_markers` records how many template markers were present — diagnostic only, never a gate, so a human reviewing a number written against a non-matching sender can tell the two cases apart.

**The order-status URL is the one strong identifier we still throw away.** `{{ order.order_status_url }}` renders to a per-order token whose shape is a platform invariant rather than a template choice — but `htmlToText` drops every `href`, and the raw body is not retained, so the token survives in **0 of 296** stored messages. Using it would need the href kept at map time *and* a token column on `orders`; neither exists, and the hash check does not need them.

### An anonymous marketplace buyer is accepted on the order number (2026-09-17)

Amazon hands Shopify the same placeholder for every buyer (`Anonymous Customer`, `anonymous-…@example.com`, on all 621 Amazon orders), so no email or name check can ever match the real person. **Found on a real ticket:** `RE: Commande 6059`. The customer quoted the number, the order existed, and resolution called it `mismatch` with `ask_purchase_email`. The draft then asked for the order number the customer had just given, plus an email Amazon never passed on.

`verifyOrder` now confirms such an order, **after** every existing check has failed, only when all of these hold:

- the order's `sales_channel_handle` is in `ALL_MARKETPLACE_HANDLES` (a closed list; an unknown channel does not qualify);
- the customer is the placeholder (`isAnonymousPlaceholder`: that exact name and an `@example.com` address). The store reads the address only to compute that flag and drops it;
- the number was quoted as an order number, not reached through a tracking number;
- it is the **only** order number in the message.

**Why only one order number.** `TR: Retour Colissimo` is a staff thread naming #6461, #6673 and #6059. Without this rule, the one anonymous order would be the one that confirms, and a thread about three orders would be linked to one.

**Internal threads are not excluded.** They sit on `/conversations`, not Tickets, and get no draft, so a link there reaches no customer. Linking them is correct anyway: `RE: Retour commande Q0026204303` really is about Amazon order #6308.

**Yves Rocher is not included.** Mirakl buyers carry their real name, so the name check can work there.

`verified_by: marketplace_order_number` keeps the weaker provenance visible, and the ticket's Order block says the buyer could not be checked.

**The investigation stops asking for an address on these tickets.** Once #6059 was linked, the rerun still asked for the account email. `lookupCustomer` finds no record (none can exist), and its no-match text told the model « c'est la question à lui poser ». Two layers, both keyed on `verified_by` through `orderBuyerAnonymous` on the investigation's ticket input. The lookup's result tells the model the missing record is expected and not to ask. `buildCaseFile` removes `purchase_email` and `account_email` from `missing` whoever added them, so the fix does not depend on the model listening. It is the only confirmed path that skips ownership, so no other ticket carries the flag. Measured by dry run before and after: **2 of 111** unresolved tickets changed (#6059, #6308), and nothing else moved.

### An order confirmed after the investigation sends the ticket back through it (2026-09-17)

**Found on `fcf4ca11`.** Florence quoted « ma commande 6669 », which is hers by email hash, yet her draft asked her to « confirmer le numéro de commande ». The newest-first re-import on 2026-09-13 created the ticket from its latest message, Taha's, so resolution at 23:23 compared #6669 against a colleague's address and said `mismatch`. `requester:repair` (run by hand; no repair tool is part of the worker or the nightly job) set Florence as requester minutes later. Nothing re-ran resolution, and nothing would have refreshed the case file or the draft if it had. #6746 and #6481 were in the same state.

Two gaps, both closed:

- **Resolution queues a new investigation.** `reinvestigationColumns` runs when a confirmed number is written to a ticket that already has `investigated_at`. It raises `needs_investigation`, and reopens `awaiting_customer` / `awaiting_human` to `open`, because the investigation only claims open tickets. Those two statuses are set only by the agent's verdict (the dashboard sets `open`, `resolved`, `closed`), so a person's decision is never reopened.
- **Drafting redoes a stale pending draft.** The case file is rewritten in place (same row, same trigger message), and drafts are keyed on the trigger message, so a re-investigation used to count as already drafted. `needingDraft` now also returns a reading whose draft is **pending** and older than `investigated_at`. An approved, edited, rejected or sent draft is never redone. Measured before the change: **0 of 123** existing drafts were older than their case file, so it redraws nothing until a re-investigation happens.

Checked end to end on the three tickets with neither `requeue` nor `--redraft`: resolution confirmed all three by email and reopened and queued them, then the investigation and drafting passes picked them up by themselves.

**How often a ticket is investigated.** There is no fixed cap: once per new inbound message (through the categoriser), plus **at most once** more when an order is confirmed after the case file was built (once the number is written, the ticket is never resolved again), plus any manual `tickets:requeue` / `investigate --backfill`. A failed run retries up to 3 times, and those retries complete the same investigation. A new message and a late confirmation in the same poll raise the same flag, so they cost one investigation.

### The customer's later replies are read, and may only confirm (2026-10-02)

**Found by the user.** We asked a customer who wrote from another address which address the order was placed with. They answered in the next message, and nothing happened: resolution read `ticket_first_inbound` and nothing else. The same was true of « quel est votre numéro de commande ? » answered by « #6789 ».

Resolution now also reads every later inbound message. Only the customer's own words count (`splitQuotedReply(...).own`, through `record.laterInboundByTicket`), and only on threads with a second inbound message (one grouped query on `ticket_message_counts` first). The addresses in those messages join the address check.

**A number found only in a later message counts only if it CONFIRMS.** Quote detection misses some mail clients (Italian « Il … ha scritto: » is not a marker), so a later "own" text can still carry our reply. Measured by dry run on 2026-10-02: one ticket picked up « exemple # 5012 » from our auto-reply and would have become a `mismatch` on #5012. A mismatch is not harmless any more, because the reply now names the order it found (below). A confirmation is safe whatever text it came from, because the order belongs to the sender or to an address they wrote. When the first message's number is a mismatch and a later number confirms, the later one wins: the customer corrected it.

Measured over 492 unlinked tickets: **5 become confirmed** (4 by the sender's own address, 1 by an address in a later message) and nothing else moves.

### An idle poll reads what could have changed: drafting refusals, the customer index, forwarding (2026-10-11)

**Found by the egress bill, measured in production.** Egress was still ~450 MB a day after the 2026-10-06 changes. A one-hour `pg_stat_statements` comparison put the worker at ~120k PostgREST requests a day. Sizing each repeated read put the two drafting passes (replies and refund notices, `draft-runner.mjs`) at **210 kB a poll, ~270 MB a day**:

- Every poll they read every case file of every case waiting on us (28), with all of its jsonb, before asking whether any still needed a draft.
- Six of those cases are claimed every poll and refused every poll: 4 `not_customer_trigger`, 1 `not_open`, 1 `stale_case_file`. Each time the pass first read their full threads with bodies, their tickets and their case siblings.

**The rules:**

- **The queue is decided on keys.** `needingDraft` runs on `id, ticket_id, trigger_message_id, investigated_at`. The full case file (`investigationForDrafting`) is read by id only for the rows claimed.
- **A refusal is remembered** (`createDraftRefusals`, one per pass in the worker). A candidate refused by a gate or by `draftDecision` is not claimed again while its key holds. The key is the ticket's `updated_at` (new mail, status, a pending pass and a recorded notice all move it), the case file's id and `investigated_at`, and the case version and `as_of_message_id`. Anything that moves outside those is caught by a **15-minute expiry**, the change gate's floor: a sibling thread of the case, or a rule or template edited in Agent Setup. A model failure is never remembered; it is retried next poll. The CLI and the rehearsal pass no memory and judge every candidate every time.
- **The brand voice is read once a poll** and shared by both passes.

**Measured on live data, sealed** (GET only, no model call), two consecutive polls each:

| Code | First poll | Next poll |
|---|---|---|
| Before | 210 kB | 210 kB |
| After | 153 kB | 24 kB |

The same six refusals are counted, for the same reasons. At one refresh per 15 minutes that is ~43 MB a day instead of ~270.

**The rest of an idle poll, the same day.** Run sealed as a whole worker (Supabase reads real; writes and RPCs answered fake; Graph an empty mailbox; OpenAI and Shopify refused):

- **Customer index.** `refreshIfChanged` drops the 4.7 MB hash index only when the newest `customers.updated_at` moved since it was read, or after a day. A day is the backstop because a row deleted outright moves no stamp. If the stamp cannot be read, the index is dropped, as every pass did before.
- **Forwarding is behind the change gate**, on `tickets`, `forwarding_destinations` and `forwarding_settings`. New mail, our own replies and a category all move `tickets`. A failed forward or acknowledgement is now retried on the 15-minute floor rather than every minute.
- **The reply pass reads `case_current` without `obligations` and `pending_customer_inputs`.** Only a notice reads them.
- **The mailbox cutover is read as one key** (`sync_cursors->>mail_ingest_cutover_at`), not the whole cursor object with both delta links.
- **Saving a delta cursor returns nothing.** Before, each folder's save, every poll, downloaded the whole `shops` row.
- **The brand voice is re-read only when its row's `updated_at` moved** (`loadIfChanged`). An edit is still read on the next poll.

Measured with that harness: **41 kB → 33 kB a poll**, about 42 MB a day for an idle worker. The 3.8 MB first poll after a restart, and once a day after that, is the catch-up passes reading everything once. The paged reads still cost a second, empty request each: `supabaseSelectAll` stops on an empty page because it does not trust the server's page size.

### The other per-poll passes run on change, not on the clock (2026-10-06)

**Measured with writes blocked, after the order-resolution fix:** an idle poll still downloaded about 720 kB. That is the change router 269 kB, the fold's staleness scan 264 kB, customer resolution 127 kB, order context 48 kB and auto-close 15 kB. Every one of them re-read its whole input to conclude that nothing had moved.

**The rule is that a pass reads again only when its inputs could have moved:**

- **Change gate** (`agent/src/lib/change-gate.mjs`, `changeGate` in the worker). Customer resolution, order context, the change router and auto-close run only when the newest `updated_at` of the tables they depend on has moved, or at least every **15 minutes**.
  - The 15-minute floor covers what moves with time alone: the router's windows and auto-close's days of silence, which are measured in days, so a 15-minute grain changes nothing. It also covers what lives outside those tables, such as a rule edited in Agent Setup.
  - New mail moves `tickets.updated_at`, so a customer's message still reaches every pass in the same poll.
  - Customer resolution is gated on `tickets` only. Reading a stamp off 62k `customers` rows per poll would cost more than it saves, so a newly synced customer waits at most 15 minutes.
- **The fold is incremental** (`staleTicketIds`). It reads the tickets, case-state readings and actions changed since the last poll, plus whatever was still stale, and runs `staleTickets` on those alone. The whole shop is read again once a day and after a restart.
- **`metadata` is read for one key, or not at all.**
  - The change router and customer resolution read it only to write one key back.
  - Customer resolution now selects `metadata->customer_resolution`.
  - The router selects none.
  - Both merge their key into the row's metadata as read at write time, which also closes the window where a whole-object write could drop another pass's trail.
- **Heavy columns only for the rows used.**
  - The router finds the newest investigation per ticket first, then reads `tool_calls` and `findings_trace` for those runs only.
  - Order context scans built tickets for `id, order, version` only, and reads full rows for the few behind.
  - Casework finds unread staff messages by id and reads only their bodies.

Measured: two consecutive dry-run polls on live data cost 723 kB, then **~0 kB**.

**Shipped broken once, 2026-10-06 06:52–07:15 UTC.** The gate was first called `gate`, and the poll body's spam filter declares its own `gate` (`blocklistStore.loadGate`). The inner name shadowed the outer one, `gate.run` threw « not a function » right after ingestion, and every pass after it stopped for 23 minutes until `b3bc979` was reverted. Mail was still stored. It is now `changeGate`, `poll-order.test.mjs` fails on a second binding of that name, and a deploy of `index.mjs` is preceded by one sealed poll (writes blocked, Graph faked, no model calls) of the real worker, since no unit test executes that file.

### Resolution re-reads only what changed, and writes only a new outcome (2026-10-05)

**Found by the egress bill.** Every 60 s poll took up to 500 unlinked tickets, read the opening body of **every ticket in the shop**, read every later inbound body on the pending threads, and PATCHed all ~490 with `return=representation`. Each row came back whole, and every write was "new" only because of a fresh `resolved_at`. That came to about 3 GB a day, nearly all of it for results that had not moved. It also made `tickets.updated_at` meaningless.

The outcome depends on the ticket (its messages and requester), the orders its text names, and the shop's marketplaces. So the worker keeps `createOrderResolutionState()` in memory and re-resolves only:

- tickets whose row changed since the last pass (`updated_at`, which a new message moves through `last_message_at`);
- tickets that quoted an order number or parcel belonging to an order changed since then (`changedOrderRefs`, two narrow columns);
- **the whole queue** once a day, after a restart, and when the marketplaces change. This catches what is not tracked: a customer renamed, the order-number range quoted in a `detail`.

The rules that go with it:

- **An unchanged outcome is not written.** The stored entry is compared with `resolved_at` ignored and keys sorted, because jsonb reorders them.
- **A confirmed match is always written**, so a column cleared since is set again, exactly as before.
- **Bodies are read for the selected tickets only**, by id.
- **Writes return nothing** (`returning: 'minimal'`).
- **Without state** (tools, rehearsal, tests), every call is a full pass, as before.

**Two bugs this surfaced.**

- **The 500 cap starved the tail.** With no sort the queue was `id.asc`, so tickets past the first 500 UUIDs were never resolved. A dry run on 2026-10-05 found 154 never-resolved tickets, 36 of which confirm an order. Most are closed. Two are open (`e4bcf204`, `d33fda0b`) and one is `awaiting_human` (`ee493c1a`). One more `awaiting_human` (`cd82ff5a`) had a stale mismatch that now confirms through the marketplace rule. The queue is now newest-activity first, and the daily pass is uncapped.
- **A number longer than `integer` failed the pass for everyone.** `9600053422`, on a live ticket, made the `orders` query error out. `loadOrders` now never sends a number that cannot be an order number. It reached the batch only once the order changed. Under `id.asc` it had sat in the starved tail.

### `order_identity` names the situation, not just "unconfirmed" (2026-10-02)

`none` covered every unconfirmed ticket, so the 15 approved rules on it all asked for the number **and** the address. That included the ticket where the customer had just quoted #6668 from another mailbox. The resolver knew which case it was; nothing below it could see it.

`none` is split into five values (`agent/src/resolution/order-identity.mjs`), read off `metadata.order_resolution` and `customer_id`:

| value | means | asked |
| --- | --- | --- |
| `no_number_known_sender` | no reference; the sender is a customer | the number |
| `no_number_unknown_sender` | no reference; nobody under this address | the number and the address |
| `number_not_found` | a reference that leads to no order (typo, `Q00…`, unknown parcel) | the number |
| `other_email_same_name` | the order exists under another address, same name | the address, naming the order |
| `other_email` | the order exists under another address | the address, naming the order |

**To support it, resolution records the order it found** (`found_order_name`) even when ownership is unproven, and whether a reference led nowhere (`unmatched_reference`). The column is still written only on a confirmation.

**Code trims the questions, whatever the rule says.** `fieldsAlreadyAnswered` treats the address as known on `resolved` and `no_number_known_sender`, and the number as known on both `other_email` values. `fieldsAskedInstead` turns an answered number into the address question, so a rule asking only for the number still asks the one thing open. The address question names the order (`purchase_email.askAbout`). The rule text for each situation is the merchant's, written in the Rulebook.

**The model's own questions are filtered too.** `buildCaseFile` used to filter only the rule's asks, so the model could still list the order number on a ticket whose order was found. One pass now covers both.

**Migration 59 keeps `none` beside the five.** `normaliseConditions` drops a value it does not know, and a condition left empty makes the rule fire on every ticket. With both present, code from either side of the change reads the rule the same way. The Rulebook drops `none` when a rule is next saved.

### Audit: which passes read only part of a thread (2026-10-02)

Run after the order-resolution bug above. Every reader of the first or a capped set of messages, and what it should read:

| reader | reads | verdict |
| --- | --- | --- |
| order resolution | first message | **fixed** above |
| situation match, retailer check | opening message | intended (§ the matcher reads the opening message), **but** the investigation capped the thread to its newest 10 rows, so on 11 threads (longest 30) "opening" was a mid-thread reply. **Fixed:** no cap; the model's text is still budgeted by characters, newest first |
| categoriser | first + latest | intended, **but** it read the first 10 inbound oldest-first, so on 7 threads "latest" was the 10th. **Fixed:** first + true latest |
| investigation transcript labels | every message | **bug, fixed:** `transcriptLabel` was called without the sender directory, so colleagues and Deret were rendered « client », the failure that labelling was added to stop |
| customer resolution and `lookupCustomer` | the sender's address only | **fixed, the safer version:** an address given in a reply counts only after we asked for one (§ An address given when we asked for one may link the customer) |
| case manager, drafting | whole thread | fine |

### The investigation transcript: times, two marks, and nouns (2026-10-02)

Decided with the user after asking whether the investigation can tell who wrote what, and the latest message from the history.

- **Date and time, in shop time** (`[client — 2026-09-28 17:10]`, from `shops.iana_timezone`, UTC if unset). The date alone could not order three messages written the same day.
- **Two messages are marked.** « DERNIER MESSAGE DU FIL » is the newest message, whoever wrote it (Deret, a colleague, our own reply): it says where the case stands. « DERNIER MESSAGE DU CLIENT » is the newest customer message, where the request most likely is. When they are the same message it carries one mark. The marks are words in the label, so no message is printed twice.
- **Both marked messages are always kept.** They are budgeted before the rest. The newest message may take at most half of what is left while a separate customer message waits, so a long Deret reply cannot push the customer's question out.
- **The heading says what the text is.** « Message du client » only for a lone customer message, byte for byte as before (the common case). « Message reçu (il ne vient pas du client…) » for a lone message from someone else. A thread is « Fil de la conversation… », with a line saying what each mark is for.
- **Generic nouns, no company names.** Our replies are « nous (service client) », colleagues « collègue ». The company stays in the directory, and the header names the domain. The transcript still never renders a domain, because these labels also reach the drafting prompt.
- **Every directory label has a role.** `distributor`, `supplier`, `partner` and `other` fell back to `customer`, both in the label and in `senderRole`, which the closure check reads.

**Our own replies carry the shop's name** (`shops.shop_name`, through `senderDirectoryStore.load`), not a literal. Without a name: « nous (service client) ».

### Company facts come from data, never from code (2026-10-02)

The user's rule (« [company_name], not Qiriness, and the same for the others »). Every runtime text that named the company or a partner now reads it:

- **The name** is `shops.shop_name`, synced from Shopify. It is a fact the platform holds, so it is not typed in a second time.
- **What the company is** (`company_description`, « une marque de soin de la peau ») and **who ships** (`logistics_provider_name`, « Deret ») are parameters, editable in Setup. Unset, the text falls back to the name alone and to « the logistics provider ».
- `scripts/lib/company.mjs` reads them (`loadCompany`) and words the agents' first line (`serviceClientOf`). The investigation, categorisation and spam-filter prompts take a `company` option; the worker reloads it every poll with the models, so an edit in Setup rebuilds the prompts on the next poll.
- **Where no name is needed, none is used.** The draft check matches « votre compte <any word> indique », the brand-voice notice says « the brand », the management chat lists the marketplaces from `MARKETPLACE_CHANNELS`, the sales report takes `companyName` from the shop.
- The two parameters were set for this shop to the values that had been literals, so every prompt reads exactly as before.

**The dashboard followed the same day.** The root layout reads the shop once (`getShop`, now with `storefront_url`) and hands `{ name, storefrontUrl }` down through `ShopProvider` (`web/lib/shop-context.tsx`). Page titles use one template, « %s · <shop> Support OS », so each page states only its own part. The store link goes to `storefront_url` (it was https://qiriness.com). `useT` fills `{store}` in any string with the shop's name, which is how « Open the {store} store » and the outbound role label work without every caller knowing the name. The logo file is `brand/logo.png`: another shop replaces the file, not the code.

**The marketplaces became data too** (the user's choice: a Setup table). `sales_channels` holds one row per marketplace: its key, its name, the Shopify channel handles behind it, and the names Shopify Analytics gives it. That last list was a second hidden literal, `MARKETPLACE_SALES_CHANNELS`. Every handle not listed is the shop's own store, as before. `scripts/lib/marketplaces.mjs` builds one registry from the rows, and every consumer takes it: the Insights context (`ctx.marketplaces`), the orders list and order detail (`getMarketplaces`, cached per request), the VIP rule, order resolution's anonymous-buyer rule, the chat prompt and `chat.vip_customer_rows()` (migration 60). The UI strings say `{marketplaces}`, which `useT` fills from the shop context. `PlatformId` is now a string. This shop's two rows were inserted with the values that had been literals, and a dry run of order resolution gave the same result as before.

**A shop with no rows has no marketplaces.** Every order counts as its own store's, nothing is excluded from per-person figures, and the anonymous-buyer path in order resolution stays closed. Failing towards "our store" is the right direction: a marketplace nobody configured is a mistake visible in Insights, while a store order read as a marketplace's would silently drop real customers from every per-person figure.

**Setup → Sales channels shows what the orders say**: every handle with Shopify's label and an order count. « connect-dev-1 » means Yves Rocher only because its orders say so, and nobody knows a handle by heart.

**The trigger is unchanged**: the case file is still keyed to the newest received message. The marks change what the model is shown, not which message a run belongs to.

#### TO DO — before drafting joins the worker poll

Drafting is **not** in the poll today. It runs only through `npm run draft`, so a re-investigation updates the case file at once and the draft only at the next manual run. When drafting becomes automatic, both cases below have to hold:

1. **An order confirmed before anyone drafts: re-investigate, then draft once.** This works today because `orders` runs before `investigate` in the same poll. Drafting must be added **after** `investigate`, never before it, or it drafts from the case file the order is about to replace. It should also skip a ticket whose `needs_investigation` is still raised: a re-investigation that failed and is waiting to retry leaves the old case file in place, and drafting would read it.
2. **A draft that already exists: rewrite it from the new case file.** `needingDraft` redrafts a **pending** draft older than its case file, at one model call per ticket, and never touches one a person approved, edited, rejected or sent. Decide before switching on:
   - **Rewrite or flag.** Keep the rewrite, or mark the stale draft outdated for the reviewer and save the call.
   - **The review mail.** `save` clears `review_sent_at`, so a draft already mailed to a reviewer is mailed again once it is rewritten. Check that is wanted once review copies are automatic too.

### A person can link a ticket's order, and the person is the proof (2026-09-17)

Three cases the resolver cannot settle and a person can: no order was found (a number in a later reply, or a reference we do not parse), the order found is wrong, or the investigation's **candidate last order** is the right one. The ticket's Order block therefore has a pencil beside a confirmed number, **Add order number** when there is none, and **Confirm this order** on a candidate. All three end in one server action, `changeTicketOrder`, so there is one rule.

**No ownership check.** A person linking an order has already judged it, so none of the resolver's paths apply and `verified_by` is `manual`, with `set_by` (the dashboard user), `matched_by` (which control) and `previous_order` in `metadata.order_resolution`. The popup shows how the order relates to the sender (same email, different email, anonymous marketplace buyer, nothing to compare) and **never blocks**: a gift or a second mailbox is the ordinary reason for a mismatch.

**Two steps, because it costs a run.** Look up and preview, then a second screen saying the investigation runs again and the pending draft will be rewritten. Nothing is written before that confirmation.

**What the change writes** (`manualOrderColumns` in `scripts/lib/order-link.mjs`):

- the number;
- the order bundle, rebuilt at once with the worker's own `buildOrderContext`, so the panel shows the new order immediately;
- `customer_id`, only where the ticket had none (the same rule as the context pass);
- the requeue.

The requeue is the same `reinvestigationColumns` the resolver uses, moved to `scripts/lib` so the two cannot drift, with one difference: a person requeues any open ticket, investigated or not. `awaiting_customer` / `awaiting_human` reopen; `resolved`, `closed`, `forwarded` and `spam` get the order but no investigation, and the popup says so.

**Queued, not run inline.** The worker picks the ticket up on its next poll, so the dashboard never waits on a model. The consequence: nothing is re-investigated while the worker is stopped.

**Conditional on what the person saw.** The request carries the order the popup was opened on, and the write filters on it, so a change made meanwhile by another person or by the resolver makes the update match nothing. The person is told to reload, and nothing is overwritten. The resolver itself only reads tickets with no order number, so it never replaces a manual one.

**`buyer_anonymous` became its own flag.** The investigation's "do not ask an anonymous marketplace buyer for an address" rule read `verified_by === 'marketplace_order_number'`, which a manually linked Amazon order would miss. Both writers now set `order_resolution.buyer_anonymous`, and the investigation reads the flag, or the old `verified_by` for rows written before it (#6059, #6308).

**Not built: unlinking.** "This ticket has no order" is a fourth case, left out by decision for now.

### An order remembers which promotion was applied, not only how much (2026-09-17)

Two tickets asked the same unanswerable question. #6827: « j'avais vu qu'un cadeau exclusif était offert, mais je ne le trouve pas ». #6913: « je n'ai pas eu les 20% pour ma première commande ». Both were answered by `expediee_sans_scan` — the general "your parcel has shipped" rule — because nothing in the data could say whether a promotion had landed.

**The order knew, and we were not storing it.** Shopify returns `discountApplications` per order and `discountAllocations` per line; the sync fetched neither, only `totalDiscountsSet`. So #6827 carried "20,90 € of discount" and no way to learn that this WAS the gift: « Sauna Visage offert », 100% off one line.

**A gift and a sample are both lines at 0,00 €**, and telling them apart is the whole point. A GIFT is a line whose price was reduced to zero by a named promotion; a SAMPLE was never priced. Measured over 6,026 orders: 2,643 carry a zero-price line, only 1,126 carry a line reduced to zero. Answering "yes, your gift is on the order" by pointing at an échantillon would be the wrong answer delivered confidently.

**What was extended** (one query, so the webhook path gets it for free — it re-reads each order through the same `ORDERS_QUERY`):

- the order query: `discountCodes`, `discountApplications` (typename, allocation, target, value, code/title) and per-line `discountAllocations`;
- the mapper: `discount_applications` and `discount_codes` on the row, `discounts: [{amount, name}]` on each line item;
- migration 28 for the two columns, and 29 for the new need;
- the order bundle: a `promotions` block — what was applied (by name), the gifts with their value and the promotion that gave them, plain reductions, and samples listed separately.

**This shop's promotions are AUTOMATIC**, so `discountCodes` comes back empty and the name lives in the application's `title`; a code-based order carries the typed code in both. 3,363 of 6,026 orders carry a named promotion, 1,109 a code.

**`checkOrderPromotion` reads the stored bundle**, like `getOrderContext` and for the same reason: one account of the order, not two. It reports everything applied rather than a verdict, because a reply that can say « le cadeau « Sauna Visage offert » a bien été appliqué » answers the customer, and « une remise de 20,90 € a été appliquée » invites the same question again. The finding `order_promotion` (`gift` / `discount` / `both` / `none` / `unknown`) is what rules branch on.

**Situation P-22 and its three rules** (drafts, for the desk to approve): no order identified → ask for the number and the purchase email, worded after `d01_commande_non_identifiee`; something applied → say yes and name it, never counting a sample as the gift; nothing applied → say so plainly, promise nothing, and hand it to a person.

**It cost a full re-sync** (`sync:shopify:orders -- --all-orders`, 6,026 orders, Shopify calls only) and a bundle rebuild (`context:build -- --refresh`, 65 tickets). Both are re-runnable and neither spends a model call.

**The incident this work caused is in `VALIDATION_LOG.md` item 12**: the new situation was first written under `P-21`, a key that already existed in the database and not in the document, and the importer overwrote it. Recovered from the prose documents, moved to `P-22`; the importer still has no database-side duplicate check.

### The order passes run before the investigation, and nothing used to check that

`getOrderContext` is a **reader**. It returns whatever the order passes stored on the ticket and never queries for itself — deliberately, so the agent is shown the one reviewable bundle rather than a second derivation of the same facts that could disagree with it. The consequence is that an order those passes have not yet confirmed does not exist as far as the agent is concerned.

Until 2026-08-22 the poll ran `categorise → investigate → orders → context`, so on the **first** message of every thread the investigation ran against an empty `resolved_context`. The comment above the resolver said *"every order tool downstream needs its output"* while sitting downstream of the tool that needs it; the placement and its own stated rationale had disagreed since it was written.

**The cost was invisible, which is why it survived.** The tool answers « Aucune commande confirmée n'est rattachée à ce ticket », the model correctly records the order as *unverified* rather than inventing a status, and the ticket goes to a human — a chain of individually correct behaviour that reads as the agent being appropriately cautious. Nothing in a log says the answer was sitting in the database the whole time.

**Found by the test chat, on a real ticket.** Order `#5144`, quoted in the message, registered to the sender's own address. The trace: `getOrderContext` → `not_resolved` → case file records "la commande #5144 a été passée par le client" as unverified → verdict `needs_human` → *then* the resolver confirms it `verifiedBy=email`, and the bundle builds. The deterministic check had the answer with certainty; the expensive, fallible one had already written the conclusion.

**Measured before fixing, so the claim is sized rather than assumed:** 60 case files on order-family tickets, 24 investigated with the order in hand, 35 blind with no order number to know (correct — nothing to see), and **1** blind while the order was known. The backlog largely escaped because it was ingested in bulk and the passes ran repeatedly, so most tickets were investigated on a later cycle than their order was resolved. That is an accident of loading, not a property of the design: for live mail everything happens inside one poll, and every first email quoting a number would hit it.

**Placed after categorisation rather than before it.** The only real constraint is "before the pass that reads its output" — the categoriser reads the subject and the message bodies and would learn nothing from an order. Moving them ahead of `categorise` as well would have changed what `--stop-after=categorise` runs, and that flag is the documented cheap corpus-building path (`ingest:once --limit=500 --stop-after=categorise`). `--stop-after=orders` changed meaning instead, which nothing uses and which now reads more sensibly anyway: it stops before the expensive investigation rather than after it.

**Two dormant rules woke up.** `escalationTriggers` reads the order's delivery state and can raise a ticket to level 3 — a parcel in transit with no scan for 10+ days, or a carrier reporting *delivered* on a `delivery/problem` ticket. Neither could fire on a first message while the context was always null. Both cap at 3, and level 4 is the only band that blocks drafting, so nothing is newly suppressed; some delivery tickets will simply sit higher in the queue than they used to.

**`candidate_order` fires less often, by design.** The investigation attaches the customer's most recent order as a lead for a human, but only where no order was confirmed. With the resolver running first, more tickets carry the real one — the fallback shrinking is the fix working, not information lost.

**The guard is `agent/src/poll-order.test.mjs`.** It asserts what the stage list *declares* and what the poll body *does*, and that the two agree — because this bug was exactly a list and an execution order drifting apart with nothing watching. `index.mjs` calls `main()` at module scope and cannot be imported, so the assertions read it as text, the same trade `_shared.test.mjs` makes over the `.sql` files.

### The order bundle is assembled, not handed over raw

The raw order carries four separate status columns, a fulfillments array, a refunds array and twenty monetary fields. Answering "where is my parcel?" from that means the model reasoning that `fulfillment_status = FULFILLED` with `delivered_at = null` and `in_transit_at = null` means "dispatched, no scan yet" — a deduction it will sometimes get wrong, differently each time. Deriving it once here makes the answer deterministic and reviewable.

The bundle carries the buyer's name and email (support cannot answer without knowing whose order it is) but **no street address and no phone** — the sync stores only a coarse city/country, and this is an email desk.
