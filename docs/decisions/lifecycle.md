<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Lifecycle

### Snooze hides a waiting case until something happens, and only a sent message snoozes it (2026-09-30)

Asked for: a ticket nobody can act on yet should leave the queue and come back on its own when it needs someone. The customer has our question, Deret is investigating, or a colleague has been asked. Nothing is closed. **Decided by the owner: an automatic snooze happens when our reply is sent, not when it is drafted or approved.**

- **A layer, not a status.** The fold owns `open` / `awaiting_*` / `resolved` (§ The ticket status follows who acts next), and the categoriser and the investigation claim only `status = 'open'`. A `snoozed` status would have fought the fold and stranded tickets. Instead an open row in `ticket_snoozes` hides the ticket, and the status still says who acts next.
- **The trigger is a message of ours new in the thread** — to the customer: mail that never left the company (`internal_only`, a forward to colleagues, 06) is not part of the case the fold reads, so it neither snoozes nor stales anything; the person forwarding is offered a snooze instead. Our reply is in the thread only once it has gone out: it comes back through Sent Items. That one trigger covers a sent agent draft, a manual reply and a reply typed in Outlook, and no approval or draft in Outlook's Drafts folder can snooze anything. The fold then snoozes when `next_actor` is the customer, a colleague or an operations partner and no check of ours is open (`casework/snooze-rule.mjs`, behind `AGENT_AUTO_SNOOZE`).
- **Waiting is not work.** A check a person must do (`support`) keeps the case in the queue. So does a partner's or colleague's check that a **rule** opened, until someone has written to them about it: « Deret needs asking » is work, « Deret has been asked » is waiting. A cancellation, an address change or a manual refund stays active until the check is done.
- **Edge-triggered, so it never loops.** The rule fires on « we just sent something », never on a case that still reads « waiting ». A ticket its deadline woke is not snoozed again until something new happens. The index on `(ticket_id, trigger_message_id)` holds the same line in the database.
- **A person settling a check is the other edge (decided by the owner, 2026-10-05).** « Mark done » or « No longer needed » re-folds the ticket at once, with the same newest message, so the send alone could never fire again. Now that re-fold may snooze too. It needs our message to be the last one, nothing of ours still owed, and that message's deadline not passed. It snoozes on that message (`trigger_message_id`), so it is still one automatic snooze per message of ours: a case its deadline woke, or a person unsnoozed, is not snoozed again by a later action. Found on `b2789896`: the only thing keeping our sent reply from snoozing was a check of ours opened by mistake, and clearing it by hand left the case in the queue. **The dashboard re-folds with its own environment:** it snoozes only if `AGENT_AUTO_SNOOZE=true` is set on the dashboard too.
- **Every snooze has a deadline** (`wake_at not null`). A partner's snooze ends when its check would turn overdue (`partner_check_overdue_days`), a colleague's likewise (`colleague_check_overdue_days`), and a customer's after `customer_reply_wait_days` working days. The customer delay is new: 3 working days for Qiriness (set 2026-09-30); a shop that leaves it unset never has a case waiting on the customer snoozed automatically. A person picks a time, or a party with the same delay as the deadline. 60 days at most.
- **What wakes a ticket:**
  - a **new** message from anyone but us, at ingestion, whatever the deadline (re-delivery is not arrival, § Re-delivery);
  - the fold, when the case comes back to us (`case_changed`) or ends (`resolved`), on the change only, so « follow up Friday » on a case already ours holds;
  - the deadline sweep, each poll, whatever `--stop-after` says;
  - a person;
  - for a partner's snooze, an order update that changes what a carrier would tell us (a parcel number, a fulfilment or parcel status, a refund, a cancellation). Shopify's parcel status comes from the carrier's tracking, so « delivered » can reach us before any email.
