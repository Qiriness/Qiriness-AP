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

**It runs in the investigation, not the categoriser**, although the categoriser already reads the same email and emits structured output. The categoriser runs on *every* ticket; investigation runs only on `ENABLED_SUBJECTS`, so decomposing there would pay for forwarded mail, level 4 and the `contact` kind. `shouldDecompose()` narrows further on cheap structural signals — a second subject from the categoriser, ≥320 chars, or ≥2 question marks — so an ordinary one-question ticket spends nothing.

**Entities are copied, not inferred.** The extraction is told to return what the customer *wrote*; a date, an amount or a `Q00…` reference is not an order number. They are hints for the router, never facts: an order number still has to be confirmed against the order's email hash before anything is written.

**Which text each tool gets is the subtle part.** The semantic matchers (`lookupProduct`, `lookupStock`) get the sub-question plus any verbatim product names, because asking the IDF-weighted matcher about an email half-concerned with a parcel means competing with the parcel's vocabulary. `extractPromotionCodes` always gets the **raw** email: a paraphrase is exactly where a literal code stops being present.

**The tool budget grows (+2 per extra task) and the turn budget does not.** Tool calls here are cached database reads; the expensive bound is how many times the model speaks. Holding tool calls fixed would mean the second half of an email is investigated with whatever the first half left over. Opening moves are capped at 4 so a three-way split cannot consume the budget before the model has spoken.

### The matched situation is recorded and acted on by nothing

Exemplar retrieval runs beside the investigation, on the message that triggered the run, and its result reaches `ticket_investigations.exemplar_match` and nowhere else. `investigate()` is never told; a test asserts the key never appears in its input.

**The independence is the measurement, not caution.** Two declarations of what a ticket requires now exist — the exemplar's authored `requirement_needs` and the run's own `evidence_gaps` — and comparing them answers whether the corpus describes real tickets. Feed one into the other and the comparison becomes circular, answered once and permanently lost. `npm run eval:exemplar-needs` is the report, and it excludes by name any row where the exemplar supplied the needs.

Three supporting reasons: a wrong match would inject a wrong situation's needs, and restraint at 0.65 is 85% on the subject proxy; enforcing it would make the *second* source load-bearing while the first still is not; and on current bands it would fire on a minority of tickets anyway.

**It cannot break a run.** Every failure path returns `{}` and logs. It costs no extra API call either — `findInboundMessages` selects `embedding`, so the match reuses the vector ingestion already wrote.

**One asymmetry to remember when reading the numbers:** the bands were calibrated on each ticket's *first* inbound message, and the match is taken on the *trigger* message, which for a thread is a later one. Expect the two to disagree on follow-ups.

### The exemplar stands in only when the decomposer produced nothing

`decompose.mjs` deliberately invents no needs when its call fails — guessing from the category would put fabricated requirements into the very numbers the field exists to measure. A matched exemplar is not that guess: it is a list a person wrote for a situation that cleared the MATCHED band, so it stands in rather than reporting "nobody said what this required".

**Only there.** While the decomposer has spoken the exemplar is ignored entirely, because the moment it can top up a *successful* decomposition the two stop being independent. `caseFile.needsSource` records which source spoke (`model` / `exemplar` / `none`) and the row is stamped `supplied_needs`, so the comparison never measures a list against a copy of itself.

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

### Two index spaces in one column, because the pruner deletes by position

`import-exemplars.mjs` deletes any phrasing at or past the end of the authored list — the only way it can know that an exemplar which used to have five phrasings now has three. Translations are generated rather than parsed out of the document, so by that test every one of them looks stale and would be destroyed on the next import.

Translations therefore live at `phrasing_index >= 100`, out of the pruner's reach, and `05_exemplars.sql` enforces the boundary with a check constraint rather than trusting two scripts to keep agreeing about it. `TRANSLATION_INDEX_BASE` is exported from `exemplar-import.mjs` and the migration test asserts the constraint against it, so moving the base moves both or fails.

`language` is reported by `match_support_exemplars()` and **never filtered on**: an English email matching a French phrasing weakly is better than not matching it at all, and the column exists to measure that, not to prevent it.

**Every phrasing is embedded alone and separately**, translations included — `buildExemplarEmbeddingInput` takes the text and nothing else, no language tag, so an English email meets the English row directly and the exemplar takes its best phrasing rather than an average. Translations can therefore only raise an exemplar's score, never lower it.

