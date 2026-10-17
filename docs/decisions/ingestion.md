<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Ingestion

### `--limit=N` means the newest N, and it is asked for (2026-09-14)

A limited initial delta read adds `$orderby=receivedDateTime desc`. Graph already enumerated this inbox newest-first without it — measured before the from-scratch re-ingestion, the first 400 messages came back in order (2026-09-13 back to 2026-07-10, no inversions) with and without the sort — but that is an observed default, and "re-run the latest 400" should not rest on one. **Unlimited reads are untouched**, because their `deltaLink` becomes the stored cursor, and a limited run never persists one (`delta-poller.mjs`).

**Read newest first, written oldest first.** Every ingestion rule that fires on the message that *creates* a ticket — `sender_label`, the requester, the duplicate link — assumes that message opened the thread. The first limited run wrote in read order, so each thread's ticket was created from its latest message. Measured on that 400-message re-ingestion: **15** staff threads unlabelled, **7** tickets with a colleague as requester (**2** then linked to the wrong customer, which no pass can undo), **4** duplicates and **5** related links missed. So under `--limit` the poller now collects the newest N across pages and writes them in `receivedDateTime` order (`oldestFirst`). Buffering is bounded by the limit. **An unlimited full re-enumeration still writes page by page in Graph's order.** Sorting it would mean holding the whole mailbox in memory. **Since 2026-09-26 that order no longer decides the opener or the requester**: both are re-read from the whole thread as each message lands (§ *The opener and the requester come from the thread, not from arrival order*). The duplicate link still fires only on the creating message.

### Progress is saved page by page, and a rejected saved link starts the read over (2026-09-26)