- **A deadline wake costs no model.** It brings no new information: the ticket returns marked « snooze time reached » and a person decides. A wake by mail runs the normal pipeline on that message: Case Manager, investigation, fold, draft. The old draft is never restored; the fold has already staled it once the case moved. Priority is scored at read time, so a woken ticket is ranked on what is true now.
- **An automatic snooze follows the party it waits on (2026-10-03).** `waiting_for` was set once, at the send, and the fold only woke on a move to `support` or `nobody`. So a case snoozed on the customer that the fold then read as waiting on Deret kept `waiting_for = customer`: an order update (which wakes partner snoozes only) left it hidden, its deadline was the customer's, and the Snoozed tab named the wrong party. Now, when `next_actor` moves from one waiting party to another, the fold judges the new party as a fresh snooze would: still only waiting → the open row is **retargeted in place** (`waiting_for`, `wake_at` from that party's delay counted from the fold's latest message, `case_version`); work for us now (a check we owe, a rule-opened request not yet sent, …) or no delay set for that party → woken (`case_changed`); new deadline already passed → woken (`deadline`). In place rather than wake + new row, so the ticket never appears to have come back, and `trigger_message_id` stays, so the one-snooze-per-message index still holds. **A person's snooze is never retargeted**: they chose it.
- **Auto-close skips a snoozed ticket**, so a snooze a person set for five weeks is not closed for silence first.
- **But a closure takes precedence over a snooze (decided by the owner, 2026-10-05).** Closing or resolving a snoozed ticket ends its snooze, with reason `resolved` (`CLOSED_TICKET_STATUSES` in `snooze-record.mjs`):
  - a person closing it in the dashboard (recorded with their id);
  - the fold moving it to `resolved` / `closed`, whether `AGENT_AUTO_SNOOZE` is on or not.

  As a backstop, the deadline sweep ends a due snooze on a closed ticket as `resolved`, never as « snooze time reached ». A closed ticket cannot be snoozed. Its row and page show no snooze chip or banner. Found on `35e0afd9`: it was resolved with a person's snooze still open until 8 Oct, so it would have come back as « snooze time reached », and hidden again if reopened. Auto-close's own rule is unchanged: silence does not close a snoozed ticket. Only an actual closure ends the snooze.
- **Not `--also=fold` on the sync-only worker.** Proposed, then dropped: without the Case Manager reading our reply, the fold reads an unread reply of ours as « nobody owes anything », and the status map would resolve those tickets. Automatic snoozing needs the full pipeline; waking does not.

**Measured before switching it on (dry run, 2026-09-30).** Of 1,008 tickets, 13 end with our reply on a status the fold manages. With a 5-day customer delay, 2 would have snoozed on the customer: `59869d23` and `27aa78bb`, both after we asked for the purchase channel. Only `59869d23` would still be snoozed today. `2aa6604e` (« Produit défectueux ? ») stays: a `product_property` check is ours. The rest are owed by nobody (7) or still have a pass pending (4).

### An automatic reply is nobody (2026-10-05)

**Found live on `35e0afd9`.** Our P-15 reply went out at 10:37:19. The customer's iCloud vacation responder answered at 10:37:30 (« je suis actuellement en congés jusqu'au 19 octobre »), and ingestion filed it as the customer. The ticket reopened, `next_actor` moved to support, both the categoriser and the investigation re-ran on the out-of-office, and the snooze our reply should have set would have been woken by it.

- **Ingestion recognises it** (`ingestion/auto-reply.mjs`, pure), inbound only, headers first: `Auto-Submitted: auto-replied`, `Precedence: auto_reply`, `X-Autoreply`, `X-Autorespond`, `X-Apple-Action: VACATION`. The subject is the fallback (« Auto reply: », « Réponse automatique », « Abwesenheitsnotiz »…). **The header alone was not enough:** measured on that message, iCloud sends no `Auto-Submitted` at all. The matched signal is kept in `raw_graph_payload.autoReply`, so a person can see why a message was set aside.
- **Replies only, never notifications.** `Auto-Submitted: auto-generated` and `Precedence: bulk` also mark machine mail, but that is a Shopify contact form, a carrier update or a newsletter, which open or feed a case.
- **Stored, as the `automated` actor** (migration 73). It stays in the thread a person reads. It is a message actor, never a case actor: not in `ACTORS`, never `last_actor` / `next_actor`, never read by the Case Manager, and not settable from `AGENT_ACTOR_BY_LABEL`, because it is what the message is, not who the sender is.
- **What it no longer does:**
  - raise `needs_categorisation` or reopen the ticket;
  - wake a snooze;
  - count in the fold (it is filtered out before « who spoke last », and a case file or reading keyed to it drops out with it);
  - become the investigation's trigger, the categoriser's latest message or the Case Manager's newest inbound message.
