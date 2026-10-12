<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Deduplication

### There are two problems, and only one of them is duplicate emails

Measured on the corpus (2026-08-19):

| | |
|---|---|
| Inbound messages | 296, **all** carrying an `internet_message_id` |
| Same Message-ID in two tickets | **0** |
| Identical body across tickets | 12 clusters |
| Consecutive ticket pairs from one sender within 30 days | **72** (48 sharing a category) |
| …beyond 30 days | **0** |

**A true double-post exists and is rare.** Bavita NOBIN: same sender, identical body, **one second apart**, different Message-IDs and different Graph conversation ids — a form or mail-system double-submit.

**A split conversation is the common shape and does more damage.** A customer writes through the contact form, then replies to our answer by email, and the reply arrives under a different `conversationId` — so one conversation becomes two tickets, gets investigated twice, and would be answered twice.

**Message-ID does not detect either.** It is fully populated and collides zero times, because a double-post gets two Message-IDs and a split thread is genuinely two emails. Deduplication keyed on it would look rigorous and catch nothing.

### The reply chain is captured before any detection is built

`In-Reply-To` and `References` are how every mail client threads, and they point at `internet_message_id` values already stored — the deterministic link between the two halves of a split thread, with no similarity and no model. Graph has no `inReplyTo` property, so the only route is `internetMessageHeaders`.

**Measured cost, because it is not free**: the header set is ~**10 KB per message** in transit and Graph returns 51–68 headers each. Ongoing that is 10 KB per *new* email rather than per stored one, which a support mailbox will not notice; the one-off full enumeration is the expensive moment. **46% of stored inbound messages have a reply-style subject**, so the chain will be present often enough to be worth the bytes.

**Only two headers are ever stored.** The rest is `Received` chains carrying relay IPs and hostnames — personal data with no use here, and a test asserts it never reaches `raw_graph_payload`.

**Capture precedes detection deliberately.** A header not requested at ingestion cannot be recovered later without re-reading the mailbox — and the mailbox question makes that unavailable. Same argument as `auto_send_eligible` and the draft edit log.

### Detection: two deterministic rules, and one deliberately left out

**No model, no embedding, no similarity.** A hit means a ticket is skipped by the drafting queue, and a customer who is wrongly skipped receives no reply at all. Nothing that guesses is allowed to cause that.

**Rule 1 — the reply chain**, tried first because it is the strongest evidence available. `In-Reply-To` and `References` name Message-IDs we already store: a match is not a resemblance, it is the sending client stating which conversation this belongs to. No time window applies — a reply a fortnight later is still the same conversation.

**Rule 2 — the double-post.** Identical text from one sender within an hour. **The window is the whole rule**: the same text three days later is a customer chasing us, which is owed an apology rather than silence. An hour is far wider than the real cases (one second, and thirty-two seconds) and far narrower than any plausible chase.

**What is deliberately not a rule: sender plus quoted order number.** It looks like a third rule and is not safe as one — a customer may legitimately open a delivery ticket and then a refund ticket about a single order, and linking those would silence the second. It stays out until something measures how often that shape is a duplicate rather than a sequel.

**Replayed over the whole corpus before being trusted**: 203 ticket-opening messages against the live candidate pool produced **2 links, both `identical_body`, both verified by hand as genuine double-posts** — Bavita NOBIN one second apart, Christine Alexandre thirty-two seconds apart. Zero false positives. Zero `reply_chain` hits, which is expected and not a failure: the stored corpus predates header capture, so that rule can only fire on mail arriving from now on.

**Detection never fails ingestion.** A missed link costs a second reply somebody has to notice; a failed ingestion loses the email. The first is recoverable and the second is not, so the check is wrapped and logged.

### Semantic matching was measured and NOT built, and the reason is not cost

Phase C was a measurement, not a build: every ticket message is already embedded, so the whole candidate pool could be scored with `<=>` before writing any detection. 124 sender pairs inside 30 days were scored. The result kills the tier as designed.

**The false positives score HIGHER than the true positives.**

| | Cosine similarity |
|---|---|
| Genuine split conversations (contact form + emailed reply) | 0.795 · 0.893 · 0.928 |
| B2B reorder POs — separate weekly transactions | 0.996 – 0.998 |
| Partner "commandes en retard" reports — separate reports | 0.996 |

A threshold at 0.95 catches none of the real ones and all thirteen B2B POs. A threshold low enough to catch the real ones sweeps in everything above it. There is no threshold, because **embeddings measure wording and duplication is about identity**: a split conversation is one person writing *different* text twice, while a repeated business process is *different* transactions in identical wording.

**And the dangerous confusion is not B2B — it is a chase.** Of the pairs inside 30 days, **12 have byte-identical text and only 2 of them are duplicates**:

