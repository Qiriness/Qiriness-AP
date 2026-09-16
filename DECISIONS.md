# DECISIONS

Why the system is shaped the way it is. **`APP_SCHEMA.md` says where things are; this says why they are like that.**

Read a section here **before changing the thing it describes** — most entries record a measurement against real mail or a failure mode that was hit and fixed, so re-deriving them from the code alone tends to reproduce the bug. Nothing here is needed to *find* code; if you only need to navigate, `APP_SCHEMA.md` is enough and this file can stay closed.

Sections match the headings in `APP_SCHEMA.md`.

---

## Taxonomy

**One vocabulary, two consumers** (`scripts/lib/support-taxonomy.mjs`).

**Subjects** (14) are shared by `knowledge_documents.category` and `tickets.category`, so a ticket's subject filters straight into matching knowledge chunks with no mapping. `faq` + `brand_story` are knowledge-only — an article is reference material; nobody emails "an FAQ".

**Request kinds** (question/problem/complaint/contact) are tickets-only and stored **separately** from the subject — never composed into one value like `order_problem`, which would need stripping for every knowledge lookup and would make the categoriser pick 1-of-23 instead of 1-of-14 plus 1-of-4. `complaint` is a kind, not a subject, so a delivery complaint is (delivery, complaint). Both axes are constrained in the database.

**Level is derived** from the pair, never assigned independently. Subjects whose answers live in the database (order, delivery, payment, account, product_stock, promotions) floor at **2 for both questions and problems** — measured against human labelling on real mail, most "problems" there are answered by looking something up, and flooring them at 3 made a third of the review set impossible to agree with. Other questions 1, other problems/complaints 3, `contact` 2, plus one override: `cosmetovigilance` + `problem` → 2 (natural formulations, so a reported reaction is a mild allergy, answerable with advice). The categoriser escalates to 3 itself when the fix requires *changing* something.

The module also holds the per-ticket **signal** vocabularies (`CONFIDENCE_LEVELS`, `REPLY_LANGUAGES`, `HAPPINESS_SCORES`) and `ratchetLevel`, for the same reason as the rest: one list per vocabulary, shared by the model's response schema, the database check constraint and its test.

### Level 4 is a severity judgement, not a subject

No `(subject, kind)` pair derives it. It arrives only as a categoriser escalation read from the email text, and should be very rare. **Two triggers, narrowed 2026-08-14:**

- an explicit **legal** threat — court action, a complaint, a lawyer, a formal notice;
- **grave harm to the person** — hospitalisation, or a life-threatening condition.

**A threat to go to the press or post on social media is no longer one of them.** It was, and it does not fit either half of what level 4 is for: it is neither a legal exposure nor an injury, it is a very unhappy customer — which `happiness` already measures on its own axis. Conflating the two would put reputational annoyance in the same queue as hospitalisation, and the queue exists to separate them.

The model must name the trigger that fired in its `reason`. A subject-implied 4 would make the level mean *this topic* rather than *this is serious*, filling the manager queue with routine mail.

The narrowing costs nothing retroactively — **no ticket in the corpus has ever been labelled level 4** — but it is not cosmetic going forward: level 4 strips every tool, and is the one status auto-close will never touch.

### Level never falls

A ticket's `level` is never below `defaultLevel(category, request_kind)` — including the *secondary* pair's floor, so an order question that also asks for a return is level 3. The model can only escalate, and an unusable answer falls back to a kind that raises the floor (`problem`), never one that lowers it.

It never falls **across** re-categorisations either (`ratchetLevel`). A thread is re-read blind whenever the customer replies, so without the ratchet a polite follow-up could silently drop a level 3 back to 2 and take a promised refund out of the human queue. Levels only climb; a human closing the ticket is what ends it. The model's un-ratcheted answer is kept in `metadata.categorisation.proposed_level` so the clamp stays visible.

### `happiness` and `level` are independent, deliberately

`level` is what *work* a ticket needs; `happiness` is how the customer *feels*. An angry customer asking where their parcel is stays level 2 with happiness 4; a cheerful refund request is level 3 with happiness 1. Nothing derives one from the other — a mood-implied level would repeat exactly the mistake the level-4 rule was rewritten to fix, and refill the manager queue with routine mail. Happiness reaches Phase 5 as drafting tone, not as routing.

---

## Ingestion

### `--limit=N` means the newest N, and it is asked for (2026-09-14)

A limited initial delta read adds `$orderby=receivedDateTime desc`. Graph already enumerated this inbox newest-first without it — measured before the from-scratch re-ingestion, the first 400 messages came back in order (2026-09-13 back to 2026-07-10, no inversions) with and without the sort — but that is an observed default, and "re-run the latest 400" should not rest on one. **Unlimited reads are untouched**, because their `deltaLink` becomes the stored cursor, and a limited run never persists one (`delta-poller.mjs`).

**Read newest first, written oldest first.** Every ingestion rule that fires on the message that *creates* a ticket — `sender_label`, the requester, the duplicate link — assumes that message opened the thread. The first limited run wrote in read order, so each thread's ticket was created from its latest message. Measured on that 400-message re-ingestion: **15** staff threads unlabelled, **7** tickets with a colleague as requester (**2** then linked to the wrong customer, which no pass can undo), **4** duplicates and **5** related links missed. So under `--limit` the poller now collects the newest N across pages and writes them in `receivedDateTime` order (`oldestFirst`). Buffering is bounded by the limit. **An unlimited full re-enumeration still writes page by page in Graph's order** and so still carries this risk; sorting it would mean holding the whole mailbox in memory, and it is left open rather than half-fixed.

### A Shopify sync never writes `sync_cursors` (2026-09-11)

`mapShop` returned `sync_cursors: {}` and `app_settings: {}`, and every Shopify sync upserts the shop — so **every sync wiped the mail delta link**, and the next mail poll re-enumerated the whole mailbox. Found while building the Insights freshness strip: `shops.sync_cursors` read `{}` on a shop whose worker had run many times. It is the likely cause of the mail window moving back on re-enumeration, and with the nightly sync now scheduled it would have happened every night.

Both columns are ours, not Shopify's, and both have a `'{}'` default for a first insert, so the mapper now omits them — the same arrangement as `order_retention_mode`, which it already left alone. `shopify-shop-mapper.test.mjs` pins it. The re-delivery rule (below) is what kept the wiped cursor from corrupting tickets; it did not stop the cost of re-reading.

### Direction: the Inbox is not only inbound

The team's replies land back in it. A message whose sender is the support mailbox is recorded `outbound`. Measured on real mail, 123 of 348 messages; before this they were stored as customer mail and sat at the end of 43% of threads, exactly where the categoriser looks for how the customer currently feels.

### Identity: a contact-form notification is *about* a customer but *from* Shopify

`contact-form.mjs` parses the labelled body fields (`Name`, `E-mail`, `Indicatif de pays`, `Phone`, `Corps`) and those replace the envelope; `body_text` becomes the customer's own text. Without it 95 tickets shared 2 requester hashes, so `requester_email_hash` — the join key to `orders.customer_email_hash` — was unusable for half the inbox. The parser returns null on an unrecognised template, so a reworded form degrades to the envelope rather than to a wrong customer. It already understands the planned `Catégorie` / `Numéro de commande` dropdown fields, which land in `raw_graph_payload.contactForm` until the Shopify form ships them.

### `first_message_at` tracks the true earliest message

It moves backwards as well as forwards. Graph's delta is not chronological, so on an initial enumeration a thread is routinely opened by one of its later replies; "the first message we saw" was late on 93 of 171 tickets, by 5 days on average and 24 at worst — and the categoriser queue is ordered on this column.

### Only inbound messages are ever classified

The spam gate skips outbound (blocking the support address would drop every reply the team sent), and the categoriser reads `findInboundMessages` only — spending a model call on text Qiriness wrote would make `happiness` measure our own tone.

A thread holding *only* our replies is therefore unclassifiable: it is skipped **and taken out of the pending queue**, because ingestion re-raises `needs_categorisation` the moment a customer message arrives. Leaving it pending instead parks it at the front of an oldest-first batch permanently — measured on real mail, 11 such tickets took 11 of every 25 slots on every pass.

---

## Spam gate

### Gate 2 drops `irrelevant`, not just `spam`

`irrelevant` was previously labelled and then kept anyway, which made the label decorative — automated notices, FYI forwards of a provider's mail and test messages all became tickets a human had to close.

The prompt is explicit that internal mail *about a customer* is customer work: measured on this mailbox 17 of 20 purely internal threads were relances, tracking numbers and refund decisions, and dropping them would have destroyed live level-3 cases. Replies into existing tickets are never triaged, and the gate **fails open** on any error or missing key.

### Spam never becomes a ticket — but the trace now includes the body

Both gates drop mail before the first insert, so `spam_audit` is the only trace of a dropped email and is what makes a wrong drop reviewable at all.

The original rule was "sender and subject, never the body". **That was reversed**: the one question a reviewer has is *should this have become a ticket?*, and a subject line does not answer it — "Votre commande" is a newsletter or a customer whose parcel is lost, and the corpus contains both. The row was reviewable in principle and not in practice.

Two rules keep it proportionate:

- **The body is kept only on a `blocked` outcome.** A kept email is written to `ticket_messages` in full a moment later; copying it here would duplicate personal data into a second table with a second retention clock.
- **The body has its own expiry.** `body_expires_at` is nulled by the worker's per-poll purge while the decision row is kept indefinitely — bounded review window, unbounded audit trail. The purge is a PATCH, never a DELETE: destroying the row would destroy the trace that a drop happened at all.

`buildBodyPatch` is the single owner of the cap and the clock, so live ingestion and the Graph backfill cannot diverge. The backfill selects on `body_captured_at is null` rather than `body_text is null` — keying on the text would make it silently undo the retention purge on every run.

**No gate ever promotes one back, but a person may.** The heading still holds of the pipeline — nothing automatic turns a drop into a ticket — and the dashboard's "Add as ticket" is the deliberate human override, which the stored body is what made possible. See § Add as ticket writes, and it writes through ingestion.

### Who a sender is lives in a table, not in an env var

`sender_directory` maps an email address or domain to a label — internal, contractor, logistics, courier, retailer, distributor, supplier, partner, other. It replaces `INTERNAL_EMAIL_DOMAINS` for the demand report, and the reason is a measured failure rather than a preference.

**Config did not survive a project move.** Switching to a new Supabase project carried the data across and left the env file behind, so `lap-groupe.com` — our own second domain, and the second-largest sender in the inbox at 43 inbound messages — was counted as customer demand. The clustering report that decides which knowledge article to write next ranked an internal reorder thread sixth, and `return_exchange` was half internal ops coordination. Who we work with is a business fact; it belongs with the business data, where it travels.

**A boolean could not express the corpus anyway.** Nocibé sends 10 of the 13 `b2b` messages and every one is a real request. Marking it internal hides real work; leaving it unmarked pollutes the consumer writing order. So `NON_DEMAND_LABELS` is `internal, contractor, logistics, courier` — retailers, distributors, suppliers and partners stay *in* the demand set, as B2B demand that a consumer FAQ does not answer.

**Labels are context, not behaviour.** Exactly one pass branches on them, and it is a report rather than a customer outcome. Everywhere else the label is read *to* the investigation, never *by* it: it lands in the case file deterministically before the model is asked anything, because the sender is already in hand and a tool call would spend a round trip — and a slot of the six-call budget — on a question that was already answered. Nothing here may ever gate a reply.

**The address never reaches a prompt.** A matched *domain* is named, because "un revendeur (nocibe.fr)" is the useful half and a company domain is a business fact. A matched *address* is not: the label is stated and the address withheld, since the case file is stored and re-read.

The table shares `email_blocklist`'s shape and its matcher (`scripts/lib/sender-patterns.mjs`) — exact address before domain, subdomains belonging to their parent. Two copies of that rule would have drifted silently. Rows are exceptions: an unlisted sender is an ordinary consumer, so this stays a dozen rows a person maintains rather than a directory of every address.

### A mailbox-id mismatch is a configuration answer, not missing mail

Exchange item ids are mailbox-scoped. `getMessage` separates `ErrorItemNotFound` (that email is gone — permanent, per row) from `ErrorInvalidMailboxItemId` (the id was never valid for *this* mailbox, so every row fails identically, kept mail included). The backfill stops at the first mismatch rather than reporting hundreds of rows as unrecoverable and sending an operator to fix the wrong thing for ever.

---

## Categorisation

Runs after ingestion in the same poll, as a separate batch pass selecting on the pending flag rather than on what the poll just wrote — so anything missed by a crash or a key-less run is caught up automatically.

`categorise.mjs` is classification-only (no tools, no DB) and sends subject + first/latest inbound body — never the sender's address or name. A failure leaves the ticket pending and counts the attempt in `metadata.categorisation`; after 3 it is written as (other, problem) → level 3, team contact, flagged `failed`, so it lands in front of a human instead of retrying forever — unless the ticket already had labels, in which case those are kept and only marked low-confidence.

### Re-categorisation is blind

A ticket's labels describe the conversation so far, not the email that opened it, so ingestion re-raises `needs_categorisation` whenever a new **inbound** message joins a thread (never on our own outbound replies, which also move `last_message_at`).

The re-run never shows the model its previous answer, which would only make it defend a first call that may have been wrong. Stability comes from the ratchet instead. Superseded labels are kept in `metadata.categorisation.history` (newest first, capped at 5) so a ticket shows its trajectory.

### `needs_categorisation` is a boolean, not a timestamp comparison

PostgREST cannot compare two columns, and our own outbound replies also move `last_message_at`.

### Backlog `--limit` is shared with categorisation

The daemon keeps categorisation at its normal 25-ticket batch when no CLI limit is supplied. A staged backlog run is different: `npm run ingest:once -- --limit=500 --stop-after=categorise` is meant to build a review corpus in one deliberate pass. If `--limit` capped only Graph ingestion, that command would store hundreds of messages but label only 25 tickets, and the next step would look like the knowledge gaps were measured against the whole batch when they were not.

### The categoriser is never asked how confident it is

It was, and answered `high` on 171 of 171 live tickets and 40 of 40 review cases — Structured Outputs emits fields in order, so the model rated an answer it had already committed to in the same forward pass, with nothing pushing it toward calibration. A constant field carries no information, and a constant field *called confidence* invites the wrong decision downstream.

`tickets.categorisation_confidence` survives as a **known-untrustworthy marker**: only `low` is written, only by the failure paths (retries exhausted, or stale labels after a failed re-categorisation), and a clean categorisation clears it to NULL. Until a calibrated signal exists (sampling for agreement, or token logprobs), Phase 5 should gate auto-drafting on `level` and `happiness` instead — on this mailbox, level 1 alone is 17 of 160 tickets and every one of them is calm.

### Measured, not assumed

Two review sets. **Synthetic** (`agent/eval/categorisation-cases.mjs`): 40 dummy emails, ~38–39/40 on all three axes — guards against regressions only. **Real** (`categorisation_review`): 30 hand-labelled emails from the live mailbox — subject 77%, kind 90%, level 73%.

The real set is what drives the rules. The boundary definitions in the prompt (dispatch splits order/delivery; `complaint` only without an actionable request; `contact` only for a first approach; L3 = something must change) and the level floors all come from measured disagreements with human labelling, not from intuition.

---

## Customer resolution

Runs as soon as the mail is stored and **before every LLM pass**: identity is what a ticket has from its first message, so it waits on nothing — no category, no order number, no OpenAI key. It calls the CRM lookup with `tickets.requester_email_hash` and writes `tickets.customer_id`, which was previously only ever set as a by-product of a confirmed order number — leaving every account question, pre-sales enquiry and contact-form message permanently unlinked.

**The hash it keys on is the address the customer typed**, because ingestion already replaced the contact form's `mailer@shopify.com` envelope with the form's own `E-mail` field. Nothing here re-derives identity from the envelope.

Three rules make it safe to run every minute:

