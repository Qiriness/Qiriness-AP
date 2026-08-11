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

No `(subject, kind)` pair derives it. It means an explicit threat of legal action or public exposure, hospitalisation, or grave injury/danger, so it arrives only as a categoriser escalation read from the email text and should be rare. The three triggers live in the categoriser prompt and the model must name the one that fired in its `reason`. A subject-implied 4 would make the level mean *this topic* rather than *this is serious*, filling the manager queue with routine mail.

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

`shopify_order_number` is written **only** by a confirmed resolution — the order's `customer_email_hash` equals the ticket's `requester_email_hash`. A name-only agreement, or an order belonging to someone else, is recorded in `metadata.order_resolution` and left off the column.

The parser recognises `#NNNN` / "commande n° NNNN" only, and classifies the `Q00` ERP references (911 in the corpus) as **not** Shopify order numbers.

### The order bundle is assembled, not handed over raw

The raw order carries four separate status columns, a fulfillments array, a refunds array and twenty monetary fields. Answering "where is my parcel?" from that means the model reasoning that `fulfillment_status = FULFILLED` with `delivered_at = null` and `in_transit_at = null` means "dispatched, no scan yet" — a deduction it will sometimes get wrong, differently each time. Deriving it once here makes the answer deterministic and reviewable.

The bundle carries the buyer's name and email (support cannot answer without knowing whose order it is) but **no street address and no phone** — the sync stores only a coarse city/country, and this is an email desk.

---

## Investigation

Runs immediately after categorisation and consumes its output in the same poll — the categoriser raises `needs_investigation` in the same patch that clears its own flag, and is the **only** writer of it, so a thread is never investigated against labels describing an older conversation.

This is the first stage that *chooses* what to do, and the first with a budget: **6 tool calls, 4 model turns**, identical-args calls served from a per-run cache. Every bound resolves to an outcome (`needs_human`, budget exhausted), never an exception.

**What keeps the loop short is that most of the evidence is deterministic** — a product question always needs the product matched against the question text, a promotions ticket always needs its codes extracted — so `openingMoves()` fetches those *before* the model's first turn. Measured over 40 real tickets, the whole run took 1–3 tool calls against a ceiling of 6.

Scope is `ENABLED_SUBJECTS` (product, product_stock, promotions, account, other): `cosmetovigilance` and `legal_privacy` are deliberately toolless (a confident-looking case file about a reported skin reaction is worse than none), and the forwarded subjects have nothing to investigate. Out-of-scope tickets are skipped *and their flag cleared*, so **enabling a subject later means re-raising the flag** (`npm run investigate -- --backfill`), not only editing the array.

**The order family is excluded for an operational reason, not a design one — and the reason has changed.** It used to be that Supabase held a dev-store fixture whose twelve orders could not match mail quoting `#4854`; that is over, and the live store's 2052 orders (`#4716`–`#6770`) cover the corpus. What blocks it now is that `orders:resolve` has never run, so no ticket carries a confirmed `shopify_order_number` and `getOrderContext` answers `not_resolved` regardless. Enabling before that pass runs reproduces the old empty answer for a new reason. This distinction is worth keeping: the gate protects against *confidently wrong case files built on absent evidence*, and it is satisfied by evidence existing **and being linked**, not by the store being correct.

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

### Tickets close themselves after 21 days of silence

Last pass of every poll, so it sees the timestamps that poll just advanced. Without it `status` carried no information at all — every one of the 565 tickets read `open`, including threads last touched seven months ago.

**Level 4 is exempt and that is the whole safety margin**: it means legal threat, hospitalisation or grave danger, and there silence is the opposite of resolved. Level 3 closes with everything else. Inactivity is `last_message_at`, which advances on our own replies too, so a thread the team is working stays open while the customer is quiet. Auto-closed rows are stamped `metadata.closed_reason = 'inactivity'` so they stay distinguishable from a hand close.