| | |
|---|---|
| Identical text, within the hour → linked as a duplicate | **2** |
| Identical text, hours or days later → a **chase** | **10** |

An embedding scores all twelve at ~1.0. The only thing that separates them is elapsed time — and they need **opposite** treatment: a duplicate must be suppressed, a chase must be answered *with an apology for the delay* (see the drafting rules). A similarity-linked tier would have silenced ten customers who were already waiting and had written again, which is the worst failure this system could produce.

**So the hour-long window is not a tuning parameter, it is the entire discrimination.** Phase B's rule is right for a reason the embeddings made visible rather than despite them.

**What still catches split conversations is the reply chain**, deterministically, and it cannot be evaluated on this corpus because the headers predate their capture. That is a reason to wait for data, not a reason to reach for similarity.

**If a semantic tier is ever revisited, it must surface rather than link.** Showing a reviewer "this looks related to ticket X" carries no suppression risk; deciding for them does.

### The semantic tier, revisited (2026-08-19) — and what changed the answer

It was revisited, and the conclusion above held in substance while being wrong about the reason. Two findings moved it.

**Excluding business senders makes a threshold exist.** The earlier measurement mixed consumers and B2B into one distribution, where no threshold worked. Split them and the consumer band is clean: at **0.90**, 25 same-sender cross-ticket pairs inside 30 days, and inspection finds no pair that is not genuinely the same conversation. The cross-category risk that was cited as the objection — a delivery ticket followed by a refund ticket about one order — produces **5 pairs above 0.80**, and every one is the same message categorised differently, not a sequel being wrongly merged.

**But same-sender scoping is exactly what does *not* save you from B2B**, because it is the same sender by construction. Nocibé's weekly purchase-order template scores **0.9945–0.9981** against its own past orders — *above* every genuine consumer match except byte-identical text. The false positives sit above the true ones, so no threshold can separate them. The sender has to.

**`sender_directory` is the filter, and category is not.** The categoriser labels by *subject*, correctly, so Nocibé's mail lands under `b2b`, `order` and `delivery` alike — and the single worst false positive in the corpus (0.9957, two different lists of late orders) wears `delivery`. Filtering on category catches **13 of 14**; filtering on directory membership catches **14 of 14**. An address absent from the directory is a consumer, which is the definition this codebase already uses.

**What a match means is not "duplicate".** At 0.90, **18 of 25 pairs are more than an hour apart and 14 had already been replied to** — they are chases and continuing threads. One customer's message recurs across five tickets spanning 24 days, every one answered. Suppressing on a semantic match would go silent on people we are actively in dialogue with.

So the tier ships with **two outputs and neither is silence**:

| | |
|---|---|
| `related_ticket_id` + `related_score` | thread context in the dialog, and the earlier thread merged into chase detection |
| the **cross-ticket chase** | `describesChase` reads one thread, so a customer who writes again under a new conversation id looked like a first contact. Merging the related ticket's envelopes makes the existing rule see the conversation the customer thinks they are having |

Suppression stays deterministic — reply-chain header, or identical text inside the hour. Nothing that guesses causes silence. That asymmetry is the whole licence for a similarity score here: **a wrong duplicate link costs a customer their answer; a wrong related link costs an unnecessary apology and a line in the dialog.** Only the second is safe to decide from an embedding.

`MIN_RELATED_GAP_MS` is one hour, and it is a handoff rather than a tuning knob: under it, `duplicate-rules` owns the decision.

On the corpus the backfill linked **9 tickets, 2 of them unanswered chases** (a ticket links to at most one earlier ticket, so this is narrower than the 25 pairwise matches).

### A sender in the directory is never spam

Four emails from addresses already recorded in `sender_directory` had been dropped by the spam gates:

| sender | label | dropped by |
|---|---|---|
| `EARGENTO@nocibe.fr` | retailer | the LLM, as an "automatic notification" — it was a routing-address change |
| `dnouali@lap-groupe.com` ×2 | internal | the LLM — a colleague forwarding a customer's message in |
| `patrick@dopweb.com` | contractor | an explicit blocklist rule |

**The directory is an assertion, not a hint.** Somebody sat down and recorded that this domain is our 3PL, our agency, a retailer we sell through. A pattern rule or a model overruling that turns configuration into a suggestion — and it fails silently, because dropped mail never becomes a ticket and its only trace is a `spam_audit` row nobody reads.

`exemptKnownSenders` wraps **both** gates, because both got it wrong in different ways — one a pattern, one a model. Wrapping rather than teaching each gate is deliberate: the directory is loaded per poll, and a rule that lives in two places can be half-applied. The LLM call is **skipped, not overruled**: deciding after the model has answered pays for a judgement we were always going to discard.

