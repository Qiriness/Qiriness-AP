<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Investigation

Runs immediately after categorisation and consumes its output in the same poll — the categoriser raises `needs_investigation` in the same patch that clears its own flag, so a thread is never investigated against labels describing an older conversation. It is the only writer **that follows a new message**. Order resolution also raises the flag when it confirms an order on a ticket already investigated (§ An order confirmed after the investigation), a person linking an order on the dashboard raises it (§ A person can link a ticket's order), and `tickets:requeue` raises it by hand. Neither changes the labels.

This is the first stage that *chooses* what to do, and the first with a budget: **6 tool calls, 4 model turns**, identical-args calls served from a per-run cache. Every bound resolves to an outcome (`needs_human`, budget exhausted), never an exception.

**What keeps the loop short is that most of the evidence is deterministic** — a product question always needs the product matched against the question text, a promotions ticket always needs its codes extracted — so `openingMoves()` fetches those *before* the model's first turn. Measured over 40 real tickets, the whole run took 1–3 tool calls against a ceiling of 6.

Scope is `ENABLED_SUBJECTS`, which since **2026-08-13** is every subject that has tools: product, product_stock, promotions, account, other, **order, delivery, payment, return_exchange**. The five absent ones — `cosmetovigilance`, `legal_privacy`, `b2b`, `partner_collaboration`, `careers` — are absent because their tool sets are deliberately empty (a confident-looking case file about a reported skin reaction is worse than none), so `isInvestigable` would refuse them anyway. Out-of-scope tickets are skipped *and their flag cleared*, so **enabling a subject means re-raising the flag** (`npm run investigate -- --backfill`), not only editing the array.

A test now asserts that the enabled set and the tool table say exactly the same thing. Until this date they deliberately did not, and the gap was the mechanism; with the gap closed, the invariant worth protecting is the agreement — a subject given tools but never enabled is dormant code nobody notices, and one enabled without tools is a ticket routed nowhere.

### Trade mail is out of scope on any axis, not only a primary `b2b` (2026-09-17)

A primary `b2b` ticket is never investigated, so it is never drafted and waits for a person. Before this change, only the primary category counted. Two tickets show the gap:

- **`7b95c755`**, a pharmacy's unreceived May order, filed `order` + secondary `b2b`. Investigated as a Shopify order, it got a draft asking for « le numéro de commande (au format #XXXX) » and the purchase email, a day after LAP's commercial director had already answered in the thread.
- **`f091e971`**, Nocibé's « Relance commandes en retard » (PO n°3089694, €3,556.69), filed `delivery` with no `b2b` at all. It got the same draft.

The categoriser labels by subject, correctly, so a secondary-category rule alone would miss the second ticket. So scope now refuses a ticket when **either**:

- `secondary_category = 'b2b'` (in `isInvestigable`), or
- the thread's **opening** sender is `retailer` in `sender_directory` (`isTradeSender`, checked in the runner once the messages are loaded, before the matcher spends an embedding). A domain entry covers its subdomains.

**`retailer` only.** This is not the sender gate removed earlier in the runner: those 14 threads were our own side (`internal`, `contractor`) working a customer's problem, and they are still investigated. So are carriers (`logistics`, `courier`).

**The opening message, not the latest.** A consumer thread a retailer is copied into later stays a consumer thread.

Measured by running the scope check over all 169 categorised tickets before and after: **3 moved to out of scope**, and nothing else. The third was not predicted: `129fed9b`, a payment notice from `sap.nocibe.fr` (Nocibé accounting) filed `other`, which had a customer-voice draft addressed to an SAP robot. The three pending drafts were rejected the same way the dashboard does it, and the two tickets the agent had parked as `awaiting_customer` were reopened. Their old case files are still stored.

Team routing and forwarding are unchanged: `responsible_team` still follows the primary category, and `category_forwarding` is empty.

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

**One deliberate never-satisfiable entry, down from two.** `checkout_state` had no tool wired — `abandoned-checkout.mjs` existed and was validated but sat outside the investigation registry — so it always resolved `unavailable`, and counting how often it was *needed* was the argument for wiring it or for dropping it. It was wired 2026-09-16; see § "The basket becomes a branch". `other_fact` remains, and always will.

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

**Superseded in part, measured 2026-10-01:** `BIENVENUEQIRINESS` is `ACTIVE` again with no end date, and since 2026-09-24 a per-subscriber welcome discount (`BIENVENUE_QS20`, one unique code, valid 9 days) is being issued. The P-15 rule was written for a shop with no welcome code and has to be revisited against this.

### A discount's product list is the whole list, and a shipping discount knows its countries (2026-10-01)

The discount listing asked for the first 20 products or collections of each leg and never asked whether there were more. **Twenty was the cap, not the rule.** Measured against live Shopify: « wrap vitaminé offert dès 65 € » qualifies on **98** products and was stored with 20, « Masque Or offert » 97, `QIRINESS20` 94, `BIENVENUEQIRINESS` 55. Every eligibility answer built on those lists — "does your basket qualify for the gift?", "is this product covered by the code?" — would have been wrong for most of the catalogue, and wrong silently, because a short list looks exactly like a narrow promotion.

**The listing keeps its 20; the rest is fetched per discount, only when Shopify says the list continues.** Fetching 250 under every discount in the listing would spend the query-cost budget on the minority whose lists are long. Same shape as the redeem-code follow-up beside it.

**`rule_snapshot.destination` is the country list, as codes.** Only the type name was stored, so « Frais de port offerts à partir de 70 € » read as worldwide while Shopify applies it to `FR` alone. Real tickets complain of shipping charged on 260 € and 74,50 € baskets; the destination is what separates "under the threshold" from "outside France". `include_rest_of_world` is kept because it inverts the list's meaning.

### What an offer does is derived, and an automatic offer is describable by default (2026-10-01)

**The label is Shopify's structure, never the title.** `promotion-mechanic.mjs` reads the discount type, its classes and the stored rule: a shipping type is `free_shipping`; a buy-X-get-Y on a spend threshold is a `gift`, on a quantity a `multi_buy`; a basic discount is `order_discount` or `product_discount` by its class; an app's is `app`. Titles are free text that differ per shop and language, so a label read from them would need maintaining, which the owner ruled out. Run over all 331 live discounts, none came out `unknown`, and every active one matched what its title says without the title being read.

**The reward value had to be fetched first.** A buy-X-get-Y keeps it under `DiscountOnQuantity.effect`, which the query never asked for, so all six gift offers stored an empty reward and « 1 article offert » could not be told from « -50 % sur le 2e ». Percentages are fractions on a discount (`QIRINESS20` 0.2, a free item 1), unlike an order's discount application.

**`describable_in_replies` defaults to TRUE, the opposite of `offerable_in_replies` (decided by the owner).** The risk is opposite. A code is a key, and nothing in the data separates a public code from a partner's 50 %, so a person opts each one in. An automatic offer is advertised on the site and applies itself, so describing it hands out nothing. It explains what the customer already saw. An operator switches one off only to keep it out of replies. Same survival mechanism: the mapper never writes it, and a test asserts that.

`listActivePromotions` drops a switched-off automatic offer and marks the rest « offre automatique, sans code ». Most automatic-offer tickets are a customer looking for something to type.

### A promotions ticket is identified as code or automatic offer before anything else (2026-10-01)

`identifyPromotion` replaces code extraction as the promotions opening move. It reads two things.

- **The codes the customer typed.** A code counts only if it appears in the message as a word.
- **The offers the customer describes.** The decomposer already reads the email, and now also reports each offer described there: its mechanic (free shipping, gift, multi-buy, % or € off), the threshold, the percentage and the product, copied rather than inferred.

The match against the shop is done in code, never by the model.

**When the decomposer has read the email, its codes decide; the uppercase scan is only the fallback.** « WRAP ECLAT commandé 3 » made the scan report the real code `WRAP`, which is also a product name, on two 3+1 tickets. A typed code the shop does not hold is kept and marked unknown, because « code introuvable » is an answer.

**Matching rules:**
- **Mechanic** filters candidates.
- **Percentage** filters too, because it is the advertised number: « -20 % » once matched a past 25 % offer.
- **Threshold** only ranks. Customers misquote it (« dès 49 € » for a 70 € offer), and the gap is reported to the model.
- **Gift names** are weighted by how rare each word is across the candidates, so « masque » and « offert », shared by every gift, count for nothing. No stop-word list is needed, so no language is assumed.
- **Recently ended offers** (120 days) are candidates too, because a complaint arrives after the offer it is about.

**In a situation that gives a code, that code is the one the customer means (2026-10-05).** P-15 is « inscrite à la newsletter, jamais reçu le code ». On `35e0afd9` identification saw five active 20 % codes and asked « lequel ? ». The P-15 rule gives BIENVENUEQIRINESS but may only tighten a verdict, so the drafter got « give the code » and « ask for her code » together. Four rehearsals of her message asked; the live reply gave the code. Decided by the owner: no entitlement check and no first-order check. In this situation she gets the code and the rules of application, whether she names it or not.
- **The situation's code is data:** the single `offer_code` its own rules carry (`situationOfferCode`, `answer-selection.mjs`). None, or two different ones, is no code.
- **Identification:** in such a situation, a customer who typed no code means that code. A code she typed, or an automatic offer she describes, is never replaced.
- **Lookup:** that code may be looked up although she never wrote it (`no_code_in_message` still refuses any other code), so the case file holds its real Shopify state.
- **Case file:** a code the selected rule gives is never asked for. When it was the only question, the case is `answerable` rather than `needs_human`.
- **Measured:** 6 rehearsals of her message, all `answerable` on `newsletter_code_client_connu`, all giving the code with its Shopify conditions. When she names the code herself, the ticket selects P-18's « code actif » and gives its conditions. Stacking was shortened to « pas cumulable avec une autre remise » in 2 of the first 3 runs. After the stacking term became one line with both halves, and the instruction said to keep each condition whole, it was still shortened in 1 of 3. That remains open.

**A code we hand out goes with its Shopify conditions, and a policy's « peut » stays a possibility (2026-10-05).** On `35e0afd9` a rule gave `BIENVENUEQIRINESS` and its skeleton said « donner les conditions du code ». The drafter had the code alone and the shop's promotion policy. It turned the policy's list of what *may* stop an offer (« produits exclus », « offres non cumulables », « client non éligible ») into three firm conditions of this code, and « non cumulable » was false: Shopify has it combinable with a delivery discount. `lookupPromotion` had refused the code (`no_code_in_message`), rightly: that guard protects the customer's own code, and stays.
- **The offerable-codes load carries each code's terms** (`describeOfferTerms`, `promotion-rules.mjs`): advantage and product scope, who may use it (the Shopify segment), the minimum, what it can and cannot be combined with, once-per-customer and an end date. The terms come from `rule_snapshot` and `combines_with`, never inferred. As in `renderPromotion`, an absent limit or an absent end date is never stated.
- **The prompt gives them under the code as its only conditions** (« n'en ajouter aucune autre, ni d'une politique ni d'ailleurs »). A code with no known terms is told so.
- **`POLICY_INSTRUCTION` now says** that a policy states general rules, not this case's facts: what it presents as possible is told to the customer as a possibility, never as a certainty about their order, code or offer. This applies to every policy, not only promotions.

**A campaign name in prose is not a code (2026-10-04).** Unknown codes are kept, so « ce code n'existe pas » can be said. But on ticket 424b4702 the decomposer returned « octobre rose » (« la promo octobre rose ») as a code, and the case file then stated as fact that the code OCTOBREROSE does not exist, for a customer who never typed one. That happened on dry-runs with less of the case's context: the stored run, with the other thread's message, read it correctly as a gift. So an unknown "code" that the message writes across two words, all in lowercase (`writtenAsPhrase`), is dropped. A known code is always kept, however it was typed; so is « PANIER 10 » in capitals, and a single lowercase word, which may be a mistyped code. On 2026-10-04 there were only 9 stored identification calls, reporting one code between them, and the guard would have dropped none of them, so this is protection for the future rather than a measured fix.

**The kind is not which offer.** « Un masque offert » while five mask gifts run is unmistakably an automatic gift; which one is open. `promotion_identity` therefore carries the KIND: `code` / `automatic` / `both` / `ambiguous` / `none` / `unknown`. `ambiguous` is kept for the one doubt that changes the answer, code or automatic offer. The candidates travel in the details. This replaced `resolved`, which no rule branched on.

**It runs wherever the complaint lands.** `order`, `delivery`, `payment` and `product_stock` carry the tool, and it runs as an opening move only when the decomposer read a code or an offer. An order ticket about a parcel costs nothing.

**Measured on 39 real tickets** (code, gift, 3+1 and free-shipping complaints, each evaluated as of its own date): 35 matched the hand label, after fixes for the product-name codes, the percentage filter and the kind/offer split. Two of the four misses are the decomposer reading no offer in « le cadeau est facturé » / « le cadeau est en rupture ». The prompt now names those phrasings, and the misses held anyway.

**Not yet: rules.** P-18's `aucun_code_identifie` branches on `promotion_validity: unknown`, which is also what an automatic-offer ticket produces, so it can still ask a free-shipping complaint for a code. Rules branching on `promotion_identity` are the rules phase.

### Why an offer did not apply is read off the order, and the order can overrule the customer (2026-10-01)

`checkPromotionOutcome` takes one identified promotion and one basket and returns a single reason. The basket is the ticket's confirmed order, or else the customer's last abandoned checkout. The reasons are `applied`, `expired`, `outside_destination`, `not_combinable`, `items_not_qualifying`, `below_threshold`, `reward_not_in_basket`, `conditions_met` and `undetermined`. It becomes the need `promotion_outcome` (migration 58). It runs straight after identification, before the model's first turn, for each offer or known code identification pinned down, two at most.

**The first failing reason is THE reason, in a fixed order.** Expiry comes first, because nothing else matters for an offer that was not running. Then destination, combination, qualifying items, threshold, and the missing reward.

**What cannot be seen is never concluded:**
- **Threshold:** a spend is measured both before and after discounts, because which one Shopify uses is not in the data. If the two sit on opposite sides of the threshold, the answer is `undetermined`.
- **Collections:** one whose membership was never synced is `undetermined`. The collections sync now also fills collections an active promotion depends on, which put « Masques Monodose » (the 3+1) in reach: 10 products.
- **Checkout:** an abandoned checkout cannot say which automatic offers it carried.

**A free item is the customer's to add.** The 3+1 makes the fourth item free; it does not add it. A gift is added with « je le veux ». A qualifying basket without the reward is `reward_not_in_basket`: that is the cause, not a failure of the offer. A gift never counts towards the spend that earns it.

**`conditions_met` hands the ticket to a person.** It means every checkable condition held and Shopify still did not apply the offer. That is the « Masque Or offert » charged on #6328 and #6452: two gifts that are set to combine, combined on 18 orders, and did not combine on these. Nothing in the data explains it, and saying "not combinable" would be inventing a rule the settings contradict.

**The order can overrule the customer's description.** On #6452 the customer quoted « dès 65 € », which identifies « wrap vitaminé ». That offer WAS applied; the line charged was the Wrap d'Or, the free item of « Masque Or offert ». A charged free item on the order therefore takes over whenever the asked-about offer was applied, or no offer was pinned. The reply is told that the quoted offer applied and the charged item belongs to another. This uses product-scoped rewards only: a 3+1 reward cannot be told from an ordinary paid line of the collection.

**Measured on the 49 tickets with a confirmed order that mention an offer:**
- **Free shipping refused:** #7072 is `outside_destination` (an English-speaking customer, angry about « free shipping over €70 »).
- **Offers that had ended:** the Saint-Valentin gift sought after ordering (#4687) and the cabas offer (ended 2025-11-21, order 2025-12-04, #3440) are `expired`.
- **Packing, not promotion:** « il me manque les produits offerts » on a 3+1 (#4977) is `applied`. The promotion landed, so the cause is in the parcel.
- **Charged gifts:** all three #6452 tickets reach « Masque Or offert », `conditions_met`.

**Limits, stated:**
- A gift the customer left out of the basket, or one out of stock, leaves no charged line, so nothing is checked. (The stock is now reported, for the remedy rather than the cause: see « A missing gift's remedy reads today's stock » below.)
- A 3+1 applied once reads `applied` even when the complaint is that it applied to one product of three (#2798).

### A missing gift's remedy reads today's stock (2026-10-04)

**Asked by the owner.** When a gift is missing, from the basket or from the parcel, the fix is to send it, or to offer something in its place when it is gone. Which of the two depends on the stock **when the ticket is answered**, not on the order date. So the order-date question this file once raised ("was it out of stock then?") is not the one that matters, and a snapshot from the last product sync is the right source.

- **New need `promotion_reward_stock`:** `in_stock` / `partial` / `out_of_stock` / `no_reward` / `unknown`. `checkPromotionOutcome` computes it for every outcome, not only `reward_not_in_basket`. « Il me manque les produits offerts » on an `applied` 3+1 (#4977) needs it just as much.
- **Which product:** a reward line on the order if there is one. Otherwise the gift product(s) the offer names. For a 3+1, it is the qualifying lines, because the « +1 » is one more of what was bought. `partial` is a 3+1 over a mixed basket, or a two-product gift, where only some of the candidates can be sent.
- **In stock means `buildStock().purchasable`**, the rule already used for stock questions: an archived product or a -1 count is never in stock. A product row that can't be found makes the whole answer `unknown`. A free item scoped only by variant (two expired gifts) or a collection that was never synced is also `unknown`, never guessed.
- **It reads the same first outcome check as `promotion_outcome`**, through `firstOutcomeCheck`, so the two facts always describe the same offer. It is satisfied even when the outcome is `undetermined`, because the offer itself names the gift.
- **No rule uses it yet.** What to send instead, and whether a person approves it, is the merchant's decision in the Rulebook. It is not code.

Measured 2026-10-04 on the live offers: 15 are gifts or 3+1s, and 12 name their reward product(s) directly. Every current reward product is in stock; the lowest is the Gua Sha, at 19.

**Samples get the same treatment: need `sample_stock`** (`in_stock` / `partial` / `out_of_stock` / `no_samples` / `unknown`), read by `checkOrderPromotion` for P-20 « je n'ai pas reçu mes échantillons ».
- **Samples are order lines, not something we can't see.** Over 90 days, 287 of 754 orders carried 722 sample lines, all with a `product_id`, spread over 7 `SAMPLE PRODUCT`s, all with tracked stock (the lowest is BB Crème Light, at 141). `buildPromotions` now keeps each sample's `productId`. An order bundle stored before that has none, which reads `unknown` until the order pass rebuilds it.
- **The order says what was meant to be packed, not what arrived.** A sample listed on the order doesn't prove it was in the parcel.
- **One reader, `stock-by-id.mjs`, for gifts and samples alike.** "Can it be sent?" must mean the same thing for both. Samples are not excluded there, unlike every customer-facing product lookup, because being sent in a parcel is exactly what they are for.
- **The approved rule `p20_echantillons_manquants` claimed samples are not order lines.** That premise was wrong, and the corrected text is in CHANGELOG (2026-10-04).
- **P-20 is « les échantillons OU le cadeau », so the gifts get their own fact: `order_gift_stock`** (`no_gifts` in place of `no_samples`). The gift lines come from the same `checkOrderPromotion` call. A rule that branches on `sample_stock` alone offers to resend samples to a customer who is missing a gift. And no rule can tell which item is missing; only the customer's message says. So the P-20 rule (`p20_offerts_manquants_stock`) requires both facts to be known and keeps one route, `needs_human`. Its text handles each item the customer says is missing: send it if it's in stock, otherwise ask alternative or wait.
- **Collection:** P-20 is rule-directed, so the samples' stock is collected only once a rule branches on `sample_stock`. Declaring the need on the situation alone would not make the planner fetch it.

### Promotion answers branch on the kind and the outcome, and are shared, not per situation (2026-10-01)

**Twelve rules, written as drafts.** Approval is a person's decision, and only approved rules load.

**Nine shared rules (no situation)**, each on `promotion_identity` (automatic / both, or code where it applies) × `promotion_outcome`:
- **Answered directly:** outside destination, below threshold, no qualifying item, not combinable, expired, and the offer's conditions explained when no verdict is possible.
- **Routed to a person:** the free item not in the basket (sending it now is their call), applied-yet-complaining (almost always the parcel), and conditions met.

**Shared because the answer does not depend on how the request was phrased.** « Frais de port facturés hors de France » is the same answer under P-17, P-18 or no matched situation at all. So no new situation was created for « 3+1 non appliqué » or « livraison offerte non appliquée »: the shared rules answer them wherever they land, including where the matcher found nothing.

**A situation-keyed rule outranks every shared one** (`selectAnswer`, before depth). That is why P-18 needed three keyed drafts:
- `p18_code_non_cumulable` and `p18_code_applique` let the outcome speak on a code ticket. Without them, « le code est actif » would win even when the order says it did not combine, or did apply.
- `aucun_code_identifie_code_seul` replaces the approved `aucun_code_identifie`. That rule branched on `promotion_validity: unknown` alone, which is also what every automatic-offer ticket produces, so it asked a free-shipping complaint for a code. **Approve the replacement and withdraw the original together.** While both are approved, the original still matches automatic tickets.

**Enumerated before writing, as « Specificity outranks priority » asks.** Every identity × outcome × validity combination under P-18, P-17 and no situation (360 cases) selects exactly one rule or none, with no ties. The two gaps the first enumeration found are fixed: a code's outcome being shadowed by « code actif », and `both` with no verdict selecting nothing. An `ambiguous` identity selects nothing on purpose: whether it is a code or an offer is the doubt a person resolves.

**The rulebook now opens on evidence, not only on category.** `resolveRequests` adds the promotions set whenever `identifyPromotion` found a code or offer. « Le masque offert a été facturé » filed `order` with no second subject used to reach no promotion rule at all.

**A typed code is looked up deterministically** (`followUpMoves`). Identification replaced extraction, and extraction was what led the model to `lookupPromotion`. Without that lookup, `promotion_validity` stayed unknown on a ticket that named its code, and « aucun code identifié » would ask for the code just given.

### P-18 decides the kind first; "unknown" is never an answer (2026-10-01)

**The approved P-18 rules branched on `promotion_validity` alone**, which made validity the first question for every « ça ne s'applique pas » ticket. Two of its leaves were wrong for that reason.

- **`unknown` was a terminal answer for three different states.** A discount described but not typed (« les 20 % ») needs a request for the code. A message naming no promotion needs « which offer? ». An automatic offer has no code to validate at all. One rule asked all three for a code. In this vocabulary `unknown` means "the evidence did not settle it", and a rule that answers on it answers without knowing.
- **`not_found` could be about a code the customer never gave.** On `c8ef367a` the model looked up a code of its own. The guard refused it but returned `found: false`, and the finding read that as `not_found`, so « le code que vous citez n'existe pas » went to someone who had cited none.

**The tree now:**
1. **Kind** (`promotion_identity`) comes first.
   - none / unknown: ask what code or offer they mean, and give the configured code.
   - ambiguous: ask whether they mean a code or a displayed offer. No code is given.
   - automatic / both: the shared outcome rules.
2. **Validity**, for codes only.
   - unknown (described, not typed): ask for the exact code, and give one.
   - not_found: `code_introuvable`.
   - expired, inactive, not yet started: `code_plus_utilisable`.
3. **Outcome**, under an active code. Each settled outcome has its own leaf. « Code actif » keeps only `undetermined` / `unknown`, the one case where its « nous ne voyons pas son panier » is true.

Approved wording is reused verbatim where the leaf means the same thing. **14 drafts.** The 360 identity × validity × outcome combinations select one rule each, with no ties and no gaps. **To go live**, approve the 14 and withdraw `aucun_code_identifie`, `code_introuvable`, `code_plus_utilisable` and `code_actif_ne_sapplique_pas` in the same sitting.

**The lookup now refuses any code not in the message, before looking it up**, not only codes the shop lacks. Three of the four P-18 runs (`71f9fdc2`, `66d921a7`, `576f4de9`, none with a typed code) recorded `promotion_validity: active` for a code the model chose. A described code is identification's to list as candidates, never the model's to pick. A refusal carries `found: null` and reads as `unknown`, never `not_found`. Two adjacent words count as one code (« PANIER 10 »).

**P-18's declared needs** went from `promotion_eligibility` to `promotion_outcome`, in `Email-Example-Queries.md` and in the row. No rule ever read eligibility, and the outcome answers the same question against the real basket.

### Offers are named only if a reply may use them, and ranked by recent use (2026-10-01)

**The active list used to name every single-code offer**, partner rates included: `LAPFAM26` at 50 %, `PENILLEAU2025` at 26 %, and the 100 %-off `WRAP`. They sat in front of the model on every promotions ticket, one turn from a draft. Rules only ever hand out offerable codes, but nothing stopped the model repeating a code it had read.

`listActive` and `offersForProduct` now name only what a reply may use: codes an operator cleared (`offerable_in_replies`), and automatic offers not switched off (`describable_in_replies`). The rest are COUNTED (« 19 autres codes actifs ne sont pas proposables ») and never named.

**Ranked by orders in the last 30 days, not by Shopify's lifetime count.** The two disagree. Free shipping counts 1,659 lifetime against 16 in the last 30 days, a gap still to explain. Masque Or (61) and wrap vitaminé (59) lead the recent count. Recent use says what customers take NOW. The count is a ranking only; rules forbid quoting it.

**Automatic offers now count as offers on a product.** An offer is « on » a product if the product earns it (a gift's or a 3+1's buy side) or is what it gives. The existing ten-other-products line still decides « specific » against « general ». Measured live:
- The Monodose mask's specific offer is the 3+1.
- The LED mask's is `UKLED20`.
- Lotion Exquise has none of its own. The gifts qualify on about 97 products, so they are general for it.

**`product_offer` gained `specific_automatic`, and `specific` still means a code.** The approved P-21 rule on `specific` says « donner le code EXACTEMENT », which is wrong for an offer with no code. Splitting the value keeps that rule meaning what it says, rather than editing approved wording. The top-ranked specific offer decides which value applies.

**P-21 drafts:**
- `p21_offre_auto_produit` (new): describe the offer, say there is no code, and say the free item must be added to the basket.
- `p21_offre_en_cours` (rewritten draft): lead with the most-used running offer, one or two at most, then the configured code. Its old text said « pas d'offre en cours » whenever no code was in the dossier, which is never true while automatic offers run.

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

### A broken or defective product is its own situation, filed under product (2026-10-04)

PR-38 exists because three tickets matched nothing: a pot open in its box (3e28483f), a pump with no tube (2aa6604e), a cream whose texture and smell had changed (a0465150). Searching the mail found 34 more, mostly pumps that stop delivering mid-bottle. D-08 (wrong product) and D-02 (missing item) are `delivery` situations, and these tickets are filed `product`. Situations are matched only within the ticket's own subject, so a delivery situation could never reach them.

- **The order comes first, and the `product` tools could not reach it.** `getOrderContext` was added to the product subject. It reads the stored order bundle and costs nothing on a product question that never calls it.
- **A retailer purchase is said, not asked.** The question asking for the order number also says that a product bought elsewhere is taken up with that retailer (`retailer_order_policy`). That avoids asking « où l'avez-vous acheté ? » first and costing a round trip.
- **The lot number rides along and never branches.** `lot_number` is in every question's `ask` (asks are unioned and deduplicated), and no rule waits for it.
- **Photos go to a person; nothing is offered before.** `damaged_wrong_missing_item_policy` lists replacement, re-shipment, refund or a gesture, chosen after verification, and `pr38_photo_recue` routes to `needs_human` saying exactly that.
- **2aa6604e is the warning.** The « missing » tube was by design, and the team resent a serum anyway before finding that out. A person looking at the photo is the step that catches it.

### A declared loss is a different situation from a suspected one (2026-09-21)

D-37 exists because the reply was already wrong and nobody could see it. A
carrier that has searched, failed and written to the customer is not a delivery
question any more — the search is over — and the two tickets carrying such a
letter (`bb82f4f1`, `de880691`) matched nothing at 0.581 and 0.594, fell to the
shared `expediee_sans_scan`, and one of them came out **`answerable`**.

**The line is who declares the loss, not whether it is lost.** « je pars de
l'idée que mon colis s'est perdu » (`b52f3e4c`) and « je pense qu'elle s'est
perdue pendant l'été » (`9454eaa2`) are D-36: a customer's hypothesis after a
delay, answered with a state. D-37 is the carrier's own finding, in writing,
after a claim — answered with a decision. Same words, opposite evidence, and the
reply differs by more than tone.

**The loss itself stays `unverified`, and the exemplar does not pretend
otherwise.** `perdue_reclamation` remains 🔒: nothing we hold can confirm a
carrier's declaration. What the rules branch on is our half of the story — which
order, dispatched when, scanned or not — which is enough to route and enough to
avoid claiming the parcel is moving. Both real tickets already recorded the loss
as `unverified` and that is where it belongs.

**No `policy_answer`.** There is no approved article on a lost parcel, and what
one would have to say — refund, reship, on what terms — is a commercial decision
per ticket, not a constant. Declaring the need would run `searchKnowledge` to
report a hole. The same call P-15 made about the welcome code.

**`delivered` is no longer a one-in-two-thousand state.** The section above
records `delivered` at 1 of 2 006 orders on 2026-09-03. Re-measured 2026-09-21
over 6 043 orders: **131 carry a `DELIVERED` fulfilment**, the latest on
2026-07-30. So `d37_perte_colis_avec_scan` is not written for a future — its
`delivered` branch is reachable today. `in_transit` and `stale_in_transit` are
still not: 130 fulfilments carry an `in_transit_at`, **every one of them also
carries a `delivered_at`**, and the newest scan of any kind is 2026-01-20. Those
two values are in the rule on the same discipline as the six dormant transit
rules — correct, and early.

### A dispatched parcel can be late, and until now nothing could say so (2026-09-20)

`expediee_sans_scan` answered every dispatched parcel with no carrier scan — 99% of shipped orders, per the section above — so a parcel two days out and a parcel three weeks out were the same state and got the same reply. `dispatch_days` had already drawn exactly this line on the other leg of the journey: quoting the window is useful on day one and an insult on day eight. Nothing drew it once the parcel had left.

**`delivery_delay_state` is a new need, not a fourth `delivery_state` value**, and that was the whole design question. A new value would have done something worse than duplicate: `expediee_sans_scan` branches on `dispatched_no_scan`, so the moment the late case became its own value that rule would have silently stopped matching it — and every stored investigation that recorded `dispatched_no_scan` would have come to mean something narrower than it did when it was written. As a separate need the two are read off the same tool call and compose: `{delivery_state: dispatched_no_scan, delivery_delay_state: overdue}` is two conditions, which beats `expediee_sans_scan`'s one on specificity, so the new rule takes the late slice and the old rule keeps the rest. Nothing existing changed.

**Two numbers, because one would be wrong somewhere.** Measured over the last 1 000 orders: **881 to France, 119 elsewhere** (Belgium 58, Italy 24, the Netherlands 14, then the United States, Switzerland, Monaco, Spain, Hong Kong, Portugal, Luxembourg). A parcel late to Paris is still on time to Milan, so `abroad_delivery_days` joins `france_delivery_days` and the order's `country_code` picks between them. **Monaco is on the abroad number** — La Poste arguably treats it as domestic, and four rows is not enough for this codebase to decide that.

**The reply never quotes either number.** Same split `return_eligibility` already makes: the parameter decides the branch and the customer does not see it. A skeleton quoting `{france_delivery_days}` would be wrong on the Belgian parcel it also fires on, and « le délai habituel est dépassé » says the true thing for both.

**The clock is the customer's message, and this corrected every order state, not just the new one.** `orderStates` compared against `new Date()` — the moment the worker happened to run. What a rule is asking is how things stood WHEN THEY WROTE. The two agree on live mail and part company everywhere else, and the measurement makes the size of it plain: the corpus orders are 16–100 days old (median 55), so against `now` **all 62** dispatched-no-scan tickets read as overdue and the state would have carried no information at all. Against the ticket's latest inbound message the split is **23 overdue / 39 within window**. `ticket.latestInboundAt` now travels on the investigation's ticket and falls back to the wall clock when a message carries no `received_at`, because a missing date must not turn every order state into `unknown`. **Amended 2026-10-04 for routed work** (§ *Change router*): the change router measures open tickets at `now`, and a run it queues is clocked at `max(latest inbound, change_router.at)`.

**It degrades to today's behaviour rather than to a guess.** No parameter, no country code, no dispatch timestamp, or a parcel not yet gone or already arrived — all `unknown`, and `expediee_sans_scan` keeps the ticket. That included every bundle stored before `delivery.dispatchedAt` existed: `daysSinceDispatch` was frozen against the build-time clock and could not be re-measured, so the raw instant now travels too. It also filled a reader that had been silently empty since it was written — `escalationTriggers` has always read `delivery.dispatchedAt`, and nothing ever set it.

**D-05 does not get the split, and should not.** `D05_expediee_sans_scan` names the situation, and a rule naming one outranks a shared rule before depth is counted. That is the ranking working: D-05 IS « le suivi n'a pas bougé » — the customer has already said it is late — so its own rule already apologises and already routes to a person.

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

### `hasAttachments` is not evidence of absence

**Everything above was right about the null and wrong about who gets one.** The
rule was "a *flagged* message with no metadata reports `attachment_type_unknown`",
and the flag was trusted to decide which rows deserved the doubt. Exchange sets
`hasAttachments: false` when a message's only attachment is inline — which is how
Gmail sends a photo pasted into the compose window — so the rows that most needed
the doubt were the only ones that never got it.

**Measured 2026-09-20 on ticket d48f1c08.** The customer wrote « les adjunto foto
de la caja y del contenido » on 16 July; Graph held `gmail_images20260716_160612.png`,
3.6 MB, `isInline: true`; the row read `has_attachments = false`,
`attachments = null`. Three independent readers each took that as "nothing
attached": the delta poller skipped the fetch, the backfill's filter could not
select the row, and `summarisePhotoEvidence` fell through to
`classifyAttachments(null)` — whose `Array.isArray(x) ? x : []` is where the
third state dies. The ticket sat at `awaiting_human` for two months on a photo
that was in the mailbox the whole time. Corpus-wide: **199 of 234 inbound
messages were in that state**, and of the 7 whose text claimed an attachment, 6
carried inline images.

**Nothing decides whether to look based on the flag any more.** The poller asks
about every kept message and the backfill selects on `attachments is null` alone.
The cost is one Graph metadata call per attachment-free message, which returns
`[]` — a real answer that closes the row for good. The flag is still stored,
because it is what Graph said; it is simply not a reason to skip a question the
call itself answers.

**`not_checked` is a fourth outcome, not a widening of `attachment_type_unknown`,**
because the two support opposite conclusions. `attachment_type_unknown` means
something IS attached and we failed to identify it, so `ASK_ANSWERED_BY` counts it
as "the customer sent something" and suppresses the ask. `not_checked` means we
never asked the mailbox, which is not evidence that anything arrived, so it is
deliberately absent from that table and the ask still happens. Folding the new
case into the old value would have silenced the photo request on every
un-backfilled row in the corpus.

**`order` gained `checkPhotoEvidence`, because the repair alone reached nothing.**
The need is raised at runtime rather than declared in `requiredEvidence`, so no
static check could see that `order/problem` — where a wrong or missing item lands
— was the only breakage variant without the tool. It resolved `unavailable`, which
means "no tool here can settle this", and a need answered that way never looks at
the data. Filling the row changed nothing until the tool was offered; with both,
`checkPhotoEvidence` returns `attached` and the photo becomes an established fact
instead of an unverified claim. The same shape as `lookupAbandonedCheckout` in
2026-09-16, and the second time this subject has been short a tool its own needs
asked for — which is the argument for a check that reads runtime needs against
`allowedTools`, not just the static table.

**The mention check is not a French-only backstop any more.** `« les adjunto foto »`
matched none of the terms, because `photos?` does not match "foto" — so the one
signal that could still have caught this message scored `mentioned: false`. 119 of
the last 1 000 orders shipped outside France, so Spanish, Italian and Portuguese
terms are in the list now, as stems where the words inflect.

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

**Superseded 2026-10-01** (§ *Cosmetovigilance answers from its policy…*): the rules now branch on `policy_attached`, and the stop / layering / cautious-reintroduction protocol below is gone, because the company's policy does not contain it.

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

**It never fired until 2026-10-02.** `COLUMNS.ticketForDrafting` never selected `category`, so `ticket.category` was undefined on every real draft. No cosmetovigilance draft had been written, so nothing was marked sendable that should not have been. The same omission had silenced `tracking_number_given`.

### The parcel number is a warning, and only on « where is my parcel » (2026-10-02)

Switched on by the `category` fix, `tracking_number_given` would have failed 19 of the live drafts, and about half asked something a parcel number does not answer: « was my discount applied » (#6913), a cancellation, an item missing from a parcel already received, a gift that will not add to the basket.

- **Scoped by the question.** It runs when the rule answering the draft branches on where the parcel is (`delivery_state`, `delivery_delay_state`), or, with no rule selected, when the matched situation declares one of those needs (`isParcelQuestion`). Read from the business's own rules and situations once per run, so no key is named in code. Not `dispatch_state`: a parcel that has not left has no number. On the 19: 7 warned, all « shipped, where is it ».
- **A warning, not a failure** (the owner's call). `severity: 'warning'`: it never makes `checks_passed` false, never shows « Not sendable », never stops a send or an auto-send. It shows amber above the draft and as an entry in the Activity tab. A reply without the number is weaker, not wrong.
- **No order, no check.** The numbers come from the confirmed order's bundle; with none there is nothing to demand.

### A health condition never sends itself (2026-10-02)

Ticket `ba09c1ae`, « Le masque Led Visage est-il déconseillé pour une personne ayant un GLAUCOME ? », was filed `product`, level 1. The chooser saw only product situations, so CV-03 was never a candidate and no situation matched. Every gate would have let it send. The draft happened to be right; one saying « oui, sans problème » would have gone out the same way.

**Two subject holds, beside the category one, in `autoSendBlockers`:**
- **`health_topic`**: the customer's own words name a health condition, a treatment or a body state (`drafting/health-topic.mjs`, word list in `health-terms.mjs`). It reads their inbound messages up to the one being answered, quotes stripped, colleagues' and partners' notes excluded. **Never the draft**: a wrong reply needs no medical word to be wrong. Whatever the category, level or situation.
- **`situation`**: the draft answers a situation a person marked « never sends itself » on the Rules page (`support_exemplars.never_auto_send`). Any situation the case file answers counts: the match, each request's selection, the casework reading. CV-01 to CV-04 are marked. A switch, not a list of keys in code, because which situations are this sensitive is the business's call.

**The draft is still written.** Only sending it is a person's job. The reasons are stored on the draft (`ticket_drafts.auto_send_blockers`, every reason, not the first) and the subject holds are shown above the text, like failed checks, so the reviewer reads the draft for the right thing.

**Wide on purpose.** A false positive costs a person reading a draft; a miss is medical advice nobody checked. Measured over every inbound customer message (1,116, 857 tickets): 10 tickets flagged, all a real health mention or harmless (a job application naming « état de santé »; « elle ne présente aucune allergie »). Two terms were cut for what they caught: English `allerg*` (« allergènes », the labelling-regulation mail) and `medecin*` (« médecine traditionnelle », a marketing pitch).

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

### The timeline labels name who owes each check and who acts next (2026-09-26)

Stage 3 of `codex_plans/Case_State_Plan.md`, built **before** the case state it will score, because the Case Manager's next action agreed only 7 times in 14.

- **`waitingInternal` became `obligations: [{owner, need}]`**, with the owner being `support`, `colleague` or `partner`. The needs stay the evidence vocabulary, for the reason `INTERNAL_CHECKS` already gives. An older label's list is read as obligations **with no owner** (`owner: null`), and the eval counts those for re-labelling rather than guessing an owner.
- **`nextActor`** (`customer`, `support`, `colleague`, `partner`, `nobody`) is asked on **every cut, outbound included**, and is required. After we write, somebody still owes the next step, and « nobody » is the only honest definition of a finished case.
- **The actor of a message is shown, never labelled**, for the reason `cutsFor` already gives for the role. It is derived by `casework/actors.mjs` from the sender directory and a **configurable map** (`AGENT_ACTOR_BY_LABEL`), because which label counts as which actor is a per-business choice: one company's 3PL is part of the team, another's is a supplier.
- **What today's pipeline can say about the next actor** (`pipelineNextActor`): a draft after an inbound message means `support`; a `needs_customer_input` case file after our message means `customer`. Everything else is `inexpressible`, which is the size of stages 4 and 5, not a model failing.

**The baseline, 2026-09-26: 132 labels on 40 threads.** The set is the v3 AI first pass, reviewed by the business owner, and it **replaced the 25 September human batch** (47 of whose 52 labels it had changed; the old batch is in git). 53 notes still carry `[REVIEW:…]` flags, and `annotationMetadata` says human validation is pending. A later export replaces labels message by message.

| Field | Agree | Disagree | Cannot say | Not scored |
|---|---|---|---|---|
| `nextActor` (both directions) | 45 | 16 | **71** | 0 |
| `effect` | 31 | 15 | 19 | 0 |
| `nextAction` | 32 | 16 | 17 | 0 |
| `answered` | 4 | 21 | 0 | 40 |

What it says:
- **More than half of « who acts next » is inexpressible today** (71 of 132): `nobody` 31, the customer after our message 15, support 13, an operations partner 10. That is stage 4 and 5's work, measured.
- Where the pipeline can say it, it agrees 45 times in 61. **The disagreements are the pipeline drafting when it should not**: 9 finished cases (`nobody` → support), 4 colleague turns, 3 partner turns.
- **`effect`: a second request is missed** (`new_issue` read as `new_information` 7 times), and `closes_case` (13) and `internal_note` (5) have no pipeline value.
- **`nextAction`: a person must act first 17 times and the pipeline drafts anyway**, and a thanks after we had closed gets a closing reply 6 times (known gap 5).
- **`answered`, 4 of 25**: mostly `receipt_confirmation` (7), a question added today that nothing has asked for yet.

**The corpus to label is ten times what it was:** 356 threads and 1,072 cuts, after the history import, Sent Items and the staff fix. `cases:label -- --limit N` builds one sitting. Already-labelled threads come first, then the groups take turns. The first page (40 threads): 29 follow-ups and 11 with another sender, but **only 2 partner messages**, because partner threads are rare. A second sitting with `--groups other_sender` targets them.

### Five more questions the agent may ask the customer (2026-09-26)

The multi-turn labelling kept meeting questions the desk asks that no key could name, so a label could not say « we are waiting for it » or « this answered it ». The labelling page added them first (v2 and v3), and **the importer would have dropped every label using them**, because a customer question the eval can score must be one the agent can ask (`CUSTOMER_QUESTIONS` is derived from `MISSING_FIELDS`). The business chose to add them to the agent rather than to the eval alone:

| Key | For | The question the agent asks |
|---|---|---|
| `postal_address` | address change before dispatch, reshipment elsewhere | the full delivery address |
| `preferred_remedy` | D-36, O-12 once shipped | which of the solutions **we** offered |
| `receipt_confirmation` | the customer confirming arrival; **not** a carrier's « livré » | did the parcel arrive |
| `skin_type` | PR-25 / PR-29 advice | the skin type, as the customer states it |
| `skin_concern` | the same | what they want addressed; never inferred |

Each has a label and a sentence in `case-file.mjs`, a noun in `ASK_TERMS` for the invented-question check, an English label on the dashboard, and a place in `support_answers_ask_check` (migration 40, applied 2026-09-26). **No rule asks for them yet**: they are available to the rulebook, and nothing changes until a rule names one.

**`photo` keeps its key and its question to the customer.** Only the labelling page words it more broadly, « la photo demandée (produit ou zone concernée) », so a photo of the eye area asked for in an advice thread is labelled with it too. The customer-facing sentence is unchanged, so no reply changes.

Exports now carry `labelSchemaVersion` (3). The importer refuses an export from a newer schema instead of silently dropping values it does not know.

### One draft per case version, stale when the case moves, drafting in the poll behind a switch (2026-09-28)

Stage 6 of `codex_plans/Case_State_Plan.md` (Q11–Q15).

**The key is the case version, not the message.** `ticket_drafts` is unique on `(shop_id, ticket_id, case_version)` (migration 45). `case_version` is `case_current.version` when the draft was written, and `trigger_event_id` is the message that produced it. Keyed on the trigger message, a case that moved without the customer writing (Deret answering, our own reply) had nowhere to put a second draft. Now it gets a new row, and the old one keeps exactly what its reviewer saw. The 123 drafts from before carry no version and keep their place. A draft from before versions still counts for its message, so switching this on redrafts no history.

**Stale, and why.** `stale` joins the status, with `stale_reason` present exactly when it is stale. The fold sets it:
- **`superseded_by_outbound`:** a new message of ours (a reply typed in Outlook, read from Sent Items) stales every open draft written before it. This applies **whether or not it moved the version**. The plan tied staleness to the version (Q13), but our reply does not always change the case (a check of ours can stay open), and a pending draft answering a message we have already answered must not stay pending. No guess about whether it was this text that went out (Q14).
- **`case_changed`:** a raised version stales every open draft of an older version, and of no version.
- Only `pending`, `approved` and `edited` move. An approval of text written for a case that no longer exists is withdrawn (Q15). `rejected` and `sent` are history.

A stale draft cannot be decided on: the record and the ticket page both refuse it, and the page shows why. It is never mailed for review (`pendingReview` takes pending only), so once per version (Q12) comes free: each version is its own row with its own `review_sent_at`.

**Drafting in the poll: a `draft` stage after the fold, off unless `DRAFT_IN_POLL=true`**, at most `DRAFT_POLL_LIMIT` (10) drafts a poll. The gates (`pollGate`), the first to fail counted by name:
- the case is folded and it is our turn (`next_actor = support`);
- no categorisation or investigation pending;
- the ticket is open or `awaiting_human`;
- the case file answers the customer's latest message;
- that message came after the mailbox cutover (Q3);
- it is the customer's;
- then `draftDecision`'s own skips (already answered, duplicate, internal sender, level 4…).

The candidate read starts from `case_current` (our turn, something since the cutover) rather than from every case file in the shop, and every id list is batched, since the list travels in the URL (the HTTP 414 of 2026-09-27). **Nothing is sent**: there is still no send path.

**The dry run, before the switch** (`npm run draft -- --dry-run --gates=poll`): every gate, no model call. It prints:
- the cases waiting on us since the cutover, split into those with a case file and those still waiting for the worker;
- the drafts that would be written;
- the median tokens per draft from the drafting pass's own `llm_usage` rows (452 calls: 2,488 in, 133 out);
- the cost at `llm-rates.mjs` prices (`LLM_RATES` overrides them).

**Measured 2026-09-28:** 3 cases wait on us since the cutover, none of them investigated yet, so 0 drafts now and at most 3 × $0.0075 once they are. A handful, as the plan wanted.

**Found on the way:** the 3 are new customer messages from 26 and 27 September, still flagged for categorisation. Categorisation has not run on anything since the cutover, so the worker is either stopped or stopping before the categorise stage.

### A rule declares the checks it opens, in order (2026-09-27)

Stage 5 item C of `codex_plans/Case_State_Plan.md`. Until now a check existed only once someone wrote « je transmets à Deret » and the Case Manager read it. The rules that say « a person picks this up with the carrier » (D-36 `retard_client_veut_sortir`, D-37, O-09 `suivi_bloque`, `dispatched_no_scan_delivery_late`) opened nothing. So after our holding reply the case folded to `nobody`, and from 5c on it would resolve.

**The rule carries the steps; the case file carries a copy.** `support_answers.checks` holds `[{ owner, need }]` (migration 44). When an investigation selects the rule, the steps are copied onto `exemplar_match.policy.check_sequences`, and the fold reads them from there. So editing a rule never changes a case already opened, and an old case file never gains checks. With two requests, each rule keeps its own sequence.

**One step open at a time** (`casework/rule-checks.mjs`):
- **The first step** opens when the case file is written.
- **Each next step** opens when the one before it is done: a reading of that owner's message, or « Mark done » at the moment it was pressed. The fold now walks messages, case files and dashboard actions as one timeline.
- **Steps not yet open** are kept as `queued`. Nobody owes them, and every reader counts only `pending`. The ticket shows them as « Then: … ».
- **« No longer needed » ends the sequence.** Once a person has cancelled the Deret check, opening the refund check behind it would be the rule overruling them. Chosen at build time, not measured: revisit if it proves wrong.

**No duplicate, and Deret is not asked twice.** A step adopts a check of the same owner and need that is already open, and otherwise one already settled in the thread (the cheat sheet: « don't ask Deret again when their confirmation is already in the thread »). An adopted settled check counts as the step done.

**Owners are what the brand has.** The editor offers « Operations partner » only when the sender directory maps a label to one (`obligationOwners`, item B). Saving a step with an owner the brand lacks is refused in words. The need list is `NEED_KEYS`, the same list the Case Manager picks from.

**No live rule has steps yet.** All 130 read `[]` after migration 44, so nothing changes until someone adds them in the Rulebook. The fold eval is unchanged: 79 of 132.

### The ticket status follows who acts next (2026-09-27)

Stage 5c of `codex_plans/Case_State_Plan.md` (Q10). The fold moves each ticket's status to what `case_current.next_actor` asks for, in the worker and whenever a person settles a check. `casework/case-status.mjs` holds the rule.

| next actor | accepted statuses (the first is where a ticket moves) |
| --- | --- |
| customer | `awaiting_customer` |
| support | `open`, `awaiting_human` |
| colleague, operations partner | `awaiting_human` |
| nobody | `resolved` |

**Our turn is two statuses, not one.** The plan mapped support to `open` alone. The dry run on the live queue showed that would move 15 `awaiting_human` tickets back to `open`: cases the investigation handed to a person. Auto-close exempts `awaiting_human`, so four weeks of silence would then close work nobody did. A ticket already on an accepted status stays where it is.

**Only the agent's statuses move.** A person sets `open`, `resolved` and `closed`; auto-close sets `closed`, forwarding `forwarded`, the filter `spam`. The fold moves tickets between `open`, `awaiting_customer` and `awaiting_human`, and to `resolved`. It moves a `resolved` ticket back only if it resolved it itself: `metadata.case_status` records the move (status, from, next actor, version, time), and its `resolved_at` must be the ticket's. The write is conditional on the status the fold read, so a person's change made meanwhile wins. The customer writing again still reopens the ticket at ingestion, as before.

**Three guards:**
- A ticket still flagged for categorisation or investigation stays `open`. Both passes claim only `open`, so moving it would strand it.
- Level 4 is never resolved by the fold, like auto-close. A person closes those.
- Archived and deleted tickets never move.

**Per brand:** `AGENT_CASE_STATUS_BY_NEXT_ACTOR` overrides the map actor by actor (`nobody:open` keeps finished cases in the queue for a person), and `off` leaves statuses to the investigation's verdict as before. The verdict still sets its status first. In the same poll the fold then corrects it, for example a `needs_customer_input` verdict goes back to `open` until our question has actually been sent.

**Applied 2026-09-27** with `npm run case-status -- --apply`: 352 moves. 340 were old `open` threads already past auto-close's 28 days, 7 `awaiting_human` → `resolved`, 4 `awaiting_customer` → `open` and 1 `awaiting_customer` → `resolved`. Only 4 had a message in the last 28 days. Two of those were read before applying: `bfe0feea` (we confirmed the replacement Wrap d'Or is on its way) and `c5ec7404` (we sent the tracking number for the missing serum). Both were stale `awaiting_human`, finished once our reply went out. A second dry run found nothing left to move.

**Found on the way:** 795 of the 840 open tickets were already eligible for auto-close. The `close` stage had not run on them.

### Open checks on the ticket, and a Senders screen (2026-09-27)

Stage 5d of `codex_plans/Case_State_Plan.md`, built before 5c at the owner's request: people see and settle the checks before anything moves a status on its own.

**A person settles a check by recording an action, never by editing the case.** « Mark done » or « No longer needed » inserts a row in `ticket_case_actions` (migration 43: `fulfilled` / `cancelled`, the user's id, never a name) and re-folds that ticket at once. The fold applies the latest action per check after the readings (`applyActions`), so `case_current` stays something code recomputes: `fold:once -- --all` after a rule change keeps every manual action. Without this, a check settled by phone or in Shopify is owed forever, since no message will ever clear it.

**Overdue is an alert on screen only.** A colleague's check is overdue after `colleague_check_overdue_days` working days, a partner's after `partner_check_overdue_days` (2 and 3 for Qiriness, in `support_parameters`). Nothing is sent and no status moves: alert first, automate later, as the owner decided.

**The sender directory is edited in Agent Setup, not in the database.** Each row shows what its label means for a case, through the same `AGENT_ACTOR_BY_LABEL` map the agent uses: answered like a customer, our side, or an operations partner. The screen says whether this brand has any operations partner at all, because that is what offers « partner » as an owner of checks (`obligationOwners`); a brand with none never sees partner checks. The support mailbox's own domain counts as the team without a row. **A label change applies to mail that arrives after it:** stored messages keep their actor until `actors:backfill -- --recompute` is run on purpose.

**Names on screen:** « operations partner » (warehouse, carrier) is never shortened to « partner », since the directory also has a « Commercial partner » label that is answered like a customer. Needs are shown in English through `web/lib/need-labels.ts`, shared with Insights.

### The Case Manager reads every message, and the fold turns readings into obligations (2026-09-27)

Stages 5a and 5b of `codex_plans/Case_State_Plan.md`.

**The reading gains four fields, each from a closed list** (`case-manager.mjs`):
- `effect`: the effect lists, filtered by who wrote the message (`casework/effects.mjs`, now shared with the labels);
- `asked`: our message only, `MISSING_FIELDS` keys;
- `obligations_opened`: `{ owner, need, quote }`, where the owner comes from `obligationOwners` (support always; a colleague or operations partner only if a directory label maps there) and the need from `NEED_KEYS`;
- `obligations_cleared`: ids from the open list the model is shown, so it cannot clear a check that does not exist.

`case_relationship` stays, for customer messages only: it still drives the categoriser.

**Two reading paths.** The customer path is unchanged: it is tied to the categoriser and gains the new fields. A new path, `runOtherMessageCasework`, reads **our messages and colleagues'/partners' received after the mailbox cutover**, oldest first per ticket, carrying pending questions and open checks from one message to the next. History is not re-read at a model call per message. Migration 42 makes `case_relationship` nullable and adds the five columns.

**The fold walks the readings** (`applyReading`, then `nextActorAfter`). Its rule order, each rule checked against the labels:
- **After the customer:**
  - a thank-you ends the case when nothing is owed; with our question still open it is ours (a closing reply); with a check open it goes to the check's owner;
  - a chase while a colleague's or partner's check is open, and our last message is within the holding interval, waits on that owner;
  - otherwise it is ours.
- **After a colleague or partner:** ours when they settled a check, theirs while it is still open.
- **After us:** nobody if we closed it with nothing open. Otherwise, in order: the customer if we just asked them something, then our open check, then theirs, then the customer's pending question, then nobody.

**The holding interval is a parameter**, `holding_reply_interval_days`, set to 5 for Qiriness.

**Measured, one step per labelled cut** (`eval:casework`, each cut starting from the previous label): **who acts next 91 to 93 of 132**, the range across two runs of the model. The stage 4 fold scores 79 and today's pipeline 45. The message's effect scores 79 to 80. Two tuning passes, both kept: « our question to the customer is `asked`, never a check of ours », and « `new_issue` only for a separate order, product or problem ».

**What is left:**
- **`closes_case` versus `answers` for our final reply** differs from the reviewed labels 20 times. It does not move who acts next: an answer with nothing asked and nothing open already folds to `nobody`.
- **Open checks as exact sets agree only about 50 times in 132**, because the labels and the reading name the same check with different needs. Who owes a check agrees 71 times, and that is what decides the next step.

**Found live (2026-09-27, ticket 2aa6604e):** an unread reply of ours fell back to the stage 4 rule and dropped an open check. Now only « we closed it » needs the reading; open checks and pending questions count either way. `fold:once -- --all` re-folds every ticket after a rule change.

**Found live (2026-10-05, ticket b2789896): the prompt rule is now also enforced in code.** gpt-4o-mini listed our « pourriez-vous nous préciser le code ? » in `asked` and also as a support `promotion_validity` check that quoted the question. The snooze rule treats an open check of ours as work, so the sent reply did not snooze. `normaliseCaseReading` now drops a support check opened by our own message when its quote is made only of questions. Kept on purpose:
- a quote with a declarative sentence (« Nous vérifions ce code. Pouvez-vous… ? »), since that is a real promise;
- a partner's or colleague's check (a question to Deret is their check);
- a check from a customer's message (their question is a request to us).

5c (the status from `next_actor`), 5d (the checks on the ticket and the Senders screen) and item C (the checks a rule opens) are above.

### The case has a current state, folded in code (2026-09-26)

Stage 4 of `codex_plans/Case_State_Plan.md`. `case_current` is one row per ticket, overwritten in place, folded by a pure function (`case-fold.mjs`) from the messages, the Case Manager's readings and the latest case file. `ticket_case_state` stays the per-message trajectory. The fold sorts by `received_at` itself, so arrival order no longer matters to it.

**The actor is stored per message** (`ticket_messages.actor`, migration 41), at arrival, like `sender_label`: relabelling the directory never rewrites history. 2,304 stored messages backfilled: customer 1,090, support 727, colleague 428, operations partner 59. It moves with a re-filed direction.

**Known gap #2 closed:** drafting now skips a case file whose trigger message was written by a colleague or an operations partner (`not_customer_trigger`). `sender_label` only ever read the opener.

**Measured against the 132 labels** (`npm run eval:fold`, no model call): the fold names the next actor at every cut and agrees on **79**. Today's pipeline agrees on 45 and cannot answer 71. One rule was tried and dropped on the numbers: « the case file says a person must act → support » scored 74 with it and 79 without, because case files are mostly written at the end of a thread and are stale by the time our reply settles them. **The 53 misses are stage 5's work:**
- **33 after our own message**, where the fold cannot tell whether we asked, promised a check or finished, because the Case Manager does not read our mail;
- **9 thank-yous after a close**: the Case Manager has no closing reading;
- **7 where a colleague's or partner's check is still owed**: that needs obligations.

**Moved to stage 5, deliberately:**
- **Status from `next_actor`.** Without obligations the fold cannot tell « waiting on Deret » from « waiting on us », and switching the live queue on that would be a regression.
- **The `ticket_case_actions` table**, since nothing writes to it before stage 5's « obligation done » action.
- **Re-reading on late events**, since the Case Manager reads so few messages (4 readings) that there is almost nothing to re-read.

`ticket_events` was not built as a SQL view: the fold builds the event order in code, and a view waits for a reader that needs one.

**Live:** all 993 tickets folded, and a second run found 0 stale. The pass runs in the worker after the investigation (`fold` stage, 200 a poll), and `fold:once` runs it alone. **Caught on the first live run:** `supabaseSelectAll` pages on `id`, which `case_current` does not have. The fake store could not see it; the live run did.

### A holding reply is its own next action, due by rule (2026-09-26)

« Nous avons bien reçu votre message, quelqu'un vérifie et revient vers vous » is neither a real answer nor silence. Until label schema 4 a labeller had to force it into *full reply* or *no reply, a person acts first*. **17 of the stage 3 baseline's next-action misses sit in that grey area** (a person must act first, and the pipeline drafts anyway); the eval could not tell « a holding message is due » from « stay quiet ».

**Decided with the business:** `holding_reply` is a next action. It is due the first time a case needs a person, on a chase when our last message is **more than 5 working days** old, and always on a level 3 case. It is not due twice within those 5 days unless something changed. **5 is Qiriness's value, not a constant**: it becomes the parameter `holding_reply_interval_days` when the drafting that reads it is built (stage 5). The catalogue only holds parameters something reads.

The 132 existing labels were **not** re-labelled automatically. The 17 *no reply, a person acts first* and the full replies whose note says « holding » are the candidates for review.

### The Case Manager records what a message changed; it decides nothing else (2026-09-22)

`ticket_case_state`: one reading per inbound message that lands on a ticket already read once. What it is FOR is one thing the pipeline could not do — **record a question when it is asked, and strike it off when it is answered.** A regex reading our own sent replies to recover the same fact measured 2.4 false hits per thread, and 0.3 after narrowing, with half of those still wrong (§ *A re-ask guardrail was built, measured, and removed*). A fact recorded at the time is not a guess.

**A TABLE, NOT A DOCUMENT ON `tickets`.** Two shapes already sit side by side in this schema. `resolved_context` is a snapshot overwritten in place, because "the current state of the order" has one correct value. This is a READING of a message, and a thread's readings are a trajectory — the same argument that keys `ticket_investigations` per trigger message. A mutable `metadata.case_state` would have lost which message established what, which is the one thing a follow-up needs.

**IT IS NOT A SECOND WORKFLOW ENGINE**, and the split is enforced by where the code lives. The model reads prose and picks from a closed vocabulary: which relationship, which of OUR questions this message answered, what we promised. What any of that MEANS is decided in `case-manager-rules.mjs`, in pure functions — the same split `evidence-rules.mjs` draws, for the same reason: a model asked both questions is marking its own homework.

**IT CANNOT NAME A SITUATION.** The library is never in its prompt and the schema has no field for one. The situation is carried forward in code, or dropped on `new_issue` and re-matched by the machinery that already does it. A Case Manager minting situation names would be a second classifier with no calibration behind it.

**THE QUEUE IS DERIVED, with no third `needs_*` flag.** A ticket is due a reading when it has a prior case file and its newest inbound message has none — two reads and a set subtraction, against a column on a populated table. `draft-record.withoutDrafts` made the same trade. **A genuinely new case matches nothing**, which is the brief's own requirement: there is nothing for a first message to change.

**IT RUNS BEFORE THE CATEGORISER, and that moves `--stop-after=categorise`.** The one decision it feeds is whether the labels need re-reading, which has to be known before the categoriser claims its batch. The backlog run is unaffected in practice: freshly ingested mail has no case file, so the stage claims an empty queue and the command costs what it did.

**RE-CATEGORISATION IS SUPPRESSED ON ONE RELATIONSHIP ONLY.** `continuation` — the same request, moved along. `new_information` may have changed what the thread is about, `new_issue` certainly has, and `unclear` is where nothing should be skipped on the strength of a reading that failed. The saving is not the point: one `gpt-4o-mini` call is the cheapest thing in the poll. What it buys is the labels not moving under a case that has not changed, since a blind re-read can only ratchet the level or rewrite a subject that was right.

**AND IT IS SKIPPED, NOT BYPASSED.** `complete('categorisation')` is what clears the flag and raises `needs_investigation` in one patch; a pass that jumped over it would leave the ticket uninvestigated. The casework pass hands the categoriser a predicate and the categoriser completes its own pass, so no second writer of `needs_categorisation` comes into existence.

**A FAILURE READS AS `unclear`**, which is the value that changes nothing: the categoriser runs, the situation is re-matched, the pipeline behaves as it did before this layer existed. The dangerous direction is a rate limit silently suppressing a re-categorisation or striking a question off a list, and `unclear` takes neither decision.

### The situation is carried forward until a second request appears (2026-09-22)

§ *The situation is matched on the opening message* closed with « what a later message should do to a situation already matched is undecided ». This decides it: **carry it**.

Re-matching per run is the alternative and it is worse — the matcher reads the OPENING message, so on a follow-up it re-derives the same answer at the cost of an embedding and, on a near miss, a chooser call. And scoring the newest message instead is what the 2026-09-03 measurement already rejected: a courtesy note would redefine what a ticket is about.

**`new_issue` DROPS IT.** A second request inside a thread is what the classifier exists for, and carrying the old situation into it would answer the new question from the old case's rules.

**A STICKY MATCH THAT WAS WRONG STAYS WRONG**, and that is the cost, stated rather than hidden. It is bounded: the rulebook is editable, and the next `new_issue` re-matches.

**NONE OF THIS RAN UNTIL 2026-09-25.** The Case Manager stored the situation and `runInvestigation` took a `carriedSituation` parameter, but nothing passed it: every follow-up was re-matched on its opening message, and the paragraphs above described a design, not the worker. It is now `planSituation`, built by `createSituationPlanner` from the latest case state and wired in the poll and in `investigate`; a planner that fails returns null and the opening message is matched as before.

**A `new_issue` IS MATCHED ON THE MESSAGE THAT RAISED IT**, which narrows § *The situation is matched on the opening message*. That rule exists because a courtesy note must not redefine a thread; a second request is the one message that should, and matching the opening message again would answer it from the first case's rules. It applies only when the `new_issue` reading is about the trigger message itself (`situationPlan`), and the stored match says `matched_on: 'trigger'`. The 0.65 band was calibrated on opening messages, so these matches run on a distribution it was not measured against — a known gap, small because `new_issue` is rare.

### Evidence reuse carries outcome buckets, and the ledger cannot say which need a call served (2026-09-22)

`evidence_reuse` holds `{need, tool, argsHash, outcome, finding, run_at, status}` per need a prior run settled — and **never what the tool returned.** `tool_calls` drops `data` on purpose and `context_ref` points at `resolved_context` rather than copying it; reusing the knowledge that a call ran does not reopen either, and reusing its content would.

**THE FIRST VERSION JOINED ON A FIELD THAT DOES NOT EXIST**, and four real tickets showed it: every need read `missing`, because a stored ledger entry is `{id, tool, argsHash, outcome}` and carries no need. The mapping belongs to the evidence vocabulary — `needsSatisfiedBy` already knows which tools settle which need — so it is derived there, and a tool added to a need cannot be forgotten here. On `1e4890dd`: `order_identity`, `customer_identity`, `refund_state`, `payment_state` and `buyer_type` read `valid`; `order_state`, `delivery_state` and `dispatch_state` read `stale`.

**`unknown` IS NOT CARRIED.** The run looked and could not settle it. Inheriting that as though it were a finding would stop the next run looking again.

**REPORTED, NOT ENFORCED**, like the evidence needs before it. Nothing skips a tool call and no budget changed. Suppression is a separate decision with its own replay (`report:collection-replay`), and taking it here would mean acting on a signal nothing has measured.

**`invalidated` NEVER FIRED UNTIL 2026-09-25**: the runner passed `orderChanged: false`. It is now `orderChangedSince` — the confirmed order on the ticket against `context_ref.orderName`, the order the last run used — so a corrected number or an order confirmed after the run invalidates the order-derived findings. **`evidence_reuse` is still read by nothing**; the investigation delta is what will read it.

**`stale` IS NARROW AND THERE IS NO TTL TABLE.** Measured across all 2,006 orders: `dispatched_no_scan` **1,992 (99%)**, `in_transit` **0**, `stale_in_transit` **0**. With no carrier feed, a freshness policy on tracking re-asks a question whose answer cannot have changed.

### A follow-up investigation is told what is already known, and nothing is skipped yet (2026-09-25)

The brief: for a follow-up, investigate only « the information required for the next decision minus the valid information already known ». Until today the second half never reached the run — `evidence_reuse` was written and read by nothing. `case-delta.mjs` now renders it as a « Dossier connu » section, after the customer's message and before the gathered evidence: what earlier runs established and may stand (`valid`), what moves on its own and must be looked at again (`stale`), what belonged to another order (`invalidated`), what this message brought (`new_facts`), what the customer just gave us and what we still wait for, and what we promised.

**A PROMPT, NOT A GATE.** Every tool stays offered and the opening moves still run. The section asks the model not to look up what is established; whether it obeys, and whether cutting calls costs a refresh, is `eval:delta`'s question. Skipping a call on the strength of an instruction nobody has measured would be the enforcement this layer has refused twice already (§ *Evidence reuse carries outcome buckets*).

**ONLY WHEN THE READING IS ABOUT THIS MESSAGE.** A case state written for an older message describes reuse against an older run; a stale account of what is known is worse than none. Then there is no section, and the run is byte-for-byte the one before. **No section on `new_issue` either**: the evidence was gathered for the first request, and presenting it as known invites answering the new one from it.

**`tool_calls` NOW CARRY \`source\`** — `opening_move`, `planner`, `model`. The ledger always knew and the stored row dropped it, so « the model re-fetched an established fact » could not be told apart from « an opening move ran, as it always does ». Only the model read the section, so only its calls count as re-fetches; a refresh counts from any source.

**THERE IS NO BASELINE YET, AND THAT IS THE FINDING.** On 2026-09-25 no ticket had a second investigation: the imported corpus was read once, at the end of each thread. The first numbers come from live follow-ups.

### One investigation per inbound message

`unique(shop_id, trigger_message_id)` is the idempotency key, so a reply produces a new reading instead of overwriting the previous one and the thread's trajectory survives as rows. `context_ref` **points at** `tickets.resolved_context` rather than copying it, so personal data is not duplicated per run. `customer_id` is denormalised and indexed: that is the seam Phase 7 memory hangs off.

### The investigation reads the thread, not the customer's half of it (2026-09-21)

`record.inboundMessages` filters `direction = 'inbound'`, and every pass that read a thread used it. So a follow-up was investigated against the customer's words with our own answers missing: « oui, j'ai vérifié les deux » arrived with no record of what they had been asked to verify. **95 outbound bodies were stored and no pass in this pipeline had ever read one.**

**The reader is new, not widened.** `record.conversation` sits beside `inboundMessages` rather than replacing it, because the two answer different questions and the older one is still right for its own. The categoriser labels what the customer asked; the situation matcher scores the request that opened the thread. Neither wants our replies in its query, and **both were calibrated without them** — the 0.65 band was derived over first inbound messages.

**Everything calibrated on inbound mail still runs on the inbound subset**, filtered in the runner: the trade-sender check, the opening message the matcher reads, the trigger message the case file is keyed to, `summarisePhotoEvidence` and `latestInboundAt`. Only the text handed to the model moved.

**The filter is `!== 'outbound'`, and how it fails is the reason.** A row whose direction did not travel — a projection that lost the column, a caller wiring its own read — stays in the inbound set and the pass degrades to the behaviour it had before it could see our replies. The strict test would empty the set and skip the ticket, which is a customer's mail disappearing to fix a column.

**One message renders bare, with no label and no date.** 133 of 172 tickets are a single inbound message with no reply; rendering them as a labelled transcript would change every one of their prompts to fix the 39 this is for. A test pins the single-message output byte for byte, and that is the safety property for the other 79%.

**The budget is spent newest first**, and charged for the separators and markers rather than only the bodies. An ascending render that ran out of budget would truncate the message the pass was woken up for. It was 4,000 characters for two bodies and is 12,000 for a thread — the longest in the corpus is 9 messages, and an outbound body averages 1,758 characters.

**`quotedText` stays inbound-only.** It exists because a forwarded order confirmation carries the number and the address together; quoted history inside our own replies is our own text coming back, which is the noise the split exists to remove.

### A finished thread is reconstructed in one reading, not replayed (2026-09-21)

The corpus predates all of this: 36 threads carry two or more customer messages and every one of them was read by the pipeline exactly once, at the end, as if the whole conversation had arrived at once. To get a starting state for them there were two options, and replaying the pipeline message by message is the wrong one. It would spend a categorisation, an investigation and a draft **per message** to rebuild a state the finished thread states plainly, and it would spend them against tools whose answers have since moved — an order that was `dispatched_no_scan` in July reads as months late today.

**So `cases:reconstruct` reads the whole thread once**, the way a person picking up a case file would, and reports where it stands.

**It writes nothing, structurally rather than by policy.** The runner is built with a reader and no record module, so there is no write path to forget to guard. The read-only requirement in the brief was mostly free already — every Shopify scope is `read_*`, drafting makes no Graph call, nothing issues refunds — so the only real exposure was writing rows, and the way to not write rows is to hold nothing that can. The one row it does leave is the `llm_usage` line, because the call was billed either way, and the header says READ ONLY rather than "writes nothing" for exactly that reason.

**The model reads prose; code reads the backend; the two are never merged.** It is asked what the conversation *claims* about a refund — `not_mentioned` / `promised` / `stated_done` — and never whether a refund happened. `backendPosition` derives that from `tickets.resolved_context`, read and not re-derived. A customer told « votre remboursement est parti » has been told that, which is a fact about the conversation and evidence of nothing else; the contradiction between the two is the finding worth a person's time, and it only exists while they are kept apart. The order bundle is deliberately absent from the prompt, so the model cannot report a refund as established because Shopify shows one.

**`replacement` is `not_representable`, permanently.** Nothing in the order bundle records "we sent one of these again for free" — a replacement leaves as a fulfilment on another order or on none. The honest value says the question cannot be answered here; the alternative is a field reading `no` that means « nous n'avons pas regardé », which is the `categorisation_confidence` mistake again.

**The situation comes from the shop's own library or is null**, checked in code against the 40 approved `exemplar_key`s. A key the model invents is dropped **and reported**, because that is a fact about the library as much as about the model. Null is a real answer: the library was never written against this corpus.

**Nothing downstream reads the output, and that is the point.** Judging a reconstruction against a reconstruction is circular — the brief's own regression format asks for a `case_state_before_test_message` that only this could produce. It breaks the way `categorisation_review` broke it: the rows are corrected by a person and the corrected set is what a suite rests on.

### The reconstruction's situation choice is not stable, and that is what makes the review load-bearing (2026-09-21)

Run over the same 36 threads twice, with the prompt differing only by an instruction to write in French, the situation tally moved: `(aucune)` **4 → 2**, D-06 5 → 6, D-07 1 → 2, D-36 1 → 0, R-23 0 → 1. **At least three of 36 threads changed situation between runs** on a change that had nothing to do with situations — roughly 8%.

**So the output is a draft reading, never a label.** Correcting it by hand was already the plan, for the circularity reason; this makes it load-bearing rather than tidy. A regression suite built on an uncorrected run would be pinned to whichever way the coin landed that afternoon, and the first unrelated prompt edit would look like a regression.

**It also bounds what the situation half of this is worth.** 34 of 36 threads matched something, which reads well until the instability is priced in — the honest claim is that reconstruction narrows 40 candidates to one plausible answer, not that it identifies the situation.

**Language follows the thread unless it is told not to, and mostly obeys when it is.** The first run summarised several French threads in English; with the instruction, 1 of 36 still came back in English — `d9f5fa74`, the Italian thread. Left as is: it is a review artefact a person is correcting anyway, and chasing the last one is tuning a prompt against a single row.

**Threads with one customer message are skipped by default.** They have no trajectory to reconstruct and their case file already says everything this could; 133 of 172 tickets are exactly that, so the default spends 36 calls instead of 172 to learn the same thing.