**Which is exactly what breaks the over-fetch.** `match_support_exemplars()` fetches `match_count * 8` phrasings because the inner limit counts phrasings while the caller counts exemplars, and 8 works only while no exemplar has more than about that many. Five phrasings in four languages is twenty rows for one situation, enough to fill a three-exemplar request on its own and return one result — silently, looking like a retrieval quality problem. **The multiplier must be raised in the same change that generates translations**, not afterwards.

### Subject filter only — the opposite of the knowledge policy

`categoriesToSearch()` adds `faq` and `brand_story` to every knowledge search because reference material generalises across subjects. Situations do not: « où est ma commande » is never the answer to a promotions question. Widening here would only add near-misses, and at 32 rows a near-miss can out-rank the right answer more easily than in a library of hundreds. An uncategorised ticket searches everything rather than nothing — no filter is a weaker claim than a wrong one.

---

## Knowledge

Nothing auto-writes `knowledge_documents`; the catalog sync only fills `shopify_content_sources`. `source_type` → `manual` **is** the manual-edit lock — no separate flag, and resync is then unavailable.

Unfilled core-topic slots are client-side placeholders, never database rows; clicking one creates a pre-filled draft.

---

## Tickets dashboard

### The middle section is not tickets

Dropped mail never reaches the `tickets` table — the gate runs before the ticket write — so the only trace is a `spam_audit` row. That row now carries the body, but it is still **not a `ticket_messages` row**, which is why "Add as ticket" is disabled rather than absent: promoting one back means the agent re-fetching it from Graph, and hiding the button would hide that it is recoverable at all.

Filtered on `outcome = 'blocked'`, not `label = 'irrelevant'`: the blocklist pass writes no label, and every row currently carrying `irrelevant` was in fact *kept* (the label predates the change that made it drop). Blocked is the only field that reliably means "never became a ticket".

### Search belongs to a table; level, category and sort belong to the page

One box above four tables re-cut every section at once, and the row you were looking for was as likely to be in a collapsed one — so a search that found nothing looked like a search that matched nothing. Each section now searches only its own rows, from its own header, and the section count follows the filtered set.

**The toolbar keeps level, category and sort.** Those describe the whole open set — Queue and Backlog are one set split by age, and a level tab that applied to only half of it would be a different filter with the same name.

**The box appears only when the section is open.** A control that filters rows nobody can see gives no feedback, and four collapsed headers exist to be scanned rather than typed into.

**The header stopped being a single button to allow it.** An `input` inside a `button` is invalid and would toggle the section on every keystroke, so the button now covers the chevron, title, count and description while the search sits beside it; the card's border and background moved up to the container so the row looks unchanged.

**Closed and Irrelevant became searchable in the process** — neither ever was. Dropped mail matches on subject, sender and the gate's reason: it has no customer and no order to match on.

**One focus ring, painted on the wrapper.** The old box drew two on every click — the wrapper's teal ring, plus `--shadow-focus` from the global `:focus-visible` rule in `globals.css`, which lands on the inner `input` as well. `outline: none` never suppressed it because that global rule uses a **box-shadow**, not an outline; the input needs `box-shadow: none` under `:focus-visible` specifically. Anything else that puts a bare input inside a styled wrapper will hit this.

### Two scrollers on the tickets page, and the document is not one of them

**One per table, one for the page, and nothing above that.** The app is a fixed frame: the sidebar and topbar stay put while `AppShell`'s `.content` scrolls under them. A scrollbar on the document itself moves the whole frame, navigation included, which is the one thing the frame exists to prevent.

`.shell` pinning itself to `100dvh` with `overflow: hidden` is not enough on its own — it stops the shell spilling, not the document from acquiring its own scrollbar. So `html, body` are pinned too, in `dvh` so they cannot disagree with `.shell` by the height of a mobile browser's chrome. Every page renders inside `AppShell` (`/` only redirects), so every page already has a scroller and none needs the document's.

**All four tables share one height** (`min(62vh, 50rem)`), replacing a 50vh queue and a 26rem default for the rest. The split existed to keep a collapsed "Closed" header on screen without scrolling; the page scroller already handles that, and the cost was making Backlog and Closed read as lesser tables when they are the same table with a different filter. Capped in rem as well as vh because a table past ~50rem stops being scannable.