**It can only ever keep mail.** An unlisted sender is left to the gates untouched, so no email that would have been kept can now be blocked.

**One deliberate conflict this creates.** `patrick@dopweb.com` is both an active blocklist rule and a directory contractor. The directory now wins and that rule stops firing — someone expressed both intents, and this decides which one governs. The other 15 blocklist rules are unaffected.

**Sephora was a different problem with the same symptom.** Four emails from `sephora.fr` about EU regulation compliance were dropped, and `sephora.fr` is *not in the directory* — so nothing here would have saved them. The fix for those is a directory row; this change is what makes the row stick.

### The 3PL is our own side; a courier is not

`OWN_SIDE_LABELS` gains `logistics`. It looks arbitrary beside `courier` staying out, and it is not: the 3PL runs the warehouse, so their threads are the back office working a customer's return — the same shape as a colleague's, and a reply opening « Bonjour Madame » would be as wrong to them as to a colleague. A courier is a third party we may genuinely need to write to *as their customer*. A retailer stays out entirely because Nocibé's purchase orders are real demand.

**Zero tickets move today** — no thread in the corpus was opened by Deret, only replied to by them. This is forward-looking, and the `sender_label` check constraint already accepted the whole directory vocabulary, so no migration was needed.

### The contact-form parse had to be gated on the ENVELOPE, not the body

Chasing why a ticket showing requester "Julie Lemaire" was labelled `internal` found a bug much larger than the label.

`mapGraphMessage` swapped a message's sender and body for the customer named in the body whenever that body parsed as a Shopify contact-form notification. Correct for the notification — it is *from* Shopify and *about* a customer — and wrong for everything that quotes one, which is every reply and every forward. **"The body looks like a form" is not evidence that this message IS one. Only the envelope is.**

Measured across 148 parsed messages:

| | |
|---|---|
| genuinely from `mailer@shopify.com` — swap correct | **96** |
| our own replies quoting one | **88** *(fixed earlier in this session by the direction gate)* |
| colleagues, the 3PL and the web agency replying | **32** — identity *and* body wrong |
| the customer replying to their own thread | **20** — identity fine, body replaced by a copy of their first message |

The direction gate added earlier fixed only the first of those three. A colleague writing in is inbound, so 52 inbound messages stayed broken. `isNotificationSender` now gates the whole parse; a genuine notification is unaffected.

**The 20 quiet ones were the most damaging.** A customer's follow-up stored as a byte-identical copy of their first message *manufactures duplicates out of nothing* — and duplicate detection is built on identical bodies. On repaired data the cross-ticket identical-body pairs fall from **19 to 2**, and both survivors are inside the hour and were already linked. Every "identical text, days apart" pair — the entire evidence base for the chase-versus-duplicate table above — was this bug.

**So the hour window is still right and the argument for it was wrong.** It was defended as the discrimination between a double-post and a chase, on ten chases that did not exist. What the corpus actually shows is that identical bodies beyond an hour do not occur at all.

**Six of nine related links did not survive.** Embeddings computed from corrupted text scored a customer's first message against a copy of itself. After re-embedding 140 messages the links fall to 3. `run-related-backfill` was therefore made to **reconcile** rather than append, and `clearRelated` exists for that — deliberately with no equivalent for `sender_label` (who wrote does not stop being true) or `duplicate_of_ticket_id` (it suppresses a reply and a person may already have reviewed it).

**And of the 27 stale requesters, only 11 were defects.** The first count treated every ticket whose requester differs from its opening sender as broken. Measuring the consequence showed the opposite: rewriting all 27 would have made **7 tickets lose an order match**, because those are internal escalations *about* a customer — a colleague opens a thread to chase order #6045 for Julie Lemaire, `sender_label` records who wrote and `requester_email_hash` records whose order it is. Both columns are right, and they answer different questions.

The genuine defect is the mirror image: **a colleague's identity on a thread a customer is also on** — `Taha LAMZOUKI` as the requester of a Nocibé enquiry. Nothing joins and the queue names the wrong person. Eleven tickets, repaired by `npm run requester:repair`: **1 gained an order match, 0 lost one.**

So `requesterFor` rewrites only when the stored identity is *provably ours* and the thread has an external sender to replace it with. A requester that is already external is either correct or is the customer an internal thread is about, and nothing here can tell those apart — so it touches neither. `setRequester` exists for that tool alone; **ingestion is unchanged and the write-once rule stands**, because a requester that shifted while somebody was reading the queue would be worse than one that is occasionally stale.

### A colleague is not a customer