- **History:** `actors:backfill` re-files stored auto-replies without `--recompute`, by subject, because the headers were never kept. On 2026-10-05: 5 of 2,369 messages, all checked by hand (1 customer, 4 colleagues).
- **Known gap:** an auto-reply that opens a NEW thread (answering mail we hold no thread for) still creates a ticket. None seen so far.

### Tickets close themselves after 28 days of silence

Last pass of every poll, so it sees the timestamps that poll just advanced. Without it `status` carried no information at all — every one of the 565 tickets read `open`, including threads last touched seven months ago.

**Level 4 is exempt and that is the whole safety margin**: it means an explicit legal threat, hospitalisation or a life-threatening condition, and there silence is the opposite of resolved. Level 3 closes with everything else. Inactivity is `last_message_at`, which advances on our own replies too, so a thread the team is working stays open while the customer is quiet. Auto-closed rows are stamped `metadata.closed_reason = 'inactivity'` so they stay distinguishable from a hand close.

The 28-day window gives a ticket at least two weeks in the dashboard Backlog before it is retired, while still using `last_message_at` so any new customer or desk activity restarts the clock.

**The level exemption is applied in JS, not SQL.** PostgREST's `not.eq` on a nullable column drops the NULL rows as well, which would have silently spared every uncategorised ticket — the largest group in the table. There is a regression test for exactly that.

**A ticket still flagged `needs_categorisation` is never auto-closed.** The categoriser selects on `status = 'open'`, so closing one that is still queued drops it out of that queue for good and freezes it as uncategorised — only a customer reply could ever label it afterwards. The categoriser drains 25 per poll, so this defers a close by a few polls; getting it wrong is unrecoverable.

**A customer reply reopens a closed ticket**, clearing `closed_at`/`resolved_at` with the status. Inbound only: a ticket does not reopen because *we* sent something. Without this half, auto-close would make the queue tidy and wrong.

### The verdict decides where the ticket waits

`needs_customer_input` → `awaiting_customer`, `needs_human` → `awaiting_human`, and **`answerable` stays `open`**. The map lives beside `REPLY_INTENTS` in `case-file.mjs`, which already owns the verdict vocabulary.

Until 2026-08-14 the verdict reached `metadata.verdict` and the investigation row but never the column the queue is built on — measured, all 214 tickets read `open`, so a ticket waiting on a customer was indistinguishable from one nobody had opened.

`answerable` does not move, and that is the hook drafting will need: it means a reply *could* be written, not that one was sent. Advancing it now would mark work as handled that no customer has received. **The sent reply is what should close it**, which is the second closing path and cannot exist before Phase 5.

Safe to set unconditionally because the selection query already requires `status = 'open'`; a ticket a human closed is never picked up, so this can only move a ticket out of open, never overrule a person.

### Re-delivery is not arrival (2026-08-20)

The reopen rule below is right and stays. What was wrong is **what counted as the customer writing back**: every inbound message the writer processed, whether or not it was new to us.

The message upsert is idempotent; the two state changes beside it were not. So a delta re-enumeration — which legitimately re-delivers mail already stored, and happens whenever the cursor is re-seeded or a poll dies before persisting the `deltaLink` — walked the corpus and undid its own history.

**Measured on the day it happened.** Of 139 tickets auto-closed for inactivity, **136 came back to `open` with `closed_at` nulled**, and the original close dates are unrecoverable. Splitting them by what triggered it:

| Trigger | Tickets |
|---|---|
| A genuinely new inbound message | **10** |
| A message **already in the database**, merely re-delivered | **128** |