**Measured 2026-09-26: `shops.sync_cursors` was `{}`, so no cursor had ever been saved**, while two runs on 2026-09-25 had imported 1,173 messages. `runDeltaPoll` saved only the final `deltaLink`, never a `nextLink`. A first full read therefore had to cross the whole Inbox (2,785 items, about 280 pages at Graph's default of 10) without dying, and `--limit` runs deliberately save nothing. It never happened, so every run began at page one.

**The `nextLink` is saved after its page is written** (`mail_ingest_resume_link`), and cleared when the `deltaLink` arrives. Written after, never before: resuming can replay a stored page, which the re-delivery rule makes harmless, but can never skip an unstored one. The page-count safety valve now stops the run with the resume link in place, instead of throwing it away. Unlimited reads ask for pages of 50; the page size changes nothing about which mail arrives.

**A saved link Graph refuses is dropped, logged as `ingest.cursor_expired`, and the read starts over once.** Decided with the business: starting over is safe because known mail does not retrigger a ticket. Measured: a corrupted skiptoken answers `400 BadRequest` « Badly formed token ». A real expiry could not be produced on demand; Graph documents it as `410 Gone`, so both count, and the log keeps the status and code Graph actually sent. **Only the first request of a poll, from a saved link, gets this treatment.** A `nextLink` Graph handed over seconds earlier failing is a real error, and a fresh read that fails is not retried.

**`mail_ingest_cutover_at` is written with the first `deltaLink` and never again**, not by an expiry and not by `ingest:reset`. Mail received after it is new to the pipeline. The case-state plan derives draft eligibility from it rather than flagging 440 old threads one by one (`codex_plans/Case_State_Plan.md`, Q3).

### Sent Items is read too, and it only adds to cases that exist (2026-09-26)

Replies sent from the support address do not all come back to the Inbox. Measured 2026-09-26: of the **115** in Sent Items, **7** were already stored as Inbox copies, **98** were replies we had never seen on threads that have a ticket (3 of them from September 2026), and **10** were on threads with no ticket.

- **Its own cursor** (`mail_sent_delta_link` / `mail_sent_resume_link`), with the same page-by-page saving and restart rule as the Inbox. **The cutover stays the Inbox's**: Sent Items holds only our own mail, so it can make nothing new to the pipeline.
- **Read straight after the Inbox, before any other pass**, so a poll sees both halves of a thread before anything reads it.
- **Everything in it is `outbound`**, and **it never opens a ticket** (decided: our mail adds to a case, it does not start one). A thread with no ticket is counted in `skippedNoTicket`.
- **A copy is skipped on `internetMessageId`**: an outbound message already stored under another Graph id (`skippedCopies`). **Outbound only**, because two inbound items sharing an id have been two real deliveries on two threads (one pair in January). **Not a unique index**: decided to wait until the data with Sent Items in it has been read.

**Result of the first read:** 98 attached, 7 copies and 10 without a ticket skipped, which is exactly the prediction. 0 tickets changed status, 0 were flagged, and the second poll read 1 page per folder.

**This is secondary coverage.** Most of the team replies from personal inboxes (§ *A colleague answering the customer from their own inbox*), which no support-mailbox folder holds.

### `runDeltaPoll` dropped two of the writer's options, and nothing failed (2026-09-26)

The worker passed `senderLabel` and `detectRelated` to `runDeltaPoll`, which never named them and never handed them on. So in the worker:
- **no ticket was ever labelled at creation.** § *A colleague is not a customer* describes the stamp as happening "at creation, from the address"; in the worker it never did. The only labels were the 16 written by `sender-label:backfill`;
- **no related link was ever made live**, only by `related:backfill`;
- **the staff-reply rule built earlier that day never ran.** The writer's tests call it directly, which is why they passed.

Found while wiring Sent Items: the 347 tickets from the first full read carried 0 labels and 0 links. Fixed by passing both through, with a test that goes through `runDeltaPoll` itself.

**Repaired the same day:**
- `sender-label:backfill`: **125 tickets labelled** (141 in all). A labelled ticket stops receiving drafts; investigation still runs.
- `staff-replies:backfill` now **reconciles in both directions**. **58 of the morning's 124 re-filed messages went back to `inbound`**: they were on threads a colleague had opened, which only lacked their label. **66 staff replies to customers remain `outbound`.**
- `related:backfill`: **9 links**, 5 of them unanswered chases.

### Stored message ids become immutable, and the header follows a marker, not a setting (2026-09-26)

A REST message id can change when mail moves folders. `Prefer: IdType="ImmutableId"` fixes that, **but only if what is stored changes first.** `graph_message_id` is the unique key of `ticket_messages`, `spam_audit` and `categorisation_review`, and it is what `knownMessageIds` compares. With the header on and REST ids stored, every re-delivered message would look new, which is § *Re-delivery is not arrival* all over again.

**Measured before building (2026-09-26, live mailbox):**
- with the header, delta returns exactly the id `translateExchangeIds` gives for the same mail (40 of 40, then 151 of 151, joined on `internetMessageId`);
- a plain GET accepts an immutable id without the header, so the attachment viewer, the photo check and `/forward` need no change. Only the delta read, the one call whose returned ids are stored, sends the header;
- translation needs no permission beyond what the app has.

**So `ids:translate` rewrites the ids, proves them against delta, and only then writes `mail_id_type = immutable` and drops both links.** The poller reads the marker at every poll, not at startup, so a running worker follows the switch at its next poll. The dry run on 2026-09-26: 1,515 of 1,516 message ids and 132 of 180 audit ids translate. The other 49 are `NotFound` (mail deleted since) and keep their old id: Graph will never deliver them again, so they collide with nothing.

**A marker in the database, not an env var**, because the two halves must never disagree. An env var switched on before the translation, or left off after it, duplicates the corpus. The migration is the one writer of the marker, and it writes it last.

### History a full read imports is not queued for the model (2026-09-26)

The first complete read (§ *Progress is saved page by page*) went back to 2025-09-30 and left **831 tickets flagged for categorisation**, only 9 of them ever categorised. Each would cost a categoriser call and then an investigation, on threads nobody is waiting on.

**Decided with the business:** clear `needs_categorisation` on tickets whose every message predates the cutover, and **keep all their labels** for reporting. A later customer message raises the flag again through the ordinary ingestion rule, so nothing needs undoing if a thread comes back to life.

**Narrowed when applied.** Read literally, the rule cleared all 831, including **40 tickets with mail from the last two weeks, 24 of them ending on a customer message nobody had answered** (« Still shipping cost charged », 2026-09-25). The business's premise was "old tickets", and those are not. So the boundary is the cutover **minus the 28 days auto-close already treats as live** (`AUTO_CLOSE_AFTER_DAYS`): **791 cleared, 40 left queued.** `tickets:unqueue-pre-cutover -- --keep-after=<ISO>` sets it. The newest ticket cleared was last written to on 2026-07-23.

**A consequence to expect:** those 791 tickets are `open`, idle for more than 28 days, and no longer flagged. Auto-close exempts only level 4, `awaiting_human` and flagged tickets, so **the next full poll closes them for inactivity** (`closed_reason = 'inactivity'`). That is the housekeeping rule doing its job, and a customer reply still reopens a ticket.

### A Shopify sync never writes `sync_cursors` (2026-09-11)

`mapShop` returned `sync_cursors: {}` and `app_settings: {}`, and every Shopify sync upserts the shop — so **every sync wiped the mail delta link**, and the next mail poll re-enumerated the whole mailbox. Found while building the Insights freshness strip: `shops.sync_cursors` read `{}` on a shop whose worker had run many times. It is the likely cause of the mail window moving back on re-enumeration, and with the nightly sync now scheduled it would have happened every night.

Both columns are ours, not Shopify's, and both have a `'{}'` default for a first insert, so the mapper now omits them — the same arrangement as `order_retention_mode`, which it already left alone. `shopify-shop-mapper.test.mjs` pins it. The re-delivery rule (below) is what kept the wiped cursor from corrupting tickets; it did not stop the cost of re-reading.

### The webhook is a trigger; the poll is the truth (2026-09-28)

The brief for the mail layer asked for Graph change notifications, a sync worker and a reconciliation every ~5 minutes. Checked against what exists: delta sync of both folders, page-by-page cursors, immutable ids and « only new mail moves a ticket » were already built and measured (sections above), and the worker already polls every 60 s, which is stricter than the 5-minute reconciliation proposed. AGENT_INTEGRATION_PLAN had locked the same rule: subscriptions, if added, poke the same engine.

So a notification does exactly one thing: it queues a `sync_mailbox` job for its folder (`mail_jobs`), and the worker, which checks for due jobs every `JOB_CHECK_INTERVAL_MS`, polls early. The webhook reads no mail and decides nothing. A forged or replayed notification can at worst make the worker read a folder sooner.

- **Believed only with its secret.** The subscription's clientState is generated per subscription, stored as a sha256 (`mail_subscriptions.client_state_hash`), and compared in constant time. Everything else gets a 202 and is dropped, because an error status makes Graph retry.
- **Dedupe among queued jobs only.** A burst for one folder collapses into one job. A job already running does not absorb a new one, because its read may already be past the mail the notification is about.
- **Dormant until deployed.** Graph only delivers to a public HTTPS endpoint, and nothing is deployed. Without `MAIL_WEBHOOK_URL` no subscription is created and the timed poll does everything.
- **A renewal failure is loud and non-fatal:** `mail.subscription_renew_failed` at error level plus `last_error` on the row. There is no alert channel in the project yet; that line is the alert until there is one.
- **Case processing is not a job.** The `needs_*` flags already fire only for mail we did not hold, and every LLM pass runs after ingestion has committed. A `PROCESS_MESSAGE` job beside them would be a second source of truth for the same fact (decided 2026-09-28).
- **The columns keep their Graph names.** `graph_message_id` / `graph_conversation_id` are the unique keys of a populated table read by ~20 modules and the views. The MailProvider contract documents them as the provider's message and thread ids; a Gmail adapter fills them with Gmail's (decided 2026-09-28).

### Idle polls back off; the webhook carries the latency (2026-10-17)

Once the webhook was live (53 `sync_mailbox` wakes on 2026-10-16), the 60 s timed poll above became the reconciliation and nothing more. It was still most of the database traffic. Measured with `pg_stat_statements` over 28 h, ~105k PostgREST requests a day:
- an idle poll made ~57 requests × ~1,320 polls = **~75k**;
- the due-job check, every 5 s, made **~15.5k**.

Supabase logs every request (~1.5 kB each: 164 MB of log ingest that day), and even a response with an empty body sends headers. So at this point the number of requests was the cost, not their size.

- **The wait doubles after each idle poll, from `INGEST_POLL_INTERVAL_MS` (60 s) up to `INGEST_IDLE_POLL_MAX_MS` (10 min), and drops back after any poll where something moved** (`agent/src/lib/poll-wait.mjs`). "Moved" means a table the change gate reads (`tickets`, `orders`, the forwarding tables) has a new newest `updated_at`, or the poll failed (`changeGate.endPoll()`). New mail, a pass's own writes and a dashboard edit all move `tickets`, so follow-on work still runs at 60 s. Measured over 24 h, `tickets` moved in 8 distinct minutes and `orders` in 9, so the worker spends most of the day at the cap.
- **Only with `MAIL_WEBHOOK_URL`.** Without it, the timed poll is the only way mail arrives, and the cap stays at the base interval.
- **The due-job check went from 5 s to 15 s** (`JOB_CHECK_INTERVAL_MS`). It runs whatever the wait, so a notification or an approved reply still wakes the worker within 15 s.
- **What waits longer:** things that move with time alone. A snooze waking or an auto-close can now run up to 10 min late, against hours or days of granularity. If a subscription silently stops delivering, mail waits up to 10 min instead of 60 s. A renewal failure is still logged at error level (§ above).
- **A sealed run** (fake writes, empty Graph, 10 s base, 40 s cap) waited 10 → 20 → 40 s. Each idle poll was ~47 reads and ~40 kB.

### Direction: the Inbox is not only inbound

The team's replies land back in it. A message whose sender is the support mailbox is recorded `outbound`. Measured on real mail, 123 of 348 messages; before this they were stored as customer mail and sat at the end of 43% of threads, exactly where the categoriser looks for how the customer currently feels.

### The opener and the requester come from the thread, not from arrival order (2026-09-26)

**The cause of 174 wrong requesters.** `sender_label` and the requester were both taken from whichever message CREATED the ticket, and the requester was written once. The first full read wrote in Graph's order, so many threads were created from a colleague's reply. That colleague became the requester for good, and the thread was labelled as opened by us. Every staff reply on those tickets then failed the reply-to-customer rule, because « the customer » was the colleague. `requester:repair` fixed the rows; this fixes the cause.

**At ingestion, a message landing on an existing ticket now re-reads the thread** (`threadIdentity` in `ticket-writer.mjs`, one query per message):
- **Opener** = the earliest message not sent by the support mailbox, by `received_at`. `sender_label` follows it. « The opening message decides » still holds; it is now decided on the real opening message.
- **Requester**: `requesterFor`, the rule `requester:repair` was measured on (0 order matches lost). **Only a requester that is one of our own addresses moves**, to the first correspondent allowed to hold the role: `isCandidate`, meaning not non-demand, so a retailer can and a courier cannot. **A customer requester is never replaced**, so the write-once rule stands for everyone who is not us.
- When either changes, **the thread's stored staff messages are re-filed** by the same direction rule (`directionFor`, shared with `staff-replies:backfill`), because a reply stored earlier in the poll was judged against the wrong customer.

**Measured on the day:** in a regression test, messages fed in the wrong order end with the customer as requester, the customer as opener and the staff reply as ours. On the live database, the next poll corrected nothing (the repair had already run) and `requester:repair` finds 0 left out of 993. **Fails safe:** if the thread cannot be read, the ticket keeps what it had and the email is stored. `requester:repair` stays as the backstop.

### A colleague answering the customer from their own inbox is our reply (2026-09-26)

**The team replies from personal inboxes** (confirmed by the business), with the support address copied. The rule above knows only the support address as ours, so these replies were stored `inbound`. Measured 2026-09-26: **95 messages on 55 tickets** from an `internal` address (`qiriness.com`, `lap-groupe.com`) with the ticket's customer in To or Cc. Each one:
- raised `needs_categorisation`;
- reopened a waiting or closed ticket;
- would have read to the Case Manager as the customer's own words;
- did not count as an answer for `answeredSince`.

None of the 123 drafts at the time had been written after one, but automatic drafting would meet it.

**The rule, decided with the business:** an `internal` sender with the customer in To or Cc is `outbound`, whichever staff mailbox sent it. Without the customer, it is a colleague's message and stays `inbound`. It is applied in `ticket-writer.mjs` (`isStaffReplyToCustomer`) **before** the reopen and categorisation rules, so all four effects are fixed where they start rather than in each reader.

**"The customer" is the ticket's `requester_email_hash`**, compared by hash, because the ticket stores no raw address. Two cases are excluded:
- a thread a colleague opened (`sender_label` set), whose requester is a colleague;
- a requester equal to the sender.

**Only `internal`.** A partner writing to the customer (Deret) is not our reply, and `contractor` covers Shopify's notification address.

**What it cannot see:** a personal-inbox reply sent without copying support never reaches the mailbox. Of 179 customer replies carrying `In-Reply-To`, 63 answer a message we do not hold, but 53 of those are the first message stored on their ticket (older history). **At most 10** look like a missed reply. Reading personal mailboxes was not proposed.

**Stored mail was re-filed** with `staff-replies:backfill`: 124 messages on 72 tickets once the full read had added the older history, then **58 sent back to inbound** once the missing thread labels were restored, leaving **66** (§ *`runDeltaPoll` dropped two of the writer's options*). **Note:** until that fix the rule existed only in the tool; the worker never applied it. Only the direction moved; the reopens these messages caused before are history, and nothing records the status they overwrote.

### Identity: a contact-form notification is *about* a customer but *from* Shopify

`contact-form.mjs` parses the labelled body fields (`Name`, `E-mail`, `Indicatif de pays`, `Phone`, `Corps`) and those replace the envelope; `body_text` becomes the customer's own text. Without it 95 tickets shared 2 requester hashes, so `requester_email_hash` — the join key to `orders.customer_email_hash` — was unusable for half the inbox. The parser returns null on an unrecognised template, so a reworded form degrades to the envelope rather than to a wrong customer. It already understands the planned `Catégorie` / `Numéro de commande` dropdown fields, which land in `raw_graph_payload.contactForm` until the Shopify form ships them.

### `first_message_at` tracks the true earliest message

It moves backwards as well as forwards. Graph's delta is not chronological, so on an initial enumeration a thread is routinely opened by one of its later replies; "the first message we saw" was late on 93 of 171 tickets, by 5 days on average and 24 at worst — and the categoriser queue is ordered on this column.

### Only inbound messages are ever classified

The spam gate skips outbound (blocking the support address would drop every reply the team sent), and the categoriser reads `findInboundMessages` only — spending a model call on text Qiriness wrote would make `happiness` measure our own tone.

A thread holding *only* our replies is therefore unclassifiable: it is skipped **and taken out of the pending queue**, because ingestion re-raises `needs_categorisation` the moment a customer message arrives. Leaving it pending instead parks it at the front of an oldest-first batch permanently — measured on real mail, 11 such tickets took 11 of every 25 slots on every pass.