Fourteen tickets were opened by an address at `lap-groupe.com` — colleagues forwarding a customer's problem in, or instructing each other. They were categorised as ordinary customer work (`return_exchange` ×8, `delivery` ×3, `order` ×2, `account`), investigated, and drafted to. One of the drafts answers *"merci de procéder à sa réexpédition et de me communiquer le numéro de suivi"* — a work instruction from one colleague to another — with "Bonjour Léa, Je vous remercie pour votre message. Je m'excuse pour le délai… Je transmets votre demande à l'équipe concernée." It apologises to a colleague and promises to forward their own instruction to the team, addressed to the wrong name.

**`sender_label` is a third axis, not a subject.** `internal` was not added to `SUBJECTS`: that axis is *what the email is about*, it is shared with the knowledge library, and a colleague's email about a return is still about a return. Who wrote it is a different question, and the answer already existed in `sender_directory` — it simply was not stored on the ticket.

**The opening message decides, and the decision is never revisited.** A thread a colleague started does not become a customer's because a customer is cc'd onto message four. Graph's delta is not chronological, so "opening" is the earliest inbound by `received_at`, not whichever arrived first.

**Deterministic, at creation, from the address.** No model is asked, for the same reason the investigation reads the directory rather than calling a tool: who wrote to us is a fact we hold before any pass runs.

**Only the labels that mean "us".** `OWN_SIDE_LABELS` is `internal` + `contractor`, deliberately narrower than `NON_DEMAND_LABELS` (which adds `logistics` and `courier`). The two answer different questions: that one is "is this customer demand for the clustering report", this one is "would a customer-voice reply addressed to this person be absurd". A courier is a third party we might genuinely need to write to; a retailer's B2B order is real demand and marking it non-customer would hide a class of work.

**Drafting stops, investigation does not.** A colleague chasing a real order still needs the order facts gathered for whoever picks it up — the thing that is never right is the drafted customer email. `draftDecision` returns `internal_sender`; `isInvestigable` is untouched.

**The column is for the agent; the dashboard already knew.** `TicketListItem.senderLabel` has always been derived at read time from `ticket_first_inbound.from_email`, and the list already renders a chip. Nothing was added there. What was missing is that the *worker* had no way to branch on it without re-deriving a fact, and that a stored label is a historical one: relabelling the directory tomorrow does not rewrite what a thread was when it arrived (which is why the backfill exists).

**`sender_label` sits last in `ticket_queue`, against taste.** `create or replace view` can only APPEND columns — placing it beside `duplicate_reason`, where it belongs, fails with *cannot change name of view column*. Last is what lets the view be replaced inside a transaction rather than dropped and recreated, which on a live database is the difference between a forward step and an outage.

**Three drafts already written are left in place.** They are not deleted; the review UI is where a person rejects them. Deleting rows to clean up a rule change is how the drafting runner's `--redraft` flag came to exist, and it is not a thing this codebase does silently.

### The duplicate backfill found nothing, and that is the result

`npm run duplicate:backfill` exists and links zero tickets on this corpus. The corpus is already complete under the rule, and the reason is worth writing down because it corrects an easy miscount.

Six within-hour cross-ticket identical-body **message pairs** exist. Only **two** of them are pairs in which the duplicating message *opens* its ticket — and both are already linked. In the other four the identical text is a later message inside a thread that already existed, which is a customer re-sending into an open conversation, not a second ticket for one email. Counting message pairs overstates the backlog threefold; the rule only ever fires on the message that creates a ticket.

**The reply-chain rule cannot contribute here at all.** Of 315 stored inbound messages, **1 carries `in_reply_to` and 2 carry `reference_ids`** — the headers postdate most of the corpus. The rule is live for new mail and untestable on old.

**The tool is kept as a verification instrument**, not dead code: "is the corpus clean under the current rule" is a recurring question and this answers it in one command. It also encodes a hazard the ingestion path does not have — see the order-independence test in `duplicate-rules.test.mjs`. At ingestion the candidate is by construction the newer message, so `findDuplicate` compares *absolute* elapsed time and is immune to Graph delivering a delta page out of order. A replay over stored history has no such guarantee, so the backfill filters its pool to strictly-earlier messages; without that it would link the older ticket to the newer and suppress the original instead of the copy.

### When detection is built: link, never merge

A wrong merge is unrecoverable and a wrong link is a column. The harm being prevented is that one customer receives two replies, so the minimum fix is that a ticket linked as a duplicate is skipped by the drafting queue — both threads intact, a person deciding.

The candidate pool is **sender hash**, not `customer_id`: 145 of 214 tickets carry a customer and 203 carry a hash, and gating on the customer would miss **24%** of the pairs. Thirty days is the window because nothing falls outside it. And closed tickets must stay in the pool — **51 of the 72** prior tickets are already closed or resolved, because auto-close retires a thread after 28 days of silence.