1. A small denylist of **notification senders** (Shopify's mailers, plus the support mailbox) is refused outright and never retried — a contact-form body that fails to parse leaves one of those as the requester, and linking them would give every such ticket the same wrong customer.
2. A `no_match` is a real answer that is nonetheless **re-asked once a day**: customers arrive from the nightly sync, and today's stranger is next week's buyer.
3. Every outcome, match or not, is recorded in `metadata.customer_resolution` with the hash it was tried against — so a re-parse or a backfilled requester re-opens the question immediately while an unchanged one stays quiet.

The lookup's process-wide hash index is dropped once per pass that has work, so a customer synced since startup is visible.

### `customer_id` has two writers and one meaning

The customer-resolution pass links it from the requester's own address on any ticket; order-context links it from a confirmed order. The second never overwrites a value already there, and both are keyed on the same requester hash, so they agree by construction.

---

## Order resolution

`shopify_order_number` is written **only** by a confirmed resolution, and there are two ways to reach one: the order's `customer_email_hash` equals the ticket's `requester_email_hash` (`verified_by: email`), or it appears among the addresses in the customer's own message (`verified_by: message_email`, below). A name-only agreement, or an order belonging to someone else, is recorded in `metadata.order_resolution` and left off the column.

The parser recognises `#NNNN` / "commande n° NNNN" only, and classifies the `Q00` ERP references (911 in the corpus) as **not** Shopify order numbers.

### An address quoted in the message counts, and it is checked by hash not by layout

Customers routinely forward their order confirmation, and the desk's position is that **an email mismatch is not a security concern here** — ordering for a partner, a parent or as a gift is ordinary, and answering the person holding the order details is the correct outcome. So when the order's registered address appears anywhere in the customer's text, the number is written.

This closes 6 of the 15 mismatches that `VALIDATION_LOG` item 6 flagged for review: the number parsed, the order existed, the address it is registered to was sitting in the message, and the old rule refused it because the *envelope* did not match.

**Nothing parses the confirmation's layout**, which is the load-bearing part. The obvious build is a parser for the template — find "N° de commande", find the "Client" block, read the address under it. That reads a document we never receive. What arrives is the template after the customer's mail client re-rendered it as a forward, after `htmlToText` flattened it, and possibly after a merchant reworded it in Shopify's notification settings; each step moves the labels. There is nothing stable to anchor on either: the notification templates do carry fixed Liquid variables (`{{ order.name }}`, `{{ email }}`, `{{ order.order_status_url }}`), but Liquid renders on Shopify's side, so the received mail holds their values and never the tags.

Instead `confirmation-evidence.mjs` hashes **every** address in the text and asks whether any equals `orders.customer_email_hash`. It reads no structure, so it survives a reworded label, a translated template and a paste with the layout gone. Only hashes leave the module, so third-party addresses never reach a caller, a log line or a metadata column.

It also catches more than it was built for, and that decided the naming. Of the 6 tickets it rescues, **only 3 carry a recognisable confirmation**; the other 3 quote the address some other way. A layout parser would have found 3 and called the rest mismatches. `verified_by` is therefore `message_email`, not `confirmation_email`, and `metadata.order_resolution.confirmation_markers` records how many template markers were present — diagnostic only, never a gate, so a human reviewing a number written against a non-matching sender can tell the two cases apart.

**The order-status URL is the one strong identifier we still throw away.** `{{ order.order_status_url }}` renders to a per-order token whose shape is a platform invariant rather than a template choice — but `htmlToText` drops every `href`, and the raw body is not retained, so the token survives in **0 of 296** stored messages. Using it would need the href kept at map time *and* a token column on `orders`; neither exists, and the hash check does not need them.

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

---

## Investigation

Runs immediately after categorisation and consumes its output in the same poll — the categoriser raises `needs_investigation` in the same patch that clears its own flag, and is the **only** writer of it, so a thread is never investigated against labels describing an older conversation.

This is the first stage that *chooses* what to do, and the first with a budget: **6 tool calls, 4 model turns**, identical-args calls served from a per-run cache. Every bound resolves to an outcome (`needs_human`, budget exhausted), never an exception.

**What keeps the loop short is that most of the evidence is deterministic** — a product question always needs the product matched against the question text, a promotions ticket always needs its codes extracted — so `openingMoves()` fetches those *before* the model's first turn. Measured over 40 real tickets, the whole run took 1–3 tool calls against a ceiling of 6.

Scope is `ENABLED_SUBJECTS`, which since **2026-08-13** is every subject that has tools: product, product_stock, promotions, account, other, **order, delivery, payment, return_exchange**. The five absent ones — `cosmetovigilance`, `legal_privacy`, `b2b`, `partner_collaboration`, `careers` — are absent because their tool sets are deliberately empty (a confident-looking case file about a reported skin reaction is worse than none), so `isInvestigable` would refuse them anyway. Out-of-scope tickets are skipped *and their flag cleared*, so **enabling a subject means re-raising the flag** (`npm run investigate -- --backfill`), not only editing the array.

A test now asserts that the enabled set and the tool table say exactly the same thing. Until this date they deliberately did not, and the gap was the mechanism; with the gap closed, the invariant worth protecting is the agreement — a subject given tools but never enabled is dormant code nobody notices, and one enabled without tools is a ticket routed nowhere.

### The order family was enabled before the mismatches were read, and that is a trade rather than an oversight

Two reasons held it back and both are spent: the dev-store fixture (over — 2052 live orders spanning `#4716`–`#6770` cover the corpus), then a pass that had not run (`orders:resolve` and `context:build` have since run; 50 of 214 tickets carry a confirmed number).

It was switched on with **15 `mismatch` tickets still unexamined**, knowingly. What makes that safe is a property rather than an assumption: `isSafeToWrite()` gates the column, so a refused resolution leaves `shopify_order_number` null. **The agent cannot answer about the wrong order because it never learns which order that was.** The failure mode of enabling early is not a wrong answer; it is asking a customer for an order number they already sent.

The merchant call is that the identity check is probably too strict — a gift, a partner ordering, a second mailbox — and that an occasional redundant question is cheaper than leaving 21 of 31 exemplars and 116 of 158 messages of measured demand unreachable. **The cost is being counted rather than assumed**: `VALIDATION_LOG.md` item 6b is open, and closing it requires reading the 15 and counting how often the agent asked for something it had.

The distinction the old gate protected is still the right one and still holds: it guards against *confidently wrong case files built on absent evidence*, and is satisfied by evidence existing **and being linked**. An unlinked order produces `not_resolved` and a question, which is exactly what it should produce.

### A structure that has several audiences owns a projection for each

One source of truth, one module, and a named function per reader. Nobody reads another module's raw structure across a boundary, and nobody serialises one into a prompt.

It is already how the case file works — `toDraftingPrompt` for the drafting agent, `toHumanBrief` for the person, the second being the first plus the internal `handoff`. **The order context now works the same way**, and the three audiences are genuinely different readers rather than three formats of one thing:

| audience | reads | why not one of the others |
|---|---|---|
| the dashboard | the structured bundle directly, via `ticket-detail.ts` | the panel must show order facts for tickets **the agent never investigated** — a case-file-only path blanks them |
| the case file | `contextRef`, a **pointer** | copying duplicates personal data into every investigation row and freezes a snapshot of a snapshot |
| the model | `toOrderContextText()` | the tool layer is this agent's PII boundary; a rendering is where withholding happens |

**The projection is derived, never stored**, for the same reason `contextRef` is a pointer: a rendered copy in the row goes stale the moment the renderer changes.

### `JSON.stringify` into a prompt is the absence of a decision, not a format

`getOrderContext` returned `context.promptText || JSON.stringify(context.order)`, and measured on live data **0 of 44 stored contexts carried a `promptText`** — the fallback was the only path that had ever run.

Structured JSON is not worse than prose for a model; it is often better. The objection is narrower and it is not about format:

- **Nobody chose it.** Whatever `context:build` last wrote reached the prompt, and so would the next field added to the bundle. Every other tool has a person standing between the row and the model.
- **Raw values have known misreadings.** `buildStock` already refuses to report `available_stock: -1` — one real row is at -1, Shopify allows overselling, and "-1 in stock" is a true value and a wrong answer. An order bundle carries the same hazards: `fulfillment_status` on a cancelled order, totals on a refunded one.

What it was **not**: a size problem (line items top out at 14 across all 2052 orders) or a leak (the bundle holds no street, name or email — `context:build` had already minimised it). Overstating either would have hidden the real fault, which is that the decision was never made.

The rendering that replaced it withholds on purpose: `sku` and `productId` never appear — they are join keys, not facts a customer recognises — and money is named only when a reply turns on it, because quoting a total at someone asking where their parcel is invites the drafting model to discuss a number nobody raised. Measured: 515 characters median against 1693 for the dump.

A test asserts the general property across every tool at once — no `promptText` may begin with `{` or `[` — so the next tool cannot reintroduce it.

### An investigated fact must cite a tool call that actually ran

`verifyFindings()` drops any `established` entry whose `evidence_ids` are not in that run's own ledger, and if that empties the list the verdict is forced to `needs_human`. A model that has read *"j'ai bien été livré"* will otherwise restate it as an established fact — and unlike a wrong reply, **a wrong case file becomes the drafting agent's ground truth**, with every downstream check applied to prose written from it. Dropped claims are kept in `dropped_claims` rather than discarded, because a run that keeps producing them is a prompt problem worth seeing. Measured over 40 real tickets: 0 unsourced claims stored, 0 dropped.

### Four separate evidence columns, never merged

`established` (facts, each carrying the `tool_calls` ids it rests on), `unverified` (what the customer asserted or no tool could settle), `missing` (the fields only the customer can supply), `do_not_claim` (prohibitions). Merging them is precisely the failure the promotion tool measured: **a doubt inside a list of facts is read as a fact.**

### The prohibitions are derived, never asked for

`do_not_claim` is generated from the caveats the tools raised (`basket_unseeable`, `eligibility_undetermined`, `order_unconfirmed`, `product_ambiguous`, `knowledge_weak`/`none`, `customer_unknown`, `stock_unknown`) plus the `missing` list. Asked for them, a model produces the caveats it happens to remember — and it is least likely to remember the one covering the gap it has just filled in. The same reasoning retires the model-set reply intent (derived from the verdict) and the wording of any question to a customer (looked up from the field key).

### Guardrails are code; only guidelines are prose

What a ticket's agent may call is `allowedTools(category, request_kind, level)` — a table, tested across all 14 subjects × 4 kinds, that the model never sees the outside of. Level 4 and the `contact` kind get an empty registry and no model call at all. The distinction matters because this agent never contacts a customer: its rules are operational (what it may read, what it may spend), not editorial.

**`requiredEvidence` is a guideline only, and this file used to claim otherwise.** That per-subject checklist is rendered into the prompt (`planEvidence`) and never referenced again. It is also *static* — keyed on the category, so two `product` tickets asking completely different things get the same list, and the `other` entry is *"the knowledge base was consulted"*, which is satisfied by having searched, whatever came back. It cannot fail. Read it as prompt text.

### Per-ticket evidence needs, scored against the ledger

The mechanism that does close that gap, and it is separate. `evidence-rules.mjs` holds a **closed vocabulary of 19 facts** — `product_identity`, `delivery_state`, `promotion_eligibility`, `policy_answer` and so on. The model declares which ones *this* ticket requires (in the same call that splits it — one act of reading, not two), and code scores each against the tool ledger into one of four states:

| State | Meaning |
|---|---|
| `satisfied` | a tool established it, with the ledger ids |
| `attempted` | a tool ran and could not settle it |
| `unavailable` | no tool this ticket was allowed could ever settle it |
| `not_attempted` | **a tool was allowed, the budget was there, and nothing called it** |

That last row is the whole point: today "there was nothing to find" and "the agent never looked" produce identical case files, and no number in the system separates them.

**Why a closed enum rather than free text.** Free-text needs would take a second model call to check against the ledger — a judge marking its own homework, and no trustworthy number at the end. So the model picks *which*, code owns *what satisfies*. The same split as `MISSING_FIELDS`, where the model picks the key and this codebase owns the sentence.

**`other_fact` is the escape hatch, and it can never be satisfied.** A closed vocabulary's real danger is a false green: a ticket whose actual requirement is unnameable declares two easy needs, satisfies both, and reads as *more* complete than it would with no checking at all. `other_fact` lets the model say "there is something else here", nothing can close it, and it is logged so the vocabulary grows from real tickets rather than from guesses.

**Two deliberate never-satisfiable entries.** `checkout_state` has no tool wired — `abandoned-checkout.mjs` exists and is validated but is not in the investigation registry — so it always resolves `unavailable`. Counting how often it is *needed* is the argument for wiring it, or for not bothering.

**Reported, not enforced — on purpose.** The verdict is untouched by any of this. Downgrading an `answerable` that left a need open, and letting a complete set end the loop early, both depend on the vocabulary being trustworthy, and nothing has yet measured whether it is. Measure first, act second; a list that over-declares would otherwise downgrade good case files for reasons about the list rather than the ticket.

**This is why the decomposition call lost its gate.** It used to skip short tickets. Needs have to exist for *every* investigated ticket or the report has a hole exactly where the ordinary tickets are, so it now runs on all of them: one `gpt-4o-mini` call against the two `gpt-4o` calls the investigation already makes.

### Details say WHICH thing the finding is about

A finding states a value; it never states what the value is *of*. `promotion_validity: expired` does not name the code, and `product_identity: ambiguous` does not name the products it could not choose between. Those specifics sat in each tool's `data`, were read once to derive the finding, and were discarded — so the dashboard could show order facts, which a separate pass persists, and nothing else. A person answering a promotions ticket still had to open Shopify.

**It extends `evidence_gaps` rather than adding a column.** The entries already carry the need, a French label, the finding and the evidence ids; a parallel `facts` column would duplicate that linkage and immediately raise which is authoritative. No migration was needed.

**Declared per need in `evidence-rules.mjs`**, beside the finding derivers, because that module already owns the vocabulary and already reads the ledger. Naming the fields *is* the decision — passing `data` through would repeat the `JSON.stringify` mistake one layer up.

**For the person, not the model, and the asymmetry is the point.** `data` never reaches the model — `fromModel` sends `promptText` alone — so a detail may carry an identifier a reply must never quote. That mirrors the split already in place: the drafting prompt is narrower than the human brief.

**Absent beats empty beats null-filled.** A real run stored `{name: null, isVip: null, ordersCount: null}` — it passed every existence check and told a reader nothing while looking like an answer. `nonEmpty` now drops all-null objects, so the panel never renders a heading over nothing.

**No order needs are declared here.** Order facts are ambient: the resolution pass writes them to `resolved_context` and the panel reads them directly, so they exist for tickets the agent never investigated. Declaring them here too would put the order name in two places with two lifecycles.

### A finding is what the need turned out to be

`state` answers *"did a tool settle this?"*. That is enough to report a gap and not enough to choose an answer: « ton code a expiré » and « ton code est réservé aux nouveaux clients » are both `promotion_validity` satisfied. So nine needs additionally resolve to a **finding** — a closed value enum owned by code, derived from the ledger.

**The same split, one notch further.** The model picks *which* needs; code owns *what satisfies* them; code owns *what value they took*. No answer ever branches on a model's wording.

**Derived from structure, never prose.** Expiry and a future start date were both `FAIL` on the `window` check, separable only by reading the French `detail`. So checks gained an optional machine-readable `reason`, and `tool-registry` passes `{id, status, reason}` triples onward — never the sentences, which stay in `promptText`. A deriver that pattern-matched prose would break on a reworded message with no test failing.

**`unknown` is in every vocabulary, and `null` is not the same thing.** `null` means no answer depends on this value; `'unknown'` means one does and the evidence did not pin it. Collapsing them would hide the second behind the first. `unknown` is also the honest answer when a need is `satisfied` by a tool too coarse to name a value — listing active promotions establishes that a code exists without settling which state *one* code is in, and reporting `active` there would invent the fact the listing does not carry.

**Only the branched-on needs get a vocabulary.** Nine, chosen from what the 32 questions in `Email-Example-Queries.md` actually distinguish. Inventing enums for all 19 would be guessing at distinctions no answer depends on.

### The active listing settles a code's validity only once a code is known (2026-09-01)

`promotion_validity.satisfiedBy` named `listActivePromotions` unconditionally, on the reasoning recorded above: listing the active promotions establishes that the code exists without settling which state that ONE code is in, so `satisfied` + `unknown` is the honest pair.

**The reasoning holds. Its premise does not always.** `outcome: 'found'` on that tool means THE SHOP has at least one active promotion — a fact about the shop, true on essentially every ticket, and independent of the email being read. Where no code was identified there is nothing for « le code existe et est actif » to be about, and the need was marked settled anyway.

**Found on the first promotions ticket a rule ever fired on.** `extractPromotionCodes` returned `none`, `listActivePromotions` returned `found`, and `promotion_validity` was recorded `satisfied` while holding `unknown`. Nothing branched on it — **rules read findings, never states** — so no reply was affected. The completeness gate proposed in `codex_plans/Rule_Guided_Investigation_Plan.md` reads states, and would have counted the need as established while it held nothing.

**Gated, not removed**, through the `satisfies` half of a source — the same mechanism `product_identity` uses for its knowledge route, reading a shared helper so the condition and the finding cannot drift. With a code identified the original reasoning applies unchanged and the pair stays `satisfied` + `unknown`; without one the listing satisfies nothing.

**`satisfied` + `unknown` is therefore still legitimate, and `report:evidence-vocabulary` reports it as its own class rather than as a fault.** What it is worth reading for is exactly this: a source that is coarse on EVERY ticket is a source that should not satisfy at all.

### `order_identity` gets a value, because `unknown` was two answers (2026-09-01)

`stateFromOrderContext` returns `unknown` when no order was confirmed — there are no states to read — **and** when one was confirmed whose delivery state is unrecognised. A rule branching on `order_state: unknown` therefore fires on both, and the first wants « quel est votre numéro de commande » while the second wants a person.

Asking a customer for a number already in the dossier is the failure the *never ask for what is known* rule exists to stop, so the fix belongs upstream of the rule: `order_identity` now carries `resolved` / `none` / `unknown`, derived from the tool's own outcome, which already draws the line between `found` and `not_resolved`. Same shape as `promotion_identity`, for the same reason — **an identity is a value an answer branches on, not merely a gap it reports.**

It was one of three needs with no vocabulary, under the rule that only the branched-on needs get one. That rule stands; this need turned out to be branched-on.

### The dispatch window is a state, because the number alone insults the reader

`dispatch_days` was stored so a reply could stop guessing at how long dispatch takes. Quoting it turns out to be useful on day one and an insult on day eight — and day eight is the common case, because **a customer who writes to ask whether their order has shipped has by definition already waited long enough to wonder.** The most-asked question in the corpus (O-09, 22 messages) would have been answered with a brush-off.

So the number is not the answer; **which side of it this order is on** is. `orderStates` gains `dispatch_state` — `within_window` / `overdue` / `unknown` — computed from `placedAt` against the parameter, exactly as `stale_in_transit` is computed against `staleTransitDays`.

**Working days, and public holidays are not modelled.** That makes the elapsed count slightly high, which is the safe direction: it can tip an order into `overdue` a day early and route it to a person, and can never leave an overdue order looking `within_window` and send the brush-off.

**`unknown` when the shop has not set the parameter.** Every parameter starts null, and a default here would be this codebase inventing a delivery promise on the merchant's behalf.

**Read with `order_state`, never alone.** It is a statement about time since the order and says nothing about whether the parcel has since moved.

### Evidence dependencies are universal, so they live in code

`requires` and `moot` sit beside `satisfiedBy`. Eligibility requires validity requires identity — for every ticket on earth, not for one situation — so restating it per exemplar would duplicate one graph N times and put control flow in a dashboard. An exemplar names the *set*; `orderNeeds()` derives the sequence.

**`moot` is the half that saves calls.** There is nothing to be eligible *for* once a code has expired, so collecting eligibility afterwards spends a tool call to learn nothing. This is what makes collection progressive rather than a fixed checklist.

**Only genuine universals are listed.** `product_property` deliberately has no prerequisite: « vos produits sont-ils vegan » is answerable from the library without identifying a single product, and asserting a dependency would force a lookup the question does not need. A prerequisite that was not declared does not block its dependent either — an exemplar may want eligibility without wanting identity, and the sort simply has nothing to order it against.

**Reported, not enforced — still.** Nothing consumes a finding yet; no verdict, prompt or stored column changed. This axis landed before the exemplar layer because conditions cannot be authored against values the tools cannot produce.

### Weak knowledge chunks are withheld, not flagged

Below the answerable band the chunks never reach the case file at all; only the prohibition does. Showing a drafting model text it is told not to use is a temptation with no upside — measured, the near-misses are contractual CGV text scoring 0.45–0.55 against operational questions.

### Task decomposition, not query rewriting

The standard retrieval upgrade is to paraphrase a question into variants and union the results. That fixes a **vocabulary** problem; this corpus has a **routing** problem. An email asking whether the LED mask suits sensitive skin *and* where order #4854 is contains two requests whose answers live in different tools — one in the product row, one in the order lookup — and one blended embedding matches neither well. The database already said this happens: `tickets.secondary_category` and `secondary_request_kind` have existed since categorisation and nothing downstream ever read them.

**Bounded, not open-ended planning.** The model proposes tasks; every task is clamped to the existing (subject, kind) taxonomy, so it routes through the same `allowedTools`/`openingMoves` table as any other ticket. A planner emitting a free-form task graph would quietly undo *guardrails are code, only guidelines are prose*. Three consequences follow:

- **It cannot re-categorise.** A decomposition that yields one task keeps the ticket's own labels — the categoriser ran on the same text and its value is what is stored and reviewed. Splitting may *add* a request, never re-route the classified one.
- **It cannot enable a disabled subject.** A task landing on `delivery` is dropped from routing and reported to the model as a part it must declare unhandled. Half an email silently ignored is worse than an email never split.
- **It cannot fail the investigation.** No call, a bad answer, or an API error all degrade to one task with the ticket's labels — exactly the pre-decomposition behaviour.

**It runs in the investigation, not the categoriser**, although the categoriser already reads the same email and emits structured output. The categoriser runs on *every* ticket; investigation runs only on `ENABLED_SUBJECTS`, so decomposing there would pay for forwarded mail, level 4 and the `contact` kind.

**`shouldDecompose()` was removed on 2026-08-09 and this paragraph described it for three weeks after.** The gate — a second subject from the categoriser, ≥320 chars, or ≥2 question marks — was right while the call only *split* an email: paying a model to be told one question is one task is waste. It stopped being right when the same call began declaring the ticket's EVIDENCE NEEDS, which have to exist for every investigated ticket or the completeness report has a hole exactly where the short ordinary tickets are, and those are most of them. So the decomposer now runs on **every investigated ticket**: one `gpt-4o-mini` call against the two `gpt-4o` calls the investigation already makes.

**Entities are copied, not inferred.** The extraction is told to return what the customer *wrote*; a date, an amount or a `Q00…` reference is not an order number. They are hints for the router, never facts: an order number still has to be confirmed against the order's email hash before anything is written.

**Which text each tool gets is the subtle part.** The semantic matchers (`lookupProduct`, `lookupStock`) get the sub-question plus any verbatim product names, because asking the IDF-weighted matcher about an email half-concerned with a parcel means competing with the parcel's vocabulary. `extractPromotionCodes` always gets the **raw** email: a paraphrase is exactly where a literal code stops being present.

**The tool budget grows (+2 per extra task) and the turn budget does not.** Tool calls here are cached database reads; the expensive bound is how many times the model speaks. Holding tool calls fixed would mean the second half of an email is investigated with whatever the first half left over. Opening moves are capped at 4 so a three-way split cannot consume the budget before the model has spoken.

### "Is this a customer" has three answers, and the middle one is the point

`verifyPurchase` reports `known_buyer` / `known_no_orders` / `unknown`, and only the first satisfies the `purchase_verified` need.

The middle state is not a technicality. **Measured over the 214 live tickets: 111 `known_buyer`, 34 `known_no_orders`, 69 `unknown`.** Those 34 are addresses that exist in `customers` with zero orders behind them — a newsletter signup, or an address given at a till. A binary check would have to put them somewhere, and both choices are wrong: called verified, the agent answers about an order that does not exist; called unknown, it tells a real customer we have never heard of them.

**Neither lower state is evidence that nothing was bought.** A sale made in a physical shop never reaches Shopify, so absence here is silence, not denial. The `purchase_unverified` caveat is therefore written as a prohibition on the *denial* — « ne pas affirmer que cette personne n'a rien acheté » — and the unmet need asks `purchase_channel` (was it our site or a shop?) rather than concluding anything. Telling someone holding the product that they never bought it is the single worst reply this check could produce, so it is the one the vocabulary makes impossible.

It enters from `tickets.customer_id`, not from the address: the customer-resolution pass already did that lookup on every ticket before any LLM stage, and redoing it would be a second answer to a settled question plus a second `data_access_events` row for the same access.

### The product cross-check runs against the last order, not the catalogue

### `DISABLED` does not mean deactivated, and the word was reaching customers

Shopify's `customers.state` has four values and the obvious reading of `DISABLED` is wrong. On this shop `customerAccounts` is `OPTIONAL`, so **57,140 of 58,201 customers are `DISABLED`** — 53,677 who have never ordered (newsletter signups, a Mirakl/Yves Rocher import) and 3,463 guest checkouts, still arriving daily. It is the default for *a customer record with no account*, not a state anybody set.

`describeState` rendered it as **« désactivé »** and that string went into the prompt as a fact. It was repeated as one: *« Le compte client est désactivé mais inscrit à la newsletter »* appeared in a stored case file about a customer who had simply never opened an account. On an open L3 ticket — *« Impossible de me connecter à mon compte même en changeant le mot de passe »* — the agent now establishes « n'a pas de compte client existant avec cette adresse » instead, which is both true and actionable.

**No deactivation branch exists, and none should be written.** Checked for a deliberate-block marker: every tag on a `DISABLED` customer is an acquisition source (`Yves Rocher FR`, `Mirakl`, `prospect`, `newsletter`, Judge.me review tags) and nothing resembles blocked, fraud or closed. If a real block ever happens Shopify stores the same `DISABLED` for it, so it would need a tag or a note before any rule could mention reactivation.

### `known_no_account` and `unknown_sender` are the pair the account vocabulary exists for

`customer_account_state` was `resolved / none / unknown` — it recorded only whether the *lookup* worked, so no rule could tell a working account from one that never existed. It is now `enabled · never_activated · known_no_account · unknown_sender · unknown`.

The split that matters is the last two, and they are the two biggest buckets in the corpus: **156 tickets whose sender matches no customer row at all, and 97 whose sender matches a row with no account behind it.** They take opposite replies. The first has to *ask* which address the account is under — the corpus has that exact case, a customer writing « je pense que j'ai 2 adresses mail pour mon compte ». The second must not ask anything, because we already know precisely who wrote in and can say so.

**`never_activated` is 2 tickets and earns its place anyway.** It is the state that looks exactly like a forgotten password and is not: an invited customer has no password, so a reset link does nothing. The corpus proves it — *« Impossible de réinitialiser le mot de passe. Je commande régulièrement chez vous »* is an `INVITED` customer, and the agent now reaches « une nouvelle invitation doit être envoyée depuis l'administration Shopify » on that ticket rather than offering a reset.

**Derived from the ledger's `data`, not from the tool's outcome**, which stays `found` / `no_match`. Widening the outcome would have rewritten the ledger vocabulary for all six subjects that call `lookupCustomer`, and unlike the reaction report nothing is lost by leaving it in `data`: `customers.state` is still a column, so a stored run can be re-read through `ticket_investigations.customer_id`.

### The storefront address is fetched, never configured

A reply that has to send somebody to their account page needs a URL, and there was none — **zero URLs in the entire approved knowledge base**. The alternative was a parameter for an operator to type: a second copy of something Shopify already knows, wrong the day the domain changes and wrong silently.

So `shops` gained `storefront_url` from Shopify's `primaryDomain.url` (`https://qiriness.com`), kept fresh by the shop sync that already runs. `shop_domain` could not serve — that is the `*.myshopify.com` identity every webhook keys on, and no customer has ever seen it.

**A different page per state, which is the point of having the states.** `/account/login` for an active account, because this theme carries the « mot de passe oublié » form inline — `/account/recover` returns **404** here, so a reply naming it would send somebody to a dead page. `/account/register` where no account exists. And **no link at all for an invited customer**: no self-serve page finishes an invitation, so the answer is a person resending it, and handing them the login page would be the third time they had tried it.

`customer_accounts_version` is stored beside it. It reads `CLASSIC` today, which is what makes a password reset meaningful at all; under `NEW_CUSTOMER_ACCOUNTS` sign-in is a one-time emailed code and every reply about resetting a password would be wrong. A migration between the two is invisible from anywhere else here.

**A reply may carry a link but never an address.** `FORBIDDEN_PATTERNS` refuses any email address in a draft, which constrains how the `known_no_account` case can be worded: « nous avons bien vos coordonnées sous l'adresse depuis laquelle vous nous écrivez » says it without quoting anything, and quoting the address would fail the check.

### A-29 is four rules, one per account state

The four states each take a different reply, which is what made them worth having:

| state | route | says |
|---|---|---|
| `enabled` | *(verdict left alone)* | your account exists under this address; the login page carries « mot de passe oublié » |
| `never_activated` | `needs_human` | there is no password to reset; a person resends the invitation |
| `known_no_account` | *(verdict left alone)* | we know you, no account has been created yet; here is the registration page |
| `unknown_sender` | `needs_customer_input` → `account_email` | nothing under this address — which one is the account under? |

**Two of them route nowhere on purpose.** `enabled` and `known_no_account` are fully answerable from the tools: the account state is established, the page address comes from `shops.storefront_url`, and there is nothing left for a person to add. Leaving the verdict alone lets the investigation decide, and the tighten-only rule means a rule can never make a ticket *more* answerable than the investigation found it.

**`never_activated` is the only one that needs a person**, and not because it is uncertain — it is the most certain of the four. It needs one because the action is not self-serve: no page finishes an invitation, so somebody has to resend it from the Shopify admin.

**`account_email` is a new question, separate from `purchase_email`.** The existing one asks which address *the order* was placed with, and on an account ticket that reliably gets the wrong one of the two — the customer in the corpus writing « je pense que j'ai 2 adresses mail pour mon compte » has ordered under one address and is trying to sign in under the other.

**The `unknown_sender` branch still carries a link.** It is the one case with no customer and therefore no account state, but the login page's « mot de passe oublié » form works against whatever address they actually used — so `lookupCustomer`'s `no_match` text names it too. It is the one thing they can try while waiting for us to answer, and it costs nothing to include.

### The rulebook filters by answer set

### The returns address in the parameters was wrong

### The promotion machinery was already built; it had no rules to reach

`evaluateStacking` has read `combines_with` from the promotions table since the promotion tool existed, and produces the sentence support actually needs — *« Ce code ne peut pas être cumulé avec une remise sur commande, une remise produit. S'il y a déjà une autre remise sur la commande, c'est la cause la plus probable. »* Beside it: `promotion_validity` across six values, `promotion_eligibility` across five, and checks on the window, the status, the usage limit and once-per-customer.

All of it derived from the table, none of it guessed, and none of it reaching a customer, because the `promotions` answer set was empty. **The work here was seven rules, not a mechanism.**

### There is no welcome code, and P-15 is seven tickets asking for it

`BIENVENUE` expired 2025-08-25 and `BIENVENUEQIRINESS` expired 2026-06-22. P-15 has **seven real phrasings**, every one a customer who subscribed for the 20% and never received a code — and the code behind that promise has been dead for two months while the signup form kept making it.

So P-15 cannot name a code, and the rule does not try. It confirms the subscription and leaves the offer to a person, which is also the answer to the harder question: *which* code. That is a commercial decision per ticket, not a constant.

### `offerable_in_replies` is the one column on a synced table that is ours

Of the 14 active single-code promotions, one is **100% off a product**, and two are partner rates of 50% and 26%; six further promotions carry 600 single-use bulk codes each. A picker showing "all active codes" puts a free order one mis-click from a support reply, and nothing in the data separates the welcome code from a partner's rate — not the discount type, not the size, not the title.

So a person decides once, on `/agent-setup/promotions`, and the reply screen only ever sees what they chose. **It survives the sync by not being in the mapper**: `mapPromotionRow` returns a fixed column set and the upsert merges duplicates, so a column absent from the payload is left alone. That omission is load-bearing rather than incidental, and `shopify-promotion-mapper.test.mjs` now asserts it — adding the key there would silently reset every decision to false on the next sync, which would surface as codes quietly vanishing from the picker rather than as an error.

### Specificity outranks priority, so a shallow rule cannot be rescued by it (2026-09-01)

`paiement_non_abouti` branched on `{payment_state: unpaid}` and `expedition_dans_le_delai` on `{order_state: not_dispatched, dispatch_state: within_window}`. **An unpaid order is also an undispatched one**, so both matched every time and the two-condition rule won: the customer whose payment failed was told their order was being prepared, inside the normal window.

**Priority is not the fix, and reaching for it is the mistake worth recording.** `selectAnswer` sorts on the situation, then on condition depth, then on priority — so a one-condition rule can never outrank a two-condition one however high its priority. The rule has to be made equally deep and then win the tie.

**Found by simulation, not by reading.** Nine order states were run against the loaded set and the winner printed for each; the table looked correct to the eye and was wrong in one cell. Any rule set worth approving is worth enumerating this way, because shadowing is a relation between rules and no single row shows it.

### An offer is specific to a product, or it is a sale wearing a product scope (2026-09-04)

`lookupProductOffer` answers a question nothing in the vocabulary could: the customer named a PRODUCT and no code, and wants to know whether an offer exists for it. `promotion_validity` asks the opposite direction — whether a code the customer named is usable — which is why P-21 had no evidence to branch on until now.

**SPECIFIC IS COUNTED, NOT ASSERTED, and the count is the whole rule.** `QIRINESS20` is scoped to 94 products; naming it as « une offre sur votre produit » would be true and misleading. The line is **ten OTHER products**: past that the promotion is about the catalogue rather than about this item, and the general branch says so more honestly. `UKLED20` covers one product and is specific; a 12-product bundle is not.

**Matched on the Shopify GID, never on the title.** `promotions.rule_snapshot.customer_gets.items.products[].id` and `products.shopify_product_id` are the same identifier from the same sync. Matching by title would be matching two strings that only happen to share a source.

**`offerable_in_replies` gates the lookup exactly as it gates the picker.** A partner rate or a 100%-off code must never reach a customer because a lookup happened to find one — and one such code WAS flagged offerable by mistake and removed on 2026-09-04, which is why the gate is in the query rather than in the caller.

**The rule carries no `offer_code`, and that is the difference from every other offer rule.** A rule holds ONE code, so a `product_identity: resolved` branch holding `UKLED20` would offer the LED code for any product. Here the code is whichever one covers the product, so it travels as EVIDENCE — the tool names it, the model cites it, and the skeleton says to reproduce it exactly and invent nothing. The cost of that choice, stated: `offer_code` is re-checked at drafting for still being offerable and a code carried as evidence is not, so a promotion ending between investigation and drafting would still be quoted. The window is minutes.

**`none` satisfies the need.** « There is no offer for this product » is a fact the shop established, not a gap — the same distinction `refund_state: none` makes. Only `no_match`, where no product could be identified, leaves it open, and that is a product problem rather than an offer one.

### An empty offer dropdown says nothing; the skeleton says everything (2026-09-04)

P-21 — « avez-vous une offre ou un code promotionnel en cours ? » — is the situation the per-request work surfaced: the promotions half of a product enquiry matched nothing, because all three promotions situations were about a code that does NOT work.

**The design question it raised, and the column that turned out not to be needed.** The intent was three branches: offer a product-specific code, offer a general one, or say we have none. The third looked like it needed a sentinel in the offer dropdown — `(no codes available)` — to distinguish "the operator picked nothing" from "there is nothing to pick", with a worry that the no-offer wording would otherwise fire on every rule with an empty dropdown.

**It cannot.** `resolveOfferCode(null)` returns null and no code section is added, so an empty dropdown produces SILENCE. The only thing that mentions offers is the rule’s own skeleton. Every other rule in the book has an empty dropdown and none of them talks about promotions, because none of their skeletons do. The sentinel would have encoded in a column what the skeleton already says in words — a second home for one intent, which is the drift this codebase keeps removing.

**Including the case that motivated it**: saying « nous n’avons pas d’offre » while codes DO exist is a commercial decision, and it is expressed by writing that skeleton and picking no code. The rule withholds; nothing has to model withholding.

**The conditional lives in the skeleton, where the truth is.** `p21_offre_en_cours` reads "if a code appears in this dossier, give it; if none does, say we have no offer and invite the newsletter". That survives the code being dropped at drafting time for stopping to be offerable — which is the one soft spot of a skeleton that assumes a code it may not get.

**And it forbids the thing a promotions answer most wants to do**: hint at a promotion to come. A customer told a sale is coming does not order now, and we do not announce them in advance.

**The product-specific branch is not built.** A rule carries ONE code, so a `product_identity: resolved` branch holding `UKLED20` would offer the LED code for any identified product. Doing it properly needs a lookup over `promotions.rule_snapshot.customer_gets.items.products`, which carries the scoping and which no tool reads. Until then the general code answers, less precisely and never wrongly.

**Approval is what earns an embedding, and an embedding is what makes a situation matchable** — so P-21 was created as a draft and approved only once its rule existed. Approved earlier it could have pulled a ticket off P-18 and left it with no rule at all. Re-matched all 24 previously-matched runs afterwards: **no ticket’s situation changed.**

### Rules go per request; the verdict stays per ticket (2026-09-04)

An email can ask two things. The investigation has always known that — the decomposer splits it, and tools, budget and evidence all follow the split. The rules layer did not: one rulebook, one situation, one selection, for the whole email.

**The case that names it.** A customer asked four questions about the LED mask and then « avez-vous une offre ou un code promotionnel dont je pourrais bénéficier ? ». The agent FOUND the answer — `UKLED20` sits in `established` — and selected `pr28_caracteristiques_connues`, whose guidance is entirely about product characteristics. Nothing addressed the discount. The human who replied did answer it.

**The categoriser already knew.** That ticket is filed `category: product / secondary_category: promotions`. The second axis has been on the row since categorisation and nothing downstream read it. **66 of 309 investigable tickets (21%)** carry a secondary subject that opens a different rulebook.

**Opening the second rulebook is NOT safe on its own**, which is why this is one change rather than the two I first proposed. Three approved rules apply to any situation: `reaction_signalee {}` has no conditions at all, `produit_non_documente` fires whenever a knowledge search comes back empty, and `non_expediee` on an order state. Open the cosmetovigilance book for an email at large and the first fires on any evidence whatsoever. A second rulebook is only safe when it is scoped to the REQUEST that named it.

**So: per request for rules and wording, per ticket for the verdict.**

- **The strictest route wins.** Tighten-only survives for free — the strictest of several tightenings is still a tightening, and a request whose rule wants to answer can never clear one whose rule wants a person.
- **`ask` unions and deduplicates**, so two requests needing the customer produce one reply asking for both rather than two round trips.
- **Skeletons concatenate, each labelled with its question**, because the failure being fixed is a reply that answers one half well and improvises the other; a merged instruction naming neither would be no better.
- **One request produces exactly today’s object**, byte for byte, with no `per_request` key. That is the safety property for the other 79% and the regression test.

**Two sources for the request list, and the second is the one that was thrown away.** The decomposer names a category per task; the categoriser’s `secondary_category` covers the case where the decomposer is absent or collapses to one task, which is exactly when `normaliseDecomposition` falls back to the ticket’s own category and loses the other subject.

**A consequence worth stating: a reported reaction now reaches a person.** `reaction_signalee` is the cosmetovigilance fallback and routes to `needs_human`. A ticket whose SECONDARY subject is cosmetovigilance previously ran on its primary family alone and could be answered automatically; it now picks up that fallback and goes to somebody. That is the documented stance on adverse reactions, applied where it was silently not applying.

**Findings stay per ticket, and not out of laziness.** The plan calls a `taskIndex` on ledger entries the prerequisite for all of this. It is not, and it would only half work: opening moves are attributable because `planMoves` iterates tasks, but a MODEL-initiated call cannot be attributed at all — the model is never asked which request it is serving. A findings map reliable for the deterministic half and guesswork for the discretionary half is worse than one honest shared map. The cost: where two families share a need — `policy_answer`, `customer_identity` — a finding from one request can select another’s rule. Both are facts about the sender or the shop rather than about a specific product or order, which is what makes the sharing tolerable.

### Who the customer is becomes a floor fact, not a thing the model remembers (2026-09-04)

The replay said suppression would lose 7 established facts, so nothing was suppressed. The cause was not the rules and not the mechanism — it was the response floor, which I had set from an old prompt checklist rather than from what replies demonstrably rest on.

**Measured against the claims themselves: `lookupCustomer` carried 24 established claims across five subjects and appeared in none of their floors.** The floor said a reply was ready while a quarter of the evidence behind it came from a tool the floor never mentioned. That is what "stopped too early" meant in practice.

**And it was not deterministic where it mattered most.** It is an opening move on `promotions`, `account` and `cosmetovigilance` — not on the order family, where the model had to think of it: **86% on order, 100% on payment, 93% on returns, and 42% on delivery.** The same load-bearing fact, collected or not depending on which subject the mail landed in. That spread is the inconsistency this layer exists to remove, and `openingMoves` already makes the argument in its own words: having a model ask for a foregone conclusion is a model call spent to reach one.

**So it became an opening move on all four, and `customer_identity` joined their floors.** The order costs nothing: making it deterministic first is what makes requiring it free. Measured cost of the move itself: **19 calls across 67 runs**, because it already ran on 48 of them — the spend is exactly the 28% where a customer identity was load-bearing and nobody established it.

**`EVIDENCE_BY_SUBJECT` gained the matching entry.** The checklist the model is shown and the list that gates suppression are two statements of one requirement, and letting them drift is the failure this repo guards against everywhere else.

**Result, on a re-traced corpus: established facts lost fell from 7 to 3, and discretionary calls from 60 to 48.** The floor is more honest and the model has one less thing to remember. **Suppression is still off everywhere** — no situation both saves something and loses nothing — but the number moved in the direction the diagnosis predicted, which is what says the diagnosis was right.

**What the floor is NOT.** A list of every fact some reply happened to use. `verifyPurchase` (2 claims) and `recommendProducts` (1) stayed out: a floor is what a reply ALWAYS needs, and fitting it to a 47-run sample would be over-fitting the next measurement into agreement with itself. `other` keeps no floor at all — there is no fact a reply to "anything else" always rests on, so it can never suppress, which is the safe direction.

### The replay says do not suppress, and that is the result (2026-09-03)

Collection may now stop early — the mechanism exists, per situation, and **not one situation has it on**, because the measurement built to justify it says it would cost more than it saves.

**Over 47 traced runs: 13 calls saved, 7 established facts lost across 6 runs, 1 `answerable` stopped with an open gap.** And the shape is worse than the totals: **every situation that would save anything would also lose something**, and every situation that is safe saves nothing. There is no situation where the trade is worth making today.

**Two stopping conditions, and the measurement that forced the second.** `nextNeed` returning null means THE RULE IS DECIDED, not that the investigation is done — a rule branches only on what changes the routing, and a reply rests on facts that change nothing about which answer is selected. Measured before any of this was built: on **58 of 90** runs the rule was already decided, and **50 of those still produced established facts**, 115 claims in all. A loop stopping on the rule alone would have dropped the collection behind every one of them. So `responseComplete` had to be built here, not deferred again.

**`knowledge_searched` is not a response need, and could not be.** The per-subject checklist it comes from is prompt text in its own vocabulary, and that entry names a TOOL CALL — « la base de connaissances a été consultée ». This vocabulary says in as many words that needs are facts, not tool calls. Admitting the one shape it refuses into the list that decides when collection may STOP would have been the point lost exactly where it matters most. Nothing is lost by dropping it: `searchKnowledge` is already an opening move on every subject that listed it.

**`return_state` maps to `refund_state`, not `return_eligibility`.** The label is « l’état du retour ou du remboursement », which is what `refund_state` reports. `return_eligibility` answers whether a return is still possible and resolves `unknown` on every ticket until the returns window is set — a floor built on it could never be met, so it would have disabled suppression on returns by accident rather than by decision.

**A need nothing can close does not hold the loop open.** `responseComplete` accepts satisfied, moot, or `gapClosability === 'never'`, reusing step 6’s classifier. Without that clause the loop would never end on any subject carrying a need with no tool wired, which is most of them — the feature would be dead rather than off.

**A second column rather than a third value on `collection_mode`.** Directing collection can only ADD a call and its worst case is a wasted lookup; stopping it REMOVES one and its worst case is a reply resting on a fact nobody fetched. Different risks want different opt-ins, and a shop that wants the first must not get the second by implication.

**The traces had to be bought.** Only 2 of 137 stored runs carried one, and a trace cannot be filled in afterwards — the tool `data` it derives from does not survive the run. Re-investigating the stratified 50-ticket sample produced 47, at 204 model calls and 325k tokens. That spend is what the number above rests on, and it is the reason `findings_trace` was built first.

### The planner reads a need’s STATE, because `unknown` means two things (2026-09-03)

Rule-directed collection ships as `collection-planner.mjs`: the rules propose the next fact to establish, per situation, opt-in. It may add and reorder calls; it may never suppress one.

**The design in the plan would have proposed nothing, ever.** `nextNeed`’s candidate filter is `findings[need] === undefined`, and a run never produces an undefined finding: every `derive` returns `unknown` when its tool has not run, so `findingsOf` hands back a value for every need a rule names. Measured against P-18’s own four rules — `nextNeed` proposes `promotion_identity` on an empty map and **null** on the map a real run produces.

**`unknown` is overloaded and both readings are load-bearing.** To a rule it means « nous avons cherché et nous ne savons pas », which `aucun_code_identifie` legitimately branches on. To a planner it has to mean « personne n’a encore cherché ». The distinction the flat map loses is in `resolveNeeds`: `state`. So the planner reads state and the rules read findings, and neither has to change to accommodate the other — `collectedFindings` is that translation and it is why the module exists rather than being a wrapper.

**`available` is the needs the RULES name, plus their prerequisites** — not the ticket’s declared needs, which is what the plan specified. Over 90 stored runs the declared set proposes nothing at all: the decomposer declares what a good ANSWER rests on, while rules branch on what separates one answer from another. With the rules’ own needs, **30 of 90** get a proposal. The prerequisites have to be in the set too, or `firstUnmetPrerequisite` cannot reach them — P-18 proves it, since its rules name only `promotion_validity` and the code that must be extracted first appears in no rule at all.

**A proposal whose arguments cannot be assembled is skipped, never guessed.** `lookupPromotion` with no extracted code is the live case, and it is where every P-18 ticket in the corpus sits. Inventing a code there would be fabricating evidence. `identifyReactionProduct` can never be assembled at all — its arguments ARE the model’s reading of the email — which is what makes **cosmetovigilance never rule-directed**, at no cost, since that subject goes to a person whatever the evidence says.

**A cache hit is not progress, and reading it as progress hung the run.** `run.call` serves a repeat from cache and returns the original entry: truthy, no new id, no new row. The planner re-derived the same findings, proposed the same need, and spun — and because every await resolves as a microtask it starved the event loop rather than merely looping. The loop now requires the ledger to GROW. A regression test holds it, on the ordinary case that produced it: a rule branching on what an opening move already established.

**Two off switches at different altitudes.** `collection_mode` per situation, set by a person in the rulebook and **never inferred from how many rules exist** — a set with three of eight rules approved converges faster than a complete one, so counting rules would rate it readiest exactly when it is least ready. And `RULE_DIRECTED_COLLECTION=false` globally, for the decision taken at 2am without a deploy. The column defaults to `model`, which is what makes shipping this change no ticket at all.

**The pilot the plan named is dormant.** P-18 needs a promotion code and `extractPromotionCodes` has returned `found` on **zero** runs in the whole corpus. D-02 is the live one: opted in, a real ticket went from 1 tool call to 3 — `searchKnowledge` for `product_identity`, `checkPhotoEvidence` for `photo_evidence` — and its « 1 non cherchés » evidence gap closed. Set back to `model` afterwards; opting a situation in is an operator’s decision.

### A rule may pin the article it answers from (2026-09-03)

Some situations have their answer in one approved article, and leaving retrieval to rediscover it per ticket makes the reply depend on which category the ticket landed in. D-33 is the case: « livrez-vous dans mon pays ? » is answered by **three** approved articles with **three different country lists** — Germany appears only in the FAQ, Hong Kong only in *Livraisons et retours*, and the CGV calls foreign orders exceptional. A `delivery` ticket searches `delivery, faq, brand_story, other`, and there is no `delivery` article, so it reaches the FAQ and nothing else.

**`support_answers.knowledge_document_id`, the second value a rule carries rather than a condition**, and the same kind of decision `offer_code` is: which source answers this case is a choice a person makes once, not a similarity score.

**PER RULE, NOT PER SITUATION**, which reads like the wrong axis until D-33 is looked at. Pinned to the situation, the article would also attach to `d33_livraison_non_documentee` — the branch that fires when NO article answered, which exists for exactly that case. The branch is what knows whether an article applies, and a rule already carries `situation_key`, so per-rule says "per situation" whenever it should.

**A real foreign key, unlike `offer_code`.** That one cannot be constrained because the Shopify sync rewrites `promotions` underneath it; these rows are ours. `on delete set null` rather than cascade: deleting an article must never delete the rules that cited it.

**Recorded at investigation, resolved at drafting**, exactly as the offer code is, and for the reason already written there: whether the document is still approved is a drafting-time question, and a stored run has to read back which article the rule chose either way. An unapproved or deleted article is dropped and logged, which degrades to the behaviour before pinning existed rather than blocking a ticket over a library edit.

**Its own heading, not `caseFile.knowledge`.** That array is documented as chunks that cleared the answerable band; a pinned article cleared no band, and putting it there would change what the column means and leave a reader hunting for a `searchKnowledge` call that never happened. The prompt says « Article de référence pour cette situation » instead — retrieval found one, a person chose the other, and a reply written from the wrong assumption about which is which is a different kind of mistake.

**Capped at 6,000 characters, logged when it bites.** The longest approved document is 18k against a 2.5k median, and one article that dwarfs the case file is an article the reply gets written from instead of the evidence. An article that keeps hitting the ceiling wants pinning by section, which the chunks already carry headings for.

**It does not skip the tool call, deliberately.** The rule is not selected until the tool loop has closed, so skipping `searchKnowledge` means acting on the situation during collection — which is `collection_mode: rule_directed`, gated per situation for its own reasons. It would also be self-defeating here: skip the call and `policy_answer` derives `unknown`, so the D-33 branch that fires is the one for having no article.

### A situation's decisions are its own, and the shared rules get a lane (2026-09-03)

The canvas built its evidence decisions from every rule visible under a situation, which included the set's situation-less ones. So D-33 — « livrez-vous dans mon pays ? », a rule that branches on `policy_answer` and nothing else — showed `order_state` and `delivery_state` as decisions, borrowed from `non_expediee` and `expediee_sans_scan`, with `order_identity` dragged in behind them as their prerequisite. Three decisions on a shipping-policy question, none of which any rule on that screen reads.

**They are not merely noise, they are unreachable.** `selectAnswer` ranks situation above condition depth, so a rule keyed to the situation always outranks a shared one. With D-33 covering all four `policy_answer` values, no shared branch can ever win there — the canvas was drawing paths the runtime cannot take.

**Listed, not hidden.** A situation-less rule still applies to the set, and dropping it from the screen would misrepresent that as surely as folding it into the decisions did. It gets its own lane saying what it is and why it loses.

### The rule editor opens on the situation, and never hides what a rule depends on (2026-09-15)

The editor was a modal from the flat-list rulebook: it asked again for the answer set and situation the rail had already chosen, and listed every need and finding the vocabulary has. It is now a slide-in panel over the canvas.

**Conditions open on this situation's needs, not all of them** — its `requirement_needs`, the needs its other rules branch on, the needs this rule already names, and their prerequisites. **Narrowing is a view and never a filter**: a need this rule already names is always in the set, so a ticked finding cannot be hidden, and "show all" is one click away for a branch on something new. Where nothing narrows (a new shared rule in an empty set), every need is shown.

**The scope is where it was opened.** Moving a rule to another situation is still possible, behind "Change", because it is rare and consequential — it changes which tickets the rule can ever reach.

**Escape and a backdrop click do not discard edits.** They close a clean panel and ask on a dirty one; Cancel and Discard are the deliberate exits. A half-written skeleton is what an accidental close costs.

**The "evidence says" section stayed, renamed "When the agent found".** The conditions are what separate one rule from another inside a situation — A-29 is four rules told apart by account state alone — so they cannot go; what went was the raw-key wording.

### A rule may set the tone of its reply (2026-09-15)

Until now tone was one global field — the Brand voice's « tone and voice » — and a skeleton that wanted a different register said so in prose: `connexion_aucun_compte` « le rassurer », `d05_suivi_bloque` « le confirmer plutôt que de le rassurer à vide ». `support_answers.tones` makes it a choice: Reassuring, Empathetic, Factual & brief, Firm, Apologetic, Understanding.

**The catalogue is code** (`scripts/lib/reply-tones.mjs`), for the reason parameters are: the list is what the prompt can word. The check constraint holds the same keys and `05_exemplars.test.mjs` asserts they agree. The save path refuses an unknown key; the read path drops one, which only ever meets a row older than the catalogue.

**Per rule, not per situation.** D-01 has `d01_expedition_en_retard`, where an apology belongs, and `d01_expedition_dans_le_delai`, whose skeleton says « ne pas s'excuser d'un retard qui n'en est pas un ». Per situation would force one register on both.

**Several tones, and an email with two requests gets the union** — the same treatment as `ask`, and for the same reason: each request's rule chose how its half should land, and one reply carries both halves. Stored and rendered in catalogue order, so the union reads the same whichever request came first.

**An adjustment, never a replacement.** The prompt section « Ton de cette réponse » sits after the skeleton (what the reply does) and before the code and article (what it does it with), and says in words that it changes neither the facts, nor what the reply must do, nor the structural rules. A tone able to override « n'affirmer que ce qui est établi » would be an apology that promises a refund.

**Apologetic is regret, not fault.** Its wording draws the line the chase rule already draws: apologising for the inconvenience admits nothing. It was kept although it can contradict a skeleton; the editor warns when Apologetic is picked on guidance that forbids an apology, rather than refusing the save, because « nous sommes désolés pour la gêne » on an on-time order is a judgement a person may make.

**No draft moves until somebody picks one.** Every existing rule takes `{}`, and a prompt with no tone is byte-identical to one written before tones existed — asserted in `compose-draft-tones.test.mjs`. **Tone is not mechanically checked**: no pattern proves a reply is « compréhensif ». The review queue is what stands behind it.

### A rule may offer a link, and the model is given a marker, never the address (2026-09-15)

**The demand was already in the live rules.** Four approved skeletons asked for a link nothing could supply: `masque_led_verifications` « donner le lien du guide d'utilisation », `connexion_compte_actif` and `connexion_aucun_compte` pointing at the login and sign-up pages, and `connexion_client_introuvable` claiming the login page's address « figure dans les faits établis » — which it cannot, since nothing in a case file is a URL. That last one is the skeleton-supplies-a-fact failure in its purest form.

**This extends « The reply names the parcel; the number is the link », it does not reverse it.** That decision found that a model handed a URL pastes it — in full mid-sentence, or as markdown nothing renders. So the URL still never reaches the model. The rule carries `link_url` + `link_label`; the prompt section « Lien à proposer au client » gives only the label and asks for one `[[ici]]` marker (the word follows the reply's language); code puts the address on the marked word wherever the draft is shown. `no_web_link` is unchanged and still fails any address the model types.

**« click here », not a bare link**, because that is what was asked for, and because the marked word is the one place a link can sit without the address appearing in the prose.

**The draft keeps its own copy** (`ticket_drafts.reply_link`), taken at drafting time. The marker was written about that address; a rule edited afterwards must not re-point text a reviewer has already read. A column rather than a key of `prompt_inputs`, because the review projection reads it with the body and deliberately leaves `prompt_inputs` out.

**Two checks, one per direction.** `link_placed`: with a link, exactly one marker — none means the customer gets no link, two means two anchors on one page. `no_orphan_link_marker`: without a link, no marker, because a marker nothing can link reaches the customer as « [[ici]] ». Both read the pattern in `scripts/lib/reply-link.mjs`, the same module the dashboard renders through, so a marker the check accepts is always one the screen links.

**One link per reply.** When two requests' rules each carry one, the first is taken — the treatment `offer_code` gets, recorded in `per_request` so the clash is visible.

**https only, and no host allowlist — pending.** The shop's public domain is not recorded anywhere in this codebase (`SHOPIFY_STORE_DOMAIN` is the admin domain), and inventing one would refuse the real addresses. Typed per rule by a person, like a code.

**Not built: sending.** When a send path exists it must turn the marker into an anchor from `reply_link`; a plain-text send has no anchor to make and that choice is undecided. The four skeletons above still say what they said; rewriting them is the first thing to do once their addresses are entered, and saving one takes it off live mail until it is approved again.

### A branch a general rule answers is not a gap, and the screen derives that rather than asking (2026-09-15)

D-01's `delivery_state` decision showed `dispatched_no_scan` as a missing branch with « Add branch », while at runtime every such ticket is answered by the shared `expediee_sans_scan` — the most common D-01 case, drawn as a hole. The canvas now shows « General rule applies » there, naming the rule.

**Two sources for the box, and only one of them is what the agent does.** A branch reads « General rule applies » when a live general rule's conditions cover it (`generalRulesCovering`: approved, no situation, not the fallback, conditions only this need with this finding or none) — which is exactly when `selectAnswer` would use it. It ALSO reads so when a person picked a general rule for it in the editor's « Use a general rule »: that was the point of the tick box, and a first version that ignored the pick left the dropdown doing nothing visible.

**The pick is frontend only**, by request — kept per branch in the browser (`lib/general-rule-choices.ts`), keyed by rule key so a restored rule keeps its picks, never sent to the agent. Because the agent does not consult it, a pick the agent would not act on says so inside the box (« Picked here, but the agent only uses … when … », or « once it is put live » for a draft), and « Unpick » removes it. A box claiming coverage the runtime does not apply would be the canvas drawing a path the agent cannot take, which is what the situation-lane decision above removed. « Write a D-01 rule instead » stays, because a situation rule would override either.

**English names for the seven shared rules are display only.** `answer_key` is recorded on every investigation that selected it; renaming it would orphan stored runs. The key stays one hover away.

### A completeness gate needs to know who could close the gap, not just that it is open (2026-09-03)

The gate refuses an `answerable` verdict while a declared need is still open. Run over the fresh corpus before enforcing anything, it would downgrade **12 of 91 runs — and on 4 of them every open gap is one nobody can ever close.**

**The specification assumed somebody always can.** Its table routes a gap by who closes it — us, the customer, or a person — and has no row for *nobody*. But `checkout_state` has no tool wired at all, `product_recommendation` comes back `unavailable`, `other_fact` is unsatisfiable by design so that a ticket whose real requirement cannot be named can never read as complete, and `promotion_eligibility: undetermined` is the vocabulary's own honest gap because the basket is invisible to us. Downgrading those hands a ticket to a person who can do no more about it than the agent could — the cost of a gate with none of the benefit.

**So closability is now a property of the vocabulary**, beside `asksCustomer` and `moot`, rather than a rule the gate invents. `gapClosability` returns `now` / `customer` / `never` / `unclear`, and **the order it reads in carries the whole argument**:

- **`other_fact` first**, because it is the escape hatch and failing towards a person is its job, not a gap to be closed.
- **The finding before the state.** `promotion_eligibility: undetermined` means a tool ran and still could not decide; that is a stronger statement than `attempted`.
- **`not_attempted` before `asksCustomer`.** A tool was allowed, the budget was there, and nothing called it — that is our miss, and putting a question to a customer we never looked for the answer to is the one outcome this whole layer exists to prevent.
- **`asksCustomer` before `unavailable`, but only where the question names the FACT — and neither plain ordering gets this right.** `unavailable` means no tool in this ticket's registry can settle the need, which on a cosmetovigilance ticket is every tool, deliberately; the customer can still be asked which product they used, which is exactly what CV-01 does. But `asksCustomer` is many-to-one, and on half the needs carrying one it names a **prerequisite** rather than the answer: `product_availability` asks for `product_name`, and being told the name does not tell us the stock — only `lookupStock` does, and `unavailable` is precisely the statement that it cannot run. Asking there costs a customer a reply and closes nothing.

  **`ASK_ANSWERED_BY` already draws that line**, so it is reused rather than restated. Written for `fieldsAlreadyAnswered` on the same observation — knowing an order's STATE does not mean holding its number, knowing its IDENTITY does — it reads forwards as "stop asking, we have it" and backwards as "asking would actually get it". Measured over the corpus: of the 20 `unavailable` gaps that carry a question, **13 name the fact and 7 name only a key**.

**`unclear` is kept as its own class** — attempted, nothing found, nobody to ask — and deliberately not folded into `never`. A knowledge gap somebody could write an article for is not the same as a fact that does not exist.

**`DESIGNED_GAP` moved out of the audit script and into the vocabulary** on the same reasoning, and the two sets are related but not equal: both describe a legitimate open need, but `photo_evidence: mentioned_not_attached` is one the CUSTOMER closes by attaching the photo, while `promotion_eligibility: undetermined` nobody closes at all. Collapsing them would have marked the drafting prize unclosable.

**Reported, not enforced, and that ordering is the point.** `product_property` was derived wrong until 2026-08-31; a gate enforced over that bug would have turned 8 correct `answerable` verdicts into handovers. The same discipline found this: the design was wrong in a way only the measurement showed.

### Findings are kept where tool data was correctly dropped (2026-09-03)

`ticket_investigations.findings_trace`: the derived findings after each tool call, in call order. Nothing reads it yet. It exists because the shadow replay that gates suppression cannot be built later over what is stored today.

**Neither existing store can replay a run.** `tool_calls` keeps `{id, tool, argsHash, outcome}` and drops every tool's `data` on purpose — but **8 of the finding derivations read that data**: `buyer_type`, `product_identity`, `promotion_validity`, `promotion_eligibility`, `customer_account_state`, `product_availability`, `photo_evidence`, `checkout_state`, which is the whole discriminator for promotions and for accounts. Rehearsal traces are no better: `toolEntry` keeps an allow-list of `data` fields chosen precisely so a column added later cannot leak into a stored trace.

**A replay over either would fail in the flattering direction.** Those findings score as absent, so fewer rules fire, so the run stops earlier — it would report rule-guided collection as cheap exactly where it is most likely to under-collect, which is the one error that would be acted on.

**Findings, not data, is what makes this safe.** A closed enum of a few dozen values carrying no personal data. Widening `tool_calls` was the other, wrong fix — it would undo a deliberate minimisation to serve a diagnostic.

**Built where `policy` and `reaction_report` are built**, in the investigation rather than the case file, for the reason all three share: that is the one place the ledger still carries each tool's `data`. And built as a **fold over ledger prefixes** rather than by instrumenting the tool loop — `resolveNeeds` is pure over its entries, so scoring `slice(0, n)` afterwards gives exactly what snapshotting live would have, and cannot perturb the run it measures.

**The whole vocabulary, not the declared needs.** Findings do not depend on the tool registry — only `state` does — so the wider scoring is free, and the row can never be recomputed: a trace scoped to today's needs could not answer a question about a rule set authored next month. Measured on a live promotions ticket: 7 calls, 23 findings each, **4.9 KB**.

**Full snapshots, not deltas.** A delta is derivable from snapshots; a snapshot is not recoverable from deltas if the reconstruction is wrong, and this store exists precisely because the recompute path is gone.

**NULLABLE, and the null is load-bearing**, the same argument `reaction_report` and `ticket_messages.attachments` already make. `[]` means the run made no tool calls; NULL means the row predates the column. A `not null default '[]'` would have stated the first about all 137 existing rows, and **their tool data is gone, so no backfill can ever correct it**. Every replay is therefore restricted to mail investigated after 2026-09-03 — which is the argument for writing it before the replay is built rather than after.

**On no projection.** `scripts/lib/tables.mjs` selects explicit column allow-lists, so a new column is invisible to drafting and to the detail panel until somebody types its name. Not an omission — the property that made adding this cheap.

### A need may be entitled to a positive finding it was never satisfied by (2026-09-03)

The vocabulary audit's rule was *only a satisfied need may make a positive claim*, and on the post-backfill corpus every contradiction it found was that rule being too strong. Four needs deliberately score a value that states **why they could not be settled**, and each says so in its own declaration:

- `photo_evidence: mentioned_not_attached` — « the customer saying a photo is attached is not a photo ». It is also the drafting prize: 36 of 203 tickets mention one and attach nothing, and « vous mentionnez une photo mais rien n'est joint » is a different reply from « merci de nous envoyer une photo ».
- `product_identity: ambiguous` — a tie between two products is precisely the case where the reply must ask rather than pick.
- `reaction_product: not_in_catalogue` — a real finding a rule branches on, and not a product we can name back to somebody reporting a reaction.
- `product_property: weak` — the library answered below the band that answers.

**A reason a need is open IS an evidence gap**, which is what the need was recording in the first place. The report was reading the value as a claim to have settled the need and calling it a disagreement.

**Checked on `attempted` alone, not as a blanket pair exemption** like `refund_state: none`, and the narrowing carries the whole argument. The same pair under `satisfied` is still a contradiction — a tie cannot also be resolved — and so is the same pair under `unavailable` or `not_attempted`, because a tool that never ran cannot have found a tie. Only where the tool actually ran is the value a finding rather than a fabrication.

**This is the third false positive of the same family**, after `promotion_eligibility: attempted + undetermined` and `refund_state: none`, and the pattern is now clear enough to state: the audit's two statements are independent by construction, so every exception has to be written down by the person who owns the vocabulary. Inferring them from `satisfiedBy` would cancel exactly the disagreements the report exists to find — the `product_property` bug of 2026-08-31 lived in that gap.

**`return_eligibility` stays reported and is not a fault.** Three coarse entries, `satisfied` with `unknown`, and `possible`/`out_of_window` have never once been seen: the returns window is a merchant parameter nobody has set, so every ticket resolves `unknown` and routes to a person. That is the documented behaviour, and it means no rule may branch on the two real values yet — the same dormancy as the six delivery rules.

### The situation is matched on the opening message, reversing an earlier call (2026-09-03)

The matcher read `triggerMessage`, the newest inbound. The test pinning that behaviour named the problem in its own comment — *"the bands were calibrated on each ticket's FIRST message; the run is triggered by the LATEST"* — and settled it by making the trigger unambiguous rather than by aligning the two. So a 0.65 threshold derived from one distribution was applied to another.

**The two are different questions.** The investigation asks *what does this customer need now*, which is the newest message. The matcher asks *what is this thread about*, which is the request that opened it.

**Measured on the ticket that exposed it.** A thread opening « je constate que ma commande #6686 du 28 juillet n'est toujours pas traitée » and closing « je vous confirme que j'ai bien reçu ma commande » scored **0.623 against O-12** — an address-change situation whose nearest phrasing merely shares « je viens de passer une commande » — on the last message, and **0.869 against O-09** on the first. Across the nine multi-message threads in the sample the opening message scored higher on six, and doubled the matches from 2 to 4.

**The trigger is unchanged.** `trigger_message_id` still keys the case file to the newest message, and the investigation still reads it. Only what the matcher is handed moved.

**Follow-ups remain an open problem and this does not solve them.** A thread that opens « où est ma commande » and becomes « finalement je veux être remboursé » still matches the first intent. What a later message should do to a situation already matched is undecided — in production every thread's opening message goes through the workflow and later ones are additive, so treating a follow-up as a fresh match would let a courtesy note redefine what a ticket is about.

### A rule may name a question; the case file decides whether to ask it

`policyAsks` pushed a rule's `ask` into `missing` gated on the verdict alone, never on what had been found. A rule names its question from the **evidence position it fired on**, and a position is not the whole dossier: a rule keyed only to a situation fires whatever else was established, so it could ask for an order number the run had resolved twenty lines earlier.

**Gated on the findings, because the rule is not the one that knows.** `fieldsAlreadyAnswered` reads the identity needs and returns the `MISSING_FIELDS` keys the dossier already answers.

**Only the identity needs can vouch for an askable fact, and that is the subtlety.** `asksCustomer` is many-to-one — five needs name `shopify_order_number` — but knowing an order's STATE does not mean we hold its number; knowing its IDENTITY does. `customer_account_state` is the one non-identity in the table and belongs there: every value but `unknown_sender` means we found the account.

**Suppression is per field, not per rule.** A reaction with no product named needs the product AND the batch number, so dropping both because one is held would be the mirror of the bug.

**Passed in rather than derived**, like `candidateOrder`: `case-file.mjs` imports nothing and stays a pure contract, so the investigation computes the set and hands over plain keys.

**What this deliberately does not do.** A need never attempted on a ticket whose registry could have settled it is also a question that should not reach a customer — but the answer there is to run the tool, not to drop the question, and this module cannot run tools. It stays visible as `not_attempted` in `evidenceGaps`.

### The dependency graph reaches the product family (2026-09-03)

Fifteen of twenty-five needs had no prerequisite declared and the whole product family was among them, so a planner walking this graph would have proposed a stock check before knowing which product. Thirteen now have one.

**`product_availability` requires identity and `product_property` does not**, which looks inconsistent and is the point. Stock is a fact about one variant, so without a product there is nothing to look up. A characteristic can also be settled by the library — « vos produits sont-ils testés sur les animaux ? » is answered without a product being named — and a prerequisite there would order a collection that does not need one.

**`product_recommendation` has none, deliberately.** It asks what we can put forward to somebody who has named nothing, which is the opposite end of the same subject; requiring identity would make it uncollectable exactly when it is the need that matters.

**`photo_evidence` and `purchase_verified` are ordered behind the thing they are about** — a photo of an unidentified product is a question nobody can act on, and an unverified purchase reads as « nous ne trouvons pas d'achat » only once we know who is asking.

A test now walks every need for a cycle, because `orderNeeds` falls back to declaration order rather than hanging — a bad edge would mis-order silently.

### A situation that requires evidence needs a branch for not having it

Nine situations whose answer requires an order had no rule for the case where no order number was given — D-02, D-03, O-12, O-13, O-14, D-05, D-06, D-08, D-36 — so they fired **nothing at all** on the commonest state in the corpus. Only O-09 and D-01 had that branch, and only because they were authored after `order_identity` gained a findings vocabulary.

**The pattern was already settled everywhere else**, which is what made the gap invisible: CV-01 covers it through `reaction_product: not_attributed`, P-15 through `customer_account_state: unknown_sender`, PR-25 through `product_recommendation: nothing_to_go_on`. The order family simply could not express it until the vocabulary existed.

**Two skeletons say something the others do not.** On O-12 and O-13 the ask is time-critical — an address change or a cancellation is only possible while the order has not left — so they say the number is needed quickly **and** are forbidden from implying that anything has been paused meanwhile. On D-36 the demand is answered first and the ask second, because asking for a number is otherwise indistinguishable from ignoring what was asked.

### Six rules are dormant because two delivery states cannot occur yet (2026-09-03)

Measured across all 2,006 orders: `dispatched_no_scan` **1,992 (99%)**, `not_dispatched` 13, `delivered` 1, **`in_transit` 0, `stale_in_transit` 0**.

Without the carrier feed nothing ever reports a scan, so every dispatched parcel stays in `dispatched_no_scan` permanently and the two transit states are unreachable. `colis_en_transit`, `d01_colis_en_transit`, `suivi_bloque`, `d01_suivi_bloque`, `d05_suivi_avance` and `d05_suivi_bloque` therefore fire on nothing.

**They are kept, not deleted**, on the same discipline `checkout_state` already has — listed and unwired, so the gap argues for itself rather than being forgotten. They are correct, and they are early.

**Two consequences worth stating plainly.** `expediee_sans_scan` is not an edge case: it is 99% of shipped orders, so for virtually every dispatched parcel the honest reply is « c'est parti, et nous n'en savons pas plus ». And **D-05 (« le suivi n'a pas bougé ») describes the normal state of the estate while the evidence to confirm it does not exist** — the customer's complaint is real and unanswerable today.

This is also why three proposed condition-only parcel rules were NOT written: two would have been dead on arrival and the third would have fired on one order in two thousand.

### The document is the corpus, and three situations had left it

`O-11`, `CV-04` and `A-35` were approved, embedded and matching real tickets while existing only in the database — `CV-04` carrying two rules and seven phrasings. The importer never deletes an exemplar that has left the document, so a row authored elsewhere survives every import in silence, and the document came to show 34 of the 37 situations the agent actually uses.

**Phrasings behave the opposite way and that asymmetry is the trap.** A phrasing added outside the document is pruned by the next import — R-21 lost « Vous n'avez d'étiquette pour le retour ? » to an import that had nothing to do with it. So the two halves of an exemplar have opposite failure modes: whole rows drift out of sight, individual phrasings vanish.

All three are written back, and the import now reports **37 parsed, 37 in the database, 0 stale**. A future divergence is visible in that one line.

### D-01 mirrors O-09 rather than merging with it

Both are settled by the same order states, so the two sets are identical today — which is exactly the argument for merging them, and the reason not to is dated rather than principled: **the carrier API will split them.** D-01 (« où en est ma commande ») will then be answerable from where the parcel actually is; O-09 (« pas encore expédiée ») never will be. A merge now would have to be undone then, and merges are judged on the ANSWER — which is about to change for one of them and not the other.

**The cost is that they must be edited in step**, and it is real. It is paid deliberately, and the duplication is written from a single list in one place rather than copied by hand across a dashboard.

**Condition-only rules were the alternative and were rejected on one row.** Dropping the situation would have covered the six-in-ten tickets that match nothing — but `commande_non_identifiee` fires on `order_identity: none`, which is true of « livrez-vous en Italie ? » as much as of « où est ma commande ». The situation is what licenses asking for an order number. The other seven would have been safe; one being unsafe is enough.

### A rule may never name a code

### The offer belongs to the rule, not to the reviewer

### Product questions need branches, not more exemplars

### `other` is reachable from every subject, because of what it means

### A product question comes in four shapes, and the matcher reported two

`matchProduct` answered "one product", "two products" or "nothing". Measured against the questions that actually arrive, that lost three distinctions:

| the question | before | now |
|---|---|---|
| « le coffret Caresse Temps Sublime » | **ambiguous** (a sample won) | matched, 0.83 |
| « la gamme Temps Sublime convient-elle… » | ambiguous | **range**, 12 products |
| « vos produits sont-ils testés sur les animaux ? » | no_match | `no_product_named` |
| « un lait solaire Caresse soleil suprême » | no_match | `partial_match` |

Device versus cosmetic needed nothing: `led` is in one of 98 titles, so IDF already makes it nearly decisive while « masque » spans fifteen and settles nothing.

### Samples were candidates for months, behind a filter that looked like it handled them

A sample's title is the range name plus « échantillon » — short, so almost fully covered by any question naming the range. « Caresse Temps Sublime - échantillon » outranked **both** real coffrets, and « gamme active énergie » resolved to a sample too.

`loadIndex` has claimed since it was written that samples are excluded. The query filtered `status = 'active'` — and the sample in the ticket that prompted that comment was `unlisted`, so it went away and the class looked closed. **Eight samples are `active`.** They are excluded by `product_type` now, which is why the title index loads that column, and `isCustomerFacing` states the rule where the matching reasoning lives rather than in a query.

Excluding them fixed the coffret case on its own, before any of the rest.

### A range is an intent read from the question, not a fallback for a weak match

« gamme » appears in **zero** of the 98 titles, so a range has no marker in the data — it is simply a phrase several products share. `buildRanges` computes those from the catalogue: adjacent word pairs spanning two or more products, where at least one half of the pair is distinctive. « temps sublime » and « active energie » qualify; « soin visage » names a category and does not.

**Derived, so next season's range works the day it syncs.** A hand-kept list would be wrong from the first product added to it.

**A cue is required, and that is the guard.** « Le coffret Caresse Temps Sublime jour et nuit » contains a family phrase and asks about one product; without `gamme` / `ligne` / `collection` in the question it stays an ordinary match or an ordinary ambiguity. The cue list is the one hand-written vocabulary in the module, and unavoidably so — there is nothing in the titles to derive it from.

**It yields to a confident match.** Both signals can be present: « la crème nuit Caresse Temps Sublime de la gamme anti-âge » scores 0.76 and is one product, while « la gamme Temps Sublime convient-elle… » scores 0.40 and is the family. Below 0.7 the cue wins.

`match` is null whenever a range answered, for the same reason it is null on ambiguity: a caller reading only `match` must never silently get one product where the honest answer was a family.

### `partial_match` claims only what it measures

Two ways to match nothing need opposite replies — a shop-wide question wants an answer, a mis-named product wants « de quel produit s'agit-il ? ». The split is the best raw title coverage, floored at 0.15. Measured:

```
vos produits sont-ils testés sur les animaux ?   0.000
100% de vos produits sont-ils vegan ?            0.088
faire évoluer ma routine de soins du visage      0.202   <- named nothing
un lait solaire Caresse soleil suprême           0.219   <- named something
le mode pulsé sur le masque qiriness             0.250   <- named something
la Crème Yeux Anti-Âge Regard d'Exception        1.000
```

The bands overlap, and the advice question sits on the wrong side. That miscall is cheap — advice is `recommendProducts`' job and this reason changes no reply — and separating them properly would need to know that « routine » is a request and « lait solaire » is a noun, which no token score can tell.

**It is deliberately not called `not_in_catalogue`.** A product the shop never listed shares no words with any title, so it looks exactly like a question that named nothing and lands in `no_product_named`. The limit is in the signal rather than the threshold, and naming the value for the stronger claim would have been a lie the tests would then have enforced.

### Coverage divides by the median title, because a verbose name was harder to say

Title coverage asked "how much of this name did they say", so every marketing word appended to a title made that product harder to identify. « Déodorant Bille Anti-transpirant 48H - Fleur d'Oranger 100% Naturel - Roll On - Sans Alcool » is 51 weight over twelve tokens; a customer writing « le déodorant fleur d'oranger » covered 13.5 of it and scored **0.265 — below vague questions naming no product at all**:

```
                                matched  titleTotal   ratio
le déodorant fleur d'oranger      13.53     51.0      0.265   <- correct, rejected
un masque pour le visage           4.08     14.6      0.280   <- vague, scored higher
une crème anti-âge                 4.54     14.7      0.309   <- vague, scored higher
```

The ranking was inverted, not merely low. The denominator is now `min(titleWeight, medianTitleWeight)`: identification needs only enough of a name that no other product fits, and past that more of it is redundant. The déodorant goes to 0.666 and matches.

**The median rather than a constant**, so it tracks the catalogue instead of dating — and so `matchQuestionToOrder`, which reuses this scorer over the two or three lines of one order, gets a cap sitting next to both titles that therefore never binds. The same reuse already forced `EXACT_TIE_GAP`; a hardcoded saturation would have broken it a second time.

**Measured against the live catalogue before and after, not just against the suite.** Every other case scored identically or moved slightly toward the right answer — « Caresse Temps Sublime »'s two real creams rose from 0.451 to 0.470 against the coffret leading them.

### PA-30 confirms the order and then stops, because no facture exists to send

`facture_commande_confirmee` routes to a person even when the order is fully identified, and that is the finished state rather than a gap waiting to be filled.

**Three separate things are missing, and any one of them is enough.** Shopify exposes no invoice PDF for a regular order — `statusPageUrl` is the customer-facing status page and `invoiceUrl` exists only on *draft* orders, where it is a payment link. No invoicing app's output reaches this database: the stored payloads contain no `invoice`, no `facture`, no document URL. And there is no outbound send path at all — `autoSendEligible` exists, nothing auto-sends, and `attachments` is inbound-only, so a PDF in hand would have nowhere to go.

**Confirmed 2026-08-31: the merchant has no way to produce a facture at all.** So this is not a plumbing problem to solve later; the document does not exist upstream.

**The order gate still earns its keep.** Identifying the order changes nothing about who answers, but it changes what they receive: a case with the order named, rather than a round trip that starts by asking. The skeleton forbids inventing a download link for the same reason the knowledge bands refuse a weak chunk — a plausible URL is worse than an honest hand-off.

### A trade buyer is a finding, not a category

Four tickets from professionals were filed as `payment` or `promotions`: a pharmacy and a company asking for invoice duplicates, an invoice reminder, and a €1,901.93 « facture définitive » request. The tempting fix is to teach the categoriser to send them to `b2b`. **It is the wrong fix on three counts.**

**`b2b` is not where they belong.** That set is trade *correspondence* — partner reorder POs, supplier dunning, freight quotes — and 22 of its 25 tickets are `request_kind: contact`. A customer asking for their invoice is `problem`, and filing it beside *Overdue Invoices Silgan Dispensing Systems* loses what it was about.

**The category is already right.** « Comment obtenir la facture définitive » IS a payment question; a pharmacy asking it asks the same question a shopper does. What was missing is who is asking — and that is the findings axis, the same split that stops a phrasing deciding a shipping status.

**Precision cannot be won from the text.** The first pattern tried here matched twelve job applications on « projet professionnel ». Any instruction strong enough to catch « prix pro » also catches « je suis esthéticienne professionnelle ».

**So `buyer_type` is derived from evidence.** Measured over all 574 inbound messages, six name a sum above the ceiling and all six are trade; no consumer ticket trips it.

**A MISSING ORDER IS DELIBERATELY NOT A TRADE SIGNAL**, though it was the first thing tried. Shopify not finding the order is why PA-30 asks for a number, but a mistyped reference or a guest checkout produces it too — inferring wholesale from it would misroute ordinary customers on the strength of a typo.

**The ceiling is a parameter, not `max(total_price)`.** A maximum ratchets: one trade order syncing into Shopify would raise the ceiling above itself and switch the guard off. 500 € sits above the 99th percentile (248,57 €) and the largest order ever placed (488,60 €), and is the merchant's to move.

**Parsing money was the hard part and was wrong twice.** Reading `.` as a thousands separator turned « 1605.71€ » into €160,571 and invented four trade customers; the correction then matched nothing; a third version read across a date, taking « 06/08 1605.71€ » as €81,605.71. The decimal mark is now decided per amount, a lookbehind refuses a start mid-number, and two decimals are the cap — which is what rejects « 8829,6201€ », two order references with a comma between them.

**A situation-less guard cannot pre-empt a situation rule**, and the first version of these rules was broken by it. `selectAnswer` ranks a rule naming the situation above one that does not *before* priority is read, so `client_professionnel` at priority 40 still lost to a PA-30 rule at 20 — and the pharmacy was asked for a Shopify order number, the exact failure the guard exists to prevent. The situation rules now carry `buyer_type: [consumer, unknown]` and decline the case themselves.

### The article names the product, because the matcher reads titles and the words are not in one

Measured, and it is not a threshold problem. « la batterie de mon masque ne tient pas », « la télécommande ne fonctionne plus », « il ne s'allume plus » identify nothing, because « batterie », « télécommande » and « s'allume » appear in no product title.

**Reading product DESCRIPTIONS instead makes it worse, not better.** Counted over the live catalogue:

```
"batterie"      2 products  -- NEITHER is the LED mask
"recharge"      7 products  -- on a cosmetic it means REFILL
"allum"         0 products  -- the mask never mentions lighting up
"telecommande"  1 product   -- the mask
```

« mon masque ne se recharge plus » would have matched seven refillable creams. So the identity comes from the other direction: retrieval finds the right article easily — those words are distinctive *because* they appear almost nowhere — and an operator has said which products that article is about. `knowledge_documents.product_ids`, denormalised onto chunks.

**Three gates, and each is one the matcher already enforces somewhere.**

- **It fills a gap, never overrides one.** A named product, a range, or an honest ambiguity all stand; a tag only speaks when the matcher resolved nothing. A customer's own word beats an inference about what they meant.
- **Top band only.** `searchKnowledge` drops every chunk when the *best* is weak, but an answerable result still carries weak chunks behind it. Letting one name a product would turn a retrieval the bands refused to answer from into a hard fact by a longer route.
- **Two articles disagreeing is an ambiguity**, exactly as two titles scoring alike is. Several products on ONE article is not — that is how a range is expressed, since ranges are computed from title bigrams and have no id to store.

**Never `reaction_product`.** Cosmetovigilance is where attributing the wrong product is actually harmful; which product caused a reaction has to come from the customer, not from which article was retrieved.

**`satisfiedBy` gained an optional `satisfies` predicate** so `product_identity`'s need and its finding read one helper. Those two answering differently is precisely the defect `product_property` carried until 2026-08-31. `KNOWLEDGE_NEEDS` counts only *unconditional* library sources, so the gap report keeps meaning "an article somebody could write" rather than "the title matcher missed".

**Not in `content_hash`.** Retagging rewrites the chunk rows and re-uses every stored vector — which products an article is about does not change a word of its text.

**Nothing fires yet, and that is content rather than code.** Measured against the live library, all four device questions return `verdict: none` — the only LED text is a marketing section scoring 0.477, under the 0.50 floor. The tag round-trips through the RPC; the article it needs does not exist.

### The bare name « Caresse Temps Sublime » resolves to a coffret that is not called that — open

Not caused by the median cap: **0.596 before and after.** « Caresse Temps Sublime » is the name of two live creams — `… Caresse Temps Sublime` and `… Caresse Temps Sublime Riche` — and the matcher confidently returns *Coffret Temps Sublime - Anti-âge*, whose title contains no « caresse » at all. It clears `CLEAR_MATCH` because a short title is well covered by « temps sublime » alone.

The gap is that **nothing penalises a leader for ignoring a distinctive word the customer used**. Coverage is measured in one direction only; a candidate missing « caresse » is not scored differently from one containing it. This is the exact class the module exists to prevent — quoting one product's ingredients at someone asking about another — so it is recorded here rather than left in a test.

The taxonomy defines `other` as « rien de ce qui précède » — so an article filed there is one whose subject the taxonomy could not name, and restricting it to tickets the categoriser also gave up on is the narrowest possible audience for the broadest possible content. It joins `faq` and `brand_story` as always-searched.

**Found by a real miss.** « Nos Points de Vente » — eight embedded chunks listing the shops that stock the brand — sat in `other` while « où puis-je acheter votre crème à Paris ? » arrived as `product`. The one article that answered it was the one the category filter hid. That article has been recategorised; this is the guard against the next one, and the principle is that **a mis-filed article should cost relevance, not reachability**.

It costs nothing today: `other` holds one empty draft, so the category list is longer and the result set is not.

### The retrieval fallback that was proposed, and why most of it already existed

A cascade was proposed for unmatched questions: search knowledge, then fall back to FAQ chunks, mixing in keyword search, verifying the chosen chunk, then escalating to agentic RAG.

**Three of those five already run on every call.** `searchKnowledge` issues dense (20) and lexical (20) **in parallel** over the ticket's category plus the shared ones, fuses them by rank, and bands the result three ways — `answerable` / `weak` / `none` — with `weak` never shown to a model. Sequencing knowledge *then* FAQ would issue two queries for rows one query already returns.

**The measured problem was not retrieval.** The library is **61 chunks** (faq 11, product 4, legal 18) and knowledge reached a reply in **3 of 93 investigations**. Of product investigations, **13 of 15 wanted an article and got none** — every other subject scores 0–1. An agent that searches harder over four product chunks finds the same nothing, several model calls later: the failure is absence, not mis-ranking.

**So agentic retrieval is deferred, and the condition for revisiting it is written down**: a report showing articles that EXIST and are not being found. That is not today's shape, and the cheap measurement is what would prove it either way.

### The gap report costs nothing per ticket, and that is the point

`npm run report:knowledge-gaps` reads `ticket_investigations.evidence_gaps`, which the investigation already stores, and joins it to the ticket the question arrived on. It writes nothing and runs no model. An agentic loop would answer the same question by spending a call per ticket, forever, to rediscover the same absences.

**`weak` counts as a gap.** A chunk below the band is one the model was never shown, so as far as the reply is concerned the library was silent.

**It reports the customer's own words, not the subject line.** Half this corpus arrives as « Nouveau message de client le 12 août », which names nothing — somebody deciding what to write needs the question, not the envelope.

**`KNOWLEDGE_NEEDS` is derived from `satisfiedBy`, never listed.** A hardcoded list would be a second statement of which needs read the library, and the day a fourth is added the report would quietly stop counting it — the one failure a report about missing knowledge cannot have. It is also what makes the report subject-agnostic: nothing in it knows about products, so any answer set gets the same output for free.

First run: **product 13 of 15 (87%)**, all but two of them `product_property` — the missing content is product facts (expiry dates, LED warranty, pulse mode, vegan status), not policy. That is the commissioning list, and it is the thing that moves the number.

Product questions vary enormously in CONTENT and barely at all in ASK. There are about five asks on this subject — advice, product facts, a defect, stock, brand policy — and unlimited content. Content is what `lookupProduct` answers; putting it in the exemplar corpus would mean matching by embedding what the findings already carry.

**The general/specific split is `product_identity`**, which has existed all along: `resolved · ambiguous · none · unknown`. « Quel produit avec celui-ci » names a product and « quel produit pour peau sensible » names a concern — the same ask, different evidence. So PR-25 stays one situation and gains phrasings for both shapes, and the branching happens in `when_conditions`.

Measured after adding them: an unseen advice wording matches PR-25 at **0.752** and the other four product exemplars keep their own tickets (PR-24 0.958, PR-26 0.930, PR-28 0.828). The one shape that does not generalise is « qu'est-ce qui va bien avec » at **0.551** — which is the argument for the branch rather than for more phrasings.

### The concern vocabulary joins two languages, and is not a tag normaliser

`peaux sensibles` is a tag nobody writes in an email; « ma peau tiraille » is an email nobody tags a product with. `product-concerns.mjs` holds the closed list in the middle: five readable concerns, each with catalogue `tags` on one side and customer `cues` on the other, plus `all_types` which is catalogue-only because nothing resolves to it from a message.

**Without it there is no left-hand side.** « Si le client a la peau sensible, proposer X » is only a rule if *sensitive* is a value something resolves to; otherwise it is a phrase a model re-interprets every time, and "which products do we suggest for sensitive skin" has no readable answer.

**IT IS NOT FOR CLEANING THE TAGS, which is what it looked like it should be.** The variant spellings are near-total overlaps — `peaux sèche` is on 56 products, all 56 also carrying `peaux sèches`; querying the plural alone misses **0** for dry, **0** for mature and **1** for combination. The duplicates are noise in the tag list, not gaps in coverage. An earlier note here claimed a query for `peaux sensibles` would miss things tagged `peau sensible`; it would not, because that tag is on no products at all.

Cues are deliberately conservative: « rougeurs », « démangeaisons » and « brûlure » are absent from `sensitive` even though a dermatologist would list them, because a cue that also appears in an adverse-reaction report would pull a cosmetovigilance ticket into product advice. The subject split happens upstream and this must not fight it.

### The tag reconcile runs on the sync that already happened

Tags arrive on every product with every sync, so there is nothing extra to fetch and no second list to keep in step — a separate "all tags" table would be a copy of `products.tags` free to go stale on its own.

**Scoped to the skin family, not to every tag.** This catalogue carries 190 distinct tags on the sellable products, and reporting all the unclassified ones would be a list nobody reads. `unclassifiedSkinTags` flags tags that look like they belong to this vocabulary and are not in it — four today: three descriptors (`eau de peau`, `effet seconde peau`, `soin de la peau`) and one real candidate, `peau terne et fatiguée`. Short enough to act on, which is the point.

### Recommending is curation, not inference — the tags cannot do it

The obvious build was "customer says sensitive → return products tagged sensitive". Measured, that returns **64 of the 90 sellable products**, because the merchandising is generous by design: `peaux sensibles` on 52 and « tous les types de peaux » on 52 more. That is right on a product page and useless in a reply. Narrowing helps only once: adding the `Apaisant` claim takes it to four — but claims are on **44 of 90 products**, so narrowing that way silently drops half the catalogue.

So `products.recommended_for_concerns` is a curated column, filled in on `/agent-setup/recommendations`, and **the tags are deliberately not a fallback**. An uncurated concern returns nothing and the reply hands off, because a shortlist of 64 reads like an answer and is not one. It is the same decision `promotions.offerable_in_replies` records, for the same reason: no property of the data separates "what we would put forward" from "what is compatible", and a customer acts on a product recommendation by buying it.

Both local columns survive the Shopify sync by not being in their mappers, and both mappers now have a test asserting that — adding either key would silently empty every choice on the next sync, which surfaces as the agent quietly recommending nothing rather than as an error.

### `recommendProducts` has two sources and they are not interchangeable

A named product resolves to `custom.cross_sell_products` — 198 links across 50 products, every one resolving, filled in by whoever set the catalogue up. « Quel autre produit irait bien avec celui-ci » is therefore a join and not a judgement, and it works today with nothing curated.

A concern resolves to the curated column. `not_curated` and `nothing_to_go_on` are separate outcomes because they need opposite replies: the first is a question the shop has not answered, where a colleague should advise; the second is a message with nothing to go on, where the customer should be asked.

**The skin concern is not an argument.** It is read from the message by `concernsInText`, a closed cue list over the customer's own words, so it cannot be a concern the model invented. What the model does supply is the product the customer says they already use — « je suis passée de X à Y » names two and asks about neither, which needs reading rather than matching.

The first build put the code picker on the drafting screen, beside approve/edit/reject. **That was the wrong place**, and the reason is the same one the whole rules layer rests on: a reviewer choosing a code per reply is a decision taken under time pressure that can come out differently for two identical tickets. Which code somebody who never received theirs is given is a property of the SITUATION, so it belongs on the rule — chosen once, applied the same way every time, and visible in the rulebook without opening anything.

It also moves the work off people entirely. With the code on the rule the agent writes the whole reply, and P-15 — seven tickets asking for the welcome discount — stops needing a human at all.

`support_answers.offer_code` is **the one place a rule carries a value rather than a condition**. Everything else it holds is a test against evidence; this is a commercial decision that changes with the season and cannot be derived from the ticket.

**No foreign key, deliberately.** The codes live in `promotions`, which the Shopify sync rewrites — a constraint would either block the sync or delete rules when a promotion expires. The code is re-checked at DRAFTING time instead, against the promotions that are still both `ACTIVE` and `offerable_in_replies`, and dropped if it is neither. That is the treatment `fillParameters` already gives a parameter nobody has set: the rest of the rule is still right, so the reply is written without the offer rather than held back or sent stale. It is dropped **loudly** — a code that has quietly stopped being offered is a rule that has quietly stopped doing what it was written for.

**The picker is a select, never a text box.** A typed code is a key, and a mistyped one reaches a customer looking exactly like a real one; they find out at the checkout. The options are what an operator cleared on the promotions screen, so a partner's 50% rate cannot be reached from the rule editor at all.

**And the prompt names it as a literal.** A discount code is the one thing in a reply a model must never compose — it looks like a word and it is a key — so it arrives under its own heading, to be reproduced character for character, with the instruction that an absent section means there is no code rather than one to find. Four tests cover the two directions: the code reaching the prompt, and a stale one being dropped with a warning.

**Two rules deliberately offer nothing.** `code_actif_ne_sapplique_pas` — their code works, and a second one would only muddy the answer. `newsletter_code_client_introuvable` — we cannot place the sender, so a welcome discount would go to somebody whose subscription we cannot verify.

### P-18 branches on validity, and covers every value it can take

`active` is the only branch that answers on its own — and it says only what is known: the code exists and is not expired. It must not say the code *will work*, because that depends on a basket we cannot see, and `eligibility_undetermined` forbids exactly that claim. The first draft of this skeleton said « le code est bien valable » and tripped the check; the distinction between confirming a code's existence and promising its result is the whole of that branch.

`expired` / `not_yet_started` / `inactive` and `not_found` route to a person and offer a live code instead. `not_found` is worded most carefully: it means we cannot find the code, never that the customer invented it — a partner code, a magazine, or an operation nobody recorded all land there.

A test asserts the branches cover **every** value `promotion_validity` can take, because the failure mode is a real ticket falling through to no rule at all, which is invisible.

`returns_address` held **"31 Welbeck Street"** — a London street that appears in no approved article and no ticket in the corpus. The approved Refund policy says returns go to **Qiriness, 33 Avenue de Wagram, 75017 Paris, France**. Nothing quoted the parameter yet, so nothing had gone out; R-21 is the rule that would have.

Corrected to the policy address. The two now agree, which is the point of holding the number once — a parameter that disagrees with the article it came from is worse than no parameter, because it looks authoritative.

Physical returns are routed to **DERET Logistics** in internal mail, so there may be a second address the warehouse actually receives. The customer-facing one is what the policy publishes, and that is what a reply may say.

### The approved returns policy contradicts itself, and every skeleton has to say so

The Refund policy is Shopify's template, lightly edited. Four paragraphs after promising a 30-day window it lists exceptions that include **« les produits de soins personnels (tels que les produits de beauté) »** — which is the entire Qiriness catalogue. Read literally, nothing this shop sells can be returned.

Retrieval can surface either half, and `policy_answer` is exactly how a returns rule reaches the article. So all four R-21/R-22 skeletons carry an explicit instruction never to tell a customer a product is non-returnable, naming the clause and why it is not to be relied on. **This is a workaround for a document that needs editing**, and it is written down here so the workaround is removed when the article is.

### `refund_state` was a need nothing could derive

R-23 (« sous quel délai suis-je remboursé ? ») has declared `refund_state` since the vocabulary existed, and there was no finding behind it — so every run scored it `unknown` and no rule could branch. The same shape `customer_account_state` was in.

It is now derived in `orderStates`, and it is **not `payment_state` under another name**. That one asks whether we are holding the customer's money; this asks where their *request* has got to, and the two part company exactly where the question gets asked — a return opened and not yet settled is `paid` to the first and `return_open` to the second, and `paid` is indistinguishable from a customer who has asked for nothing.

`return_open` is checked before the refund values, because a return in progress with no money moved is the state a reply must not describe as "nothing has happened". It resolves to `none` on every bundle today: `hasOpenReturn` is false on all 78, because returns are handled by mail and by the logistics provider rather than through Shopify's returns feature.

### The returns rules are written for a delivery date that does not exist yet

`return_eligibility` counts days from `delivery.deliveredAt`, and **4 of 78 bundles have one** — the same carrier-scan gap the DERET feed is meant to close. Setting `returns_window_days` did not unblock it; the missing date did.

The rules branch on it anyway, on the explicit decision to write for the tool that will exist. What that costs today is that `unknown` is the branch that almost always fires, so it is written to be a *good* answer rather than a holding one: the procedure for requesting a return does not depend on the window, so `retour_delai_inconnu` gives it in full and says nothing about the delay in either direction. `out_of_window` is the only branch that routes to a person, and it is careful not to read as a refusal — a goodwill gesture is a human's call.

**R-22 answers nothing, deliberately.** No approved article says who pays return postage. The policy mentions a label being sent once a return is accepted, which invites the inference, and the skeleton forbids drawing it: acknowledge, say a person will confirm, and move to what is certain. The rule exists to make the gap visible rather than to fill it.

### Two returns situations the corpus has and the exemplars do not

Scored against real customer wording rather than the thread's latest message — these are long threads, and the trigger message is usually a colleague's reply:

| | | |
|---|---|---|
| return address (R-21) | **0.834 / 0.876** | matched |
| return postage (R-22) | **0.764** | matched |
| refund timing (R-23) | **0.761** | matched |
| « vous n'avez d'étiquette pour le retour ? » | 0.640 → **0.959** | added to R-21 |
| **droit de rétractation** ×2 real tickets | **0.572 / 0.583** | no situation |

The label question was a real phrasing scoring just under the bar, and its answer is exactly R-21's — the label is issued once the return is requested and accepted. Added as a variant; the withdrawal cases were re-measured afterwards and did not move.

**The right of withdrawal has no exemplar**, and it is not R-21 with different words: it is a separate legal route, 14 days rather than 30, no reason required, and `withdrawal_days` is already set for it. It appears at least three times in the corpus with real customer wording. Worth its own situation.

### A-35 is the first exemplar written from no real mail

Nothing in the 400-ticket corpus is an account-deletion request. Searched for « supprimer / désactiver / fermer mon compte », « effacer mes données », « droit à l'oubli » and RGPD: one hit, a recruitment-check firm citing the GDPR, filed under `careers`. So the five phrasings are **authored**, and `source_note` says so — because two exemplars here (D-07, P-18) never win a ticket at all, and having no real phrasing is why.

**One invented phrasing was measurably bad and was dropped.** « Je ne veux plus de compte chez vous, merci de le supprimer » scored **0.632** against a newsletter unsubscribe — 0.018 under the 0.65 threshold, close enough that a slightly different message would have been answered with instructions for deleting an account. Removing it took that case to **0.578** and cost nothing: real deletion phrasings still match at 0.704–0.828, and login questions still go to A-29 at 0.899 with A-35 half a point behind.

### An explicit RGPD request leaves the agent entirely, and that is right

Measured on the live categoriser: « supprimer mon compte », « désactiver mon compte » and « supprimer le compte sous l'adresse X » all land on **`account`**, so A-35 is reachable. Adding « conformément au RGPD » sends the same request to **`legal_privacy`** — which has no tools, fails `isInvestigable`, and reaches a person untouched.

That is a feature rather than a gap. A formal erasure request carries a statutory deadline and a duty to verify identity; drafting one automatically is exactly the wrong economy.

**So the split is now stated in the glossary rather than left emergent.** It held on every phrasing tested, but it held by inference — neither line mentioned closing an account, and the model was reconciling « données du compte » against « données personnelles » unaided every time. The `account` gloss now names supprimer / désactiver / fermer and names `legal_privacy` as the exception, following the shape `cosmetovigilance` already uses to hand defective products back to `product`.

Re-measured after the change, twelve cases: the three deletion phrasings and « fermer définitivement » stay on `account`; RGPD, « droit à l'oubli » and a solicitor's letter all reach `legal_privacy`; and login, password reset, newsletter, a delivery question and a skin reaction are unmoved. `categorise.test.mjs` now asserts both halves of the boundary over the prompt source, plus that every subject in the enum has a gloss at all.

### Deletion is confirmed against the sender, never against a named address

The two rules split on whether the sending address resolves to a customer:

- **it does** → do not ask for anything, name what will be deleted without quoting the address, and route `needs_human` — the agent has no write tool and the deletion is a person's action, so the reply says it is *taken in hand*, never *done*.
- **it does not** → `needs_customer_input`, asking `account_email`.

**A named address is not an identified account**, which is the part that looks like an exception and is not. If somebody writing from X asks to delete the account at Y, we cannot verify they hold Y — so the question is still asked, and the reply invites them to write from Y instead, framed as a protection rather than a suspicion. Acting on the mention alone would let anyone close anyone else's account by email.

Retention — what survives a deletion for accounting reasons — is deliberately not stated in either skeleton. It names `policy_answer` and lets the approved privacy policy supply the sentence, the same rule every other answer follows.

Three sets and 29 rules is already past the point where the page is read rather than scanned. The filter is buttons rather than a `<select>` because the per-set counts are the reason to pick one and a dropdown hides them until it opens, and it appears **only when there is more than one set** — a filter offering a single option is a control that cannot do anything.

It filters the grouped sets rather than the rules, so the buttons always list every set that exists rather than only the one being looked at: a filter that hides its own way out is one you get stuck in. A set whose last rule is deleted while it is selected falls back to showing everything, rather than leaving a blank page with no visible cause.

Once the customer is known, the question "which product is this about" has a much better candidate set than 116 catalogue titles: the two to five things they actually bought. So `matchQuestionToOrder` scores the customer's wording against the last order's line items.

**The IDF weights still come from the catalogue.** An index built over three line items gives every token the same weight and collapses the match to plain word overlap — `creme` would count as much as `led`. So `product-lookup` lends its `catalogueIndex()` and only the *entries* are swapped. Shared rather than rebuilt: a second index would be a second answer to "how rare is this word", and it would also re-tokenise the whole catalogue.

**Ambiguity is checked before absence, and the order is load-bearing.** `matchProduct` returns `match: null` on a tie, deliberately, so a caller reading only `match` cannot silently receive one of two. Testing `!match` first reads that tie as "nothing matched" and would tell a customer their product is not in an order that contains both candidates. There is a test named for it.

The cost is stated rather than hidden: someone writing about a product from three orders ago reads as `not_in_last_order`, which is why that verdict is worded « il peut venir d'une commande antérieure ou d'un achat en boutique » and never as "you did not buy this". One order also keeps this close to the data-minimisation line `customer-context.mjs` already holds — it carries no order history beyond the aggregate, and this widens that by exactly one order's line items, for one question.

### Photo evidence is two signals, and they disagree

`checkPhotoEvidence` reports what the customer *said* and what actually *arrived*, separately. On the real corpus those agree far less often than they diverge, which is why collapsing them into one boolean throws away the case worth acting on.

**Measured over 203 tickets after backfilling attachment metadata: 7 carry a real photo, 36 mention one and attached nothing, 160 neither.** The 36 are the drafting prize — « vous mentionnez une photo mais rien n'est joint » is a different reply from « merci de nous envoyer une photo », and only a two-signal check can tell them apart. Of the 7 with a photo, 6 are `delivery/problem`, `return_exchange/problem`, `order/problem` or `product/problem` — exactly the breakage cases.

**`has_attachments` alone could never have done this.** It is one boolean, and the two largest attachment groups in this mailbox are careers CVs and b2b catalogues. The dry run over the first 12 rows found an LED-mask manual, four invoices, a packing list, two purchase orders and the T&Cs — all of which the boolean reported identically to a photo of a broken bottle. So ingestion now fetches Graph's attachment metadata (`name`, `contentType`, `size`, `isInline`) and `$select`s around `contentBytes`, which would otherwise pull a customer's multi-megabyte photo through the worker to answer a question four scalars settle.

**A signature logo is the false positive to beat, and `isInline` alone does not beat it.** A customer who pastes a photo into the body also produces an inline part, so excluding all inline images drops the evidence. The rule is a name pattern (`image001.png`, `logo`, Outlook placeholders) plus a 50 KB floor on inline images: the corpus's signature logos are `image001.jpg` at 30 KB and the real photos are 400 KB–2 MB, so the gap is wide and the raw counts still travel in the result for a caller that wants its own rule.

**`attachments` is nullable and the null is load-bearing.** `[]` means we asked Graph and there was nothing; NULL means we never asked. A `not null default '[]'` would make those identical and let the check report "no photo attached" about a message whose own flag says otherwise — so a flagged message with no metadata reports `attachment_type_unknown`, which beats `mentioned_not_attached` precisely so nobody is asked to resend a photo they already sent.

### The photo is shown, and still not stored

**The panel renders the customer's photo, fetched from the mailbox when a browser asks and kept nowhere.** No bucket, no `bytea`, no file on disk. `web/lib/server/attachment-service.ts` resolves the part, `GET /api/tickets/[id]/attachments/[index]` streams it, and the bytes exist only in that response.

**Fetch-on-demand rather than a store, decided 2026-09-09 before anything was built.** The alternative was a Supabase Storage bucket: faster, survives the mail being deleted, and net-new infrastructure — there is no Storage usage anywhere in this repo — that would need a retention job and redaction-webhook deletion *before it could hold its first byte*. Proxying keeps the compliance question at "who may look at this" instead of also "what do we now keep, and for how long", and `SHOPIFY_PERSONAL_DATA_PROTECTION.md` line 85 is explicit that adding personal-data retention is not something to do in passing. A parcel photo can carry a face, a doorway or an address label; it is the least minimisable data this project touches.

**The price is paid per view and it is small.** Two Graph calls — list the message's parts, then `/$value` for the one we want — because the Exchange attachment id is deliberately *not* stored (see below). Measured over the whole corpus: **35 of 37 image parts resolve, 2 have left the mailbox, 0 mailbox mismatches.** A photo that has left is a permanent hole, which is the honest cost of not keeping a copy, and the panel says so rather than showing a broken image.

**THE INDEX IS THE AUTHORISATION MODEL.** A request names a ticket and an offset into the images `listTicketAttachments` derives for that ticket; the server rebuilds the same list and resolves the offset itself. Nothing that is not already in the ticket's own stored metadata can be addressed, so no crafted id reaches another customer's mail, and the furniture rules stay load-bearing — a signature logo is not in `images`, so it cannot be requested either. Exchange ids are never accepted from a browser and never rendered into a page: `toPublicAttachments` strips `messageId` and `partIndex`, and a test asserts the id is absent from the serialised payload, because the dashboard still has no authentication and anything it returns is readable by anyone who opens it.

**Images only, and the STORED content type wins.** The list also holds CVs, catalogues and invoices; the route refuses them, because streaming arbitrary files out of the support mailbox is a different feature from showing a photo of a broken bottle. And the type served is the one we stored and classified, never the one Graph currently reports — letting a mailbox decide what a URL on this origin renders as is the shape of a stored-XSS bug. `nosniff`, `sandbox`, `no-store` and `no-referrer` go with it.

**8 MB cap, as a refusal rather than a truncation.** Half a JPEG is a corrupt JPEG, and the corpus holds a 12 MB video and a 12 MB image. The panel says "too large" and the operator opens Outlook.

**`next/image` is refused deliberately.** It would proxy the URL through the Next optimiser and write the result into `.next/cache` — customers' photos on the server's disk with no retention rule attached, which is precisely the property this design exists to keep. The lint rule is disabled at the call site with that reason.

**The Exchange attachment id is still not stored, and that is the one thing worth revisiting.** Storing it at ingestion would make this one Graph call instead of two. It is left out because `ticket_messages.attachments` is metadata that outlives the mailbox, and a mailbox-scoped handle stored beside it is a stale pointer waiting to happen — the same reasoning that keeps `contentBytes` out of the ingestion `$select`. If per-view latency ever matters, that is the trade to make, with a backfill behind it.

### The mailbox mismatch that blocked this is gone

**`SUPPORT_MAILBOX` is `contact@qiriness.com`, the mailbox the corpus was ingested from.** Measured 2026-09-09 against the live API: attachment metadata resolves for stored messages, and 35 of 37 stored photos can be fetched with **zero** `ErrorInvalidMailboxItemId`.

**Several documents said otherwise and were wrong.** `README.md` step 3 and the notes that referred to it described every stored `graph_message_id` as unusable because the variable pointed at `onouailhetas@lap-groupe.com`. That was true when it was written and stopped being true when the variable changed; `.env.local` is gitignored, so nothing in the repo could have caught it drifting back. **The lesson is the one this file keeps relearning: a claim about configuration is a measurement with an expiry date, and it belongs beside the check that produced it.** The spam-body backfill and `/forward` were blocked on the same premise and should be re-tested rather than assumed broken.

### A signature separated by an underscore was being read as a photo

**`\b` does not exist between `Signature` and `_`, because `_` is a word character.** So `Signature_6C20675392446.png` — 12 KB, not inline, unmistakably corporate furniture — passed the name pattern and was counted as a customer's photo. `FURNITURE_NAME` now ends in `(?![a-z0-9])`, which is what the pattern meant before `\b` was reached for as shorthand.

**This is the second time this exact trap has been sprung in this file.** The `cliché` pattern above carries the same note: `\b` is ASCII-only, so it does not exist after `é` either. Two bugs from one shorthand is the argument for the lookahead being the default here rather than the exception.

**Measured before changing it: 1 part in 115.** Across every inbound image part in the corpus, exactly one changes classification — that file, on ticket `6ad65501`, a `delivery/problem` whose case file read `photo_evidence: attached` while the ticket carried no photo at all. So the corpus's real-photo count is **15 tickets, not 16**, and one case file was wrong in the direction that matters: it told the agent evidence had arrived.

**`Signatures.png` is still not furniture, deliberately.** The lookahead stops at the word, so a plural or a longer word starting with the same letters — `signatures-bon-de-livraison.jpg`, a photographed delivery note — stays evidence. Widening further would start eating the thing the rule exists to protect.

### Neither new tool goes near `cosmetovigilance`

An adverse-reaction report is the one subject with an empty tool set, and both of these stayed out of it. The reasoning is unchanged and gets stronger here: assembling a confident-looking answer is worse than assembling none, and "we cannot find any order for you" is a particularly bad thing to put in front of someone reporting a reaction to a product. It goes to a person untouched.


**REVISED 2026-08-30 — one lookup, and a rule that refuses to answer.** The set is no longer empty: `lookupCustomer` is in it, and the subject is in `ENABLED_SUBJECTS`.

**What changed is the question being asked.** The paragraph above is about ANSWERING, and it still holds — every order tool and `verifyPurchase` stay out, because « nous ne trouvons aucune commande à votre nom » is exactly the sentence they produce and exactly the one that must not reach somebody reporting a reaction. What was never separated from it is GATHERING. A person picking up one of these tickets needs to know who wrote in and what they last bought, and was going to Shopify for it.

`lookupCustomer` answers the first. The second arrives free: `lastOrderLookup` is not in the tool table at all — it runs outside the model's loop and lands in `candidateOrder`, which the human brief renders and the drafting prompt does not. So the context reaches the person and never the reply.

**Giving a subject tools makes it investigable, and an investigable ticket is a draftable one.** That is the risk the empty set was really buying, and an empty set is a blunt way to buy it. The `cosmetovigilance` answer set now carries one rule — no situation, no conditions, `route: needs_human` — so every ticket in the subject is pinned to a person whatever the evidence says. **Tools gather; the rule refuses to answer.** The level 4 override is untouched: a hospitalisation still strips every tool.

The evidence checklist is one item — *the customer is identified* — and names nothing about the reaction. What caused it, whether the product is implicated and whether anything is owed are the judgements a person makes, and a checklist naming them would invite the case file to answer them.

### The reaction tool records attribution, and attribution is not causation

**REVISED 2026-08-30 again — a third tool, and rules that answer.** `identifyReactionProduct` joins the set, and it is the one product tool this subject gets.

**`lookupProduct` is still out, and the difference is the whole point.** It answers *which product does this message evoke*, and a reaction email routinely evokes three: the one that was used, the one used before it, and a competitor's. « J'utilisais Untel sans souci, depuis que je suis passée à Machin j'ai des rougeurs » names two products and blames one, and picking "the product this ticket is about" from that text is a coin toss — which would then be written into a reaction record. It also returns the ingredient list and the usage advice, which are the raw material for *« ce produit contient X, ce qui peut expliquer… »*, the one sentence this desk must never send.

So the model says which product the customer **blames** and the tool resolves that name against the catalogue. The reading is the model's; the identification is not. It returns an identity and nothing else — the product sheet is fetched, used to confirm the name exists, and dropped.

**Four outcomes, and `not_attributed` is the useful one.** It means the customer described a reaction and named no product, which is the case where the reply has to ask — and it is a positive finding rather than an empty lookup, because the model reached it by reading. `unknown` is the tool never having run, and the two must not collapse: the rule that asks *« de quel produit s'agit-il »* is right on the first and asks a customer a question we never looked into on the second.

**`reaction_cause_unestablished` is raised on every outcome, including success.** Every other caveat fires when something could not be established; this one fires hardest when something was. Naming the product a customer blames is the moment a reply is most tempted to agree that it is to blame. It forbids the denial too — *« ce produit ne peut pas causer cela »* is the same unfounded safety claim with the sign flipped, and it is the one a reply defending the brand reaches for. It is **mechanically checked** rather than advisory, because a causal claim in French needs a causal verb and that has a signature; the ingredient clause catches *« en raison de la présence de … »*, which is how a reply reaches a diagnosis without using one.

**The record is lifted out of the ledger because the ledger loses it.** `tool_calls` keeps `{id, tool, argsHash, outcome}` and drops every tool's `data`, so one word survives the run and the product and the symptoms do not. `ticket_investigations.reaction_report` holds them, nullable rather than `'{}'`: an empty object would have to mean both *no reaction was reported* and *one was, with nothing identified*, and those need different replies. It is on the detail projection and deliberately not on the drafting one — a reply that needs to name the product already has it as an **established fact** cited to the tool call that resolved it, and offering a model the unchecked copy beside the checked one is the split this codebase draws everywhere else.

### The cosmetovigilance rules answer, and a person still releases them

**Seven rules, 2026-08-30**, replacing "one rule that refuses to answer" — which stays as the catch-all beneath them.

The protocol itself — stop using the product, check whether several were layered, reintroduce cautiously once symptoms have gone — is now a rule's **skeleton** rather than a knowledge article retrieved by similarity. That was the point of the layer: an instruction fetched by cosine distance is an instruction that arrives or does not depending on how the customer phrased their email.

**CV-01, CV-02 and CV-04 branch on `reaction_product`, and CV-03 does not.** A question about whether a product suits a medical condition is not a reaction report; it gets its own rule, routes to a person, and answers nothing. Every reaction situation splits two ways: the product is known, or the customer never named one and the reply asks which.

**The ask rules route to `needs_customer_input`, not `needs_human`, and the schema is what decided it.** `support_answers_ask_needs_route_check` refuses an `ask` on any other route, because the drafting stage would otherwise hold a question and a verdict that does not permit asking it. This is a *lighter* route than the blanket `needs_human` these tickets used to get, and it is safe for the reason the whole route mechanism is: `applyPolicyRoute` only ever tightens, so an investigation that concluded a person is needed keeps that verdict and the rule loses.

**CV-02 and CV-04 carry the same answer, stored twice.** A severe reaction and a refund demand after a reaction both get the batch number asked for, a photo invited without insistence, and a note that the team has the request — so the two rows are identical but for their keys. That is exactly the shape the tie-break had to be widened for, and the pair now resolves instead of falling through.

### `ask` is a list, because one reply can need two facts

`support_answers.ask` was a single `MISSING_FIELDS` key until 2026-08-30, and nobody had checked whether one was enough. It is not: a reaction reported with **no product named** needs the product *and* the batch number, and with one slot the rule had to drop one — turning a single reply into two round trips with somebody waiting on an answer about their skin. `missing` on the case file was already a list; this column was the only narrowing between a rule and it.

**`text[] not null default '{}'`, so "asks nothing" has one representation.** The singular column was nullable and the route constraint turned on `ask is null`; an empty array beside a null would have been two ways to say the same thing, which is precisely the shape that produced the earlier three-valued-logic bug in that same constraint. The check is now `cardinality(ask) = 0 or route is not distinct from 'needs_customer_input'`.

Both readers tolerate a bare string, so a row or a caller written against the singular shape does not silently save a rule that asks for nothing — which would be invisible, because `buildCaseFile` turns a `needs_customer_input` verdict with nothing to ask for straight back into `needs_human`.

**Only the severe path asks for both.** CV-01 with no product named asks which product and stops: it never asks for a batch number when the product *is* known, so asking for one only when it is unknown would be incoherent. Traceability to a manufacturing lot is what a severe reaction or a refund claim needs, not a mild one.

**Widening the column exposed an older bug, and it was the more serious one.** A rule's questions were pushed into `missing` only when the ROUTE changed the verdict — so a rule that *agreed* with the investigation contributed nothing at all. Found on the live reaction ticket: the model had already reached `needs_customer_input` by itself, the route therefore changed nothing, and the rule's « quel produit utilisiez-vous » and « quel est le numéro de lot » never arrived. The reply asked whatever the model had thought of instead, which is the non-determinism this whole layer exists to remove — arriving through the one branch where the rule and the investigation agreed.

The questions now travel whenever the FINAL verdict is `needs_customer_input`, which loosens nothing: a rule asking for the batch number against an investigation that concluded a person is needed still loses, because the route could not tighten `needs_human` downward and the branch does not run. The questions only ever join a reply that was already going to ask.

### Cosmetovigilance has its own draft-only switch

`DRAFT_ONLY` asks *has auto-send graduated*; `DRAFT_ONLY_COSMETOVIGILANCE` asks *is this the kind of mail that may ever send itself*. Both default to true and **both must be false** before a reaction ticket can send itself. Folding the second into the first would mean the day the desk graduates is the day cosmetovigilance does, and a wrong reply to somebody describing a skin reaction is not the same size of mistake as a wrong reply about a promotion code.

**It lives in `autoSendEligible`, not beside `DRAFT_ONLY`,** and that placement is the argument. `DRAFT_ONLY` is a rollout switch that gates a send path; this is a property of the subject, which puts it alongside the three conditions already there — the level, the customer's mood, and the mechanical checks. It also keeps the stored column honest: `auto_send_eligible` is the measurement auto-send will eventually be graduated on, and a cosmetovigilance draft recorded as *would have sent* would inflate exactly the number that decision reads.

It **defaults to excluded**, so a caller that has not wired the config gets the safe answer rather than the permissive one. A second subject wanting this should turn the pair into a list rather than add a third boolean.

### The matched situation is recorded and acted on by nothing

Exemplar retrieval runs beside the investigation, on the message that triggered the run, and its result reaches `ticket_investigations.exemplar_match` and nowhere else. `investigate()` is never told; a test asserts the key never appears in its input.

**The independence is the measurement, not caution.** Two declarations of what a ticket requires now exist — the exemplar's authored `requirement_needs` and the run's own `evidence_gaps` — and comparing them answers whether the corpus describes real tickets. Feed one into the other and the comparison becomes circular, answered once and permanently lost. `npm run eval:exemplar-needs` is the report, and it excludes by name any row where the exemplar supplied the needs.

Three supporting reasons: a wrong match would inject a wrong situation's needs, and restraint at 0.65 is 85% on the subject proxy; enforcing it would make the *second* source load-bearing while the first still is not; and on current bands it would fire on a minority of tickets anyway.

**It cannot break a run.** Every failure path returns `{}` and logs. It costs no extra API call either — `findInboundMessages` selects `embedding`, so the match reuses the vector ingestion already wrote.

**One asymmetry to remember when reading the numbers:** the bands were calibrated on each ticket's *first* inbound message, and the match is taken on the *trigger* message, which for a thread is a later one. Expect the two to disagree on follow-ups.

### The exemplar stands in only when the decomposer produced nothing

`decompose.mjs` deliberately invents no needs when its call fails — guessing from the category would put fabricated requirements into the very numbers the field exists to measure. A matched exemplar is not that guess: it is a list a person wrote for a situation that cleared the MATCHED band, so it stands in rather than reporting "nobody said what this required".

**Only there.** While the decomposer has spoken the exemplar is ignored entirely, because the moment it can top up a *successful* decomposition the two stop being independent. `caseFile.needsSource` records which source spoke (`model` / `exemplar` / `none`) and the row is stamped `supplied_needs`, so the comparison never measures a list against a copy of itself.

### The worker sees open tickets only; a person may widen that, and a widened run never moves a ticket

`PASSES.investigation.where` is `{status: 'open', needs_categorisation: false}`, so the pass never spends the mid tier on a thread the queue has moved past. That is right for the worker and wrong for a backfill: auto-close retires a thread after 28 days of silence without clearing its pending flag, so an **imported historical corpus** ends up with work no poll can claim — measured 2026-08-17 at 113 flagged tickets and 0 claimable. On live mail this never arises, because a ticket is read within a poll of arriving.

`claim({anyStatus: true})`, reachable only through `investigate --include-closed`, drops the **status narrowing and nothing else** — flag, categorisation, `archived_at` and the soft-delete all still apply. It is a per-call argument that no pass descriptor can set, because a worker quietly investigating closed mail would be a bill nobody asked for.

**And the verdict does not move a ticket it did not claim from the open queue.** 65% of verdicts map to `awaiting_human` or `awaiting_customer`; applied to a backfill that would resurrect dozens of settled threads into the live queue. The case file is a note about the thread, not a reason to reopen it — so `nextStatus` is computed only when the ticket was open. The status write had no test until this change went in beside it, which is why one was added in both directions.

### A 429 waits out the window (2026-09-14)

gpt-4o on this account is capped at **30,000 tokens per minute**. The transport retried a 429 three times at 250 / 500 / 1000 ms — under two seconds in all — so on the first from-scratch investigation run about half of some ten-ticket batches failed, each failure spending one of the ticket's three attempts before it is abandoned towards a human. A per-minute limit cannot be outlasted in two seconds.

A 429 now waits OpenAI's own hint (`retry-after-ms`, `retry-after`, then the `x-ratelimit-reset-*` clocks), or 2 s doubling without one, clamped to 0.5–60 s, for up to **six** retries — about two minutes worst case. A 5xx and a transport error keep the short backoff and three retries: those are blips, and waiting a minute on them would stall the worker for nothing. The retries are still not `llm_usage` rows, for the reason in § Insights.

### A repaired ticket is re-queued by name, and may be reopened (2026-09-14)

`tickets:requeue` exists because the repair tools change what an investigation read — the requester, and through it the customer — without touching the case file already written from the old values. `investigate --backfill` re-raises the whole open queue, which is the wrong tool for five tickets.

**`--unlink-customer`** calls `record.unlinkCustomer`, the first path that ever clears `customer_id`. Customer resolution only looks at unlinked tickets, so a link made from a colleague's address was permanent. The resolution trail is kept deliberately: it records the hash the old attempt used, and a changed requester is what lets the next pass try again.

**`--reopen`** is the deliberate exception to "a widened run never moves a ticket" (§ The worker sees open tickets only). That rule protects a status somebody chose. A status written minutes earlier by a run against the wrong identity was chosen by nobody, and left in place it would outlive the corrected verdict. It is a flag a person passes per ticket, never a default.

### One investigation per inbound message

`unique(shop_id, trigger_message_id)` is the idempotency key, so a reply produces a new reading instead of overwriting the previous one and the thread's trajectory survives as rows. `context_ref` **points at** `tickets.resolved_context` rather than copying it, so personal data is not duplicated per run. `customer_id` is denormalised and indexed: that is the seam Phase 7 memory hangs off.

---

## Forwarding

Runs last, after categorisation, because it reads the category and kind that step assigns.

`forward-rules.mjs` is the whole decision: `request_kind = 'contact'` **and** the category has an address in `category_forwarding`. Both halves are load-bearing — routing on category alone would divert genuine `b2b` reorder problems as FYIs, and the taxonomy already restricts `contact` to b2b, partner_collaboration and careers (38 of 330 customer-facing tickets on the measured corpus).

The covering note is in French (internal mail, French company), and sidesteps both tu/vous and gender agreement by never addressing the reader and referring to `le message` rather than a pronoun agreeing with the category phrase.

Sends via Graph's own `/forward` action, so the recipient gets the original mail with attachments intact (a CV arrives as a CV) rather than a re-composition of the stripped `body_text` we store. **Needs the `Mail.Send` Graph application permission** — the only write this worker makes to Graph; without it every attempt lands as a `failed` row rather than silently doing nothing.

### A null address is the off switch

There is deliberately no separate `enabled` flag, because two ways to express the same state can disagree. Keyed by category rather than `responsible_team`: the team mapping sends `careers` to `contact`, the generic bucket the mail just came from.

### `unique(ticket_message_id)` is what makes the pass safe to re-run

Per message, not per ticket, so a candidate's follow-up still reaches the recipient exactly once. The ledger snapshots the category + address used, so re-routing tomorrow does not rewrite where mail went yesterday. Failures are rows, not silence — a Graph rejection stays visible and retryable.

---

## Lifecycle

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

---

## Embeddings

### Every stored message is embedded; only approved knowledge chunks are

The corpora differ because their gates differ: a chunk holds a vector **iff** its parent document is currently `approved` and not brand-voice, and the vector matches the current input hash + model + dimensions — whereas a message is part of the corpus by virtue of existing.

Both share one determinism quadruple (`embedding_model`, `embedding_dimensions`, `embedded_input_hash`, `embedded_at`), so a re-run over unchanged text is a no-op for either. Verified on real data: 348 messages embedded, second run embedded 0.

Message hashes are additionally salted with the quoted-reply stripper version, so changing how history is stripped correctly invalidates every message vector without the version ever reaching the model. `embedded_input_hash` covers title + category too, so a rename invalidates the vector even though `content_hash` ignores it.

Unapproving regenerates chunks vectorless. Embedding runs both inline (on approval, best-effort) and via the reconciler.

### A subject we wrote ourselves is not a subject (2026-09-01)

The subject is prefixed to every message embedding because support subject lines carry real signal — « Colis bloqué », « remboursement commande #5229 ». On 39% of inbound mail it carries the opposite.

**Two shapes, and the second is the dangerous one.** « Nouveau message de client le 7 août 2026 à 09:51 » is the contact form notifying us: no content, and a date that hundreds of unrelated tickets then share. « Votre commande est confirmée » is the order mail the customer hit reply on — so a complaint that nothing arrived is embedded under a heading saying it was confirmed. Measured: O-09 (« pas encore expédiée ») outranked D-01 (« toujours pas reçue ») on exactly such a ticket.

**The argument already existed one file away.** `buildEmbeddingInput` excludes the category from knowledge chunks because "a constant contributes nothing to ranking while diluting the actual content". Nobody had applied it to the query side, where 39% of queries carried one.

**Matched on the subject only, never the body.** A customer writing « votre commande est confirmée ? » in a sentence is asking us something. Reply and forward markers are stripped first, because « RE: RE: Nouveau message de client » is the same worthless heading three replies later.

**Measured twice.** On 60 near-band tickets: 9 crossed into `matched`, 0 fell out, margin +13%, relevance proxy unchanged at 33/60. Across the whole corpus after re-embedding: matched 120 → 123, and the ≥0.80 band 24 → 38 — the gain is mostly in CONFIDENCE rather than in count, which is what removing a diluting constant should do.

**What it does not fix.** « Je n'ai toujours pas reçu ma commande » rose 0.606 → 0.628 and still misses: four lines of substance under a name and an Outlook footer. Mail-client footers survive in only 4% of embedded text, so there is no second lever of this size — the remaining near misses are short bodies, not noisy ones.

### One reconciler, three descriptors

The three embedded tables each had their own ~160-line script around the same five steps: find the rows that may hold a vector, read them, hash-gate, write what changed, clear vectors off rows that must not keep one. The pure part — the staleness gate in `embed-chunks.mjs` — was extracted and tested; the loop around it was copied three times and tested nowhere, which is where the interesting failures live, because the gate cannot be wrong about a row nobody read.

`lib/embeddings/reconcile.mjs` is that loop, once. A descriptor answers one question per table — **which rows should hold a vector** — as a parent (optional: `ticket_messages` has none, since every stored message is part of the corpus), a child, and the same question backwards for the orphan sweep. `--limit` caps parents where there are parents and rows where there are not. The three `embed:*` commands and their three reports are unchanged; what they no longer each own is the loop.

Collapsing them closed a live hole: the knowledge and exemplar orphan sweeps used a plain `supabaseSelect`, which PostgREST caps at `db-max-rows` (1000) with a 206 and no error — so past a thousand embedded rows they simply stopped seeing orphans. The message reconciler had already been fixed for this; now all three page.

### The category is never embedded

Retrieval always filters by category first, so embedding the category name into a chunk adds a near-constant to every candidate in the filtered set — no discriminative value, and it dilutes the content. `title` carries the topical anchoring instead.

---

## Exemplars

The recurring situations a customer writes in about — 32 of them, derived from 248 real messages — stored as a question plus every real phrasing of it, and matched against an incoming ticket.

### Separate tables, not a knowledge category

An article answers a question; an exemplar **is** one. Two things follow. `requirement_needs` must be constrained against the investigation vocabulary and a knowledge document has nowhere to put that. And separation by *table* means retrieval can never reach an exemplar while looking for policy — separation by category value would depend on `categoriesToSearch()` never returning it, which is a promise about future code rather than a property of the schema. A customer asking « où est ma commande » retrieving a *question* as though it were an answer is the failure being designed out.

Otherwise the mechanics are knowledge's, deliberately: exemplar is to phrasing what document is to chunk, so the staleness gate, the determinism quadruple and approve-gates-the-vector are reused rather than reimplemented.

### The variants carry the retrieval, not the canonical question

The query side is a whole customer email — long, misspelt, half-polite. A canonical question is short and tidy, and comparing them compares two registers. The variants are real phrasings, so they match messy-to-messy. That is the entire reason a phrasing is a row rather than a column.

**A phrasing is embedded alone**, with no title or heading prefix — the one composer in the codebase that adds nothing. A knowledge chunk needs its title because a bare fragment floats free; a phrasing is already a complete question, and the thing it is compared against is a bare email. Prefixing it with the canonical question would pull every variant toward a common centre, which shrinks the distance between variants of *different* exemplars too, because the added text is the tidiest and least discriminating part of the row.

### One exemplar or none, never a shortlist

An exemplar decides which evidence gets collected and which answer is selected. *"Probably this one, or possibly that one"* is not a state either can act on, and resolving it downstream would put the choice somewhere with less information. So `match_support_exemplars()` returns one row per **exemplar**, scored by its best phrasing — not an average, which would punish a situation for having one loosely-worded variant.

**A near-tie resolves to `ambiguous`, not to the higher score.** Two situations at 0.65 and 0.64 are indistinguishable at the precision these numbers carry. The margin is reported because it is the honest confidence signal, and a persistent near-tie is the corpus telling you two exemplars want merging.

**A tie the rules cannot tell apart is settled anyway — on the key, never the score.** The refusal above is made in retrieval, before any rule is loaded, so it cannot know whether the choice changes an answer. Most ties in this corpus do not: measured across the confusable pairs, the situations differed and the reply did not. Refusing there spends a matched situation, and the requirement needs that steer collection with it, to avoid a choice that was free.

So `resolveSituationTie` asks the question retrieval could not. Two situations are interchangeable under a set when `selectAnswer` provably returns the same rule for either, for **every** possible findings map — which holds exactly when the rules naming them are interchangeable, and no rule branches on a need they disagree about (closed over prerequisites, because declaring a need collects its requirements too). Either condition failing leaves the ticket ambiguous, unchanged.

**The first condition was "no rule names either of them" until 2026-08-30, and that version was actively harmful.** It refused the moment a rule named either situation — which is what happens as soon as you write the rules for a confusable pair. Cosmetovigilance is the case that exposed it: a severe reaction (CV-02) and a refund demand after a reaction (CV-04) get the *same* treatment, and because `situation_key` holds one key that answer has to be stored once per situation. Two identical rules made the pair unresolvable, so a tied ticket matched **neither** of them and fell through to the set's catch-all. Authoring the answer made the answer unreachable.

The condition now compares what the rules **do**: identical conditions, route, ask, skeleton, priority and fallback flag, sorted at every level because none of those orderings mean anything. `answer_key` is excluded and is the only field selection never reads — two rules differing only in their key are one rule written twice. What is proved equal is the behaviour, not the credit: the recorded `answer_key` is whichever situation the key sort picked, which is a reporting nuance rather than a behavioural one. The old rule is the new rule's empty case, so nothing that resolved before stops resolving.

**The pick is lexicographic on the exemplar key, and that is the whole of the determinism.** The scores are precisely what could not be trusted to order these two; breaking the tie with them would return a different situation whenever re-embedding nudged 0.660 and 0.655 past each other. `CV-02` before `CV-04` is arbitrary — arbitrary and fixed is the point, and it is only reached once the two have been proved to answer the same. On the real severe-reaction ticket, tied at 0.0051, it selects the lower-scoring CV-02; add a rule naming CV-04 and it goes back to unresolved.

The verdict stays `ambiguous` and `resolved_from` records what was level, so a corpus review still sees the pair asking to be merged. Overwriting it with `matched` would erase the only evidence that the embeddings cannot separate them.

### A near miss is settled by a model, and it went live without a shadow phase (2026-09-15)

**This narrows « one exemplar or none, never a shortlist » above, and the reasoning there still holds.** That rule refused to hand a shortlist downstream because the choice would land « somewhere with less information ». A model reading the full opening message beside the candidates has *more* information than the embedding score, so the shortlist now goes to it — and nowhere else. The investigation still receives one situation or none.

**Where it runs:** only when the matcher scored `near` (0.55–0.65) or `ambiguous`, only on the opening message, only among the matcher's own candidates (subject-filtered, top 3), and before the rules load — so the situation it picks drives the evidence collected and the rule selected, exactly as a mechanical match does. A score of 0.65+ stays mechanical; below 0.55 nothing is plausible enough to choose between.

**Measured before it shipped**, on the 56 near misses and ties in `ticket_investigations` and the 53 existing matches as a control, every committed choice read by hand against the customer's message:

| | tickets | read as right |
|---|---|---|
| near/tie — agreed with the top candidate | 26 | 22 |
| near/tie — picked another candidate | 9 | 6 (2 wrong, 1 unclear) |
| near/tie — answered none | 21 | 18 |
| matched — agreed | 47 of 53 | — |

It commits a situation on **35 tickets that had none, about 80% right**. The wins are the mechanism the embedding cannot see: a customer's one line above a quoted Colissimo or Shopify notification, an Italian message against French phrasings, the right situation sitting second (D-36 → D-07, D-36 → D-01, O-12 → P-17). **The owner chose to act on it immediately rather than record-only first**, with that 80% as the known price.

**Three fixes from the measurement are in the shipped version:**
- **Our own side is skipped** (`OWN_SIDE_LABELS` on the opening sender): four of the errors were colleague-to-warehouse threads worded like a customer situation.
- **A request phrased as a question is still its situation.** Three control « none » answers were « comment bénéficier des 20 % ? » against P-15/P-18 — the prompt now says so.
- **No confidence field.** It said `high` on all 109, so it could never gate anything.

**Recorded, not hidden.** `exemplar_match.verdict` keeps what the embedding said (`near`/`ambiguous`); `chosen_by: 'model'` and `chooser {model, choice, reason, candidates}` say who supplied the key — so coverage reports can still count the misses the corpus did not catch. `chooser.skipped` / `chooser.failed` distinguish not-asked from asked-and-failed. A failed call is no situation, never a failed investigation. The reason is shown in the test chat but is not evidence: one of 109 invented a detail.

**Its spend is its own pass**, `situation` in `llm_usage`, so Settings → Agent settings shows it as a row. `AGENT_SITUATION_CHOOSER_MODEL` (default `gpt-4o-mini`, empty = off).

**Seen on the AI agent panel** (owner's request, same day): "How situations are picked" counts each ticket investigated in the range once, on its latest run, from `exemplar_match` alone (`insights_agent_situations`, migration 23). Buckets partition the tickets, so the verdict is never overwritten to make the chart simpler: matched · tie settled by the rules · near miss picked by the agent (`chosen_by: 'model'`) · agent found none · **not settled** (no key and no "none" — chooser off, our own side, failed, or a run from before it shipped) · no situation close · not recorded. At ship time every stored run predates the chooser (54 near, 2 ambiguous, 53 matched, 29 none of 138), so "picked by the agent" reads 0 until tickets are investigated again.

**What it cannot fix:** a right situation filed under another subject is not among the candidates (5 of the 56 — P-17 under `order`, D-08 under `order`, D-36 under `return_exchange`). That is categorisation, and phrasings.

### Answers are shared across exemplars, not nested inside them

Nesting is the obvious shape and it multiplies: 32 situations × 3–5 branches ≈ 100–160 drafts, most of them duplicates — « votre commande n'est pas encore expédiée » answers both *where is my order* and *why has it not shipped*.

The findings vocabulary is what makes sharing possible. A `when` clause is a conjunction over **closed** enums, so the number of distinct evidence positions is bounded by the vocabulary rather than by the question count. The promotions family collapses to four positions serving five questions; across all four families the estimate is **10–15 answers, not 160**.

Two properties make sharing safe. The answer is a **skeleton for the drafting agent**, never text sent to a customer, so per-question wording is not its job. And it never restates policy — it names `policy_answer` and lets retrieval supply the sentence, or a returns-window change means editing an article *and* every answer that quoted it.

The cost is one indirection: an exemplar names its `answer_set` rather than carrying answers inline. Scoping by set is load-bearing, not decorative — without it a promotions answer could be selected for a product question whose need sets happen to overlap.

### Selection is mechanical, and it is also the stopping rule

**Most specific wins, `priority` breaks ties.** Never first-match-wins alone: that makes authoring order silently load-bearing, so inserting a general answer above a specific one would quietly shadow it. An unbreakable tie — equal depth, equal priority — reports `ambiguous` rather than picking one, because sort order there is arbitrary and resolving it would hide an authoring bug for ever. No match and no fallback yields no answer and the ticket goes to a person.

**The same table decides what to collect next.** A need no live answer branches on cannot change the outcome however it resolves, so collecting it spends a tool call to learn nothing; the need the live answers most *disagree* on is the one worth having. Discrimination is measured by counting distinct value-signatures, not answers — a need every answer agrees on would otherwise score as the perfect split while settling nothing.

**Prerequisite readiness is not a filter on that choice.** The most discriminating need is usually the deepest one, and excluding it because its prerequisite is unmet would leave only needs that discriminate nothing — collection would stop before it started. So the best need is chosen first and the dependency graph is walked *back* from it. That is why `promotion_identity` gets collected at all: no answer branches on it, and the promotion cannot be looked up without it.

Collection halts when one answer remains, or when nothing available separates the survivors — reached before the tool budget rather than by exhausting it.

### The bands are not the knowledge bands

0.60/0.50 were re-derived against a 61-chunk library of *prose*. This corpus differs on both sides of the comparison — rows are questions, and the variants are real phrasings — so reusing those numbers would be a guess wearing the clothes of a measurement.

**Calibrated 2026-08-11** by `npm run eval:exemplars`: 79 phrasings embedded in memory, scored against the first inbound message of 190 real customer tickets. No approval was needed for this and that is the point — approval gates the vector, and the calibration is exactly the evidence a reviewer needs *before* approving. The query side was free: `ticket_messages.embedding` already existed.

**The relevance signal is a proxy, stated as one.** There is no labelled set, so the split is whether the winning exemplar's subject agrees with the subject the categoriser independently assigned. Two situations under `promotions` can still be the wrong one of the two. It is free, it covers every real ticket rather than a hand-labelled dozen, and it separates the distributions the way a labelled set would: agreeing p25 0.629 against disagreeing p75 0.621.

| threshold | kept | restraint | recall |
|---|---|---|---|
| 0.50 | 165 | 68% | 96% |
| 0.60 | 123 | 80% | 84% |
| **0.65** | **86** | **88%** | **65%** |
| 0.70 | 55 | 95% | 44% |

**0.65 is the knee**, and the direction follows the knowledge rule: a wrong match costs more than no match, because no match is simply today's behaviour while a wrong one sends the investigation after the wrong situation's evidence. **Expect to revisit downward** — recall is held back by fixable corpus problems rather than by the number.

### The margin is much smaller than it looks like it should be

`minMargin` started at 0.03 on intuition. Measured, the median margin between winner and runner-up is **0.037**, so 0.03 would have called **45% of all matches ambiguous** — rejecting good matches wholesale. It is now **0.01**, which catches genuine coin-flips and little else (19%).

That remaining 19% was a **corpus** problem, not a threshold one, and merging confirmed it: **O-09/O-10, D-03/D-04 and P-15/P-16 collapsed on 2026-08-12**, 32 exemplars → 29, and the median margin rose to **0.040** with ambiguity at **17%**. The number did not need moving.

The measurement is also pessimistic by construction: it scores unfiltered across all of them, because filtering by subject would make the agreement proxy trivially 100%. Production filters first, so the real candidate pool is a handful of same-subject exemplars.

### Split on what the customer can OBSERVE, not on what the evidence turns out to be

This supersedes the P-15/P-16 half of the rule below, which was wrong and was reversed the same day.

That merge was made on the claim that the customer cannot tell the causes apart, so the cause is a finding rather than a question. **The claim was false here.** *"I signed up and no code came"* and *"I have a code and it will not apply"* are different **observations**, not two diagnoses of one observation. The customer knows perfectly well which of the two they are living.

**The corpus states it flatly.** Reading all 21 `promotions` tickets end to end: **14 are the code never arriving, 3 are the code refusing to apply.** That ratio is the strongest signal in the promotions data, and merging folded it away.

The test that survives both cases: **merge when the customer's own account of events is the same and only the diagnosis differs** (O-09/O-10 — "my order has not shipped", whether the cause is dispatch time or card authorisation; D-03/D-04 — "the carrier says delivered and I do not have it", whether or not a neighbour is involved). **Split when the accounts differ**, even if the same investigation resolves both.

Measured after re-splitting: P-15 sharpened from 21 tickets at median 0.696 to **14 at 0.773**, and P-18 went from never winning anything to **7 tickets at 0.740**. Both sides rose, which is the tell that an axis is right — a bad split lowers medians on both sides of it.

### A question invented from its own answer never wins

P-18 asked « puis-je cumuler plusieurs offres ? » and its only phrasing was **our own reply**, which the importer refuses to embed. It reached the eval with nothing but a canonical question and never won a ticket.

Searched across 296 stored messages and a curated review folder: **no customer has ever asked whether codes stack.** Every "cumulable" sentence in the corpus is one the desk wrote — it appears in our replies because we volunteer the rule, never because it was asked. Customers report the symptom: the code will not apply.

The general form: **an exemplar whose phrasings can only be found in outbound mail is a description of our answer, not of a question.** The importer's "skipped a phrasing annotated as our own reply" warning is the detector, and it fired on this entry from the first import — for three weeks it read as a missing quote rather than as evidence the question was wrong.

### A merge is judged on the ANSWER, not on how similar the questions look

Two of the three merges were obvious: O-09/O-10 and D-03/D-04 each resolved to a single shared answer, so the split was simply wrong — and D-04's phrasing (« le livreur GLS a livré mon colis ailleurs ») shares almost no vocabulary with D-03's (« livré dans ma boîte aux lettres mais il n'y a rien »), which is the spread that belongs *inside* one exemplar rather than split across two competing for it.

~~**P-15/P-16 spans three answers and was merged anyway**, on the claim that which of the three applies is a finding rather than a question.~~ **Reversed the same day** — see the section above. The customer *can* tell "no code arrived" from "the code was refused", and the corpus splits 14/3 along exactly that line. P-15 is now the code never arriving; P-18 is the code refusing to apply.

What the reversal did not undo: answers stay keyed by evidence position and shared across exemplars, so re-splitting the questions cost nothing on the answer side. `promo_code_non_recu` follows P-15, `promo_code_valide_non_eligible` and `promo_code_inexistant_ou_expire` follow P-18, and no answer text moved.

### "Never wins" has three causes and they want opposite fixes

Win counts alone say an exemplar is silent, never why, and the fixes contradict each other — so `diagnose-exemplars.mjs` reports the rival that beat it, the median gap, and the language of its closest tickets. A **collision** (small gap, one dominant rival) wants a merge, and adding phrasings would only sharpen the tie. **Absence** wants leaving alone. **Mid-pack** — never in the top two, never far off — means the field already covers it.

A gap of exactly **0.000** is a fourth thing and not a close call at all: the same text scored twice, which is what a merge leaves behind, since the importer upserts and never deletes an exemplar that has left the document. Those retired rows are not inert — three of them dragged the median margin from 0.040 down to 0.032 and inflated ambiguity to 23% before they were deleted, making the merges look actively harmful.

### Order numbers stay in the phrasings — measured, and it makes no difference

The intuition is that `#6686` is high-entropy noise no query will ever match, and that `[numéro de commande]` would embed better. **Measured 2026-08-12** by embedding all 92 phrasings three ways and scoring each set against the same unchanged ticket vectors:

| variant | median | ≥0.65 | affected-exemplar median |
|---|---|---|---|
| as-is | 0.633 | 88 | 0.501 |
| stripped | 0.635 | 87 | 0.489 |
| placeholder | 0.634 | 92 | 0.505 |

Differences of 0.001–0.004 on n=203. **The effect is diluted three times over:** a number is one token in a ~20-token phrasing, that phrasing is one of several on its exemplar, and the exemplar is scored by its *best* phrasing. Only 11 of 92 phrasings carry an identifier at all.

Kept as-is on the tie-break: a placeholder is a token **no real customer email contains**, so it moves the library away from the query side — against the whole reason variants exist. Literal text also keeps the corpus an honest record of what was written. (The "stripped" row is the weakest partly because the stripper left dangling nouns — « ma commande numéro qui devait être livrée » — so read it as *removal is not obviously better*, not as *removal is worse*.)

**Promo codes never arise on this side.** No phrasing contains one; codes appear only in answers, and `support_answers` has no embedding column. Parameterising `BIENVENUEQIRINESS` matters for staleness, not for retrieval.

### An answer is written from a sent reply where one exists, and tagged where it does not

The first three answers were authored from the desk's own outbound mail (`promo_code_non_recu`, `promo_code_valide_non_eligible`) or written from scratch and **marked 🟨 SYNTHÉTIQUE** (`promo_code_inexistant_ou_expire`). The tag is not bookkeeping: a synthetic answer has never been read by a customer, and the reviewer approving it is doing a different and harder job than confirming one we already send.

**A real reply settles questions authoring cannot.** The newsletter answer was sent twice in near-identical words, and it shows that the desk's response to "no code arrived" is **to send the code** — nobody investigates why the automation failed. No amount of reasoning about `customer_account_state` would have produced that.

**Two rules came out of writing them.** Live promotion facts (`BIENVENUEQIRINESS`, `-20 %`) must be parameterised before a reply becomes an `answer_skeleton`, or a code change means editing an answer instead of a promotion. And a commercial gesture — a refund, a discount on the next order — is a **merchant decision the drafting model must never invent**; either it is given a bounded gesture it may offer, or the situation routes to a person.

### An eval built on trigger messages cannot see follow-up questions

`diagnose-exemplars.mjs` scores the **first inbound message** of each ticket, because later messages are replies to us and would pull our own vocabulary into the query corpus. That is right, and it has a blind spot: some questions only ever arrive mid-thread. R-22 (« il y aura t il un remboursement des frais d'envoi ? ») is the fourth message of a broken-LED-mask thread, so its only real phrasing is never a query, and its silence in the eval was never evidence about R-22.

Read silence about a follow-up-register exemplar as missing data, not as a verdict. The exemplar entry carries the marker; scoring later messages would fix the coverage and break the corpus.

### The variants thesis, measured

Exemplars that never win a ticket above the floor are **D-07 and P-18 — precisely the two with no real phrasing, only the tidy canonical question.** That is the clearest evidence available that phrasings carry the retrieval and the canonical question does not, and it was predicted by the importer before the eval ran. Post-merge both lose *clearly* rather than narrowly (0.130 and 0.162 behind), so neither is a merge candidate: they are simply under-phrased.

### Translate the library, not the query — and only once the phrasings are final

The library is French and the query is whatever the customer wrote. Measured 2026-08-12: French tickets match at median **0.637**, English at **0.476** — a gap wider than the whole distance between `NEAR` (0.55) and `MATCHED` (0.65). Language costs more than a band.

**The earlier recommendation was to translate the query, and it is superseded.** Translating the query does help — 0.448 → 0.519 against the knowledge library, 11/11 cases — but it cannot close the gap, because it trades one mismatch for another: machine translation of a messy English email produces *tidy* French, and tidy-versus-messy is exactly the register gap the phrasings exist to close. It is also a model call in the hot path of every non-French ticket, on text nobody ever reviews.

Library-side translation is done once, offline, at import; it is deterministic, the existing staleness quadruple manages re-embedding, and a human sees the output at approval time because the approval gate already exists.

**Better still where the material exists: real non-French phrasings.** The corpus already holds them — R-21 is English, D-08 and R-23 Spanish — so the "keep the library French so the comparison stays French↔French" premise was already false when it was written. Real foreign mail is messy in the right way. Suggestive rather than proven: Spanish tickets score median **0.814**, the highest of any language, on n=2, and D-08 carries a real Spanish phrasing.

So: lift real phrasings where the corpus has them, translate to fill the rest. **And translate last** — after every question has its full set of verbatim phrasings — because each new authored phrasing is another thing to translate, and doing it earlier means paying for the same work twice.

The whole of it is worth 14 tickets, about 7%. It is a real win and a small one, and it sits behind the review surface and the answer skeletons deliberately.

**Done 2026-09-09**, in two passes and in this order: the 11 foreign phrasings into French first, then all 140 into `fr en es it de`. 562 rows, `gpt-4o`, `scripts/translate-exemplars.mjs`. The French pass runs first because French is the language the team reads, so it is the only pass anybody can actually review closely, and a source language read wrongly there would have been multiplied by four in the second.

### The language of an authored phrasing is declared, never detected

The importer never wrote `language`, so the column took its `fr` default on every row — including the six English, three Spanish and two Dutch phrasings. **The column added to measure the language gap was recording the opposite of the truth for the eleven rows it existed for**, and no report could have caught it: they read as French phrasings that happened to score oddly.

A variant's annotation may now open with a code — `- « Do you ship to Germany? »  _(en)_` — and the parser reads it, with a warning where the code is not in `REPLY_LANGUAGES`.

**Detected would have been cheaper and is wrong.** These are one-line fragments; « Do you ship to Germany? » is four words and « URGENT — Commande #6216 » is barely a sentence. The marker is also the input to the translation pass, where a misread language means paying to translate English into English and storing the result as a translation. The person pasting a phrasing in knows what it is, and this is the same choice `requirement_needs` already makes.

The marker must be the whole annotation or be followed by a dash, because half the existing annotations are French prose and « en cours — … » opens with two letters that are also a language code.

### `fr` is a translation target like any other

Nothing replaces a real foreign phrasing. They are the most valuable rows in the library — real foreign mail is messy in the right way, which is the entire variants thesis applied to language — so the French translation of R-21 is written *beside* the English original, at its own index, and both are embedded.

Which also means the two Dutch phrasings get five translations rather than four. `nl` is in `REPLY_LANGUAGES` and deliberately not in `TRANSLATION_LANGUAGES`: two phrasings is not demand enough to justify 140 more rows, and Portuguese has none at all. A language can be a source without being a target.

### The generated file is the review gate, because the approval gate is not one

The claim above — *"a human sees the output at approval time because the approval gate already exists"* — is true of a new exemplar and **false of a new phrasing on an approved one**. All 38 exemplars are approved; approval is the only thing gating a vector; so a translation written straight to `support_exemplar_phrasings` would be embedded by the next `embed:exemplars` run and matched against real customer mail with nobody having read it.

So `translate-exemplars.mjs` writes `Email-Example-Queries.translations.json` and stops. `import-exemplars.mjs` is what puts it in the table. The review is the diff, which is a real gate with a real reviewer, and it costs no schema.

**Each entry carries the hash of the phrasing it was made from**, and that is a third staleness gate distinct from the two that already exist: `content_hash` covers a row's own text and answers *does this need re-embedding*; `embedded_input_hash` covers the composed embedding input; `sourceHash` covers the text a row was *derived from* and answers *does this need re-translating*. Neither of the first two can see a French variant being edited under its four translations. A translation whose source has changed is **dropped at import rather than written** — a stale translation in the index is indistinguishable from a fresh one and answers a question nobody asks any more.

### The pruner now asks which indexes were written, not how long the list is

`removeStalePhrasings` deleted anything at or past `exemplar.phrasings.length`. That was correct while the list was contiguous and authored, and it stopped being correct the moment translations joined the same array: a three-variant exemplar with twelve translations has a list of length 15, so every authored row below 15 read as current and **nothing was ever pruned**. Comparing against the set of indexes actually written says the same thing about a shortened list and keeps saying it once the list has a hole in it at 4..99.

The one case that needs care is the translations file being **absent**, which now means "nothing to say about translations" rather than "there are none" — otherwise an import run from a checkout without the file would quietly delete the whole non-French half of the library.

### What the translated library is actually worth, measured

Run twice over the same 328 tickets — `eval:exemplars` with and without `--authored-only`, which is the only comparison that means anything, since the 2026-08-12 figures were taken over 214 tickets and reading today's number against them measures the corpus rather than the translations.

| Ticket language | n | authored only | translated | best match clears 0.65 | won by a translation |
|---|---|---|---|---|---|
| fr | 303 | 0.624 | 0.628 | 119 → 122 | 17 |
| en | 13 | 0.432 | **0.464** | 4 → 4 | 9 |
| it | 6 | 0.545 | **0.677** | 0 → **4** | 6 |
| de | 3 | 0.588 | 0.625 | 0 → 1 | 3 |
| es | 2 | 0.891 | 0.891 | 2 → 2 | **0** |

Overall median 0.619 → 0.627, p25 0.545 → 0.556, and **125 → 133 tickets clear MATCHED**. The prediction was "worth 14 tickets, about 7%"; the answer is **8 tickets, 6.4%** — the right order of magnitude and slightly optimistic.

Confirmed against the live `match_support_exemplars()` afterwards rather than left as a JS number: 12 non-French tickets, **3 exemplars returned on 12 of 12**, none starved, and the winner is a translation in its own language on all but the three tickets that have a real foreign phrasing to match instead.

**Italian is where it pays**, and it is the only language where the band moves: 0 of 6 tickets cleared MATCHED before and 4 do now, on a +0.132 median. German moves 1 ticket. **English gains 0.032 of median and moves nobody across the band** — the gap to French is 0.16 and this closes a fifth of it, so language is still costing English tickets more than a band.

**Spanish is unchanged at 0.891, and that is the most useful row in the table.** It is the one language whose exemplars already carry *real* Spanish phrasings (D-08, P-20, R-23), and not one of its tickets is won by a translation. Real foreign mail had already done the work, and machine translation added exactly nothing on top of it. **This is the "lift real phrasings where the corpus has them" rule confirmed on its own terms** — where a real phrasing exists, translating is spend with no return, and the corpus is the place to look first.

**17 French tickets are won by a translation**, which can only be one of the 11 French renderings of foreign mail. Phase 1 was the cheapest of the two passes and it earns its place on more French tickets than the whole English pass wins English ones.

### The exemplar eval scored a library production does not have

`diagnose-exemplars.mjs` filtered `deleted_at` on tickets and not on exemplars, so it scored **38** while `match_support_exemplars()` scores **37**. O-11 was merged into O-09 and soft-deleted in the dashboard, but it is still in `Email-Example-Queries.md` — so the importer keeps re-creating it, the translator keeps translating it, and the eval kept scoring it. It took the library growing to make the gap visible: O-11 now holds 10 rows, all unembedded, because the embedding reconciler had `deleted_at` right from the start.

**Fixing it moved nothing, and why is the interesting part.** Every per-language median and every MATCHED count is identical with O-11 excluded; only the overall median moves, 0.626 → 0.627. O-11's phrasings exist *verbatim* under O-09, which absorbed them in the merge, so dropping O-11 hands those tickets to O-09 at the same similarity. That is this file's own `DUPLICATE` diagnosis showing up in the arithmetic: the same text under two keys, which is what a merge leaves behind when the importer upserts and never deletes.

So the numbers above are unaffected, and the filter still belongs there: an eval that predicts the RPC must model the RPC's exclusions, and the next merge may not leave a duplicate behind to cover for it.

### The over-fetch multiplier is derived from the index scheme, not from the corpus

Raised from 8 to **64** in the same change that generated the translations, as the warning in `05_exemplars.sql` required. D-33 has 8 authored phrasings and 32 translations: at 8 that one exemplar would have filled every slot of a three-exemplar request and the function would have returned a single result, silently.

**64 is the ceiling the addressing scheme allows — 10 authored phrasings × 5 languages plus the originals — and not the 40 D-33 measures today.** Setting it from the measurement would mean one new variant on D-33 reintroducing the same failure. `05_exemplars.test.mjs` asserts the multiplier against `MAX_AUTHORED_PHRASINGS` and `TRANSLATION_LANGUAGES`, so the invariant is checked rather than commented.

### Two index spaces in one column, because the pruner deletes by position

`import-exemplars.mjs` deletes any phrasing at or past the end of the authored list — the only way it can know that an exemplar which used to have five phrasings now has three. Translations are generated rather than parsed out of the document, so by that test every one of them looks stale and would be destroyed on the next import.

Translations therefore live at `phrasing_index >= 100`, out of the pruner's reach, and `05_exemplars.sql` enforces the boundary with a check constraint rather than trusting two scripts to keep agreeing about it. `TRANSLATION_INDEX_BASE` is exported from `exemplar-import.mjs` and the migration test asserts the constraint against it, so moving the base moves both or fails.

`language` is reported by `match_support_exemplars()` and **never filtered on**: an English email matching a French phrasing weakly is better than not matching it at all, and the column exists to measure that, not to prevent it.

**Every phrasing is embedded alone and separately**, translations included — `buildExemplarEmbeddingInput` takes the text and nothing else, no language tag, so an English email meets the English row directly and the exemplar takes its best phrasing rather than an average. Translations can therefore only raise an exemplar's score, never lower it.

**Which is exactly what breaks the over-fetch.** `match_support_exemplars()` fetches `match_count * N` phrasings because the inner limit counts phrasings while the caller counts exemplars, and 8 worked only while no exemplar had more than about that many. Eight phrasings in five languages is 40 rows for one situation — D-33 — enough to fill a three-exemplar request on its own and return one result, silently, looking like a retrieval quality problem. **The multiplier was raised in the same change that generated the translations** (8 → 64, 2026-09-09); see "The over-fetch multiplier is derived from the index scheme" below.

### Subject filter only — the opposite of the knowledge policy

`categoriesToSearch()` adds `faq` and `brand_story` to every knowledge search because reference material generalises across subjects. Situations do not: « où est ma commande » is never the answer to a promotions question. Widening here would only add near-misses, and at 32 rows a near-miss can out-rank the right answer more easily than in a library of hundreds. An uncategorised ticket searches everything rather than nothing — no filter is a weaker claim than a wrong one.

---

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

## Drafting

### Every verdict gets a reply, and every reply answers what it can

Drafting first shipped with `needs_human` producing nothing, on the reasoning that a case file which resolved nothing has nothing to say. That reasoning was about the agent, and the cost was paid by three other parties: **the customer**, who heard nothing at all while a colleague worked the ticket; **the colleague**, who opened a blank page instead of an editable draft; and **the thread**, where a long wait is indistinguishable from being ignored.

**The first fix was not enough, and how it failed is the useful part.** The acknowledgement was told to resolve nothing and to stay inside three or four sentences. It obeyed: 49 drafts that said « votre demande est en cours de traitement » and little else — while the case file in front of them held the product, its two-year warranty, and precisely what could not be confirmed. **The material for a specific reply was already in the prompt; the instructions forbade using it.** A reply that tells a customer nothing they did not already know is not a safe reply, it is a useless one, and it costs the same to send.

So all three intent sets now share one shape: **answer what can be answered first**, and let the unresolved part — a question, or a point going to a colleague — come after it rather than instead of it.

| Verdict | The reply |
| --- | --- |
| `answerable` | Resolve it completely. No follow-up question; the customer should have no reason to reply |
| `needs_customer_input` | Explain what is already established, say why the missing fact is needed, then ask for exactly that. Never turn the whole reply into a request |
| `needs_human` | Answer what is established, **name the specific point that needs checking**, say the team is taking that point. Never a deadline, a promise, or a claim that a check already happened |

**Nothing was loosened.** `established` is still the only source of facts, `unverified` is still only ever attributed to the customer, and the prohibitions still hold. What changed is the order.

**Two instructions had to be added because reordering alone did not work.** Measured across eight handover drafts, only 4 of 24 established facts reached the reply — "answer what can be answered" reads to a model as "acknowledge the topic". The rule now names the obligation: *a useful established fact that is not passed on is something the customer will have to ask for again.* On the LED-mask ticket that is the difference between a reply that mentions the two-year warranty and one that does not.

### The last order is kept as a candidate, and it is not a tool

A customer writes about a product problem, or a return, and names no order. A reviewer wants their recent orders in front of them; without that they open Shopify and search by hand.

**It began as a branch of `getOrderContext`, and that was wrong for the subjects that need it most.** Which orders a reviewer sees then depended on whether the model chose to call an order tool — and `product` has no order tool in `allowedTools` at all, so the subject where recent orders are most useful was the one that never got them.

**The obvious fix is the dangerous one.** Adding `GET_ORDER_CONTEXT` to `product` and `return_exchange` would put an order tool in front of the model on tickets that are not about an order, and a model shown an order tool starts asking customers for order numbers. The requirement was the opposite: show the human recent orders, and do not let that turn into a question.

**So it is not a tool.** `lastOrderLookup` lives on the investigation stack, outside the registry. The model cannot call it, is never told it ran, and never sees its result. The runner calls it **after the case file is complete**, so it cannot touch the verdict or `missing` — a test asserts exactly that, on both an `answerable` and a `needs_customer_input` answer.

**Conditions are properties of the ticket, not of the run**: no `shopify_order_number`, and a linked `customer_id`. Deterministic, so it no longer matters which tools the model happened to choose.

**Empty is often the right answer**, and reads correctly. Measured while verifying: a `return_exchange` ticket with a linked customer returned nothing because that customer has zero orders — a newsletter signup or an address given in a shop, which is the `known_no_orders` state the purchase check already distinguishes.

**A failed lookup never fails the investigation.** A lead is worth having and never worth losing a case file for, so the error is logged and the field stays empty.

### `claim` can be narrowed to one ticket

`record.claim(pass, { ticketId })` adds a filter to the queue; it does not bypass it. The pass's flag and its `where` still apply, so naming a ticket that is not due returns nothing rather than running it anyway — which keeps it an operator convenience ("look at this one") rather than a second, unguarded way into a pass.

It exists because the queue is oldest-first over an imported corpus: 109 historical tickets carry a flag no poll can reach, so re-running one recent ticket by hand meant paying for everything ahead of it.

### The absence of a carrier scan is a fact about us, and the model was told it was a fact about the parcel

`toOrderContextText` — the model's projection of the order bundle — rendered a dispatched parcel as « Livraison : expédiée, mais aucun scan transporteur pour le moment. » The model believed it, because everything in that projection is presented as established: **17 case files recorded it as an established fact, and 8 of 81 drafts passed it to the customer**, several naming the carrier — « pas encore de scan de suivi de la part de Colissimo », « aucun scan transporteur » for GLS.

**That sentence is wrong twice.** No carrier feeds scan events into Shopify for this store at all (`delivered_at` set on 1 order in 2 006, `in_transit_at` on none), so it blamed Colissimo and GLS for a gap in our own integration. And it implied a stuck parcel where there is only an absent feed — the customer reads "the carrier hasn't scanned it" as "your parcel is not moving".

**The model is now told what is true and customer-safe**: dispatched, and how many days ago. What we cannot see reaches it as a PROHIBITION (`delivery_unscanned`) instead, and the prohibition deliberately does not explain itself — stating "no carrier scan is available" inside a `do_not_claim` line is still stating it to the model, which is exactly what it paraphrased before.

**Two checks, at different scopes.** `do_not_claim:delivery_unscanned` fires only when the caveat was raised and catches the model describing the parcel's progress. `no_carrier_scan_wording` fires on **every** reply regardless of caveat, because that wording is a statement about our own integration and is not the customer's business on any ticket.

`signals.awaitingCarrierScan` still carries the fact for the dashboard and the human brief, which are internal audiences. The tool layer knowing something and the model being told it are different things, and this is the case that shows why.

### An unanswered chase is a fact about our conduct, not a mood to read off the customer

If a customer had to write twice, the reply opens by apologising for the delay. Two signals say that happened, and **neither is enough alone** — measured across the 81 drafted tickets:

| | |
|---|---|
| Threads holding consecutive inbound messages with no reply between | **12** |
| Messages that SAY so in words | **4** |
| Overlap | **2** |

A prompt instruction alone would miss 10; the thread structure alone would miss 2. So `describesChase` supplies the fact where it is provable, and a general rule in the prompt covers the cases only the customer's own words reveal.

**Consecutive inbound, not a message count.** A customer answering our question has two inbound messages and is a normal exchange. What makes it a chase is that they wrote again while nothing had come back, so the run has to be uninterrupted by an outbound.

**It describes us, not them.** `happiness` already records how the customer sounds; this records that we left them waiting, which is true whether they complained about it or not.

**Envelopes only.** The thread read selects `ticket_id,direction,received_at,sent_at` — no bodies, no addresses. The question is answered by the order of the messages, and pulling the bodies to answer it would ship every email in a thread to a pass that reads one.

**The check is narrower than the rule, on purpose.** `apologises_for_delay` fires only when the thread proves the chase, because a check has to rest on something checkable; the stated-only cases stay the prompt's job. Its pattern covers all four languages the corpus drafts in — the first version was French-only and failed an Italian reply that opened « Ci scusiamo per il ritardo nella risposta », which is exactly how a check earns being ignored.

### A human edit is recorded against the text it corrected, not against the current draft

`ticket_drafts` already holds a pair: `body_text` as the model wrote it, `approved_body_text` as a person rewrote it. That pair is right for the review surface and **wrong as a learning signal**, for one specific reason.

**A re-draft replaces `body_text` and deliberately leaves `approved_body_text` alone.** The first half is the agent revising its own text; the second exists so a re-run cannot discard an operator's work while they are part-way through the queue. Both are correct. Together they mean the two columns stop being a pair the moment the agent revises a draft somebody had already edited — and read later they still *look* like one. What you would be training on is the agent's second attempt beside a human's correction of the first: a pair that never existed.

So `ticket_draft_edits` records each edit as it happens, with the model text **copied in beside it**. Verified against the live database: after an edit and then a re-draft, `edit.model_body_text` still holds the text that was actually corrected while `ticket_drafts.body_text` has moved on.

**Append-only, and every pass is kept.** A reviewer who edits, sends, and edits again on the next inbound message leaves two rows. "What do people keep changing" is a question about repetition, not about the latest state.

**An edit that changed nothing is refused**, by a check constraint and by the record module before it. A row asserting the agent's text needed correcting into itself is the most misleading training pair available, and whitespace-only differences are not edits.

**`source` is declared with `mailbox` before anything writes it.** Editing a review copy in Outlook and having that come back is the intended second source; adding the value later would be a constraint change on a populated table.

**`edited_by` is null on every row and will stay null until the dashboard has authentication.** A learning signal that cannot tell two reviewers apart is a weaker one, which is why the column exists now — but nothing can fill it yet, and pretending otherwise would be worse than the gap.

**Nothing reads it.** Phase 7 memory is where it is consumed. Capture had to start first: an edit not recorded when it happened cannot be recovered afterwards — the same argument as `auto_send_eligible`.

### Asking is licensed by the case file, not by the verdict

One rule across all three verdicts: **a reply may ask for a fact only if the case file named it.** That single line implements three instructions that look separate — « ne pas demander d'information supplémentaire » on an answer, « demander uniquement cette information » on a question, « ne demander une information que si le dossier en nomme une » on a handover — because they are the same rule seen from three sides.

It also resolved a contradiction the first version carried. `toDraftingPrompt` renders the « À demander au client » section whenever `missing` is non-empty, regardless of verdict, so 9 of 49 handovers were handed a question to ask *and* an instruction never to ask. The model happened to resolve all 9 the safe way, which was luck. Now a named field licenses the question and the check scores which fact was asked for; an unnamed one fails as invented.

### The handoff stays withheld, and the intent rules are why it can

"What requires attention" is derivable from `unverified` — what could not be confirmed, and why — which is factual and proposes no remedy. The handoff's `action` proposes one: measured 2026-08-19, **10 of 49 name a refund or a replacement**, and a commercial gesture is a merchant decision the model may never invent. So the model is told to describe what needs checking, from evidence it already has, and is never shown what we might do about it. The column is read only to reduce it to a boolean for `disposition`.

### The closing line is approved, not forbidden

The brand voice forbids « les formules génériques de service client sans réelle valeur ajoutée », a structural rule repeated it, and the model still ended **31 of 81** drafts with a courtesy line — in 31 different wordings. A prompt has limited grip on courtesy filler.

**The first reading of that number was wrong.** It looked like the model doing something it had been told not to; it was the model filling a real gap. « N’hésitez pas à revenir vers nous si vous avez d’autres questions » is worth saying — it tells the customer the door is open, and on an `answerable` reply it is the exact caveat the intent rules ask for ("no reason to reply unless they need further help"). The problem was never the sentence; it was that nobody had approved one, so the model wrote a new one every time.

So `closingLine` joins `signature` as a stored, editable field on the Brand voice page, reproduced exactly and checked exactly. Same mechanism, and the mechanism is proven: the signature check passes 81/81, so prompting a verbatim block and verifying it afterwards is reliable enough not to need code that appends it.

**Two checks, doing different jobs.** `closing_line` verifies the approved wording is present — a real failure. `empty_closer` stays advisory and runs against the text **with the approved line removed**, so what it reports is a *second*, invented closer. Without that removal, approving a wording would flag every draft that used it.

**Advisory is still right for the invented one.** It is a weak sentence, not a wrong one, and `checks_passed` gates auto-send — refusing an otherwise correct reply for being too polite would be the check overreaching.

**Seeded, not blank.** An empty field would not mean "no closing line"; it would mean the model inventing one per draft, which is the behaviour the field exists to replace. Clearing it deliberately is still available and does mean none.

### Terminal and intermediary, because a send has to know whether the thread is finished

A draft carries `disposition`: `terminal` when nothing is expected back and nothing is left to do, `intermediary` when the customer owes us an answer or a colleague owes them one. The distinction exists for exactly one consequence — **a terminal reply is what closes the ticket when it is sent, and an intermediary one must close nothing.** Getting it backwards closes a thread somebody still owes work on, which is the mistake in this area a customer would actually feel.

**Derived in code, never asked of the model.** "Is this exchange finished" decides whether a ticket closes, and it is the judgement a drafting model has the least evidence for: it sees the reply it just wrote, not the work behind it.

**Two conditions, and the second is the one that will matter later.** An answer ends the exchange only if nobody has to act afterwards, and what records that is the case file's `handoff`. Measured 2026-08-18: all 49 `needs_human` case files carry a handoff and none of the 15 `answerable` ones do, so today the verdict alone would give the same answer. Both are checked anyway, because the direction they could disagree in is the dangerous one — an answerable case file that also names an action is a ticket that must not close on send. Two check constraints state the same rule in the database, so a careless change to the derivation fails at the write rather than at the send.

**`handoff` is selected by the drafting pass and reduced to a boolean at the store boundary.** It is the one internal column the drafting projection would otherwise exclude; the disposition needs to know *whether* a human owes an action, never *what* they owe. Dropping the text one line after reading it keeps the derivation correct and keeps internal prose out of the runner, let alone the prompt.

### The reply names the parcel; the number is the link

`toOrderContextText` withholds the order's contact address from the model deliberately. The tracking URL is withheld for a different reason: **the reply has no use for one.**

**It was built the other way round first, and the output is why it was reverted.** Given the fulfilment URL in the prompt, the model does put a link in the reply — pasted in full, seventy characters of `https://www.laposte.fr/outils/suivre-vos-envois?code=…` sitting mid-sentence. On the first run it wrote « [Suivi Colissimo](https://…) » instead: correct markdown, which nothing renders, because `body_text` is plain text and is sent as typed. The customer would have received the brackets and the label around their own tracking link.

**The number carries the same information and is already the link.** `TrackingText` turns a tracking number into an anchor on every surface that shows one — the email chain, the draft, the dropped-mail dialog, the transcript — so the URL never has to appear in the prose to be one click away. The reply says « le numéro de suivi 6C21108711964 » and the reader clicks the number.

**`no_web_link` is the guard, and it forbids every URL rather than policing which.** Nothing in a case file is a URL, so any link in a draft is one the model produced from its own weights — at best right and ugly, at worst a plausible address that goes nowhere, sent by us, about their parcel. It sits in `FORBIDDEN_PATTERNS` beside the identifier and email-address rules because it is the same kind of rule, and it catches all four shapes: a bare URL, a bare host, markdown, an HTML anchor. **Measured before the rule existed: of 92 stored drafts, zero contain a URL.** It forbids nothing the drafting has ever done.

**When a send path is built, the anchor is made at send time**, from the same `splitTrackingText` the dashboard renders through — not by asking the model for a URL.

### The parcel number is verified, not left to discretion (2026-09-01)

`toOrderContextText` has always put the number in the prompt and never the URL, so the INPUT was already deterministic: the model is handed « Suivi : 6C21108711964 (Colissimo) » exactly when one exists. What was left to discretion was whether it used it — and a number withheld is a customer writing again to ask for something we were already holding.

**An obligation, and the only one in `draft-checks.mjs`.** Every other check there proves a sentence is ABSENT; this one proves a fact was PASSED ON. Verified rather than appended by code, on the mechanism the signature already proves at 81/81 — the number belongs inside a sentence, not bolted onto the end of one.

**Scoped to `order` and `delivery`.** Other subjects can carry a confirmed order without the parcel being what was asked about, and a check that fires on correct drafts is ignored within a week.

**The measurement is why the skeleton stays conditional.** 1,483 of 1,487 fulfilled web orders carry a number, but 402 of 467 Amazon orders carry none — the marketplace fulfils them and nothing returns through Shopify. Three of the 78 tickets with a confirmed order hold no parcel. So the check asks for the number when we have one, and the SKELETON must never instruct giving one unconditionally: that is the `annulation_trop_tard` shape, and a fabricated tracking number looks real until the customer pastes it into La Poste.

### A marketplace order is marked, because it changes how the block reads

`sales_channel` is `Online Store` on 1,500 of 2,006 orders, `Amazon` on 467, `Mirakl Connect` on 36, `Shop` on 3. The panel shows it **only when it is not the online store**, because a mark on three quarters of orders is one nobody reads.

**What it buys a reviewer:** `Fulfilled` with no parcel number is *normal* on an Amazon order and a *fault* on a web one. Without the channel those two are the same three lines.

**Not an allow-list of marketplaces.** Anything that is not the web store is named, whatever it is called, so a channel added in Shopify appears on its first support ticket rather than when somebody remembers to extend a list.

### The approved closer is translated, not reproduced, outside French

The brand voice is authored in French and the drafting prompt told the model to reproduce the signature « reproduite exactement, sans rien y changer ». It did. **All 5 non-French drafts written before this — 3 Italian, 1 Spanish, 1 English — carried a correct foreign-language body and then closed « N'hésitez pas à revenir vers nous… / Bien Cordialement, / Service Client Qiriness ». All 5 passed their checks**, because the check compared them to the French text and they matched it perfectly. 25 of 400 tickets are not in French.

**Framing the block as a SOURCE is the fix, and the wording is not decoration.** Measured against the real drafting model on the real prompt:

| Prompt | Result |
| --- | --- |
| « traduite dans la langue de la réponse … ne pas la recopier en français », block headed *Signature* | French, verbatim |
| Same block headed *source (français)*, « il ne doit apparaître nulle part dans la réponse » | « Cordiali saluti, / Servizio Clienti Qiriness » |

Told to translate, with the text presented as the signature, the model reproduces it — the text is right there and labelled as the answer. Presented as a source that must not appear, it translates. Describing the signature without showing it works too and was rejected: the approved wording stops travelling, so nobody can tell what the reply was supposed to say.

**One clause in `STRUCTURAL_RULES` was overriding all of it.** That block is headed « prioritaires sur tout ce qui précède », and « la formule de clôture approuvée … est la seule autorisée » reads as *this exact text*. The Signature section alone changed nothing until that rule also said: as-is in French, translated otherwise. A prompt that contradicts itself is resolved by the model, not by the author.

**Checking a translated signature is not possible, and the check says so** rather than guessing. Three states: French is compared character for character as before; another language is `null` — advisory, "read it"; and another language *ending in the exact French wording* is a real failure, which is the one mechanical statement worth making here. **`asks:*` moved the same way** — `ASK_TERMS` is French vocabulary, and « numero d'ordine » contains no « commande », so a correct Italian question would have been held back for missing words it had no reason to carry. Not yet observed, and that is luck: it fires only on `needs_customer_input`, and no non-French draft has had that verdict yet.

**The proper fix is per-language approved wording**, authored in the dashboard beside the French. That is a brand-voice feature, not a drafting one; until it exists, the model translates and a human reads it. No regression in French: 6 of 6 sampled drafts still reproduce the signature exactly, against a historical rate of 1 failure in 87.

### A skeleton may shape an answer, never supply a fact

The policy layer's `answer_skeleton` reaches the drafting prompt as an internal
instruction about the shape of a reply. **It is an instruction, and instructions
get followed** — which makes one that names a fact the dossier may not hold a
reliable way to manufacture that fact.

**Measured on the first live run of it.** `annulation_trop_tard` said to explain
the order had shipped and then give the return procedure « telle qu'elle figure
au dossier ». The dossier held no returns article. The model produced three
numbered steps and a **numéro d'autorisation de retour** this shop does not
issue, and the draft **passed every mechanical check** — correctly, because those
checks prove a named sentence is ABSENT and can say nothing about whether an
invented one is true.

So the rule, and it applies to every skeleton written from here:

- **Describe what to do with facts that are present.** « Donner la date
  d'expédition et le numéro de suivi » is safe on a rule that only fires with a
  confirmed order, because both are then in the bundle.
- **Never instruct stating a fact that may be absent.** Where a skeleton wants
  something the dossier only sometimes carries, it must say so conditionally and
  name what NOT to write when it is missing — no procedure, no delay, no
  reference number.
- **The condition is the better tool where one exists.** A rule can branch on
  `policy_answer: answered`, which is the honest version of « if the library
  covered it »: two rules, one for each state, rather than one instruction
  hoping.

This is the cost of the skeleton reaching a model at all, and it is worth paying
— the alternative is a layer that decides where a ticket goes and has nothing to
say about what it says. But it moves the failure mode: before this, an unanswered
question produced a vague reply, and now it can produce a confident wrong one.
**The review queue is what stands behind it, and this is the first thing a
reviewer of a rule-shaped draft should look for.**

### Answer sets are English, and group the subjects that share answers

Named `commande`, `retour`, `promo`, `produit` until 2026-08-30, which put two languages in one namespace. The French belongs in what a customer reads; a key a developer types is code. Renamed in the mapping and in both tables together: **`orders`, `returns`, `promotions`, `products`**, plus **`payments`, `accounts`, `cosmetovigilance`**.

**A set is not a category, and the difference is the reason it exists.** A category says what a ticket is ABOUT — it drives the tool set, which knowledge categories are searched, and forwarding. A set says which family of ANSWERS applies. They are many-to-one: `orders` covers order and delivery, `products` covers product and product_stock, because « pas encore expédiée » answers a delivery question and an order question alike. Keying rules to categories would mean writing that rule twice and keeping the copies in step for ever — the same multiplication that made answers shared by evidence position rather than nested under questions.

**A rule never names a category.** The link is `answerSetFor(category)`, one fixed mapping, so a rule cannot drift from the taxonomy and a subject cannot acquire rules by accident.

**`other` has a tool and no family, and that is a dead end rather than an empty one.** A ticket categorised `other` may search the knowledge base, so it is investigated, and no rule can ever reach it. Nobody has decided what `other` should do; a test pins the gap by name so it stays visible and fails the day a family is added.

## Knowledge

Nothing auto-writes `knowledge_documents`; the catalog sync only fills `shopify_content_sources`. `source_type` → `manual` **is** the manual-edit lock — no separate flag, and resync is then unavailable.

Unfilled core-topic slots are client-side placeholders, never database rows; clicking one creates a pre-filled draft.

---

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

Level 4 is still a hard band at 1000: legal threats and grave personal harm cannot be overtaken by ordinary urgency. Levels 1-3 are normal weights (`10 / 18 / 25`), so the queue is not strict tiering below the emergency band.

Customer wait is the largest ordinary factor (`35`, logarithmic, capped at 14 days). That is deliberate: once the customer is waiting, age should move a ticket harder than one severity step, while still avoiding a linear age score where very old backlog dominates forever. Contacts (`0 / 7 / 11 / 14`), `awaiting_human` (`6`) and VIP (`2`) remain smaller nudges.

This supersedes the VIP row-border treatment above: VIP remains a crown beside the requester name, while row edge colour now belongs to priority. Two border systems on one row would make VIP compete with the operational signal the queue is built around.

**Priority shows as two marks and no more: the score, and a 3px bar on the row's left edge.** The first version ringed the whole row in its band colour, which turned a queue of 214 rows into a grid of coloured boxes and fought the table's own hairlines. The bar is the header cards' accent moved from the top edge to the side, so one visual device carries severity in both places; the row keeps its ordinary neutral divider. **Left, not right**, reversing the first attempt: the bar then sits against the score it belongs to instead of ten columns away from it, and the table scrolls horizontally — a right-edge bar can be scrolled out of sight, the left one cannot.

**Band colours are the saturated primaries, not the semantic ramp.** The `-100` tints read as grey-pink and grey-amber at 3px, and the darkened ramp colours put a dark red one row above a dark orange, which is the same colour at a glance. Each band now sits as near its own pure hue as contrast allows — `#e81010` / `#ff8c00` / `#00a651` on the bar, one step darker on the score so it clears 4.5:1 on white. They are local to the table rather than new global tokens: they are tuned against each other for this one three-way comparison, and folding them into `--error`/`--warning`/`--success` would drag every chip and card along with them. Medium stays orange rather than shifting yellow, because gold belongs to VIP.

**The score is set a step larger and bold** (`--text-md`, 700). It is the number the whole queue is ordered by; at body size and weight it read as one more field in the row.

### Stats and filters

**The four header cards** recompute from the same array the tables render (`summariseTickets`, isomorphic and pure), so a card can never disagree with the rows under it.

**"High priority" is the red band** — `priorityBand === "high"`, score 70 and above — reversing the earlier "level 3 + 4" stand-in. That stand-in was right for its moment: nothing writes the `priority` column, so a card reading it would show zero for ever. The band needs no column; it is derived at read time by `scorePriority`, so the card can now count exactly the rows a reader sees marked red instead of approximating them by level.

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

## Data handling

### Personal data boundaries

- `orders` stores contact fields as hashes and `shipping_destination` coarse only (no street/postcode).
- `tickets` stores only `requester_email_hash` + `requester_name`.
- `resolved_context` holds PII but never billing or street address.
- `categorisation_review` reduces the sender to `from_domain`.
- `spam_audit` keeps sender, subject and (on a block) the body under its own expiry.
- The customer bundle's `toPromptText` **withholds the email by default** — the drafting step is replying *to* that address, so restating it in the prompt adds a personal identifier for no gain.
- `orders.customer_email_masked` holds `j***l@orange.fr` beside the hash — see below.

### A masked address, because a hash cannot be looked at

`orders` deliberately holds no raw contact address. But a hash answers exactly one question — *is it the same address?* — and the desk's actual question is the one `orders:resolve` keeps failing: **15 tickets quote a real order number from an address that does not own it**, and a person must decide whether that is a gift, a partner, or the same customer's second mailbox.

So the mask is derived **beside `hashIdentifier`, from the same input, on adjacent lines in the mapper** — the two can never describe different addresses. The local part is destroyed at map time and never stored, so it cannot be reversed or used to reach anyone.

**The domain is kept whole**, deliberately: *"same person, second address at the same provider"* is the mismatch question and the domain is what answers it. A provider domain is not personal data, which is the line this codebase already draws — `sender_directory` stores company domains as context for the same reason. Local parts of two characters or fewer collapse to `**` rather than being half-masked, since `b***o@x.fr` is longer than `bo@x.fr` and hides nothing.

**Never sent to a model.** It reaches `resolved_context.order.contactEmailMasked` for the panel, and `toOrderContextText` omits it: the agent never needs to know which address placed the order. A test asserts both halves.

It repaid itself immediately. All 15 mismatches became reviewable, and several point at `@example.com` — placeholder addresses on orders the desk or a retailer created, which no requester could ever match. That is a different cause from the one assumed, and it argues the check is not too strict for those: the data simply cannot satisfy it.

### `data_access_events` fails open

Sync paths write service events, and so does the agent's customer lookup — reading a customer to answer a ticket is access, whether a human or the worker did it. The write fails open because the data has already been read by then, so an audit outage must not also cost the answer.

**Future dashboard user views must write human access events here.** This is currently unsatisfied: the thread and dropped-mail dialogs render full email bodies with no audit event, because there is no dashboard user identity to attribute one to yet.

### Retention

`orders`: **a setting, not a constant** — `shops.order_retention_mode` is `months` (with `order_retention_months`) or `indefinite` (with none), read by `scripts/lib/order-retention.mjs`. **This shop is set to `indefinite`**, recorded in `order_retention_reason` with the date it changed. `retention_rule` names only WHY the clock started (`delivered`, `undelivered`, `return_refund_open`, `return_refund_completed`); the period arrives applied, as `retention_delete_after`, and a **null there means kept indefinitely** — the purge selects `lte now`, so a null is never matched and needs no special case. The order sync skips the purge entirely while the mode is indefinite, so a row stamped under an older policy is not deleted before a backfill catches up.

The duration used to live in the rule name (`delivered_plus_3_months`), enumerated in a check constraint and compared literally in `deriveOrderStatus`. That is what made the period unswitchable: every new window multiplied the enum and needed a branch in code that only ever cared why. It is also how the live constraint drifted — a 3→6 month change was applied to the database by hand and never written down here, leaving the mapper emitting a value the constraint would refuse. Migration 10 reconciles both vocabularies.

The fetch window is **derived** from retention (`orderSyncMonths` = period + 1 month margin, unbounded when indefinite) rather than set beside it. They were two independent constants, and a fetch window shorter than retention is a table that can never fill — the setting would look broken rather than misconfigured.

Reading the setting **fails safe, not open**: an unreadable or unknown value resolves to 6 months, never to indefinite. This is the opposite of `parameters.mjs`, where a null makes a reply decline to quote a number. A typo that silently became permanent retention of personal data is the one outcome nobody would notice. For the same reason the switch is not a `support_parameters` row: there null means "not decided yet", and indefinite retention must not be reachable by leaving a field blank.

**Raising retention is not retroactive.** The purge hard-deletes, so anything already removed is gone locally and only a backfill restores it, and only while Shopify still holds it. Lowering it deletes on the next sync. `tickets` mirrors it (`resolved_at`/`closed_at`/`archived_at`/`retention_delete_after`); `deleted_at` is the separate compliance soft-delete. `categorisation_review`: 3-month default. `spam_audit.body_text`: 90 days from capture, purged per poll.

### Supabase REST client

Every request sends `cache: 'no-store'` — Next's Data Cache otherwise pins the first response for a year, which made saved changes appear to vanish on reload. `export const dynamic = "force-dynamic"` does not prevent this; only the explicit fetch option does. The option is inert outside Next, so the sync scripts and agent worker are unaffected.

New Supabase API keys (`sb_publishable_*` / `sb_secret_*`) are sent as `apikey`
only, not as `Authorization: Bearer ...`. They are not JWTs; the hosted API
Gateway verifies the `apikey` and mints the database token itself. Sending
`Bearer sb_secret_*` returns 401 even though the same key is valid, which is why
`supabaseHeaders()` adds the Bearer header only for legacy JWT-shaped keys.

`supabaseSelectAll` pages past PostgREST's silent 1000-row cap.

### The schema is named once, in `scripts/lib/tables.mjs`

It was quoted as string literals in 65 files across all three packages — 217 table names, plus a column list at almost every call site. Nothing checked them: PostgREST answers a request for a column that does not exist with a runtime error, on the one code path that asked, whenever that path next runs. A rename was a codebase-wide sweep with no compiler and no test behind it.

`tables.mjs` holds two things and no more: every table, view and RPC the baseline creates, and the projections that are asked for in **more than one place**. A projection used once stays at its call site next to the comment explaining it — this is not an index of every select in the codebase, it is the set of names that would otherwise drift.

`_shared.test.mjs` asserts both halves against the `.sql` files, in both directions: every name in the module is created by the baseline, every relation the baseline creates is named by the module, and every column in a projection exists on the relation it projects.

### `tickets` has exactly one writer

Eight modules held a private store over the same row — ingestion, categorisation, investigation, three resolution passes, auto-close, and the dashboard — each naming its own columns and building its own patch, and the investigation's backfill wrote past its own store with a raw `supabaseUpdate`. `scripts/lib/ticket-record.mjs` is now the only writer. It lives in `scripts/lib` because `web/` cannot import from `agent/src`, and the dashboard's status write touches the same three lifecycle columns auto-close does; leaving it out would have kept two owners of exactly the columns the module exists to own.

It owns the `needs_*` flags, the `deleted_at`/`archived_at` filters, the lifecycle timestamps, the `metadata.<pass>` trail, and the shop scope — bound once at construction rather than remembered at 60 call sites. It does **not** own `ticket_messages` writes (ingestion's upsert), `ticket_investigations` (the case file's own contract), or policy: `shouldAutoClose`, the level ratchet and the verdict mapping stay where they are and hand it columns.

### The two flagged passes share one protocol, and the descriptors are the difference

Categorisation and investigation run the identical cycle — claim a batch, then complete / skip / retry / abandon each ticket — so it is written once and parameterised by a descriptor naming the flag, the flag it raises, the stamp, the metadata trail, the projection and the extra selection.

This is what put the crash-safety rule in one place instead of five comments: **`complete` clears this pass's flag and raises the next one in the same patch as the result**, so a failure anywhere before it leaves the ticket in the queue rather than marked done with nothing behind it. `skip` clears the flag and writes nothing else. `retry` touches no flag. `abandon` clears the flag and never raises the next — investigating a guess would spend tool and model calls on a subject nobody chose. `attemptsSoFar` and the trail merge existed twice, character for character, before this.

---

## Orders

### An Orders page replaced the "Knowledge — Soon" placeholder (2026-09-14)

Asked for by the owner: the Shopify admin's order list, inside the app, so looking an order up does not mean leaving it. The sidebar's Knowledge item never had a page; Orders takes its slot. Columns are the owner's: Order, Date, Name (crown when VIP), Total, Fulfilment status, Articles, Carrier, Destination. Filters: fulfilment status, Global / By country, VIP.

- **Paged in SQL, 50 rows a page.** 6,008 orders is past PostgREST's 1,000-row cap, and paging an unordered read overlaps (§ Insights). `orders_list()` orders totally (`processed_at desc, id desc`) and counts the filtered set with `count(*) over ()` before the page is cut, so the pager and the rows come from one statement. Measured 2026-09-14: pages 1 and 2 share no order, ~300 ms a page warm.
- **The URL is the state**, as on Insights: a filtered page is linkable and the server re-renders. A page past the end falls back to page 1 rather than an empty table with no count.
- **Facets come from the data, grouped on the list's own filter expressions**, so each option's count is exactly what selecting it returns — all 17 checked against the live table. Today that is only `FULFILLED` (5,977) and `UNFULFILLED` (31), plus 14 countries and one order with no destination (`??`); a status Shopify adds later appears without a code change.
- **VIP is `vip_customers()`**, never compared in TypeScript — the same rule as the queue, the Customers panel and `open_orders()`.
- **The carrier is `order_fulfilment_timing`'s derivation** (lowest tracking company through `normalise_carrier()`), so a row and the Fulfilment carrier table cannot name different carriers. A test pins both.
- **Fulfilment status was drawn neutral, then given a light amber dot at the owner's request (same day).** The first version kept colour for the ticket ring alone. Amber marks an order not yet fulfilled; it is pale (#ffd98a on #e8a93a) so it does not read as the orange ring, and local to the page because gold belongs to VIP and `--warning` is the orange ramp.

### Delay and search (2026-09-14)

**Delay is whole days since the order was placed, shown only while the order waits to ship**, and "waits" is `open_orders()`'s rule copied condition for condition into `orders_list().awaiting_fulfilment` — not fulfilled or restocked, not cancelled, **not closed**. The last condition is the one that matters: six orders read UNFULFILLED for ever because they were refunded instead of shipped (§ Insights, "Orders waiting to ship"), and a Delay column counting them would show them as the most delayed orders in the shop. A test asserts the two functions share the four conditions. SQL decides *whether*, JavaScript counts *how long* (`delayDays`, floored), because the count moves every minute and the rule does not. Three days or more is red ink, the same line the dispatch figures and the waiting-orders list use; ink rather than a filled pill so it does not compete with the ring.

**Search runs in SQL over the whole table, not over the page on screen.** A filter over 50 rendered rows would report "no match" for an order on page 40. It matches the order name, the buyer's name and email (searched, never displayed on the list), and a tracking number compared in `orders.tracking_numbers`' stored normalised form, so `6C 2072 3002 488` finds `6C20723002488`. LIKE wildcards are stripped in `normaliseSearch` rather than escaped in SQL; nothing a person searches for contains them. The box debounces 350 ms and owns its text while typing, so a slow render for "mar" cannot overwrite "martin".

**Migration 16 drops the old signature before creating the new one.** `create or replace` cannot add an argument or a return column, and adding `p_search` beside the old function would leave two overloads PostgREST refuses to choose between — the page would fail on its first read.

### The destination ring is the queue's band, not a second score

The customer's name is ringed red / orange / green when an **open** ticket is confirmed against the order. It first shipped on the Destination cell and was **moved to the name the same day at the owner's request**: the ticket is about the person who wrote, and the name is where a reader of the row looks for them — the same reason the queue's VIP crown sits beside the name rather than on the row. The colour is the `priorityBand` the ticket already carries on `/tickets` — read through `listTicketsWithOrders` (the list's own projection, both halves of the sender partition) and folded per order by `ticketMarksByOrder`, which only picks the most urgent open band. Re-scoring here would give one ticket two colours the first time either rule changed. The ring is an inset shadow so a ringed cell keeps its neighbours' height, the same reason the queue's bars are.

**The join is `tickets.shopify_order_number`, and that makes the ring a floor.** Only a confirmed match is written there (§ Order resolution), so an order whose ticket never quoted a number stays unringed: a ring can be trusted when present and says nothing when absent. Keys compare through `orderNumberKey` (`#7008` == `7008`), and a non-Shopify reference (`Q00 26200111`) matches nothing rather than its digits. Measured 2026-09-14: **58 of 172 tickets** carry one (an earlier reading of 0 was a probe bug — VALIDATION_LOG 24).

Closed tickets leave no ring: a mark for a finished conversation would say somebody is waiting when nobody is. The detail page still lists them, open first.

### The detail page is cards, and names only what the list already did

Articles, Fulfilment, Payment on the left; Tickets, Customer, Destination, Tags on the right — Shopify's order page shape, with Tickets leading the right column because they are why this page lives in a support app. Personal data matches the Fulfilment panel's waiting orders: name and email, with the email withheld for marketplace buyers (placeholder addresses), and the masked address where no customer is linked. No street address exists to show (§ Data handling). Both pages write a `data_access_events` row. Ticket entries link to `/tickets`, not to the ticket: that page has no deep link yet.

---

## Management chat

Home's chat (2026-09-14): management asks a question, a model answers it by writing SQL against the live database. `scripts/lib/chat-*.mjs`, `web/lib/server/chat-service.ts`, `web/components/chat/`, migration 17.

### SQL, not retrieval, and one tool

The questions are about structured data — revenue by channel, shipping time by month, tickets per category — so the model writes queries rather than reading embedded documents: a similarity search cannot sum a column. One generic tool, `execute_sql`, rather than a tool per metric, because a tool per metric is a panel per metric, and the Insights panels already exist for the questions somebody thought of in advance. No framework: the loop is the investigation's shape again (the transport does one round trip; budget and dispatch live in a tested module).

### The boundary is a database role, not the prompt and not the parser

`mgmt_chat_ro` has `USAGE` on `chat`, `SELECT` on its views, and `EXECUTE` on one pure function. It has no grant in `public`, `auth` or anywhere else, and **nothing in `public` it could call runs with elevated rights** (checked 2026-09-14: no `security definer` function is executable by `PUBLIC`, and only `pg_catalog` / `information_schema` grant schema usage to everyone). Each query also runs in `begin read only` with `set local statement_timeout` and is rolled back, and is sent as `select * from (<query>) limit 1001`, which Postgres cannot parse with a second statement or a data-modifying CTE inside.

`chat-sql-guard.mjs` sits in front and is **not** the boundary. It exists so a refusal is a sentence the model can act on ("only the chat schema") rather than a permission error it retries. Two things it blocks are worth knowing: `set_config()` (could lift the timeout for the rest of the transaction) and `*_to_xml()` (runs a query given as text). A read-only *default* on the role is not a privilege — a session can change it — which is why every write is also simply ungranted.

**Verified against the database, not only in tests** (2026-09-14, as the role inside a rolled-back transaction): all 13 `chat` views read; `public.tickets`, `public.customers.email`, `auth.users`, `vip_customers()`, an insert into `chat_turns`, an update through `chat.shop` and `create table` in either schema are all refused; a 2 s timeout stops `pg_sleep(5)`. `set role postgres` could not be tested that way — `SET ROLE` checks the *session* user, so from a borrowed role it succeeds and proves nothing — and was checked through a real `mgmt_chat_ro` login instead, once the password existed: `permission denied to set role "postgres"`.

### Owner-rights views, the one exception to `security_invoker`

Every table has RLS on with no policies, so a role that does not bypass RLS reads **zero rows** through an invoker view. The alternatives were a `SELECT` policy per table for the role (thirty policies, and a policy exposes every column — the personal ones included) or owner-rights views. The rule exists to stop the anon key reading past RLS; nobody but `mgmt_chat_ro` holds any privilege on `chat`, PostgREST does not expose it, and `17_management_chat.test.mjs` asserts the revokes. The views are the column allow-list, which a policy cannot be.

**A chat view reads tables, never a baseline view** — learned by it failing. The first version wrapped `order_fulfilment_timing`, `ticket_reply_times` and `ticket_message_counts`, and all three answered "permission denied" on the live database: a `security_invoker` view nested inside an owner-rights one checks its tables as the *querying* role. They now read the tables, return the same rows and medians as the views they replace (169 reply-time rows, p50 74.3 h; fulfilment p50 34.2 h), and a test forbids a chat view from reading any baseline view and asserts the fulfilment lateral is 06's, character for character. The copy is not quite verbatim on purpose: 06 reads the destination as `shipping_destination ->> 'countryCode'`, a key no stored order has (the mapper writes `country_code`), so its country column is null on every row; the chat copy reads the real key and finds it on 6,007 of 6,008 orders. 06 itself is unchanged.

Another consequence: **a view checks table access as its owner, but a function call as the querying role.** `order_fulfilment_timing` calls `normalise_carrier()`, hence the one `EXECUTE` grant — and `vip_customers()` reads tables, so a chat view cannot call it either.

**VIP status is reached through one security-definer function** (migration 21, 2026-09-14, because management asked for it). `chat.vip_customer_rows()` runs as its owner, takes **no arguments**, fixes its `search_path`, and calls `vip_customers()` with the shop's own thresholds and the marketplace handles `vipArgs` excludes; `chat.vip_customers` reads it and returns ids with windowed orders and net spend. The alternative was copying the rule's SQL into an owner-rights view like the three above, and that was rejected for this one case: those copies are of *measurements*, this is *the business rule*, and two definitions of who is a VIP is exactly what centralising it in `vip_customers()` ended. A definer function is only as safe as what can be passed to it, which is why it takes nothing. The handles are a SQL literal, asserted against `ALL_MARKETPLACE_HANDLES` by `21_chat_vip.test.mjs`. Status is current only — who *was* a VIP last quarter cannot be answered, because the rule is evaluated against now.

### Aggregates only

Results go to OpenAI, and `AGENTS.md` keeps personal data out of prompts unless a task strictly needs it. Management questions do not. So the views select no name, email, phone, address below country, ticket subject or message text (the owner's call, 2026-09-14), and the test holds a list of those columns that no view may select. The cost is explicit: "who are our ten best customers" is answered with ids and totals, or with "not available here". Because no view names a customer, the chat writes no `data_access_events` row.

### What the model is shown of a result is not the result

A query may return 1,000 rows (1,001 fetched, to know when it was cut). The model reads at most 200, each cell clipped to 300 characters, the whole under 16,000 characters — with a note when rows were held back, and a louder one when the query hit the cap, because a total over a truncated result is wrong and a model will add the rows up unless told. The screen gets the rows (preview 200); `chat_queries` keeps 50, enough to reopen an answer and see what it rested on.

### Follow-ups replay the SQL, never the rows

A follow-up ("and last year?") needs to know how the last figure was computed, and the query says it exactly. Replaying rows would make every later step pay for them and invite the model to answer from memory instead of querying again. Ten turns of history at most.

### "Never invent a figure" is a prompt rule plus a visible trail

The prompt forbids any number not in a result of this conversation and prefers "the database does not hold this" to an estimate, and the last step is forced to answer from what it has. A mechanical check that every number in the answer appears in a result was considered and not built: percentages, rounding and derived ratios make it refuse correct answers. What stands behind the rule instead is **"How this was answered"** under every answer — each query, its SQL and its rows — and the prompt carries the data's known traps (marketplace buyers minted per order, `customers` as a snapshot, no delivery data, the moving start of the mail sync) so the model does not walk into them.

### Spend is logged on the turn, not in `llm_usage`

Same reasoning as the test chat: `llm_usage` answers what handling the mailbox costs, and its `pass` constraint admits the worker's passes only. Tokens live on `chat_turns` and are priced at read time from `llm-rates.mjs`, and the page shows the open conversation's running total under the question box. `gpt-5.2` is priced from OpenAI's published Standard rates (2026-09-14) **including its cached-input rate** — `estimateCost` gained `cachedInputTokens` for it, because in the first real run 75–95% of the chat's input was cached, and billing that at the full rate would have overstated the cost several times over. Models without a `cachedInput` rate are priced exactly as before. A turn whose model has no rate is shown as "not priced", never as $0. A turn that fails outright records no tokens, so the total can undercount a conversation with errors.

### A reasoning model by default

`CHAT_MODEL` defaults to `gpt-5.2`: a question is a one-off, so the larger model is worth it (the owner's call). Reasoning models refuse `temperature` and `max_tokens`, so `openai-client.mjs` sends them `max_completion_tokens` instead (`isReasoningModel`). Every worker model is on the older shape and unaffected. The key and its 30k TPM limit are shared with the worker — a hard question can take tens of thousands of tokens, so a separate key is the fix if the two collide.

### The password is set by hand, once

A secret has no place in a checked-in migration, so the role is created without one and cannot log in until it is given one. In the Supabase SQL editor:

```sql
alter role mgmt_chat_ro with password '<a long random password>';
```

Then in the repo-root `.env.local`, the session pooler URL with the role as user:

```
CHAT_DB_URL=postgresql://mgmt_chat_ro.<project-ref>:<password>@aws-0-eu-north-1.pooler.supabase.com:5432/postgres
```

Until both exist, `/home` says the chat is not set up and runs nothing.

## Agent test chat

The rehearsal harness behind `/agent-setup`'s **Test the agent** button: a message an operator types, put through the real pipeline, with every decision shown. `agent/src/testing/`, `web/lib/server/agent-test-service.ts`, `web/components/agent-test/`.

### It fakes the database, not the passes

A tool that shows what the agent does is worth nothing if it shows what a *copy* of the agent does. So the passes are the worker's own — `runCategorisation`, `runInvestigation`, `runCustomerResolution`, `runOrderResolution`, `runOrderContext`, `runDrafting` — called in the poll's order, with the same prompts, the same models, and real Supabase reads for products, orders, customers, promotions and knowledge. The only substitutions are the database underneath them and a decorator around the OpenAI client.

**The obvious implementation was a second ticket record**, in memory, that only the test chat uses. It was not built. `scripts/lib/ticket-record.mjs` is documented as the only writer of `tickets`, and its claim filters, flag protocol and metadata trail are where the pipeline's crash-safety lives; a second copy is a second place for them to be wrong, and the failure mode is silent — the rehearsal keeps working while the worker changes underneath it, which is the one thing a rehearsal cannot survive.

Instead the substitution happens one layer lower. `createTicketRecord` and `createDraftRecord` already take their PostgREST calls as an injectable `transport`, for their own unit tests — so `memory-transport.mjs` fakes the DATABASE and the real records run on top of it, unmodified and unaware. `createCaseFileStore` gained the same parameter; it was the one store still reaching for `supabaseUpsert` directly. `memory-transport.test.mjs` drives a whole claim → complete → claim cycle through the real record and asserts the flags move. That test is what the feature rests on.

**The transport throws on an operator it does not implement.** A silent "no rows" for an unknown filter looks exactly like a pass with nothing to do — in a tool whose only job is showing what the passes did. It also honours the projection rather than returning whole rows, so a pass that reads a column it did not select fails here instead of against PostgREST.

**The alternative — real rows carrying `tickets.is_test` — was rejected on blast radius.** The flag would have to be honoured by `ticket_queue`, the `listTickets`/`listConversations` partition, `ticket_message_counts`, `ticket_first_inbound`, auto-close, forwarding, the derived drafting queue and a share of the 21 Insights views. One missed filter puts an invented customer in front of a human, or into a monthly figure.

### The order is copied verbatim, including its one surprise

The poll runs `customers → categorise → investigate → orders → context`, so a first message is investigated with `resolved_context` still null: the order tool answers "commande non confirmee" and the order facts only reach the DRAFT, which reads `tickets.resolved_context` directly. That is what happens to every newly-arrived email. The rehearsal reproduces it and the transcript states it, because the alternative — resolving the order early so the case file looks better — would make the test disagree with the thing it exists to test.

### Identity is fields; the order number is not

On a real email the sender is the ENVELOPE — ingestion takes `from_email` off the Graph message, and no parser ever reads an address out of a body — so the operator supplies name and address as inputs. Asking them to write their identity into the message would mean inventing a parser production does not have, and then testing that instead of the pipeline.

An order number is the opposite case and gets the opposite treatment: on a real email it IS in the body, so what is typed in the field is **appended to the message** and `shopifyOrderCandidates` has to find it there. Stamping `shopify_order_number` directly would skip the pass being tested and report a confidence the pipeline has not earned.

### Gate 2 runs, and stops the run

"Your test email would never have become a ticket" is the most useful thing this tool can say, so the spam classifier runs first and a `blocked` verdict ends the run with that as the answer. There is a **Run it anyway** button, because an operator who has seen the finding may still want the rest. Gate 1 (the blocklist) is skipped: it is a rule about addresses that have written before, which an invented one has not.

### Cost is reported, never recorded in `llm_usage`

Five or six model calls a run, two on the mid tier. `llm_usage` answers one question — what does handling the real mailbox cost — and its `pass` check constraint admits only the worker's seven passes. Folding rehearsal spend in untagged would move `llm_usage_summary`'s per-ticket figures and the Agent panel's cost tiles with nothing saying why; tagging it needs a migration and a wider constraint, for a number that panel should not carry anyway. So the trace totals its own tokens through a sink of the same shape, and the dialog prices them at read time from `llm-rates.mjs`. **The trade is explicit: test spend is invisible to Insights, and visible in the tool that spent it.**

### The article test reports five states, because four failures want four fixes

`summariseMatches` gained a `candidates` field — the whole ranking, beside the banded `chunks` — and the knowledge tool carries it in `data`, which the model never sees. Without it, "your article scored 0.52 and the band withheld it" is indistinguishable from "your article was never found", and those want opposite fixes.

`used` / `retrieved_withheld` / `outranked` / `not_retrieved` / `not_searched`. The last is the one people hit and do not expect: `allowedTools` gives `searchKnowledge` to five subjects, so a message that categorises as `delivery` or `order` has no knowledge tool in its registry at all, and the best-written article in the library cannot be reached from it. Reporting that as "not retrieved" would send somebody off to rewrite an article that was never consulted. Readiness — approved, chunked, embedded, in a searchable category — is checked BEFORE any model call, because it is free and it is the common answer.

**It reports mechanism, not quality.** Whether the article that came back was the right one is the operator's judgement, and the UI says so.

### Runs are kept, and the ideal answer is why

A rehearsal you cannot look at again answers only "does it work right now". The two questions worth a table both need two runs: did changing the prompt, the article or the bands improve this, and **what should the agent have said**. The second is `agent_test_runs.ideal_body_text` — the same (model text, human text) capture `ticket_draft_edits` makes for real mail, with the difference that a rehearsal's situation can be INVENTED, so a gap can be written down before a customer has hit it. Nothing reads it yet and the UI says so: promising a feedback loop that does not exist is how a capture like this fills with text nobody trusts.

The row keeps the MASK of the address and neither the plaintext nor a hash — nothing here matches on one, so a hash would be a bare identifier with no reader. Re-running an old test means typing the address again, which is the correct price.

### The situation match is on the run (2026-09-15)

49 of the 52 `orders` rules name a situation and are candidates only once it matched, so a run that matched none reaches the three unconditional rules. The first run this was checked on (« Retard Commande », an overdue unshipped order) matched no situation and got `non_expediee` instead of `d01_expedition_en_retard` — and the trace could not say why, because `exemplar_match` is written only by the case-file store, which a rehearsal holds in memory and discards.

`runInvestigation` now passes `exemplarMatch` to `onResult`, and the rehearsal emits it on the `case_file` step as `situation`. The transcript shows the matched key, or on a miss the nearest situation with its canonical question, the similarity and the margin over the runner-up: a near miss wants more phrasings, nothing close wants a new situation. `{}` means the matcher threw or was not wired; a run saved before this has no field and says so.

`closest_question` was added to the stored `exemplar_match` summary for the same reason, and is therefore also written on real investigations — additive to a jsonb nothing reads by shape.

### A rule the transcript cannot show is a rule nobody reviews

The rehearsal has always run the REAL rules — `loadAnswers` reads the same table the worker does, because a transcript is worth nothing if the policy it shows is not the policy. What it showed of them was thinner than what it applied, in three ways, and each one hid the question a reviewer was there to ask.

**The `ask` field rendered on no rule at all.** `ask` became a list on 2026-08-30; the transcript read it with a helper that returns null for an array. A field that silently never appears is worse than an absent one — the block looked complete. It now tolerates the bare string too, exactly as the loader does, and says when the questions did NOT reach the case file: they join `missing` only where the final verdict is already `needs_customer_input`, so « asked » and « wanted to ask » are two different outcomes and the transcript now separates them.

**The findings were not rendered.** They are what SELECTS the rule — a `need -> finding` map derived from the tool ledger — so both « why this rule » and « why no rule » are unanswerable from the key alone. Shown whether or not a rule matched, because the run that matched nothing is exactly the one whose findings are the answer: a missing rule and a finding that came back `unknown` are indistinguishable without them, and they want opposite fixes.

**The skeleton was not rendered anywhere in the run.** It is the one field from this layer that reaches a model, and the failure mode it carries is documented — an instruction naming a fact the dossier does not hold is a reliable way to manufacture that fact, measured on `annulation_trop_tard` and a return-authorisation number this shop does not issue. That draft passed every mechanical check. **The review queue is what stands behind it**, and a reviewer who cannot see the skeleton is reviewing the reply without the instruction that shaped it.

**And no policy at all is a finding, not a blank.** `selectPolicy` returns null when the subject maps to no answer set, when the set holds no approved rule, and when the load threw — it cannot say which, because it returns before it knows. The transcript rendered nothing, which read as the rules layer not being wired. The rehearsal now emits the answer set beside the case file, from the same mapping the runner used, so the block always states what could have applied.

## Migrations

The migrations are a **baseline, not a history**: files describing the schema as it should be, run in order against an empty database. They are not idempotent and not re-runnable over a populated one.

Editing one therefore means editing the definition — re-apply against a fresh database rather than patching an existing one in place.

**That has been departed from exactly once, deliberately, and the dev database is still equivalent to a from-empty apply.** On 2026-08-15 the refactor added three views, `order_number_range()` and a check constraint; re-applying would have cost the 214 ingested tickets every measurement in this file was taken against. The additions were applied forward instead, in one transaction, with the SQL **extracted from the baseline files rather than retyped** — so what is in the database is the definition, not a second version of it. The constraint is the one statement that could not be extracted (the baseline declares it inline in `create table`) and it was applied as an `alter table … add constraint` with the same name and clause, asserted against the baseline before running. No column was added, so the column-order caveat from the 8→5 split does not arise. The script was discarded rather than checked in: a forward step living beside the baseline is precisely how a baseline turns back into a history.

**It has now happened a second time (2026-08-17), and the answer was to shrink the problem rather than to build the second axis.** Phase 5 needed two schema changes: a new table (`ticket_drafts`) and one widened check constraint (`llm_usage_pass_check`, to accept `draft`).

- **A new table needs no forward step at all.** `07_drafting.sql` creates `ticket_drafts` complete, and applying that one file to the populated project is byte-for-byte what a from-empty apply would run. Baseline and database stay identical, and the file is a normal member of the chain. **Adding a table is not a departure and should not be treated as one.**
- **The constraint is the real one**, and it was applied the same way as 2026-08-15: clause extracted from `06_analytics.sql` rather than retyped, asserted against `USAGE_PASSES` before running, dropped and re-added under the same name in one transaction, script discarded. Five existing rows, all carrying passes the wider clause still accepts.

The **reconciling test now exists**, which is the half of the two-axis arrangement that was actually load-bearing: `06_analytics.test.mjs` asserts the constraint's literals equal `USAGE_PASSES`. Two copies of that list had been drifting apart with nothing watching — the sink degrades an unrecognised pass to `other`, so a constraint widened without the module would have silently mis-filed every drafting call's cost.

So the general rule stands, narrowed to what it is actually about: **a change that alters an existing relation** wants a forward step, extracted and asserted; a change that only adds a new one is just another baseline file.

**The third alteration came the next day (2026-08-18)** — `ticket_drafts` gained a `disposition` column and its verdict check was widened to accept `needs_human`. Same method again: clauses extracted from `07_drafting.sql`, asserted before running, one transaction. Two things are worth recording because they are the first of their kind here:

- **A column was added, so the column-order caveat now does apply.** `alter table … add column` appends, while a from-empty apply of the baseline places `disposition` after `source_verdict`. Nothing in this codebase reads by ordinal — every projection names its columns, which is what `tables.mjs` exists for — so the divergence is inert. It is written down because the next person to compare a dumped schema against the baseline will otherwise think something is wrong.
- **The backfill was a decision, not a default.** The column is `not null`, and adding it with a default would have silently labelled 32 existing drafts. It was added nullable, classified from `source_verdict`, then made `not null` — so every row's disposition was chosen rather than inherited.

The additive-steps axis is still not built, and the reason is now clearer than "it has only happened three times": all three alterations were widening a constraint or adding a column to a table this project owns end to end, each applied in one transaction with the clause extracted from the file that defines it. What would justify the second axis is an alteration that cannot be expressed that way — a backfill with logic in it, or a change that has to run against a database somebody else's deploy also touches.

### Views carry joins and aggregates, never judgement

The dashboard counted messages by reading every message id in the shop; order resolution read every inbound body to keep one per ticket; the order-number range was an asc/desc pair of round trips. All three are set operations the database can answer, and PostgREST being the only interface is why they were not.

The line is the one `search_knowledge_chunks_text` already draws: vector maths and set operations in Postgres, judgement in tested JavaScript. `shouldAutoClose`, the level ratchet and the evidence rules did not move, and `ticket_queue` deliberately omits VIP — that is derived at read time from `rfm_group` and nothing stores it, so putting it in a view would make a business rule into a schema object.

### Every view is `security_invoker`

**One deliberate exception: the `chat` schema** (migration 17) — see § Management chat. It is outside the baseline, reachable by one role, and asserted by its own test.

A view created without it executes as its **owner** and reads straight past the RLS on the tables beneath. Every table in this baseline has RLS enabled with no policies precisely so that only the service role can read, which makes an owner-rights view over `tickets` the one way an anon key could read the whole support mailbox. The views also `revoke all … from anon, authenticated`, saying it a second way, and `_shared.test.mjs` asserts both on every view the baseline creates.

Each view names its output columns with an explicit `as`. Not style: an unaliased expression gets whatever name Postgres invents for it, and a caller asking PostgREST for the name it expected gets a 400.

### The baseline is now applied by a test, not only read by one

Every other assertion in `supabase/migrations/` is a regex over the `.sql` files as text. That is enough for "does this constraint list the same 14 subjects as the taxonomy module" and worth nothing for "does this view return the row we think it does" — a join can be wrong in every way and still contain the words a text assertion looks for.

`_live.test.mjs` applies the whole baseline into a throwaway schema, seeds the smallest population that can tell each projection right from wrong, asserts the output, and drops the schema in a `finally`. It makes permanent the check that proved the 8→4 split, which was run once from a terminal. **Skipped without `SUPABASE_DB_URL`**, deliberately: `npm test` has never needed a database and this must not be what changes that.

### Split by domain, not by the order things were built

The baseline was eight files that had accreted as a changelog: 05 patched 04, 07 mirrored a flag 03 created, 08 rewrote a comment 02 had written, and `tickets` was created in 01 then altered twice more. Reading it meant reconstructing each table from up to four places.

It is now **five** files along the dependency chain — foundation → Shopify snapshots → knowledge → support → exemplars — and **every table is created complete**. There is no `alter table … add column` in the baseline at all, and `_shared.test.mjs` asserts that, because a single one is the file drifting back into being a history.

**The reorganisation was proved, not reviewed.** Both sets were applied into throwaway schemas on the dev Postgres and the resulting catalogue diffed: 425 columns, 172 constraints, 152 indexes, 17 triggers, 3 functions, 20 tables with RLS, 20 table comments and 139 column comments — identical on both sides. Column *order* differs where a folded `alter` had appended a column; nothing reads columns positionally (every query names them), so that is the one intentional difference.

### `if not exists` is only on the extensions

Guarding every statement would obscure the schema these files exist to document, and a guarded statement silently does nothing when it matters most. The extensions are the exception because a Supabase project ships with them installed. `spam_audit_body_expiry_idx` carried a guard from when it landed on a populated table; in a baseline that is meaningless and it was removed.

### Tests

`_shared.test.mjs` holds what is only checkable across the whole set: no data statements, RLS on every table, a comment on every table, an `updated_at` trigger wherever that column exists, and **nothing referenced before it is created** — which is what makes the apply order safe. Each file then has a sibling asserting its own contents, with the taxonomy lists compared element-wise against `scripts/lib/support-taxonomy.mjs` and the verdicts against `case-file.mjs`, so a check constraint and the module it mirrors cannot drift apart.


## Insights

### Every figure comes from a view, because paging rows is silently wrong

PostgREST caps a response at 1,000 rows and pages an *unordered* query in whatever order the planner returns, so consecutive pages overlap and drop rows. This is not theoretical: while designing these panels, an unordered paged tally of the 58,201 customers returned `CHAMPIONS` as **438, then 554, then 472 on three consecutive runs** against unchanged data. Only the third was right, and nothing about the first two looked wrong.

So `06_analytics.sql` carries twenty-one views and `readView` takes a hard limit with **no pagination at all**. A view that could return more rows than that limit is the wrong shape and belongs back in SQL as a further aggregate. The two exceptions — `customer_ticket_facts` and `ticket_reply_times` — are bounded by ticket count rather than by customer or message count, and each says so at its call site.

### Judgement stays in JavaScript, so the views expose `rfm_group` and never `is_vip`

**One deliberate exception since 2026-09-11:** the VIP comparison lives in `vip_customers()`, because it is a comparison over windowed order aggregates and its thresholds are data on `shops`. See § Tickets dashboard, "VIP is the shop's rule".

Same rule as the queue: joins and aggregates in SQL, business rules in tested JS. Who counts as a VIP changes with the business and is owned by `customer-segments.mjs`; writing it into a view would freeze it into a schema object and create a second definition to disagree with the first.

### A metric that cannot be computed renders as a dash, never as zero

On a dashboard a zero is a claim — "nothing was late", "nobody complained", "it cost nothing". `BlockedTile` takes a **required** reason, so a blocked metric cannot ship without saying what is missing, and a missing series in `BarList` draws hatched at full width rather than empty. The delivery tiles are the case this exists for: `delivered_at` is set on 1 order in 2,006, and a delivery panel full of zeros would read as a fleet with no late parcels.

`hasUsableDeliveryData` therefore needs a tenth of orders covered, not one. A single hand-closed fulfilment must not switch on a section whose medians would then describe three rows.

### Fulfilment and delivery are two durations, and conflating them is what kept the measurable one unbuilt

Fulfilment is `processed_at` -> first `fulfillments[].created_at`, populated on 1,993 of 2,006 orders and computable today. Delivery needs carrier scan events that never arrive. Treating "delivery metrics" as one blocked lump is why nobody had looked at dispatch timing — which turned out to show **July 2026 at 30.7% of orders past three days and a p90 of 149h**, against a steady 4-14% and ~70h in every other month.

### Contact rate counts orders, and ships with its own denominator

Per carrier, the column counts **shipments that produced at least one ticket**, not threads. One parcel chased four times is one unhappy delivery, and threads-over-shipments would put `AUTRE` — six shipments, four threads — past 100% while saying nothing. The thread count still rides in the same cell, because "many parcels went wrong" and "one went badly wrong" are different problems.

The rate itself is a **floor, and the panel says so in the same breath**. A thread reaches a parcel only through `tickets.shopify_order_number`, which the resolver fills in and which **52 of 214 tickets carry** — customers write "my parcel has not arrived" far more often than they quote #5337. A dashboard cell reading `1.2%` with nothing beside it is exactly the plausible-but-wrong number the rest of this section exists to prevent, so `fulfilment_ticket_coverage` is a view rather than a sentence in the copy: when the resolver runs again the caveat shrinks by itself instead of going stale.

**What survives the caveat is the ordering.** GLS is contacted about **4.1× as often as Colissimo** (5.1% of 198 shipments against 1.2% of 1,311), and under-counting that affects both carriers hits both roughly alike. The note ranks only carriers with 100+ shipments for that reason — a six-shipment carrier tops any ratio you like.

### "Who is writing to us" reports two reachability numbers, because they are two questions

The Support panel splits its tickets by whether the sender's address can be matched to an online purchase: **111 verified buyers, 34 from customers with no orders, 69 unmatched**, out of 214.

The middle group is the section's reason to exist, and the copy carries one prohibition throughout: **a zero-order customer is not a non-customer.** A sale made in a physical shop never reaches Shopify, so an unmatched address is silence about our records rather than a denial about the person. Three of those 22 people have written a Judge.me product review, which nobody does for a product they never had — the evidence is in the data, not in the argument.

**Reachability is two tiles and a note rather than one figure.** Those 34 tickets come from 22 distinct people; **22 of 22 have a deliverable address and only 8 carry marketing consent.** "Reachable" would have answered whichever question the reader assumed, and the expensive assumption is the lawful one: everyone in that group may be *replied to* about their own ticket, and 14 of them may not be *solicited*. Both numbers count people, not threads — a list built from the ticket count would be 1.5× too long, and that ratio is rendered rather than asserted so it corrects itself.

**The views count, they do not name.** `support_purchase_states` emits `buyer_tickets` / `no_order_tickets` / `unknown_tickets` and reachability flags; the words `known_no_orders` and what a reply may say about it stay in `purchase-verification.mjs`. Same rule that keeps `is_vip` out of the customer views — a view emitting the state names would be a second definition to disagree with the first. The per-category cut carries ticket counts only: they sum across rows, while a distinct-customer count would double-count anyone writing under two subjects, so those live in the shop-level view alone.

The category table filters to subjects where someone unverified actually wrote. Fourteen rows mostly reading zero would bury the finding, which is that **13 of 21 `promotions` tickets (62%) come from people who have never ordered** — code-hunters, and by far the highest share on the board.

### The contacts CSV filters on consent, and it is the only bulk export in the app

The reachability tile carries a download of the people behind it. Four things are deliberate.

**Consent is the `where` clause, not a column.** The query filters on `on_email_marketing_list`, so the file holds 8 rows and not 22. A "consented" column would eventually be sorted by hand, or ignored — and the 14 people who may be answered about their own ticket but not solicited would end up in a campaign. They are absent from the file instead of flagged in it.

**One row per person, not per ticket.** Somebody who wrote three times is one person to contact; their subjects are joined into a cell. A per-ticket export would put the same address into a mail merge three times, which is a real harm rather than an untidy file — two of the eight have three tickets each.

**The file is built in the route, not in the page.** The Support panel is otherwise entirely aggregates, and a client-side blob would mean shipping every name and address into the HTML on every render whether or not anyone downloads it. Personal data leaves the database only when somebody asks for the file, and that ask writes one `data_access_events` row with the count — an export is exactly the access worth being able to reconstruct later. `no-store`, because a cached export is a stale list of people and one served to a later visitor is a disclosure nobody asked for.

**The dates are `first_message_at`, and that is not a detail.** `tickets.created_at` reads `2026-08-09` for all 214 rows — the day the corpus was ingested — so an export using it would stamp every contact with the same date and look like a broken column rather than a synced one. `first_message_at` is when the customer actually wrote and covers 69 distinct days. Two columns, first and last, because a row is a person and two of the eight wrote three times over several weeks; one "contact date" would have to pick an end and would drop the other without saying so.

**The control is an icon, so its accessible name does the work.** The tile's headline figure is 22 and the file holds 8, so a corner icon labelled only "Download" would read as exporting everything above it. Both the `aria-label` and the tooltip name the count, the filter and the number of people deliberately left out — the `foot` caveat sits below the icon and is not necessarily read first.

**Two CSV details that are correctness, not polish.** A UTF-8 BOM, because Excel opens a BOM-less file in the system codepage and turns *Frédérique* into *FrÃ©dÃ©rique* — which reads as a database fault and is not one. And cells beginning `=`, `+`, `-` or `@` are prefixed with an apostrophe: Excel and Sheets execute those, and these values are whatever a customer typed into a name field on the storefront.

**The standing caveat.** `README.md` step 8 — dashboard authentication — was already the blocking item because `/insights/customers` names individuals on screen. A file of names and addresses raises what an unauthenticated visitor can walk away with, so this export tightens rather than loosens the case for shipping auth before the dashboard is exposed anywhere but localhost.

### Tickets per month carries a contact rate, and the Support panel reaches into a fulfilment view to get it

A ticket count is a volume, and a volume cannot be read without knowing whether trade grew underneath it. **85 tickets in July** looks like the worst month on the board until the orders are beside it — July did 450 orders at **18.9%**, against June's 76 over 324 at **23.5%**. The busier month is the *better* one, and the bare counts say the opposite.

The denominator is `fulfilment_by_month.orders`, read by `support-service.ts` — the only read on this panel that is not a support view. The alternative was an `orders` column on `support_by_month`, and it is wrong for a reason that is not stylistic: the two aggregates key on **different clocks**. `support_by_month` groups on a ticket's `first_message_at`, `fulfilment_by_month` on an order's `processed_at`. A join in SQL has to pick one side to drive, and either choice silently drops the months the other side owns — orders in a month nobody wrote in about, or mail in a month that sold nothing. Joining in TypeScript over two already-aggregated series keeps both, and a month present in one and absent from the other stays visible as a missing rate rather than a wrong one.

**It is a calendar rate, not a cohort rate.** A ticket about a June order counts against July if it was written in July. Attributing each ticket back to its order's month would be the cohort version, and it is not available: `tickets.shopify_order_number` is filled on 52 of 214 threads, so three quarters of the mail has no order to be attributed to. A cohort rate over the quarter that happens to be resolvable would be a far more confident-looking number about a far more biased sample.

### The first month of the ticket series is a floor, and the panel says so

Orders start **Feb 2026**; the synced mailbox starts **May 2026**. So May puts part of a month of mail over a whole month of trading and prints **7.5%** — the lowest rate on the chart, and the exact shape a genuinely quiet month has. Every other month sits at 18-24%.

The panel detects this rather than hard-coding it: the service reports the earliest month with orders, and the view flags the first ticket month when the order series began before it. That is the same distinction the current-month asterisk makes, at the other end of the series — a partial month is partial whether the truncation is the sync window or the calendar. Both are decided in TypeScript for the same reason: neither is something SQL can know.

### A sales channel is measured with the store's own instrument, in its own section

Amazon is 467 of 2,006 orders and dispatches against a marketplace's promise rather than ours, so its dispatch time is a separate question — but only answerable *against* the store-wide figure, which is why it renders directly below it rather than on a page of its own. The section reuses the same component, the same six bucket boundaries and the same 72-hour line: two blocks that look alike can be read against each other, and a copied threshold that drifts turns a comparison into two unrelated charts.

The cut lives in **three additive views** (`fulfilment_summary_by_channel`, `fulfilment_by_channel_month`, `fulfilment_by_channel_bucket`) rather than a `channel` column on the existing three. Adding one to their `group by` would have turned every existing one-row-per-shop read into several rows and made every current caller report one channel's figures as the store's — silently, with a plausible number.

The views group by **every** channel and filter to none; `fulfilment-service.ts` names `amazon` in a constant. Which channel deserves its own section is a business judgement, and a `where` clause would have made the schema own it — a second channel now costs a constant and no migration. Matching is on `sales_channel_handle`, not `sales_channel`: the latter is a display label Shopify can restyle, and matching on it would turn a cosmetic change upstream into an empty panel.

The channel breakdown deliberately carries **no carrier table**. Marketplace orders ship on the same carriers as everything else, and a per-channel carrier split would slice a 467-row denominator into three that are too small to read.

### Returns and refunds are two figures, not one rate

The Delivery section carries one measured tile among its blocked ones: orders that came back. It counts **per order, not per refund** — an order refunded twice is one unhappy order, the same arithmetic the carrier contact rate uses, and the same reason.

Returns and refunds are reported **separately and never summed**, because on this store they disagree and the disagreement is the finding: **3 refunds and 0 returns across 2,006 orders**. A single combined "return/refund rate" would print 0.1% and bury it.

**The zero is a recorded value, not a missing one** — `return_status` reads `NO_RETURN` on all 2,006 orders, so Shopify genuinely holds no return against any of them, and the tile is entitled to say so. What it is *not* entitled to say is that nothing came back: all three refunds were issued with no return record at all, which is the signature of a return agreed over email and settled by hand. So the tile never takes a `good` tone, and a note beside it states that 0.1% is a floor until someone confirms whether returns are supposed to be raised in Shopify. A low refund rate is only good news if everything that came back was recorded.

The four new columns are read with `num`, not `count`. `count()` coerces an absent key to 0, and these columns are newer than the deployed view — a database that has not been re-applied would otherwise render **"0 orders were ever refunded"** as a confident figure. Null instead, and the tile blocks with the fix in its reason.

### Carriers moved under Delivery, and ship with three columns nothing writes

The carrier table used to sit between the Amazon section and Delivery, which put it in the *dispatch* half of the page. That was the wrong half. Dispatch timing is the warehouse's number and barely varies by carrier — Colissimo 24.5h against GLS 23.3h. What the table is actually asked at is a delivery question: **which carrier loses, breaks or delays parcels.** So it renders after the Delivery section, as a peer rather than nested inside it: the blocked delivery tiles stay in their own section, because a working table mixed in among them turns "waiting on a feed" into "some of this is broken".

`Lost`, `Damaged` and `Delivered late` are wired to the table and to **nothing else**, deliberately, as placeholders for a source that does not exist. Neither side of the system can fill them today: no carrier scan events reach Shopify, and a ticket records only that its subject was `delivery` — a lost parcel, a broken bottle and a late one are the same row, because the taxonomy has no axis below the subject. The words *do* appear in `categorise.mjs`, but only inside the prompt that teaches the model what `delivery` means; nothing persists them.

They are typed `number | null` and mapped to `null` rather than through `count()`, which is the whole point of adding them empty. `count()` coerces a missing column to `0`, and **"COLISSIMO: 0 lost"** is a claim about a carrier that nobody has measured — the same failure as the delivery tiles that this panel already blocks. The cells render as em dashes over the hatch used for a missing bar elsewhere, with a note under the table saying so in the table's own words, because a reader who screenshots the table for a 3PL takes the dashes and not the tooltip.

The cost of shipping them empty is a column spec and three `null`s; the benefit is that the shape of the answer is agreed before the source is chosen, and wiring it later is one `read` per column in `mapCarrier` with no layout argument to reopen.

### Carrier names are normalised in SQL, once

The live table holds `COLISSIMO`, `Colissimo` and `LA POSTE COLISSIMO` — one carrier, three strings, from a free-text 3PL feed. A breakdown over the raw value reports three carriers and makes GLS look larger than it is. `normalise_carrier()` is a function rather than a `case` inside one view so the panel and any future SLA report cannot disagree about how many carriers exist.

### Tokens are stored; money is computed at read time

`llm_usage` holds counts. Rates live in `scripts/lib/llm-rates.mjs`, are overridable with `LLM_RATES`, and are applied when a figure is rendered. A euro figure written into a row is wrong the day the rate card moves, with no way to restate the history behind it — and models get swapped here by environment variable, so that day is not hypothetical.

`estimateCost` returns `rated: false` rather than 0 for an unpriced model, and the panel surfaces that. A new model reporting $0.00 because nobody added its rate is worse than a panel admitting it does not know.

### Usage is captured at the transport, and failures are rows

Every model call passes through one `request()` in `openai-client.mjs`, so one `usageSink.record` covers all of them; capturing per call site would have been four edits, and `completeJson` — which returns only the parsed content — could not have reported anything at all. The sink defaults to a frozen no-op, so every existing caller behaves exactly as before.

Retries inside one call are **not** separate rows: a retried 429 was never billed, and counting it would invent spend. A call that exhausts its retries **is** a row, because the last attempt may well have been served and charged, and a ledger that records only successes under-reports exactly when things are going wrong.

The store is best-effort and swallows its own failure. This table is a ledger of what the work cost, not part of the work; a poll that categorised twenty tickets and then failed to write its cost rows has still categorised twenty tickets. The accountant may not abort the job.

**None of it can be backfilled.** OpenAI reports usage on the response and nowhere else, so the history starts at the first call after wiring — which is why this shipped before any panel that reads it.

**The no-op default is safe and was also the bug (2026-08-17).** A sink nobody constructs is indistinguishable from a sink that works: for a day the table held 0 rows while the categoriser, the decomposer and the investigation agent all ran, because the poll and every CLI took the frozen no-op and no test could catch it — each half was correct in isolation. So the sink and its flush are now handed out **together**, by `createShopUsageRecording`, and a caller takes both or neither. The general rule: an optional dependency whose absence is silent needs one named constructor that cannot be half-adopted, not a default that reads as configuration.

**A dry run reports the spend and stores nothing.** `flush({write: false})` totals the calls and tokens without writing, because a dry run makes real billed calls — the money is worth printing even where the run's contract is that it leaves no rows. It drains either way: the entries describe calls that already happened, so withholding them would double-count on the next flush.

### The topic map is rebuilt by hand, and says how old it is

Clustering is an all-pairs cosine comparison over the whole embedded corpus, and its 0.68 threshold was tuned by eye and is corpus-specific. That makes a rebuild a deliberate act with a judgement in it, not something that should re-run overnight and change the map under whoever is reading it. `cluster_runs` records when, at what threshold, and over how much mail, so the panel can state the map's age and warn once the live corpus has drifted away from it.

`cluster:tickets` therefore stays **print-only by default** and `cluster:tickets:save` persists — the script's header has always promised it is read-only and free to re-run, and people rely on that.

Resync is a documented command rather than a button: the job is an all-pairs comparison over the corpus and this app has no job queue, so running it inside a web request would block a worker for its duration.

**Reversed 2026-09-11: there is a Rebuild button, because the owner asked for one.** Both reasons were re-checked rather than overruled. The whole `--save` run takes **~9 seconds** over the live corpus, so a request can wait for it; and the button takes **no arguments** — it always runs at the script's tuned defaults — so "re-run until the map looks nice" is designed out rather than left to discipline. `topic-map-rebuild.ts` spawns the same script (so the job's config, logging and exit code are what the terminal sees) and allows one run at a time: a second click joins the first, because two concurrent saves would each prune the other's run. If the corpus grows until the run no longer fits a request, this is the decision to revisit.

### Every panel is read over a range, and the range is the URL (2026-09-11)

The panels were all-time, and it showed: with the order sync reaching back to May 2024, the monthly dispatch chart had 23 bars and gained one a month for ever. Now every panel reads over a range the reader picks — **Last 24 hours · 7 days · 30 days (default) · 6 months · Last year**, or a custom from/to — and the range lives in the query string, so a filtered panel is linkable and two people reading one URL see one thing. Nothing is aggregated in the browser: the server re-renders against the new URL.

**Each ranged figure is its own SQL function** (`RANGED READS` in `06_analytics.sql`), not a filter over a finer view, because a median cannot be summed out of daily rows. The 21 views stay for their other readers.

**The range crosses the wire as wall-clock timestamps plus the shop's timezone**, and Postgres converts with `at time zone`. The database runs in UTC, so bucketing there put an order placed at 00:30 in Paris on the previous day; and doing the conversion in JavaScript would have meant re-deriving daylight saving. `11_insights_ranges.test.mjs` asserts no ranged function takes a `timestamptz`. The zone is Shopify's `ianaTimezone` on `shops`; while it is null the panels cut days in UTC **and say so** rather than assume Paris.

**The grain follows the range** — hours for a day, days up to two months, weeks to six, months beyond — so a chart has a readable number of points at every range.

**"All time" joined the presets (owner's request, 2026-09-14) and is the one without a fixed length.** It starts at the first synced order — `first_order_at` from `insights_freshness`, so the context reads freshness *before* resolving the range rather than after — and picks its grain from that span by the same `grainForSpan` a custom range uses: 17 May 2024 to today is 29 monthly bars. **It has no comparison, by construction rather than by special case:** `previous` is the equal span before the first order, and every panel already refuses a previous window that starts before its source's coverage (`previousCovered`, `windowCovered`, the agent panel's "no calls before"), so no "vs previous" chip is drawn against a period nothing was measured in. Starting at the first **order** is a choice for the panels that read orders; Support's mail starts in July 2026, so its months before that draw hatched as missing, not as zero mail. An explicit from/to still wins over `range=all`, as over every preset. Measured on live data: every panel read over all time returns, the slowest at 1.7 s (customer mix) and 1.3 s (product sales).

**The flat first year is real, not a sync gap — do not "fix" it by starting later.** Checked 2026-09-14: only 11 orders precede March 2025 — 1 in May 2024, 1 in June, none July–December, 2 in January 2025, 7 in February — and they are **#1001 to #1011**, Shopify's first order numbers, all genuine (paid and fulfilled, three `REELUP`-tagged launch orders at €0, one refunded). The shop launched in May 2024 and ramped from March 2025 (83 orders, then hundreds a month). Starting "All time" at the first month with volume would be a judgement about which orders count, and would hide the launch.

**The comparison is like for like.** "vs previous 30 days" covers the same *elapsed* time one span earlier: 14:00 today is set against 14:00 thirty days ago, not against a finished day, which would invent a drop every afternoon. A comparison whose window starts before a source's history is not shown at all — "the 30 days before our first synced order" is unmeasured, not quiet.

### A live dashboard says how old its data is (2026-09-11)

The panels were never stale in the caching sense — every page is `force-dynamic` and every fetch `no-store`. They were stale in the sense that matters: **the jobs feeding them stop, and the charts keep drawing the last thing they were given.** The mail worker was last run on 20 August, and Support carried on showing August for three weeks with nothing on screen to say why.

Three mechanisms, each for a different failure:

- **The freshness strip** (`insights_freshness` + `insights-freshness.mjs`) states when orders last synced, the newest message, the last nightly run and the topic map's age, with thresholds in one place: orders stale past 30 h (nightly sync), mail past 48 h, a sync `processing` past 6 h is an error (it died without closing its row).
- **Buckets outside a source's coverage are missing, not zero.** SQL returns only non-empty buckets; `bucketCoverage` decides which empty ones are a real zero and which fall before the source begins or after it was last synced, and those draw hatched with a gap in the line. The mail edge is the newest message in either direction, because the worker records no "last poll" anywhere. While mail is behind, Support also withholds the comparison and the contact rate: tickets from half a range over orders from all of it is a rate that only looks low.
- **An open page refreshes itself** every five minutes while visible, and on returning to the tab after a minute away — a server re-render of the same URL, holding the old render dimmed until the new one lands. Tighter would re-read identical rows: the data moves on the order sync and on each mail poll.

### Platforms are folded from channel handles, in JavaScript (2026-09-11)

The filter offers **Shopify · Amazon · Yves Rocher**. **Yves Rocher is not a handle**: it is the Mirakl Connect channel, `connect-dev-1`, and all 409 of its orders carry the tags `Mirakl` and `Yves Rocher FR`. **Shopify is defined as every channel that is not a marketplace** (online store, draft orders, the Shop app), so a new first-party channel lands in Shopify rather than in nothing. The mapping is in `insights-range.mjs`, beside where `AMAZON_CHANNEL` used to be, for the reason that constant existed: which channels make a platform is a business judgement, and SQL takes handle lists.

**The Amazon section is gone from Fulfilment** because the filter does its job for every marketplace, with the same component and the same 72-hour line. The comparison it existed for is now the same panel with and without the filter.

A filter that does not apply is **disabled with its reason, never hidden**: tickets belong to no platform, and the customer base is a snapshot with no honest date range. A control that vanishes between tabs reads as a bug.

### Sales: four definitions a reader would otherwise have to guess (2026-09-11)

- **Revenue is net of refunds, cancelled orders excluded.** Subtracting refunds alone would still count a cancelled order that was never paid. On the last 30 days this reproduces the reference dashboard exactly: €16,375.77, Shopify 99.9%, Yves Rocher €9.80.
- **A free line is not a sale.** Samples ride along on most orders at €0; counted, they top every "best product by orders" list. Lines with a zero discounted total are excluded from product rankings.
- **New vs returning is never computed over a marketplace**, which mints one customer record per order and would read every buyer as new. "New" is "no earlier order in our data", and our orders start in May 2024 — so the split differs from a tool that sees older history (the reference showed 108 / 99 where this shows 102 / 102).
- **There is no "by gender", and that is a reversal.** It first shipped as the *product's* range, read off the catalogue tags (`femme` on 83 products, `homme` on 6), because no customer gender exists anywhere in this store. **Removed the same day at the owner's request as misleading:** the question being asked was about buyers, and a women's-range ranking answers a different one while looking like it answers that. Customer gender would need a source first — a Shopify customer metafield or a survey field — and inferring it from first names was not considered: it would be wrong often enough to mislead and it is personal data derived without consent.

### The explanatory notes came off the panels (2026-09-11)

Asked for by the owner: the panels no longer carry paragraphs of interpretation: the figures lead, at the sizes of the reference dashboard. The reasoning those notes carried is this section, where it already lived. Two things were kept because they are facts about the data rather than commentary: **a blocked figure still renders as a dash with a one-line reason**, never a zero; and **the Customers panel keeps a one-line warning** that it names people and the dashboard has no sign-in.

### The Customers panel reads a range now, beside a snapshot (2026-09-11)

It was all snapshot. It now carries three ranged figures under the snapshot row, asked for by the owner — orders per customer, newsletter movement with churn, and capture — and says which rows are which ("Customer base today" / "In the selected range"). The platform control stays **disabled** here: every figure counts *people*, and marketplaces mint one customer per order, so each ranged read passes the Shopify filter whatever the control says. Four definitions:

- **Orders per customer** counts orders *inside the range* per Shopify customer, uncancelled. The last column is "10 or more" so a year's tail fits one axis; the average treats it as 10, a floor.
- **Subscribes and unsubscribes come from a snapshot.** `customers` holds each person's current consent and when it last changed — one timestamp — so a person who joined in March and left in June appears only in June. Both series are floors, the card says so, and the chart hatches after the newest consent change **and before the earliest recorded unsubscribe**: measured 2026-09-11 the snapshot holds subscribes back to 2022 but unsubscribes only from **April 2025**, and the first version of the churn card compared a year against that half-empty year and printed **"↑98% vs previous 12 months"**. Both edges are derived in SQL (`consent_through`, `unsubscribes_from`), never written down.
- **Churn is unsubscribes over the list size at the start, and the start is an estimate.** Reconstructed from the snapshot as *subscribed now with a last change before the range* plus *unsubscribed now with a change inside or after it* — exact only when nobody changed twice, and labelled "(est.)". It is stated **per day on day-grain ranges and per month on longer ones** (the average rate over the range, scaled), because a 30-day window and a 12-month window cannot share one unit and stay readable. A range starting before the unsubscribe edge gets a blocked card, not a low number.
- **Capture rate is the share of first-time buyers who were on the newsletter by that first order**, split into *subscribed before ordering* and *joined at checkout*. Checkout is a consent change within **60 minutes** of the first order — a judgement, so the constant lives in `customer-activity-service.ts` and SQL takes it as a parameter. Measured 2026-09-11 on first buyers since March: 874, of whom 227 subscribed before and 362 at checkout — the checkout opt-in is most of the list's growth, which is why the two are drawn apart rather than summed. A floor too: someone who opted in and has since left counts as not captured.

### Sales adds countries and pairs (2026-09-11)

**Sales by country** is net revenue per destination country with a flag, the reference card's layout; the first five show and a chevron opens the rest. **The flags are inline SVGs**, deliberately: Windows ships no flag emoji, so `🇫🇷` renders as the letters "FR" on the machine this is read on. Designs are simplified to what survives at 22 px; a country without one gets its code in a neutral badge rather than a wrong flag.

**Bought together** ranks product pairs: every pair of distinct paid products in the same order counts once for that order, whatever else was in it. Revenue is what the two lines brought in together. Global and per-country come from one `GROUPING SETS` query, ranked both ways in SQL, so switching metric is a re-sort. **Free lines are excluded** for the same reason as the product ranking: samples ride along on most orders and would pair with everything.

### "Who buys this product": one product, three kinds of customer (2026-09-14)

Asked for by the owner, at the bottom of Sales: pick a product and see, over the range, how many customers bought **only** it, how many **did not** order it, how many ordered it **with something else**, and the top 7 products it was ordered with.

- **People, not orders, and the three figures partition them.** Every count is distinct Shopify customers who ordered in the range, so only + with + without = customers — asserted in the migration test and checked live (209 = 6 + 3 + 200 for the 30-day best seller). "Ordered with" is therefore **across the range, not within one order**: a person with an order of the product alone and a later order of a serum has to be in one bucket, and "with something else" is the only honest one. The card says so under the figures.
- **A free line is not a purchase — on every side.** A zero discounted total (a sample, a promotional masque) neither moves a buyer into "with something else", nor appears in the ordered-with list, nor makes someone a buyer of the product itself. One filter where lines are read; the test asserts it appears exactly once. Measured on the 30-day best seller: 7 orders carried it beside a free product, and those buyers count as "only".
- **Never over a marketplace.** Amazon and Yves Rocher mint a customer per order, so every buyer would be a single-product customer and "did not order it" would count orders, not people. The service passes the customer mix's own `mixArgs` (marketplaces removed from "all"); a marketplace platform blocks the card with the reason. Same rule as new-vs-returning.
- **One product per call, selected through the URL (`?product=`).** The first draft returned every product's split in a single read — up to 8 rows a product — which PostgREST's 1,000-row cap would have cut silently once the catalogue grew (§ "Every figure comes from a view"). Now the function takes `p_product_id` and returns at most 7 rows (~160 ms). The price is that choosing a product re-renders the panel, like any Insights filter; the gain is that the selection is linkable and survives a range change. `?product=` is not carried between tabs.
- **The selector offers what sold in the range**, A–Z, defaulting to the range's best seller by revenue. **It is searchable** (owner's request, same day): a native `<select>` cannot hold a search box, so it is a small ARIA combobox — type to filter, case- and accent-insensitive through the same `foldForSearch` Best products uses (moved into `insights-format.ts` so the two cannot match differently), arrows and Enter to choose, Escape to close. A product with no paid line has nothing to split, and an unknown id falls back to the default rather than showing zeros.
- **Migration 18 drops the draft's six-argument signature first**, since it may have been applied and `create or replace` cannot add an argument.
- **Country and VIP filters narrow the population, not just the buyers** (owner's request, same day; migration 19). Both sit in the function's `ranged_orders`, so the customer total, the three buckets and the ordered-with list all describe that group and still sum — a filter on the buyers alone would divide a group by everybody and print a share nobody asked for. **Country** keeps orders delivered there, on the same `coalesce(country_code, '??')` expression the Orders facets and Sales by country use; a customer who ordered to two countries counts in each, on that country's orders only. **VIP only** keeps customers `vip_customers()` admits — no threshold is compared in this function — and the rule looks back over **its own window (6 months), not the selected range**, which the card states. VIP only with no rule set shows a notice instead of zeros, the same stance as the waiting-orders list: "nobody is a VIP yet" is not "no VIP bought this". A country the range did not ship to is dropped rather than applied, so a stale link cannot silently show an empty group. Selection is `?mixCountry=` and `?mixVip=1`, scoped to the card so they cannot be mistaken for panel-wide filters. Measured 2026-09-14 on the 30-day best seller: FR 179 = 5 + 3 + 171, FR + VIP 57 = 4 + 0 + 53, both matching an independent recount from `orders`.
- **How often its buyers bought it, as a chart** (owner's request 2026-09-16; migration 26). The Customers panel's "Customers by number of orders", for one product: columns 1, 2, 3… of how many orders carried it, `10+` last. Three choices it is worth knowing were made:
  - **Its buyers are the population, not the range's customers.** Everyone else is already the split's "did not order it" bucket, and drawn as a zero column it would be 683 against 61 on the 90-day best seller — a chart with one bar and no distribution. So the columns start at 1 and sum to `onlyCustomers + withOtherCustomers`, which the card prints beside the heading and the service asserts by construction (it adds the two rather than reading a fourth figure).
  - **Orders carrying it, not units of it.** `select distinct customer_key, order_id` — two jars in one order is one order, because that is what "orders" means on the chart this one is read against. Units would make the two axes different measures with the same label.
  - **The same filters, on the same arguments.** `insights_product_orders_per_customer()` repeats the split's `ranged_orders` predicates verbatim and `getProductCustomerMix` builds one argument object for both reads, so country and VIP only can never narrow one figure and not the other. The migration test asserts the two `where` clauses are character-identical after whitespace; a second function rather than more columns on the first, because the distribution has up to ten rows and the ordered-with list has seven, and joining them would have invented a row shape neither needs.

  Free lines are excluded on the same rule as everywhere else in the card: an order carrying the product only as a zero-value sample is not an order of it. Measured 2026-09-16 over the last 90 days, best seller by revenue (Soins Crèmes Anti-âge Duo Jour & Nuit Temps Sublime, €6,927): 61 + 3 + 1 = 65 buyers, matching an independent recount from `orders` exactly and matching the split's 37 + 28; FR 47 + 3 + 1 = 51 = its FR buyers; VIP only 22 + 3 + 1 = 26 = its VIP buyers, and no VIP column exceeds its unfiltered one.
- **The function moved below `vip_customers()` in 06.** A SQL-language function's body is checked when it is created, so calling `vip_customers()` from a function created 1,000 lines above it broke a fresh install — caught by `_live.test.mjs`, which applies the baseline into a throwaway schema, and by nothing else. The block now follows `orders_list_facets()`, after every VIP function.

### The Segment Finder: conditions in the browser, evaluation in SQL (2026-09-14)

Asked for by the owner, under the Customers panel's base cards: build a group of customers from **orders** and **spend** over the last N months and **lifetime spend**, each **more than / less than** a number, joined by **AND / OR**, and see who is in it.

- **A flat list with AND or OR in each gap, and AND binds tighter than OR** — the precedence of every query language, and the only one that needs no bracket editor. `segmentGroups` turns the list into OR-of-AND groups, and the sentence under the form prints the brackets that implies, so the operator reads `(Orders > 1 AND Spent > €100) OR Lifetime spend > €500` before running it. Six conditions at most: past that it stops reading as a sentence.
- **Evaluated in `customer_segment_find()`, never in TypeScript.** The base is every customer on file — 57,362 — and a per-customer read would be the paging mistake § "Every figure comes from a view" forbids. The groups travel as jsonb and are checked row by row in one statement; the totals are counted over every match, and only the member list is cut (25, by lifetime spend).
- **Every customer on file, not just buyers,** so "lifetime spend < €0.01" finds the 54,006 who never paid: 53,989 who never ordered plus 17 whose orders net to zero (free or fully refunded). **Minus the marketplace-synthetic records** — 1,008 customers holding an Amazon or Yves Rocher order are left out of the base entirely, not counted as zero-order people, since each is one order rather than one person.
- **Spend is net of refunds, cancelled orders excluded,** the figure Sales and the VIP rule use. Lifetime is computed from our orders, not Shopify's `amount_spent`, so the windowed and lifetime figures cannot disagree about what a euro is; the order history starts at the shop's first order (#1001), so nothing is missing from it. Comparisons are strict, because the screen says "more than".
- **Fails closed.** An unknown metric or operator makes its condition false, not true, and an empty group matches nobody — the route validates first, SQL is the second lock. One totals row always comes back, so zero matches is a figure.
- **Nothing runs until "Find customers".** The result names people, and every search that names anyone writes a `data_access_events` row (counts, never names). A live preview on every keystroke would have written one per keystroke.
- **Pinnable like any row** (`pin="segment-finder"`, owner's request 2026-09-15). Pinning moves it through a portal, which remounts it, so the conditions and the last result reset — acceptable for a one-off layout choice, and cheaper than lifting the form state out of the component.

Checked live 2026-09-14: five segments, including both AND/OR orderings, match an independent recount from `orders` exactly (225, 186, 215, 233, 11); the base equals customers on file minus synthetic records; 0.3–0.7 s a search (4.4 s cold).

### Best products can be searched, and a match keeps its rank (2026-09-14)

Asked for by the owner: a box on the Sales panel's Best products card to find one product. **It filters the ranking rather than re-ranking**: a match shows the position it holds in the full list and its bar keeps the leader's scale, so the answer to "find the Masque Repulpant" is "#23, €410", not a list of one that looks like #1. Up to 50 matches show; without a search the card still shows the top 10.

**In the browser, not in SQL**, because the global list already arrives whole — one row per product sold in the range — so there is nothing more to fetch. Matching ignores case **and accents**: the catalogue is French, and "creme" must find "Crème".

**By country, a miss is not proof the product did not sell there.** Country lists are ranked and cut in SQL (`insights_country_product_sales`, `p_limit`), so a search can only reach that country's loaded best sellers — **five**, `PER_COUNTRY` in `sales-service.ts` — and the empty state says exactly that, naming how many were loaded, rather than "no match". Raising the cap would make country search useful and costs rows per country per metric; not done without asking.

**VIP only (owner's request, same day; migration 20) is a server read, not a filter over what arrived.** The lists are ranked in SQL, and VIP is the shop's rule in `vip_customers()` — so `insights_product_sales()` and `insights_country_product_sales()` take `p_vip_only` plus the rule's arguments and re-rank over VIP customers' orders. Filtering the shipped lists in the browser could not work: they carry no customer, and a country ranking cut to five would lose products a VIP-only ranking would contain. Off by default, so every other reader of those functions is unchanged. The switch is `?bestVip=1`, scoped to the card. Three consequences, deliberate:
- **The "Who buys this product" selector keeps the unfiltered product list.** VIP only here must not change which products the other card offers, so the panel keeps its original read and makes three more only when the switch is on. The VIP rule is read once per render for both cards.
- **VIP follows the rule's own window (6 months), not the range** — the same caveat as the product card.
- **No rule, or a marketplace platform, shows a notice rather than empty lists.** "No VIP bought anything" would be a claim; with no rule nobody is a VIP yet, and a marketplace buyer never can be.

Measured 2026-09-14, last 30 days: all customers 74 products / €16,422; VIP only 58 / €6,346, matching an independent recount from `orders` product for product; no VIP figure exceeds its unfiltered one. Both functions moved below `vip_customers()` in 06 (the fresh-install rule from the product card), and `20_best_products_vip.test.mjs` now asserts that for **every** function calling `vip_customers()`, so the ordering is a unit test rather than something only `_live.test.mjs` catches.

### Numbers a client component prints are formatted by hand (2026-09-11)

`Intl` output is not the same on the server and in the browser: Node printed **"58.4K"** where Chrome printed **"58.4k"**, and fr-FR's thousands separator has moved between U+00A0 and U+202F across CLDR versions. Either mismatch fails hydration, and React then re-renders the whole page on load — found on the Customers panel as a console error, not by eye. `euros` and `compactNumber` in `insights-format.ts` now build their strings from digits, so the characters are identical everywhere. Plain `en-GB` integer grouping is left to `toLocaleString`; it has been stable.

### Orders waiting to ship, VIPs first (2026-09-11)

The Fulfilment panel lists every order still waiting to ship, under its first row of cards, asked for by the owner: name, email, provenance, order size, placed date, and days waiting — **red at 3 days or more**, the same line the dispatch figures use. It opens on **VIP customers** and switches to **all unfulfilled**.

- **Waiting means not FULFILLED or RESTOCKED, not cancelled, and not closed.** "Not closed" is load-bearing: six orders read UNFULFILLED for ever because they were refunded instead of shipped (#1095, #1794, #1923, #4687, #4886, #6398), and they are waiting for nothing.
- **Provenance is mostly "Shopify" in the VIP view, by construction.** A marketplace buyer is a new customer record per order and can never meet a VIP rule; Amazon and Yves Rocher orders appear in the "all" view, **without an email** — their record holds a placeholder address (example.com, mail.codisto.com) that would read as real.
- **Now, not ranged.** An order a fortnight old and unshipped is the one that matters, so the date range does not cut the list; the platform filter does. It is as current as the last order sync, which the card says.
- **VIP comes from `open_orders()` calling `vip_customers()`**, never compared in TypeScript, and the order number links to the order in Shopify admin. The card warns that it shows names and emails, as the Customers call list does.

### Any row of cards can be pinned to the top, two at most (2026-09-11)

Every row on every panel carries a pin in the top-right corner of its rightmost card, asked for by the owner. A pinned row moves into a **Pinned** section at the top of that panel; two rows at most, and a third pin is **disabled with its reason** rather than silently bumping the oldest — a row vanishing from the top without being unpinned reads as a bug.

- **Moved, not re-ordered.** A pinned row is portalled into the Pinned section (`PinBoard.tsx`), so DOM order — what a screen reader reads and Tab walks — matches the screen. CSS `order` would have been less code and put the two out of step.
- **Per viewer, per panel, in the browser.** Which rows someone keeps at the top is a personal view, so it lives in `localStorage` under `qiriness.insights.pins.<panel>`, read after mount (the first render matches the server's, no pins) and guarded on every access. A pin whose row is not on the page today leaves no empty band.
- **Every row needs a stable id** — `<Grid pin="…" label="…">`. Renaming an id forgets that pin for anyone who had it; the label is only the button's accessible name.

### Settings shows the model that ran, not the one configured here (2026-09-15)

Asked for by the owner: a Settings table of the agents with their model and key figures, and forwarding moved into Agent Setup (it decides where the agent sends mail).

- **The model column leads with what `llm_usage` recorded.** The worker reads its own environment on another machine, so the dashboard's `AGENT_*_MODEL` can differ from what actually runs; the recorded model on every call cannot. The configured model shows only for an agent with no call in 30 days, marked "Not run", and a second model in the window is listed, so a mid-window change is visible.
- **Read-only.** Changing a model is an env var and a worker restart; a dashboard switch would write a setting the worker does not read.
- **The management chat is read from `chat_turns`**, since its tokens are deliberately kept out of `llm_usage`; test-chat runs are in neither and are not counted.

### Large screens get a larger UI, not wider margins (2026-09-11)

On a wide monitor the dashboard sat in the middle at a laptop's size: Insights stopped at 1480px and centred, and everything was sized for 16px. Three changes, and smaller screens are untouched by all of them:

- **The root size steps up above 1600px** (12.8px base, 13.2px from 1600, 13.6px from 1920, 15.2px from 2400) in `globals.css`. It first shipped at 16 / 17 / 18 / 20px; on 2026-09-15 the owner found that too zoomed, and after a first ~5% cut asked for 80% of that across every tier, small screens included. Nearly every size in the app is in rem, so type, spacing, cards and the sidebar grow together, in proportion. The sidebar width moved from px to rem for that reason, and its icons are sized in CSS rather than by their `size` prop.
- **Insights fills the window** up to the same 2400px ceiling Tickets and Agent Setup use, with a gutter of `clamp(1rem, 2.4vw, 3rem)`. It had no padding of its own, so a narrow window used to put the cards flush against the sidebar.
- **Charts grow taller with their width**, up to 1.6x their base height, because a chart stretched across 2000px at 280px tall reads as a flat line. Axis text is in rem and the room reserved for it follows the root size.

Measured on the owner's screen (2544px viewport): root 20px, sidebar 330px, the Insights page exactly the width of its scroll area (2201px), the revenue chart 2018x484, and no horizontal overflow on Insights, Tickets or Agent Setup.

### The dashboard signs in through Supabase Auth, and roles live in app_metadata (2026-09-11)

The dashboard was open to anyone who could reach the port, and it names customers. It now needs an email and password, and three roles decide what each person may open.

**Supabase Auth holds the accounts.** This was built first on a `dashboard_users` table with scrypt hashes and a signed session cookie of our own, then replaced — before a single real account existed — on the owner's question of whether the home-made one was as safe. It was sound on the basics and weaker on the ones that matter later: no MFA, no password reset, no leaked-password check, rate limits that a restart forgets, and a twelve-hour session that could not be revoked mid-flight. Supabase brings all of those, is audited, and is already a dependency. What the custom build was right about — that Supabase's real advantage, per-user row security in the browser, is unusable here because every read goes through the server on the service key — remains true, and is why the gate, the roles and the logging below are still ours.

- **The role is `app_metadata.dashboard_role`**, not `user_metadata`: a user can edit their own user_metadata through the API, and a role a user can edit is not a role. Only the secret key writes it, and only `npm run users` holds that key. An account with no known role may open nothing, which is what makes a stray Supabase sign-up (project-level setting, on by default) harmless rather than urgent.
- **Accounts are made in the terminal.** No sign-up page, no reset email: a page that creates accounts is a page someone else can find, and the team is small enough to ask a developer.
- **Every request is checked twice, cheaply.** The access token's ES256 signature and expiry are checked locally against the project's JWKS, so a forged or stale cookie costs no network call; a token that passes is then confirmed against `/auth/v1/user`, cached for one minute per token. That one minute is the revocation window — a disabled or re-roled user stops within it — and the price is one Supabase call per person per minute. Without the second check the window would be the token's full hour.
- **Server code re-checks the cookie rather than trusting a header from the middleware.** A header can be set by whoever sends the request, so one middleware bypass would otherwise be a bypass of every page guard too. The check is the same cached one, so it is nearly free.
- **A session is twelve hours from the password**, not from the last refresh: the middleware refreshes the hour-long token as needed, but `amr` carries the original sign-in time, so a tab left open cannot renew itself forever.
- **Fails closed.** No Supabase configuration means nothing verifies and nobody gets in, rather than everybody.
- **One error for every failed sign-in** — wrong address, wrong password, disabled, or no role — so the reply never says which addresses have accounts. Five failures per address per fifteen minutes on top of Supabase's own limits, which see this server's address rather than the visitor's and so cannot tell one guesser from the whole team. In memory, which a restart resets: fine for one internal server, and the thing to replace with a shared store if the dashboard ever runs on several.
- **Signing out is told to Supabase**, so the refresh token is dead server-side and not merely dropped by one browser.
- **Roles are code.** `DENIED` in `dashboard-auth.mjs` is the one table of what each role may not open; the middleware, the Insights tabs and the panel guard all read it. Developer and Management are identical today — two roles so they can diverge without a migration. **Contact may not open Insights → Sales** (the owner's rule): the tab is not drawn, the URL redirects to Fulfilment, and `/insights` lands the contact team there instead of on Sales.
- **Who looked is logged, not what they saw.** Each surface that names customers writes one `data_access_events` row with the Supabase user id and role, and counts — never a name or an address. The trail must not become a second customer list. A panel left open writes a row per 5-minute refresh; that is the honest count of how often the data was on screen.

### The nightly is given more time than it needs, and a killed run must look killed (2026-09-12)

The order table stopped at **#6992, created 2026-09-11 09:52**, while the dashboard's freshness strip read `Nightly sync — running since 3 h ago`. Both the run and the report were wrong, in ways that fed each other.

**The job timeout was shorter than the job.** The last complete run took **71 minutes** (2026-09-11 11:51:09 → 13:02:44 UTC) against `timeout-minutes: 60`. The scheduled run of 12 September started at 06:42 UTC and was killed at the cap, part-way through. `timeout-minutes` is now **180** — the measured duration with room to grow, and still far under GitHub's 360-minute default, so a genuinely hung run does not burn six hours.

**A killed run writes no ending, so `processing` cannot be trusted.** The nightly's `catch` writes `failed` and is reached by every sync that *throws*; a sync that is *killed* dies where it stands and its `integration_events` row stays `processing` for ever. Two such rows were in the table — 30 August and 12 September — and `describeFreshness` renders `processing` as "running since…" in a quiet `info` tone until six hours have passed, so a dead sync read as a live one all morning. `failStaleIntegrationEvents` now runs at the top of each nightly and closes any `processing` row older than the timeout, as one server-side PATCH so there is no window between deciding and closing. `STALE_SYNC_MINUTES` and the workflow's `timeout-minutes` are 180 in both places and each names the other; they must not drift, or the sweep fails a live run.

**The run is latency-bound, not cost-bound — except where it is cost-bound, and one shared page size cannot express both.** Measured against the live shop on 12 September: one customer page took 378 ms at `first:10` and 443 ms at `first:50`; one order page 1054 ms at `first:10` and 1359 ms at `first:50`. At 10 — the default the nightly silently took — 58,357 customers and 5,992 orders are roughly 6,400 round trips. The nightly now passes `--page-size=50`.

**Products are the exception, and raising the shared page size to 50 broke them on the first run that used it.** Shopify prices a query *before* running it and refuses anything over 1000 points, and the price is the product of the `first` values, not of the data: each product node carries 25 variants, 100 metafields and 10 references, so it costs roughly 33 points where a customer costs about 2. At `first:50` the query priced at 1003 and was rejected outright — `MAX_COST_EXCEEDED` is a refusal, not a throttle, so the retry path cannot help and the run died after orders. Re-measured that afternoon: **30 passed, 40 and 50 were refused.** `PRODUCT_MAX_PAGE_SIZE = 25` now clamps that one connection inside `fetchProductPage`, below the measured failure point because the cost is set by those three constants — raise `PRODUCT_METAFIELD_PAGE_SIZE` again and 30 becomes the next 1003. The clamp is silent rather than an error: a caller asking for a bigger page is asking to go faster, and the honest answer is the largest page this query can afford.

**Orders still sync after customers, and deliberately.** Reversing them was considered — orders are the table support actually needs, and they are the ones that die when the axe falls — but `runShopifyOrdersSync` resolves `customer_id` from a map read out of `customers`, so orders-first would write **null** customer links for exactly the people who first bought that night. With the timeout no longer the binding constraint, the ordering costs nothing; if it ever needs to change, the re-link pass has to come with it.

### A duration chart has to show what has no duration yet (2026-09-12)

The dispatch histogram bucketed orders by how long they took to ship, which silently means *orders that shipped*. For 1–12 September it showed nothing past 96 hours while an order sat unshipped on day ten, and the reader — correctly — read the two cards as contradicting each other.

So `insights_fulfilment_buckets()` returns a seventh bucket, "Not shipped yet". The rule this sets, beside "a metric that cannot be computed renders as a dash, never as zero":

- **A chart that measures how long something took must also say how many have not finished.** Otherwise the slowest cases — the ones worth acting on — are exactly the ones it cannot draw, and the chart is most misleading when the news is worst.
- **Where two cards on one panel describe the same orders, they are counted by the same condition, in SQL.** The waiting bucket uses `open_orders()`'s rule verbatim (not cancelled, not closed, nothing dispatched), and `14_fulfilment_waiting.test.mjs` asserts the two conditions stay word for word identical. A shared denominator that drifts is how a panel starts disagreeing with itself.
- **It is not a duration, so it gets no percentage.** The six buckets carry a share of shipped orders; the seventh carries a count, because a share of a denominator it is not part of would be a third wrong number.

### An order webhook re-reads the order rather than believing it (2026-09-12)

Orders were only ever written by the nightly, so between runs the desk read a table up to a day old — and for two days in September, two days old. `/api/webhooks/shopify` closes that to seconds. Five decisions make it safe to point at production.

**The raw body, never `request.json()`.** The HMAC covers the exact bytes Shopify sent; parsing and re-serialising changes them and every signature then fails in a way that looks like a wrong secret.

**The payload is a notification, not data.** A webhook body is REST-shaped (`id: 6997`, `line_items`, `total_price`) while `mapOrder` reads the GraphQL shape. Rather than keep a second mapper honest for ever, the handler takes the id and **re-reads that one order through `ORDERS_QUERY`, the query the nightly uses**, then maps it with `mapOrder`. One extra API call buys a row that is indistinguishable from a nightly-written one, because it came from the same query and the same mapper. `fetchOrderByLegacyId` reuses the selection set through the search filter (`query: "id:…"`, `first: 1`) rather than restructuring it into a fragment.

**A refund payload's `id` is the refund.** The order is `order_id`. Reading `id` for every topic would fetch a refund id as an order, find nothing and report a clean skip — a failure indistinguishable from success, which is why `orderIdFromPayload` is a named function with its own test rather than a property access.

**The status code is a decision, not a formality.** Shopify reads any non-2xx as "retry for 48 hours". So everything a retry cannot fix answers **200** — an unknown shop, an order that no longer exists, a replay — and only what a retry genuinely can fix answers **500**. A bad signature answers 401 and writes nothing at all, audit rows included: a table anyone on the internet can fill is not an audit table.

**Two guards, for two different races.** `integration_events.event_key` on the webhook id makes a redelivery a no-op, which matters because Shopify retries whenever it is unsure. Re-reading the order already defeats late delivery — we always fetch current state — so the remaining hazard is concurrency: two deliveries for one order, handled at once, can read in one order and write in the other. Comparing the read `updatedAt` against the stored `shopify_updated_at` closes that. Equal timestamps are deliberately NOT stale, or a redelivery could never repair a row that failed halfway.

**The endpoint is public, and that is the stronger position.** `middleware.ts` lets the path through without a session because Shopify cannot hold a cookie. It proves itself with a signature over the body — a proof that covers the payload as well as the caller. Behind the gate every delivery would 401 for 48 hours and then be dropped.

**The three privacy topics are declared under `compliance_topics`, not `topics`.** Put them where ordinary subscriptions go and `shopify app deploy` refuses the entire version — "The following topic is invalid: customers/data_request" — which reads as a typo and is not one. Shopify keys them separately because it treats them as a separate obligation: required of every app in the App Store, rather than subscribed to by choice. Same endpoint either way; the route dispatches on the topic header.

**`headerValue` must handle a `Headers`, and the green test suite is why it did not.** A Route Handler passes `request.headers` — a `Headers` instance, whose entries are not own properties, so `Object.entries(headers)` is `[]`. The shared reader in `shopify-compliance-webhooks.mjs` enumerated own properties, found no signature, and returned false before comparing anything: **every real delivery got the same 401 a forged request gets, for any secret, correct or not.** Fourteen unit tests passed throughout, because all of them passed plain objects — the one shape production never sends. The afternoon of 2026-09-12 went on re-pasting a secret that was right all along. Both webhook paths now read through `.get` when it exists, and both suites assert it with a real `Headers`. The general rule this earns: when a test double stands in for a platform object, the double is a hypothesis about that object, and a handler is only tested when something passes it the real thing.

**None of this replaces the nightly.** Deliveries are dropped, and one that arrives mid-deploy is simply gone. The nightly remains the reconciliation pass; this is the fast path, not the record.