### The expanded row is three blocks and no more

**Results** (a headline read off the verdict, plus the `established` claims), **Order**, **Action** (one sentence). The case file's other lists — `unverified`, `do_not_claim`, the tool ledger — are written for the drafting stage; pouring them in here would bury the three lines somebody opened the row to read.

- **The summary is derived, not stored, and there is deliberately no summary column.** A model asked for prose *beside* the evidence lists writes a fourth account of the ticket that can disagree with all three — the failure `do_not_claim` and the derived `replyIntent` already exist to prevent. What the agent established **is** the result.
- **The action sentence is looked up from the verdict**, the same rule that makes `case-file.mjs` own the wording of a question to a customer. Only `needs_human` shows model prose — `handoff.action`, which is that verdict's whole output and internal by construction.
- **The latest run only.** A ticket is investigated once per inbound message, so a thread holds a row per reading; the panel answers "where does this stand now".
- Fetched per ticket on expand, not joined into the list: 565 rows, one open at a time. **No case file is a normal state** — uncategorised, out of `ENABLED_SUBJECTS`, or not yet reached — and reads as "not investigated", never as an empty result.

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

### The Irrelevant dialog shows the message and nothing else

Verdict, gate, reason and timing are already columns in the row it was opened from, so repeating them would turn the one thing the table cannot show into a footnote on data that is on screen anyway. The single exception is `failed_open`, kept as a banner because it has no column and it changes how the text should be read: a fallback, not a judgement about the email.

**A missing body gets one of three sentences, never a blank**: purged, never captured, or genuinely empty. "No body" alone reads as a bug in all three cases and is only actionable in one.

### VIP is derived at read time, never stored

Shopify recomputes `rfm_group` as a customer buys, so a flag copied onto a ticket would be a snapshot of the day the mail arrived — a customer who became a champion last week would still read as ordinary on their open thread.

**`CHAMPIONS` + `LOYAL` only**, and that array is the one line to edit: `ACTIVE` merely means "has ordered recently", which is most of the table, and a badge nearly every row carries signals nothing. The label map is deliberately **partial** — Shopify owns this vocabulary and can add to it, so an unrecognised segment is simply not VIP and renders from its own text rather than vanishing.

`TICKET_LIST_SELECT` is shared by the list read **and** `setTicketStatus`, which passes it to PostgREST as the PATCH's `select`. The row a mutation returns replaces a row the list rendered, so without the embed closing a ticket would silently strip the VIP badge off it.

### A VIP is a gold row, not a chip — reversing an earlier call

The badge was a teal chip under the requester's name, on the reasoning that teal is the app's one accent and a VIP is a fact about the **customer** rather than a warning about the **ticket**, with level and mood already owning "this needs attention". That reasoning was sound and was overruled deliberately: eight rows are visible at a time and a chip in the fourth column is missed, whereas knowing you are about to open a champion's ticket is worth seeing from the row itself. The row now carries a **gold border**, and a crown sits **beside the requester's name**.

**A border, not a filled row.** The first version washed the whole row gold as well. **75 of 214 tickets are VIP (35%)**, and a third of the queue tinted is more of the screen than the fact deserves — exactly the competition with level and mood that the old rule warned about. The border says the same thing and stays out of the way. The crown moved off the row's corner for the same kind of reason: next to the name it reads as belonging to the person, in the corner it read as a property of the ticket.

That 35% is the number to watch. If this ever pulls attention off a level 4, it is too strong — turn the tokens down rather than turning the feature off.

**The rules are inset box-shadows, not borders.** An ordinary row carries only a bottom border, so giving a VIP row a top and two sides made it 1px taller than its neighbours and pushed the mood face 2px right — measured at 68px against 67px, a visible limp down a column of 214 rows. The bottom edge stays a real border, because every row already has one and a border paints over an inset shadow.

Gold is its own token pair, not `--warning`: that ramp is orange and owns "something is wrong". Two steps only — a rule colour and a hairline — because a border needs no wash and no text sitting on one.

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

`orders`: delivered or completed return/refund +3mo, undelivered or unresolved +6mo → `retention_delete_after`, deleted by the order sync. `tickets` mirrors it (`resolved_at`/`closed_at`/`archived_at`/`retention_delete_after`); `deleted_at` is the separate compliance soft-delete. `categorisation_review`: 3-month default. `spam_audit.body_text`: 90 days from capture, purged per poll.

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