**The level exemption is applied in JS, not SQL.** PostgREST's `not.eq` on a nullable column drops the NULL rows as well, which would have silently spared every uncategorised ticket — the largest group in the table. There is a regression test for exactly that.

**A ticket still flagged `needs_categorisation` is never auto-closed.** The categoriser selects on `status = 'open'`, so closing one that is still queued drops it out of that queue for good and freezes it as uncategorised — only a customer reply could ever label it afterwards. The categoriser drains 25 per poll, so this defers a close by a few polls; getting it wrong is unrecoverable.

**A customer reply reopens a closed ticket**, clearing `closed_at`/`resolved_at` with the status. Inbound only: a ticket does not reopen because *we* sent something. Without this half, auto-close would make the queue tidy and wrong.

---

## Embeddings

### Every stored message is embedded; only approved knowledge chunks are

The corpora differ because their gates differ: a chunk holds a vector **iff** its parent document is currently `approved` and not brand-voice, and the vector matches the current input hash + model + dimensions — whereas a message is part of the corpus by virtue of existing.

Both share one determinism quadruple (`embedding_model`, `embedding_dimensions`, `embedded_input_hash`, `embedded_at`), so a re-run over unchanged text is a no-op for either. Verified on real data: 348 messages embedded, second run embedded 0.

Message hashes are additionally salted with the quoted-reply stripper version, so changing how history is stripped correctly invalidates every message vector without the version ever reaching the model. `embedded_input_hash` covers title + category too, so a rename invalidates the vector even though `content_hash` ignores it.

Unapproving regenerates chunks vectorless. Embedding runs both inline (on approval, best-effort) and via the reconciler.

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

That remaining 19% is a **corpus** problem, not a threshold one: 32 situations inside one narrow domain sit close together, and `Email-Example-Queries.md` already names O-09/O-10 and P-15/P-16 as merge candidates. Merging should raise the margins rather than needing this number moved again.

The measurement is also pessimistic by construction: it scores unfiltered across all 32, because filtering by subject would make the agreement proxy trivially 100%. Production filters first, so the real candidate pool is a handful of same-subject exemplars.

### The variants thesis, measured

Six exemplars never win a ticket above the floor. **Two of them are D-07 and P-18 — precisely the two with no real phrasing, only the tidy canonical question.** That is the clearest evidence available that phrasings carry the retrieval and the canonical question does not, and it was predicted by the importer before the eval ran.

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

### The expanded row is three blocks and no more

**Results** (a headline read off the verdict, plus the `established` claims), **Order**, **Action** (one sentence). The case file's other lists — `unverified`, `do_not_claim`, the tool ledger — are written for the drafting stage; pouring them in here would bury the three lines somebody opened the row to read.

- **The summary is derived, not stored, and there is deliberately no summary column.** A model asked for prose *beside* the evidence lists writes a fourth account of the ticket that can disagree with all three — the failure `do_not_claim` and the derived `replyIntent` already exist to prevent. What the agent established **is** the result.
- **The action sentence is looked up from the verdict**, the same rule that makes `case-file.mjs` own the wording of a question to a customer. Only `needs_human` shows model prose — `handoff.action`, which is that verdict's whole output and internal by construction.
- **The latest run only.** A ticket is investigated once per inbound message, so a thread holds a row per reading; the panel answers "where does this stand now".
- Fetched per ticket on expand, not joined into the list: 565 rows, one open at a time. **No case file is a normal state** — uncategorised, out of `ENABLED_SUBJECTS`, or not yet reached — and reads as "not investigated", never as an empty result.

### The Order block reads `resolved_context`, not the case file

Two sources, two projections in `ticket-detail.ts`: order facts exist for tickets the agent never investigated, and a case file exists for tickets with no order at all, so neither read can stand in for the other. `summariseOrderContext` **labels what `buildOrderContext` stored and derives nothing** — re-deriving delivery state in the dashboard would give the app a second opinion about the same parcel, and the two would disagree the first time either changed.

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

### Stats and filters