The same non-idempotency re-raised `needs_categorisation` on **374 of 400** tickets — a model bill for re-reading conversations nobody had added to — and it cascaded: `shouldAutoClose` refuses a ticket that is still flagged, so the Closed section could not be rebuilt until the whole corpus had been re-categorised.

**The fix is one boolean, and where it does *not* apply is the interesting half.** `knownMessageIds` asks once per page which ids we already hold, and only `needs_categorisation` and the status reopen consult it. Everything else in that branch runs either way, because everything else is idempotent: the first/last message window is a min/max, the subject backfill only fills a null, and the requester backfill is a *repair* — a re-sync is precisely the second chance to learn who wrote in.

**It fails open, deliberately.** A failed lookup yields an empty set, so every message reads as new and the old behaviour returns. Reading an unknown as "already held" would do the opposite: silently drop the reopen for a real customer reply and strand a live ticket in `closed`. Noisy and recoverable beats silent and lost.

**One query per page, not one per message.** A full enumeration is thousands of messages, and a guard against something that only bites on a re-sync must not cost a round trip per email. Chunked at 50 ids because the filter travels in the URL and Graph ids run to ~150 characters. **It was 100 until 2026-09-14, and 100 never worked**: against 400 real ids, 100 failed every attempt while 75 succeeded, because 399 of 400 ids carry `+`, `/` or `=` and each encodes to three characters. Every full page took the fail-open branch, so the guard was off on exactly the re-enumerations it was written for. Nobody saw it because the logger stripped the `message` field carrying the error; it now keeps it as `detail`. Verified after the change: all 400 ids looked up, 329 found.

### Any non-open status returns to open on an inbound reply — not just the terminal two

This reverses the earlier rule that only `closed`/`resolved` were rewritten, on the grounds that the worker's other states were its own. That was right while nothing ever set them, and became a trap the moment the verdict did.

**Both the categoriser and the investigation runner select on `status = 'open'`.** A ticket parked `awaiting_customer` would never be re-read once the customer answered the question we asked: the reply lands, the pipeline ignores it, and the queue looks clean because the work disappeared. Stranded silently, for ever.

### Work handed to a person is never auto-closed

`awaiting_human` is exempt whatever the level. Silence there does not mean the conversation resolved itself; it means nobody did the work, and closing it after four weeks files a service failure as a completed ticket — the queue then looks healthy precisely because the backlog was deleted.

This distinction could not be drawn when auto-close was written: the investigation set no status, so `level` was the only signal and level 3 was made closable on queue-hygiene grounds. Measured before the change, **67 level-3 tickets** would have closed that way.

The cost is counted rather than hidden: `runAutoClose` reports `awaitingHuman` separately from `exempt`, because level-4s being spared is the rule working while unactioned work piling up is the thing to look at. Emptying `AUTO_CLOSE_EXEMPT_STATUSES` restores the old behaviour in one line.

### A customer's thanks closes the ticket only when nobody owes anything (2026-09-25)

**Decided by the business:** when a customer thanks us and there is no pending action on **either** side — nothing we are waiting for from them, nothing a colleague, the 3PL or the carrier still owes — the ticket may close. If any action is still unresolved, it is closed by a person, never automatically.

**Either side is the load-bearing word.** `closureAllowed` already refuses a case file with `missing` or a handoff, but the case file is written once per investigation and goes stale: `d6d0d1c3` still read "mask missing" after the replacement had been sent. The rule needs the pending list kept current as messages arrive — the customer's questions (`pending_customer_inputs`, which exists) and the checks owed by our side (which does not exist yet). Until the second list exists, an automatic close can only be as good as the case file.

**Labelled first, 2026-09-25.** On the first batch of the multi-turn set (`eval/casework-cases.mjs`), a thanks after we had answered and closed was labelled « no reply » three times (`b781cfba`, `1d38908b`, `d6d0d1c3`); today's pipeline writes a closing reply on all three. A thanks that arrives while we were still asking (`cffa55ff`) or on a complaint (`9454eaa2`) was labelled a short closing reply.