## Migrations

The migrations are a **baseline, not a history**: files describing the schema as it should be, run in order against an empty database. They are not idempotent and not re-runnable over a populated one.

Editing one therefore means editing the definition — re-apply against a fresh database rather than patching an existing one in place.

**That has been departed from exactly once, deliberately, and the dev database is still equivalent to a from-empty apply.** On 2026-08-15 the refactor added three views, `order_number_range()` and a check constraint; re-applying would have cost the 214 ingested tickets every measurement in this file was taken against. The additions were applied forward instead, in one transaction, with the SQL **extracted from the baseline files rather than retyped** — so what is in the database is the definition, not a second version of it. The constraint is the one statement that could not be extracted (the baseline declares it inline in `create table`) and it was applied as an `alter table … add constraint` with the same name and clause, asserted against the baseline before running. No column was added, so the column-order caveat from the 8→5 split does not arise. The script was discarded rather than checked in: a forward step living beside the baseline is precisely how a baseline turns back into a history.

The general rule stands. If this becomes a second time, it is no longer an exception and wants the two-axis arrangement — baseline plus additive steps, reconciled by a test — rather than another one-off.

### Views carry joins and aggregates, never judgement

The dashboard counted messages by reading every message id in the shop; order resolution read every inbound body to keep one per ticket; the order-number range was an asc/desc pair of round trips. All three are set operations the database can answer, and PostgREST being the only interface is why they were not.

The line is the one `search_knowledge_chunks_text` already draws: vector maths and set operations in Postgres, judgement in tested JavaScript. `shouldAutoClose`, the level ratchet and the evidence rules did not move, and `ticket_queue` deliberately omits VIP — that is derived at read time from `rfm_group` and nothing stores it, so putting it in a view would make a business rule into a schema object.

### Every view is `security_invoker`

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

So `06_analytics.sql` carries fifteen views and `readView` takes a hard limit with **no pagination at all**. A view that could return more rows than that limit is the wrong shape and belongs back in SQL as a further aggregate. The two exceptions — `customer_ticket_facts` and `ticket_reply_times` — are bounded by ticket count rather than by customer or message count, and each says so at its call site.

### Judgement stays in JavaScript, so the views expose `rfm_group` and never `is_vip`

Same rule as the queue: joins and aggregates in SQL, business rules in tested JS. Who counts as a VIP changes with the business and is owned by `customer-segments.mjs`; writing it into a view would freeze it into a schema object and create a second definition to disagree with the first.

### A metric that cannot be computed renders as a dash, never as zero

On a dashboard a zero is a claim — "nothing was late", "nobody complained", "it cost nothing". `BlockedTile` takes a **required** reason, so a blocked metric cannot ship without saying what is missing, and a missing series in `BarList` draws hatched at full width rather than empty. The delivery tiles are the case this exists for: `delivered_at` is set on 1 order in 2,006, and a delivery panel full of zeros would read as a fleet with no late parcels.

`hasUsableDeliveryData` therefore needs a tenth of orders covered, not one. A single hand-closed fulfilment must not switch on a section whose medians would then describe three rows.

### Fulfilment and delivery are two durations, and conflating them is what kept the measurable one unbuilt

Fulfilment is `processed_at` -> first `fulfillments[].created_at`, populated on 1,993 of 2,006 orders and computable today. Delivery needs carrier scan events that never arrive. Treating "delivery metrics" as one blocked lump is why nobody had looked at dispatch timing — which turned out to show **July 2026 at 30.7% of orders past three days and a p90 of 149h**, against a steady 4-14% and ~70h in every other month.

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

### The topic map is rebuilt by hand, and says how old it is

Clustering is an all-pairs cosine comparison over the whole embedded corpus, and its 0.68 threshold was tuned by eye and is corpus-specific. That makes a rebuild a deliberate act with a judgement in it, not something that should re-run overnight and change the map under whoever is reading it. `cluster_runs` records when, at what threshold, and over how much mail, so the panel can state the map's age and warn once the live corpus has drifted away from it.

`cluster:tickets` therefore stays **print-only by default** and `cluster:tickets:save` persists — the script's header has always promised it is read-only and free to re-run, and people rely on that.

Resync is a documented command rather than a button: the job is an all-pairs comparison over the corpus and this app has no job queue, so running it inside a web request would block a worker for its duration.