**The four header cards** recompute from the same array the tables render (`summariseTickets`, isomorphic and pure), so a card can never disagree with the rows under it.

**"High priority" is level 3 + 4, not the `priority` column.** Nothing in the pipeline writes `priority`, so all 565 rows sit at its default of 3 and a card reading it would show zero for ever.

**Volume windows are rolling (now −24h / −30d), not calendar day and month.** Ingestion runs in bursts; on any day without a poll the calendar figures both read zero and the card looks broken rather than idle. Counted on `first_message_at`, so reviving an old thread does not inflate today's intake.

**Level, not status, is the primary filter.** Every ticket is `open` today because nothing closes them, so status tabs would be one tab holding everything. Filtering, search and sort all run client-side — 565 rows is far too few to justify a round trip per keystroke.

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

### `data_access_events` fails open

Sync paths write service events, and so does the agent's customer lookup — reading a customer to answer a ticket is access, whether a human or the worker did it. The write fails open because the data has already been read by then, so an audit outage must not also cost the answer.

**Future dashboard user views must write human access events here.** This is currently unsatisfied: the thread and dropped-mail dialogs render full email bodies with no audit event, because there is no dashboard user identity to attribute one to yet.

### Retention

`orders`: delivered or completed return/refund +3mo, undelivered or unresolved +6mo → `retention_delete_after`, deleted by the order sync. `tickets` mirrors it (`resolved_at`/`closed_at`/`archived_at`/`retention_delete_after`); `deleted_at` is the separate compliance soft-delete. `categorisation_review`: 3-month default. `spam_audit.body_text`: 90 days from capture, purged per poll.

### Supabase REST client

Every request sends `cache: 'no-store'` — Next's Data Cache otherwise pins the first response for a year, which made saved changes appear to vanish on reload. `export const dynamic = "force-dynamic"` does not prevent this; only the explicit fetch option does. The option is inert outside Next, so the sync scripts and agent worker are unaffected.

`supabaseSelectAll` pages past PostgREST's silent 1000-row cap.

---

## Migrations

The migrations are a **baseline, not a history**: files describing the schema as it should be, run in order against an empty database. They are not idempotent and not re-runnable over a populated one.

Editing one therefore means editing the definition — re-apply against a fresh database rather than patching an existing one in place.

### Split by domain, not by the order things were built

The baseline was eight files that had accreted as a changelog: 05 patched 04, 07 mirrored a flag 03 created, 08 rewrote a comment 02 had written, and `tickets` was created in 01 then altered twice more. Reading it meant reconstructing each table from up to four places.

It is now four files along the dependency chain — foundation → Shopify snapshots → knowledge → support — and **every table is created complete**. There is no `alter table … add column` in the baseline at all, and `_shared.test.mjs` asserts that, because a single one is the file drifting back into being a history.

**The reorganisation was proved, not reviewed.** Both sets were applied into throwaway schemas on the dev Postgres and the resulting catalogue diffed: 425 columns, 172 constraints, 152 indexes, 17 triggers, 3 functions, 20 tables with RLS, 20 table comments and 139 column comments — identical on both sides. Column *order* differs where a folded `alter` had appended a column; nothing reads columns positionally (every query names them), so that is the one intentional difference.

### `if not exists` is only on the extensions

Guarding every statement would obscure the schema these files exist to document, and a guarded statement silently does nothing when it matters most. The extensions are the exception because a Supabase project ships with them installed. `spam_audit_body_expiry_idx` carried a guard from when it landed on a populated table; in a baseline that is meaningless and it was removed.

### Tests

`_shared.test.mjs` holds what is only checkable across the whole set: no data statements, RLS on every table, a comment on every table, an `updated_at` trigger wherever that column exists, and **nothing referenced before it is created** — which is what makes the apply order safe. Each file then has a sibling asserting its own contents, with the taxonomy lists compared element-wise against `scripts/lib/support-taxonomy.mjs` and the verdicts against `case-file.mjs`, so a check constraint and the module it mirrors cannot drift apart.
