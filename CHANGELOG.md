# CHANGELOG

**What has been built, and how far each piece has actually been proven.** Append-only; entries are not deleted as things move on.

Three sibling files carry the other halves, and this one deliberately does not duplicate them:

- **`DECISIONS.md`** — *why* each thing is shaped the way it is. The measurements quoted below are the evidence; the rule they produced lives there.
- **`VALIDATION_LOG.md`** — what is built but **not yet proven against real data**, with the check to run for each. Items are closed only once someone has run the check.
- **`README.md`** — what the project is, how to run it, and what is next.

---

## D-33 gets the plain question, three situations come back into the document, PR-27 and D-07 get rules (2026-09-03)

**D-33 had two variants and neither was the question.** Both were long, specific customer stories — a German whose distributor collapsed, an enquiry about US duties — and the plain form nobody had written down was « Est-ce que vous livrez en Italie ? ». Five phrasings added: two plain forms (FR and EN), the checkout half of the canonical, and the two real messages verbatim. Extra phrasings cannot dilute, because `match_support_exemplars` scores an exemplar by its BEST phrasing.

**O-11, CV-04 and A-35 are back in `Email-Example-Queries.md`.** They were approved, embedded and matching tickets while living only in the database. The import now reads **37 parsed, 37 stored, 0 stale** — the document and the agent finally describe the same corpus.

**PR-27 gets three rules** mirroring PR-28, and **D-07 gets one** — the situation the `dispatch_days` parameter was stored for. Its skeleton names what is knowable and what is not: we know our own dispatch window, we do not know transit time, and it forbids adding the two into a total nobody has calculated.

**Three condition-only parcel rules were proposed and then not written.** Measuring first showed `in_transit` and `stale_in_transit` occur in **0 of 2,006 orders** — they wait on the carrier feed — and `delivered` in one. See `DECISIONS.md § Six rules are dormant`.

**P-17 was left alone deliberately.** Four gift promotions are active at once, two of them containing « masque », so identifying which one a customer means is a coin flip; and all four are threshold offers whose condition depends on a basket we cannot see. A rule there would have had to guess twice.

**87 rules, all approved. 37 exemplars, all in the document.**

## D-01 mirrors O-09, three more situations get rules, and a shadowed rule is fixed (2026-09-01)

**83 rules now, all approved.** The set went from 69 by mirroring O-09 onto D-01 and covering D-36, D-05 and PR-28.

**A bug in the O-09 set, caught by simulating states rather than reading the table.** `paiement_non_abouti` was one condition (`payment_state: unpaid`) and `expedition_dans_le_delai` was two — and **an unpaid order is also an undispatched one**, so both matched and the deeper rule won. A customer whose payment failed would have been told we were preparing their order. Priority could not fix it: `selectAnswer` compares specificity BEFORE priority, so the payment rule had to become equally deep (`+ order_state: not_dispatched`) and then win the tie on priority.

**D-01 is a mirror, not a merge.** D-01 (« où en est ma commande », 19 messages, the largest cluster) and O-09 resolve to the same answers today because the same order states settle both. They stay separate because the carrier API will split them: D-01 will be able to say where the parcel actually IS, and O-09 never will. Until then the two sets must be edited in step — which is why they are written from one list rather than copied by hand.

**Why they were duplicated rather than made condition-only.** Dropping the situation would have let them answer the six-in-ten tickets that match nothing — but `commande_non_identifiee` would then fire on any delivery ticket without an order, including « livrez-vous en Italie ? ». The situation is what makes asking for an order number safe.

**D-36 has one rule and no conditions**, which is deliberate: the customer asking for a refund-or-resend is a commercial decision whatever the parcel is doing. The evidence changes what we can tell them, never whether we may agree.

**D-05** gets the two honest answers to « le suivi n'a pas bougé » — confirm it has stalled and take it to the carrier, or say it is moving normally without inventing transport steps. **PR-28** gets three, including one that refuses to name a wavelength or an irradiance the dossier does not hold: a wrong technical value on a device is worse than no answer.

**Simulated across nine order states × five situations, plus four product states.** Every cell resolves to its intended rule and `auditAnswerSet` reports zero problems on both sets.

## O-09 has rules, D-36 is live, and the parcel instruction is conditional (2026-09-01)

**Eight rules for O-09**, the most-asked question in the corpus (22 messages) and — until now — the most-matched situation with no rule of its own: it won five tickets in the backfill and fell through all five.

| when | route |
| --- | --- |
| `order_identity: none` | `needs_customer_input`, asks for the order number |
| `order_identity: resolved` + `order_state: unknown` | `needs_human` |
| `payment_state: unpaid` | `needs_human` |
| `order_state: not_dispatched` + `dispatch_state: within_window` | — |
| `order_state: not_dispatched` + `dispatch_state: overdue` | **`needs_human`** |
| `delivery_state: in_transit` | — |
| `delivery_state: stale_in_transit` | `needs_human` |
| `order_state: delivered` | `needs_human` |

**The `within_window` / `overdue` split is the point of the set.** Quoting « nous expédions sous 3 jours ouvrés » is useful on day one and an insult on day eight, and day eight is the common case: somebody who writes to ask whether their order has shipped has by definition already waited long enough to wonder. The overdue branch acknowledges it, says we are taking the order up with logistics, promises no date, and goes to a person — because saying we are paying attention is only honest if somebody is.

The in-window skeleton quotes `{dispatch_days}` from the parameters table rather than writing the number in prose, so a rule and an article can never disagree about it. An unset parameter drops the whole skeleton rather than sending a brace to a model.

**Simulated across all nine states an O-09 ticket can present** — each resolves to its intended rule, `auditAnswerSet` reports zero problems, and `expediee_sans_scan` still wins the no-scan case, so nothing was duplicated.

**`expediee_sans_scan`'s parcel instruction is now conditional.** It said « donner le numéro de suivi » unconditionally; 3 of the 78 tickets with a confirmed order hold no parcel, and an instruction to give a number the dossier lacks is how one gets invented. It now names what NOT to write when there is none — and pairs with the `tracking_number_given` check, which asks for the number only when we are holding one.

**D-36 approved and embedded.** 69 rules, all approved; 36 exemplars.

## Our own subject lines no longer decide which situation a customer's email is (2026-09-01)

`buildMessageEmbeddingInput` prefixed the subject to every message. On **225 of 574 inbound messages — 39%** that subject is one we wrote: « Nouveau message de client le 7 août 2026 à 09:51 » from the contact form, « Votre commande est confirmée » from the order mail a customer hit reply on. The first is a near-constant with a date in it, shared by hundreds of unrelated tickets; the second is worse than empty — a complaint that an order never arrived, embedded under a heading announcing it was confirmed.

**The chunk composer already made this argument and nobody had applied it to the query side**: *"a constant contributes nothing to ranking while diluting the actual content."*

**Measured before it was written.** 60 tickets in the 0.55–0.65 band with one of these subjects, embedded both ways: **9 crossed into `matched`, 0 fell out**, median margin +13%. A third changed which exemplar won, and by subject agreement — the same proxy the band was calibrated with — that churn was neutral, 33/60 either way.

**Measured again after re-embedding the corpus**, over all 328 tickets with an embedded first message:

| | before | after |
| --- | --- | --- |
| matched (≥ 0.65) | 120 | **123** |
| ≥ 0.70 | 79 | **83** |
| ≥ 0.80 | 24 | **38** |
| agreeing with the categoriser | 156 | **160** |
| best score seen | 0.915 | **1.000** |

The headline is the 0.80 band: **high-confidence matches went from 24 to 38.** Net matched moved only +3, smaller than the cohort predicted, and part of that gap is noise — `eval:exemplars` re-embeds the phrasings in memory on every run, so the two sides are not bit-identical between runs.

**On the three tickets that started it:** « commande 6669 … montant débité » went from no match, to 0.712 tied with O-09, to **0.804 with a 0.131 margin — a clean D-01**. The D-06 chase holds at 0.665. « Je n'ai toujours pas reçu ma commande » rose 0.606 → 0.628 and is still short: four lines of substance under a signature, and no subject rule reaches that.

**The version lives in the hash salt, not the composed string**, so it never reaches the model. The cost is blunt — a bump re-embeds all 851 messages, not the 225 whose text changed — and worth it: a stale vector is a wrong match for ever, and the corpus costs a fraction of a cent.

## Four phrasings, one new situation, and what they did and did not fix (2026-09-01)

Added to `Email-Example-Queries.md`, imported, embedded. **D-36** is new — a late order where the customer has stopped wanting to wait and asks for a refund or a reshipment. One situation for both remedies, because they call for the same reply: a commercial decision, taken by a person. It is a `draft`, so it is not reachable by retrieval until somebody approves it.

Three phrasings added to existing exemplars, all from real mail this corpus already holds: D-01 *« Je n'ai toujours pas reçu ma commande. »*, D-02 *« … j'ai payé pour 4 produits mais je n'ai pas reçu la totalité »*, D-06 *« Je n'ai pas de nouvelles depuis 1 semaine au sujet de la réexpédition… »*.

**Measured against the four tickets that prompted them**, by cosine over the stored vectors:

| ticket | before | after |
| --- | --- | --- |
| D-06 chase | near | **0.665 — matched**, on the new phrasing |
| D-01 « commande 6669 … montant débité » | none | 0.712, but O-09 is 0.702 — a 0.010 margin, so still ambiguous |
| D-01 « je n'ai toujours pas reçu ma commande » | near | 0.606 — **unchanged in effect** |
| D-02 missing item | matched | 0.768 — unchanged |

**One clean fix, one half, one that says the diagnosis was wrong.** The new D-01 phrasing did not even become D-01's best match on the ticket it was taken from — the canonical still wins at 0.606. That message is four lines of substance followed by an Outlook signature and a quoted Shopify confirmation, and the embedding is of the whole thing. **The near-miss is body noise, not missing vocabulary**, which is a different and larger lever than any number of phrasings.

**A caution about the importer, learned the hard way.** The document is the source of truth for phrasings and the import prunes anything not in it: the first run removed **7 stale phrasings**, one of which was R-21's *« Vous n'avez d'étiquette pour le retour ? »* — added outside the document at some point and destroyed by an import that had nothing to do with it. It is restored, in the document this time. The other six are unrecoverable.

**Whole exemplars added outside the document survive; phrasings added outside it do not.** Three exemplars live only in the database — `CV-04` (7 phrasings), `A-35` (5), `O-11` (2) — all approved, all live in retrieval, and two of them carry rules. Anyone reading `Email-Example-Queries.md` is looking at 34 of the 37 situations the agent actually uses.

## The parcel number is checked, not left to the model, and a marketplace order says so (2026-09-01)

**`tracking_number_given`** — the first OBLIGATION in `draft-checks.mjs`, where every other check proves a sentence is absent. When the dossier holds a parcel number and the ticket is `order` or `delivery`, the reply has to contain it. Whitespace-tolerant, because a model that writes « 6C21 1087 11964 » has passed the number on.

Prompted-then-verified rather than appended by code, on the mechanism the signature check already proves at 81/81: the number belongs inside a sentence, not bolted to the end of one. The prompt has always carried the number and never the URL, so `no_web_link` still forbids the link.

**Scoped to two subjects deliberately.** A cosmetovigilance reply about a reaction has no business quoting the tracking number of the order the product came from, and a check that fires on correct drafts gets ignored within a week.

**Measured first, and the measurement changed the skeleton advice.** Of 1,487 fulfilled WEB orders 1,483 carry a number (99.7%) — but across all channels it is 80%, because 402 of 467 Amazon orders carry none: the marketplace fulfils them and the number never returns through Shopify. Zero of the 78 tickets with a confirmed order are Amazon, so the tail is small, but 3 of those 78 carry no parcel at all. **A skeleton must therefore still say « if the dossier holds one »** — an instruction to give a number that is absent is how one gets invented.

**The sales channel is now on the ticket** — `TicketOrderFacts.channel`, rendered as a chip in the detail panel and a row in the expanded block, **only when it is not the online store**. Web is the absence of a mark: a fact restated on 1,500 of 2,006 orders stops being read. Not an allow-list of marketplaces either — anything that is not the web store is named, so a channel added in Shopify tomorrow shows up on its first support ticket rather than when somebody remembers to add it.

Why it earns the space: an Amazon order reading `Fulfilled` with no parcel is normal, and the identical pair on a web order means something went wrong. The chip tells a reviewer which of the two they are looking at.

## Two findings the O-09 rules need before they can be written (2026-09-01)

**`order_identity` now resolves to a value** — `resolved` / `none` / `unknown`, from the order tool's `found` vs `not_resolved` outcome. It had none, so `order_state: unknown` was the only way to ask "do we know which order", and that value also covers a *confirmed* order whose state is unreadable. A rule on the pair would have asked customers for a number already in the dossier.

**`dispatch_state` is new** — `within_window` / `overdue` / `unknown`, computed in `orderStates()` from `placedAt` against the stored `dispatch_days` (3), in working days. It exists because quoting the dispatch window at somebody already past it is a brush-off, and that is the common case for the corpus's most-asked question. See `DECISIONS.md § The dispatch window is a state`.

The migration's `requirement_needs` check constraint gained `dispatch_state` too — caught by the test that exists to hold the SQL list and `NEED_KEYS` together, which is the second time that guard has paid for itself.

## The corpus is fresh: 39 investigations, and the rules layer measured on real mail (2026-09-01)

Every ticket in an enabled subject re-investigated — 186 model calls, ~332k tokens. Four hit OpenAI's 30k TPM ceiling on `gpt-4o`; three succeeded on retry and one exhausted its three attempts and was routed to a person with the reason recorded, exactly as `handleFailure` promises.

**Rules reached 18 of 39 tickets, though only 12 matched a situation.** The difference is condition-only rules firing regardless of the matcher — which is the property that makes coverage independent of the 31% match rate. One verdict was tightened; none was loosened.

**`return_exchange` has 8 approved rules and none of them fired**, on any of its three tickets. R-21 was the closest exemplar every time and matched none. A coverage hole in the authored set, invisible before this run.

**The vocabulary is in better shape than the old corpus suggested**: 118 need entries, 2 contradictions, 5 coarse. No `product_property` satisfied-but-empty entry appeared, which is the first evidence that the 2026-08-31 fix holds against real mail.

`report:evidence-vocabulary` gained one more distinction on the way: **`refund_state: none` means the order has no refund** — a fact the order bundle establishes — while `product_property: none` means the library held nothing. Same word, opposite epistemic status, so the empty-finding test now lists its exceptions by `need:finding` rather than by value alone.

## A rule fired on real mail for the first time, and it found a bug (2026-09-01)

One promotions ticket, run for real: 5 model calls, 7,284 tokens. **P-18 matched at 0.74** and `aucun_code_identifie` was selected — the first `support_answers` rule ever applied outside the test chat.

**It did the job the layer exists for.** The investigation concluded `answerable`; the rule tightened it to `needs_customer_input`, asked for `promotion_code`, and offered `QIRINESS20`. `verdict_before_policy: answerable` beside `applied: true` is the tighten-only ratchet working on live mail.

**The decomposer split the email into two tasks** — `promotions/problem` and `delivery/question` — and one rule fired, from the promotions set only. The delivery half was investigated and got no rule and no skeleton. That is the per-ticket/per-task gap described in the plan, observed rather than predicted.

**The fresh row exposed a live scoring bug**, fixed the same day — see `DECISIONS.md § The active listing settles a code's validity only once a code is known`. `promotion_validity` was `satisfied` while holding `unknown`, because `listActivePromotions` satisfied it whether or not a code had been identified. Re-scoring the stored ledger with the fix moves it to `attempted`, and nothing else on the ticket moves.

**The audit gained a distinction it was missing.** `satisfied` + `unknown` is not a disagreement — it is the documented honest pair for a tool too coarse to name a value — so it is now reported as its own class beside the real contradictions. The corpus reads 9 contradictions plus 2 coarse entries, rather than 11 faults.

## Two read-only reports, and what they found (2026-09-01)

`npm run report:investigation-calls` and `npm run report:evidence-vocabulary`. Both write nothing, call no model, and read tables the pipeline already fills. Built to answer the two questions that gate `codex_plans/Rule_Guided_Investigation_Plan.md`.

**How much of an investigation the model chooses.** `tool_calls` drops the ledger's `source`, so opening moves are reconstructed by asking `openingMoves()` what the ticket's category would have opened with. That over-counts a decomposed ticket's extra moves as the model's, so every figure is an upper bound — the useful direction, since a near-zero upper bound would have settled the question. It is not near zero: **median 1 call beyond the floor, p90 2, 69% of investigations reach beyond it.** By subject, the share reaching: promotions 100%, payment 100%, return_exchange 100%, order 80%, product 53%, delivery 39%, account 33%.

**Whether the evidence vocabulary agrees with itself.** Each gap entry states the same thing twice — `state` from `satisfiedBy`, `finding` from `derive` — by different routes over the same ledger, so a disagreement means one of them is wrong without needing a labelled set. **11 contradictions in 294 entries**, in four groups, the largest being the `satisfied` + `finding: none` shape that the `product_property` bug made.

**The first version reported 20, and nine were its own false positive**: `attempted` + `promotion_eligibility: undetermined` is the *designed* pairing — `satisfiedBy` excludes `undetermined` deliberately so the tool's one honest gap is not laundered. `undetermined` joined the empty-findings set.

**Three facts the reports turned up that matter more than their own output:**

- **No rule has ever fired on real mail** — 0 of 93 investigations carry a policy record. The layer has only ever run in the test chat. 44 of 93 matched a situation, so its input exists.
- **The corpus ends 2026-08-21**, eleven days ago. Every contradiction's most recent occurrence predates the `product_property` fix of 2026-08-31, which proves nothing, because nothing has run since. A backfill is now a prerequisite for concluding anything about the vocabulary.
- **`products` (9) and `payments` (6) rules are `draft`.** `loadAnswers` reads approved only, so they are invisible to the agent. Approved counts: orders 17, cosmetovigilance 8, returns 8, promotions 7, accounts 6.

## The test chat shows the rule it fired, and the evidence that picked it (2026-08-31)

The rehearsal already ran the real rules — `loadAnswers` against the real table, the route tightening the verdict exactly as it does on live mail. The transcript showed less than it applied. Four fixes, all in `PolicyBlock` plus one field on the trace:

- **`ask` rendered on no rule at all.** It became a list on 2026-08-30 and the block read it with a string helper, so « Would ask for » was silently absent on every rule written since. Now rendered, tolerating the pre-2026-08-30 bare string, and it says when the questions did not reach the case file — they join `missing` only where the final verdict is already `needs_customer_input`.
- **The findings are shown**, matched or not. They are the `need -> finding` map the selection actually reads, so without them a missing rule and a finding of `unknown` look the same.
- **The answer skeleton is shown**, labelled as the one field from this layer that reaches the drafting model. It is what a reviewer of a rule-shaped draft should read first.
- **No policy is stated rather than blank.** `selectPolicy` returns null for three different reasons and cannot say which, so the rehearsal now emits `answerSet` beside the case file and the block names the family that could have applied.

The offer code renders too, with the note that it is re-checked at drafting time.

**Nothing about selection changed** — no agent behaviour is different, and the one agent-side edit is a field on the trace. `agent npm test` 1228 pass (one new), `web` typecheck and lint clean.

## `searchKnowledge` for cosmetovigilance, and what it reaches is a protocol (2026-08-30)

The subject's tools are now `lookupCustomer` + `searchKnowledge`, both as opening moves, and its checklist gains *the knowledge base was consulted*. The order family and `verifyPurchase` stay out, which is the half of the original decision that has not changed.

**The article it reaches is guidance, not knowledge, and that is worth recording rather than discovering later.** *"Cosmétovigilance — Rougeurs, irritations et réactions cutanées"* opens with reference content — formulations, Hanbang, why a reaction can occur with any cosmetic — and then becomes a **numbered protocol**: recommend stopping use, check whether several products were layered, reintroduce cautiously once symptoms clear.

That second half is **an instruction retrieved by similarity**, which is precisely the non-determinism the rules layer was built to remove. Whether the agent is told to recommend stopping use would depend on a cosine score, on a subject where it should depend on nothing at all.

**So this is a deliberately temporary shape.** The protocol belongs in a rule's skeleton, where it applies every time or not at all; the article should keep the reference half, which is what an article is for. Until they are split, the same guidance can arrive twice — once retrieved, once from a rule — and the two can drift, which is the failure the parameters table was built to stop for numbers and the same failure in prose.

**Nothing about answering changed.** The blanket `reaction_signalee` rule still routes every ticket in the subject to a person whatever the evidence says, and a rule cannot route to `answerable` at all. Retrieval gathers; the rule refuses. Level 4 still strips every tool.

## Answer sets in English, three new ones, and cosmetovigilance gets a lookup (2026-08-30)

**The sets are English.** `commande · retour · promo · produit` → **`orders · returns · promotions · products`**, renamed in the mapping and in both tables at once. Two languages in one namespace was the problem: French is what a customer reads, and a key a developer types is code.

**Three families added — `payments`, `accounts`, `cosmetovigilance`** — closing a gap that was a dead end rather than an empty one. `payment` and `account` had tools, four live situations (`PA-30`, `PA-31`, `PA-32`, `A-29`) and 15 real messages, and **no rule could ever reach one of their tickets**, because the code looked up a family and found nothing. `answer_set` is now set on all 31 live situations from the same mapping the runner uses, so the column agrees with the code instead of sitting stale.

**`other` remains the one subject with a tool and no family.** A test pins it by name so the gap stays visible and fails the day somebody decides what `other` should do.

## Cosmetovigilance gathers, and still never answers

The empty tool set was documented and deliberate: *"assembling a confident-looking answer is worse than assembling none."* It now holds `lookupCustomer`, and the subject is in `ENABLED_SUBJECTS`.

**The reasoning was about ANSWERING, and that half is untouched.** Every order tool and `verifyPurchase` stay out, because « nous ne trouvons aucune commande à votre nom » is exactly what they produce and exactly what must not reach somebody reporting a skin reaction. What was never separated from it is GATHERING: a person picking the ticket up needs to know who wrote in and what they last bought, and was opening Shopify for it.

`lookupCustomer` answers the first. **The last order arrives free** — `lastOrderLookup` is not in the tool table at all, runs outside the model's loop, and lands in `candidateOrder`, which the human brief renders and the drafting prompt does not. Context reaches the person and never the reply.

**The rule is the other half, and it is why this is safe.** Tools make a subject investigable, and an investigable ticket is a draftable one — which is the risk the empty set was really buying, bluntly. The `cosmetovigilance` set carries one rule: no situation, no conditions, `route: needs_human`. Every ticket in the subject is pinned to a person whatever the evidence says. **Tools gather; the rule refuses to answer.** Level 4 is untouched — a hospitalisation still strips every tool, asserted.

Its evidence checklist is one item, *the customer is identified*, and names nothing about the reaction: cause, product implication and what is owed are a person's judgements, and a checklist naming them would invite the case file to answer them.

**Six tests were asserting the old intent** — four used `cosmetovigilance` as the canonical toolless fixture. They now use `legal_privacy`, which still is, and the two that describe the subject directly say what it may and may not reach.

## Parameters now reach the rules, both ways (2026-08-30)

The parameters screen shipped as a store with no consumers — a number you could set that changed nothing. Both links now exist, and they are different mechanisms for different jobs.

**The decision link: pre-wired, invisible, deterministic.** `returns_window_days` feeds `orderStates`, which derives **`return_eligibility` — `possible · out_of_window · unknown`** — and a rule branches on the state. Nobody attaches the parameter to a rule; the wiring is in the deriver, exactly as the 10-day stale-transit threshold already worked. The difference is that this number is a merchant decision rather than a measurement, so it comes in as a parameter instead of a constant.

**An undecided window resolves `unknown`, never a default.** A default here would be a policy: 30 would quote customers a window nobody approved, 0 would refuse every return. `unknown` routes to a person, which is the right behaviour for a shop that has not written the number down — and this one's two approved articles disagree about it, so there is no default to reach for.

**Counted from delivery, not from the order**, which is what both articles say. An undelivered order is `unknown` too rather than `possible`: the clock has not started, and telling somebody they can return a parcel nobody has received answers a different question.

**The wording link: yours, per skeleton.** A skeleton writes `{returns_window_days}` and it is substituted when the prompt is composed. The rule editor has an insert list under the skeleton box — the one place a rule names a parameter directly.

**An unresolved placeholder drops the whole skeleton**, and the alternatives are worse. Sent as-is, the model sees a brace-wrapped token and either copies it into the reply or invents a number. Refusing to draft blocks a ticket over a wording gap when the case file and the route are both fine. Dropping it degrades to the behaviour before skeletons existed, and `draft.skeleton_dropped` records which parameter was missing so it is not silent.

**The editor says when a rule cannot fire.** Ticking a state computed from an unset parameter now shows *"needs returns_window_days, which is not set — this rule cannot fire yet"*, which is cheaper than finding out from a transcript. The state→parameter map is declared in the service because the wiring lives inside a deriver and nothing exposes it.

**A drift guard caught real drift.** `_shared.test.mjs` asserts every `T.*` constant is created by a baseline file, and adding `support_parameters` broke it across eleven tests — the file list is mirrored in `README.md` and `APP_SCHEMA.md`, and the test exists precisely so a ninth baseline cannot appear without them. All four updated.

**Six parameters, all still unset**, so `return_eligibility` resolves `unknown` on every ticket today and every returns question still routes to a person. That is correct and it is also the remaining work: the number is the merchant's, and their own articles give two answers.

## Parameters, and one bar across the three setup screens (2026-08-30)

**The failure that argued for this was already live, in approved content.** Two approved articles gave two different returns windows — "Refund policy" says « une politique de retour de 30 jours », "Livraisons et retours" says « un droit de rétractation … de 14 jours » — so which one a customer is told depends on which article retrieval happens to surface. That is not a content bug to fix once; it is what happens whenever one number lives in two paragraphs.

`09_parameters.sql` + `scripts/lib/parameters.mjs` hold each number once, for a rule to compare against, an article to state, and a skeleton to quote.

- **The catalogue is code, the values are data.** Which parameters exist and what each means live in `parameters.mjs`; only the numbers are in the table. A screen letting somebody invent a key would let them spend an afternoon setting something nothing reads — and rows are created on demand, so adding a parameter needs no migration and no backfill.
- **Every value starts NULL, and that is the honest state.** The numbers are the merchant's, and this shop's articles disagree about the most important one; seeding a guess would put a **third** answer into circulation wearing the authority of a setting. Null is a state every reader handles, and the screen calls it out — *"3 still to decide"* is the work, not an empty field.
- **`kind` is checked in the schema and mirrored by the reader**, so a `days` parameter can always be compared against a date without a caller checking first. `09_parameters.test.mjs` asserts the constraint's literals equal `PARAMETER_KINDS`, the same arrangement holding `requirement_needs` to the investigation vocabulary.
- **No approval step, unlike a rule.** A parameter is a fact about the business rather than a behaviour: there is no state in which the number is decided and should not yet be used, and an approval flag would only be a second place for "which number is live" to be wrong.
- **Clearing is a real operation.** Taking a wrong number out of circulation must not require inventing a right one first.

**Six parameters offered, all unset**: returns window, EU withdrawal period, refund processing time, dispatch delay, free-shipping threshold, returns address.

## Tabs, not buttons

Knowledge · Rules · Parameters now sit in one bar, in a shared `layout.tsx`, so the three cannot drift into showing different navigation — the exact failure a tab bar exists to prevent. A button reads as an action taken from where you are; **these are three places of equal standing**: what the agent knows, what it does about it, and the numbers both quote.

"Test the agent" stays a button, because it IS an action — it opens a dialog and goes nowhere.

The active tab is matched **exactly, never by prefix**: `/agent-setup` is a prefix of both other routes, so a `startsWith` test would light every tab at once on the rulebook.

**Verified against the running app** — every refusal is a sentence: `30.5` days refused, `seventy` euros refused, an unknown key refused; set, read back and cleared.

## The rule's wording reaches the reply (2026-08-30)

Phase 5, and the last of the layer. A matched rule's `answer_skeleton` now travels into the drafting prompt, so a rule shapes what the customer reads and not only where the ticket goes.

- **One field out of `exemplar_match`, read by name.** That column also carries the similarity, the margin, the runner-up and every finding the run resolved — diagnostics for a person, none of which a reply has a use for. `caseFileFromRow` narrows to `policy.answer_skeleton`; spreading the object would put the whole diagnostic one careless renderer away from a prompt.
- **After the facts, before the rest.** The model needs to know what the reply is FOR while the evidence is still in view; above the case file, an instruction about shape outranks the facts it is shaped around. Same reason the customer's own words come first.
- **Framed as an instruction, never as a reply**, and the framing is load-bearing: a skeleton is shared across situations by design, so handed over as text to send it would give different customers the same words.

**And it immediately produced the failure it was always going to produce.** The first live run of `annulation_trop_tard`, whose skeleton said to give the return procedure *« telle qu'elle figure au dossier »*, met a dossier with no returns article. The model invented three steps and a **numéro d'autorisation de retour** that this shop does not issue — and the draft **passed every mechanical check**, because the checks prove a named sentence is absent and can say nothing about whether an invented one is true.

**The rule this is worth stating as a rule: a skeleton is an instruction, and instructions get followed.** One that tells the model to state something the dossier *may not contain* converts a missing fact into an invented one — which is the single failure this pipeline is built around, arriving through the one door that had just been opened.

**A skeleton may describe what to do with facts that are present. It may never instruct stating a fact that may be absent.** `commande_annulee` already had the safe shape by accident (« mentionner le remboursement uniquement s'il figure au dossier »); `annulation_trop_tard` did not, and now reads: give only what the dossier explicitly holds, and if it holds nothing, describe no procedure, no step, no delay and no authorisation number.

Re-run after the fix, the invented procedure is gone and the reply says a colleague will send the instructions. **Corrected through the rulebook screen's own API**, which is also the first exercise of it: editing a live rule returned it to `draft` and it needed re-approving, exactly as designed.

## The rulebook has a screen (2026-08-30)

Phase 4. `/agent-setup/rules` — rules read, written, approved and deleted without a deploy.

- **The editor cannot offer a state the agent cannot score.** `policyVocabulary()` derives the needs, routes and asks from `evidence-rules.mjs` and `case-file.mjs` at request time; nothing is restated in `web/`. Needs carrying no findings are **excluded rather than shown empty** — `return_eligibility` and `refund_state` are needs with no states, so a rule branching on one could never fire, and a dropdown is the wrong place to advertise that gap. 16 needs offered, 2 withheld.
- **Validation is the agent's own functions, not a second copy.** `normaliseConditions` drops anything the vocabulary does not know, and the save compares what it kept against what was sent — so « en_cours » is a refusal with a sentence rather than a row that reads correctly and never matches. `auditAnswerSet` runs before the row exists instead of after.
- **Saving never approves.** A save always lands as `draft`; approval is its own endpoint. Sharing a handler would mean a typo fix silently re-approving a rule somebody had withdrawn — the same split `import-exemplars.mjs` keeps, for the same reason.
- **`answerable` is absent from the route dropdown**, as it is from the check constraint. The UI, the service and the schema all refuse it, which is right for the one property of this table that must never be revisited by a future caller.
- **A route, not a tab.** `AgentSetup` already holds the article library, the editor, the brand voice and the test chat in one client component; the rulebook shares no state with any of them.

**Verified against the running app** — every refusal returns a sentence an operator can act on:

| Attempt | Result |
| --- | --- |
| a state that does not exist | refused — « en_cours » is not a finding of order_state |
| a need that does not exist | refused — unknown need « colour » in a condition |
| routing to `answerable` | refused — never to answerable |
| asking without routing to the customer | refused |
| no conditions and no situation | refused — use is_fallback instead |
| a legitimate rule | created as `draft`, approved, deleted |

**One retyping at the boundary, recorded because it looks like a workaround.** `answer-selection.mjs` declares its `warn` option through a JSDoc default, so TypeScript reads it as taking no arguments and rejects a handler that wants the message. `normaliseConditions` is narrowed once where the two languages meet, rather than cast at the call site, so the `.mjs` stays the only definition of what a condition is.

## The rulebook is live (2026-08-30)

Phase 3. A matched rule now moves the verdict. 17 `commande` rules approved and loading.

- **Tighten only, and by RANK rather than by trust.** The schema stops a rule routing to `answerable`; nothing in it stops one routing to `needs_customer_input` on a ticket the investigation had already handed to a person. `applyPolicyRoute` closes that half: `answerable < needs_customer_input < needs_human`, and a rule is applied only when it raises the rank. **A written policy is a floor under the verdict, never a ceiling — the investigation saw this ticket, the rule saw a category.**
- **The question travels with the route.** A rule routing to `needs_customer_input` carries its `ask` into `missing`, or the very next rule in `buildCaseFile` turns the verdict back into `needs_human` for naming nothing to ask — silently undoing the rule that had just fired.
- **Approval became a gate.** It deliberately was not one during the shadow phase: filtering on `approved` while every rule was a draft would have loaded nothing and measured nothing. It is one now, for the reason an unapproved knowledge article holds no vector.
- **`would_change_verdict` was renamed to `applied`, and the rename is not cosmetic.** With the route live, `route !== verdict` is false precisely when the rule worked, so the old field would have reported "changed nothing" on every ticket it moved. `verdict_before_policy` is stored beside it, which is the only way to audit the layer now that it is no longer a shadow.

**Verified on the two tickets the shadow run predicted would move**, re-investigated with the route live:

| Ticket | Situation | Rule | Investigation said | Now |
| --- | --- | --- | --- | --- |
| #5144 | D-06 | `colis_retourne` | `answerable` | **`needs_human`** |
| #5953 | D-02 | `article_manquant` | `answerable` | **`needs_human`** |

Both are tickets the agent was about to answer on its own: a parcel returned to us, and an item missing from a delivered order. Neither is an answer an agent should be writing.

**The blast radius is 2 of 50** on the measured sample, and both directions are safe: a rule can send a ticket to a person and can never send an answer to a customer.

**The rules were approved without a per-rule reading by the operator**, which is worth stating plainly rather than leaving implicit. The shape was reviewed and corrected — D-02's photo branch exists because of that correction — but the French skeletons were not read line by line. They are one `approval_status` update away from being switched off again, individually or as a set.

## The "dilution" explanation was asserted, then tested, and does not hold (2026-08-30)

A claim was made here that whole-email embedding buries the one sentence deciding which situation an email is about — offered as the reason `D-01` absorbs specific complaints, and as the case for turning on the lexical half of exemplar matching. **It was asserted without evidence. Tested, it is not supported.**

**Test 1 — the decisive sentence against the whole email**, on two real tickets:

| Ticket | Whole email | Sentence alone |
| --- | --- | --- |
| #5953 « il manque un article » | **D-02 wins at 0.787**, next 0.650 | D-02 at 1.000 |
| #5144 order shows unprocessed | D-06 0.643 · D-01 0.627 · O-09 0.609 | O-09 wins |

The first case refutes the claim outright: the whole email picks the specific situation, decisively, with a 0.137 gap. The second is consistent with it — but that email is genuinely vague, and a person reading it could defend either answer.

**Test 2 — sentence-level scoring across all 44 stored matches.** If the decisive sentence were being buried, scoring sentences separately and keeping the best should move the winner.

```
winner unchanged   37 of 44
winner changed      7
  thin matches (margin < 0.05)   4 of 6   moved
  confident matches               3 of 38  moved
```

**What this does support**: a thin margin predicts instability — 67% of thin matches move against 8% of confident ones. That was already visible in the stored margins and needed none of this to establish.

**What it does not support**: the dilution mechanism as a general explanation, or sentence scoring as a fix. Two of its seven changes are plainly worse — a promotions ticket becoming « annuler ma commande », and a disputed delivery becoming the same — which is sentence scoring latching onto a stray line rather than reading the request.

**The honest blocker is ground truth.** The 44 matches were reviewed by hand and judged mostly right, but which ones were wrong was never written down, so no proposed fix can be measured against them. **Any further work on matching should start by recording that judgement, one line per ticket, and not with a mechanism.**

`search_vector` on `support_exemplar_phrasings` stays as the migration left it: generated, indexed and unread. It may well be the right instrument, and nothing here has shown that it is.

## O-11 merged into O-09 (2026-08-30)

The fourth exemplar merge, and the first argued from a measurement rather than a reading: replaying every confusable pair through the rule selector showed **O-09 and O-11 select the same rule in all 20 evidence positions the `commande` set can distinguish**. One situation with two names, and the matcher spent 7 tickets choosing between them at a margin of 0.11.

- `Email-Example-Queries.md` is the source, so the merge happened there first: O-11's real variant and its canonical question moved onto O-09 as phrasings 5 and 6, demand `18 → 22`, and the O-11 entry was removed. Re-imported (30 questions, 94 phrasings) and re-embedded (2 new vectors).
- **O-11 needed `deleted_at` set, and the three earlier merges did not.** O-10, D-04 and P-16 were retired while still `draft`, which holds no vector and is unreachable, so leaving their rows cost nothing. **O-11 was approved and embedded** — removing it from the document would have removed it from nowhere, and it would have gone on competing for matches against the question that absorbed it. `match_support_exemplars` gates on `deleted_at is null` and on the vector existing, never on whether a question is still authored. Live exemplars: 31 → 30.
- **A stale count was corrected rather than carried forward.** The document claimed "32 exemplars → 29" after the August merges; the importer parses 30, and the table holds 30 live rows. The figures now say what was counted.

**The other confusable pairs are not merge candidates and this does not touch them.** They pair a specific complaint (`D-02` item missing, `D-03` disputed delivery, `D-06` parcel returned) with the generic `D-01` « où en est ma commande », and those genuinely differ — the answers diverge in all 20 positions. Merging them would destroy a distinction that matters; the problem there is that `D-01` absorbs specific complaints at margins as thin as 0.022, which is a retrieval problem rather than a corpus one.

## Which situation confusions actually matter (2026-08-30)

The operator reviewed all 44 stored situation matches by hand. **The majority are correct, and the wrong ones are wrong in one specific way: the situation chosen is near-identical to the one it should have been.** That reframes the problem — the matcher is not unreliable, it is unreliable *between near-duplicates* — and it makes the useful question not "how accurate is matching" but "which confusions change an outcome".

Answered by replaying the 21 confusable pairs seen on real tickets through the real selector, across all 20 evidence positions the `commande` rules can distinguish. No model calls, no re-investigation.

**Confusing these changes nothing — 7 tickets.** `O-09` (« toujours pas expédiée ») against `O-11` (« confirmation puis plus de nouvelles ») select the same rule in every position. They are the same situation wearing two names, which the source document already suspected: it flags `O-09/O-10` and `P-15/P-16` as merge candidates. **Merging is better than teaching the matcher a distinction that carries no consequence.**

**Confusing these changes the outcome — 16 tickets**, and they share a shape: every one pairs a SPECIFIC problem with the generic `D-01` (« où en est ma commande »).

| Pair | Diverges in | Margin |
| --- | --- | --- |
| `D-01` vs `D-02` (item missing) | 20 of 20 positions | 0.074–0.095 |
| `D-01` vs `D-06` (parcel returned) | 20 of 20 | 0.022–0.062 |
| `D-01` vs `D-03` (says delivered) | 20 of 20 | 0.092–0.122 |
| `O-11`/`O-09`/`O-13` vs `O-12` (address) | 12 of 20 | 0.075–0.120 |

**The harm is asymmetric, and only one direction is dangerous.** Mistaking a specific problem FOR `D-01` means a missing item or a disputed delivery is answered rather than escalated — the failure that matters. The reverse, `D-01` losing to a specific situation, only escalates a ticket that did not need it: wasteful, never wrong. `D-01` is the vague catch-all, so everything resembles it slightly, which is exactly why it wins narrowly against the situations it should lose to.

**Nineteen of the 21 pairs are in families with no rules yet** (`promo`, `produit`), so nothing here says whether their confusions matter. `P-15` vs `P-18` alone accounts for 9 tickets and is untested.

**No change made yet.** The mitigation is a choice between merging the interchangeable situations, requiring a margin over the runner-up (`summariseExemplarMatches` already accepts `minMargin` and nothing passes one), and sharpening `D-01`'s phrasings so it stops absorbing specific complaints — and picking between them is the operator's call, not a detail to settle in code.

## The shadow run: 50 tickets, 2 disagreements, and the matcher is the weak link (2026-08-29)

50 order/delivery tickets re-investigated in dry run against the seeded `commande` set. Nothing written, no flag moved: the real runner was driven with a read-only queue, because `--backfill` would have raised `needs_investigation` on every ticket it touched just to read it.

```
investigated       50        rule selected              situation matched
a rule matched     22          17  expediee_sans_scan      41  none
would change route  2           2  colis_retourne           2  D-02 · D-06 · O-11 · D-01
                                1  livraison_contestee      1  D-03
                                1  article_manquant
                                1  article_manquant_photo_recue

order_state:     unknown 29 · dispatched 19 · delivered 2
photo_evidence:  unknown 46 · none 2 · attached 1 · mentioned_not_attached 1
```

**The shared rules carry the load, which is the design working.** `expediee_sans_scan` fired 17 times with no situation matched at all. Had rules been keyed to situations only — the obvious build — 41 of these 50 tickets would have had no policy whatsoever.

**Two disagreements, and they are not the same kind.**

- **#5953 — the rule is right and the investigation was wrong.** « Il manque un article malgré mes vérifications : Élixir eclat parfait 30ml. » The investigation concluded `answerable`; `article_manquant` would have sent it to a person. A missing item is a resend-or-refund decision and the agent has no business answering it alone.
- **#5144 — the rule is right and the SITUATION was wrong.** The customer says the site shows their order unprocessed and they have been charged. It matched **D-06** (« mon colis est revenu chez vous ») and selected `colis_retourne`. The routing lands somewhere defensible, and the reason is false — the skeleton would have told the drafter to discuss a returned parcel that does not exist.

**That second case is the finding.** The failure is in the exemplar matcher, not in the rules, and it is the risk the plan named before any of this was built: matching has only ever been validated by a PROXY — whether the winning exemplar's subject agrees with the categoriser's — and that proxy cannot tell D-06 from D-01, because both are `delivery`. Here it did not.

**Coverage is also lower than the exemplar eval implied**: 9 of 50 tickets matched any situation (18%), against the 45% `eval:exemplars` reported over its own sample. Situation-keyed rules are reaching far fewer tickets than the corpus suggested they would.

**Neither is a reason to hold Phase 3**, and both are reasons to keep the tighten-only constraint: a mis-matched situation can currently send a ticket to a person with a wrong reason attached, and can never send a wrong answer to a customer.

**A measurement error worth recording.** The first attempt ran without `shopId` reaching `createInvestigationStack`, so `lookupCustomer`, `verifyPurchase` and `searchKnowledge` all failed — visible as `invalid input syntax for type uuid: "undefined"` and a `match_knowledge_chunks` signature miss. The numbers were wrong in a way that looked plausible. Re-run with it wired, `needs_customer_input` fell 22 → 9 and `answerable` rose 10 → 17, which is the shift you would expect once the lookups work.

## The policy layer runs, and changes nothing (2026-08-29)

Phase 2. Every investigation now selects a policy rule and records what it would have done. **No verdict moves.** A wrong rule costs a row in a diagnostic rather than a customer a wrong reply, and the disagreements are the review list before Phase 3.

- **Selection happens inside `investigate.mjs`, after the tool loop closes**, and it had to: the case file keeps the ledger as `{id, tool, argsHash, outcome}` and drops each call's `data`, so findings cannot be derived anywhere downstream. Running it last is also what makes the shadow meaningful — the verdict, the needs and every tool call are settled before this reads them.
- **The rules say which needs to score, not the ticket.** D-02 declares `order_identity, order_state, policy_answer` while its rules branch on `photo_evidence`; scoring only the declared set would have left every one of those rules permanently unmatched. `needsNamedBy()` closes that, and it costs nothing — it re-reads a ledger that already exists.
- **The answer set comes from the ticket's SUBJECT**, not from `support_exemplars.answer_set`: `match_support_exemplars()` does not return that column, and today a family is exactly a grouping of subjects, so reading it would need the function widened for no difference in outcome. Worth doing the day a situation draws on a family its subject does not imply. **Until then that column is written and unread**, which is worth knowing rather than discovering.
- **`loadAnswers` is an injected loader, not a store method.** The case-file store's transport is the seam the test chat swaps for an in-memory database; rules are read-only reference data like products and knowledge, so a rehearsal wants the real ones.
- **Approval is deliberately not a gate yet.** The rules are `draft`, and filtering on `approved` now would load nothing and measure nothing. It becomes a filter the moment a route is applied for real.
- **The shadow record extends `exemplar_match` rather than adding a column.** `ticket_investigations` is populated, so a column is a forward step against real rows; this is the same diagnostic subsystem with the same lifecycle, and § Investigation already records extending an existing jsonb as the cheaper correct move.

**Verified end to end through the test chat**, three messages against order #6513 (dispatched 43 days ago):

| Message | Situation | Rule | Verdict |
| --- | --- | --- | --- |
| « je souhaite annuler ma commande » | O-13 | `annulation_trop_tard` | unchanged |
| « où en est ma commande » | D-01 | `expediee_sans_scan` | unchanged |
| « il manque un article dans le colis » | D-02 | `article_manquant` | agrees (`needs_human`) |

The third selected the backstop rather than a photo rule because the model never called `checkPhotoEvidence`, so `photo_evidence` resolved `unknown` — which is exactly what the backstop is for.

**A stale comment was corrected while here.** The runner claimed the exemplar match "is not passed to `investigate`, so no tool choice, need or verdict can depend on it". It has passed `requirement_needs` since needs-fallback landed — which is why `needsSource` exists — so the comment described a contract the code had already left.

## A missing item is a photo case too — and the sentence asking for one was dead (2026-08-29)

Corrected by the operator: a missing item **can** be photographed, because the evidence is the packaging rather than the product. Whether there was room in the box for the article says whether it was ever in it. D-02 now follows the same three photo states as D-08, taking the `commande` set to 17 rules.

**Following that correction found a live bug.** `photo` was declared **twice** in `MISSING_FIELDS`, and a duplicate key is silent — the later declaration won. So the sentence customers actually received asked for « une photo du produit concerné », while the one above it, asking for « une photo du produit **et de son emballage** », had been unreachable for as long as both existed.

That is precisely the wrong half to lose. On « il manque un article dans le colis » there is no product to photograph; the surviving sentence asked for the one thing that case does not have.

- **The duplicate is removed and the packaging wording is live.**
- **`case-file.test.mjs` now checks the source text, not the object.** By the time a duplicate reaches `Object.keys` there is one key and nothing is detectable, so the test reads `case-file.mjs` and counts declarations per field. Verified by injecting a second `photo` and watching it fail (`photo is declared 2 times`) before restoring.

## The `commande` policy, written down (2026-08-29)

15 rules seeded into `support_answers`, and `answer_set = 'commande'` set on the 11 order/delivery situations that draw on them. Authored as `draft`: nothing reads them yet, and Phase 2 runs them in shadow.

**Three shared rules do most of the work.** `non_expediee`, `expediee_sans_scan` and `commande_annulee` are keyed to the state alone, with no situation, so one rule answers D-01 « où en est ma commande », O-09 « toujours pas expédiée » and O-11 « plus aucune nouvelle » — which is the reason answers are keyed by evidence position rather than by question. They also fire when **no exemplar matched at all**, so coverage does not rest on the matcher's recall.

**The situation-specific rules are the ones evidence alone cannot reach.** « Je souhaite annuler » resolves three ways off one order field:

```
O-13 + not_dispatched        -> annulation_possible      -> a person (who cancels it)
O-13 + dispatched|delivered  -> annulation_trop_tard     -> verdict unchanged, answers directly
O-13 + no confirmed order    -> no rule; the existing machinery asks for the number
```

Same words from the customer, three different outcomes, decided by the order record. That is the whole point of the layer.

**D-08 is the three-state photo pattern**, and it is the shape the operator asked for: a photo attached routes to a person to judge it; none attached, or one the customer believes they attached, asks for it via `MISSING_FIELDS`; the photo tool never having run falls back to a person. `attachment_type_unknown` is grouped with `attached` deliberately — that gap is ours, and telling someone to resend a photo they did send reads as not having looked.

**No rule promises an action.** There is no write tool for Shopify, so cancelling, changing an address and adding an item all confirm the request is *still possible* and hand over. Three rules route to a person for that reason alone.

**Verified by reading the table back through the real selector** across 14 positions, including the two that matter most: an unmatched situation still gets the shared state rules, and a cancellation with no confirmed order selects nothing and leaves the verdict alone. The seed validates every rule through `normaliseConditions` and `auditAnswerSet` before writing, and refuses if a condition would be dropped — a branch that can never fire is the failure mode hardest to see from outside.

**No seed script was kept.** `support_answers` is the source of truth from here, and the dashboard will edit it; a checked-in seed would be a second copy that drifts the first time somebody changes a rule in the UI.

**Not covered, deliberately:** D-07 and D-33 are pure policy questions with no order behind them, so they need no state rules. `in_transit` and `stale_in_transit` have no rules because no ticket can reach those states until a carrier feed exists.

## A rule can name the situation, and can tighten where a ticket goes (2026-08-29)

Phase 1. `support_answers` gains the three columns that turn an answer skeleton into a policy rule, and `answer-selection.mjs` gains the second axis.

- **`situation_key`, nullable.** The two axes answer different questions: `when_conditions` says what is TRUE about the order, `situation_key` says what the customer WANTS. « Où est ma commande » and « il manque un article dans le colis » are two delivery tickets with identical order facts and different answers, so evidence alone cannot separate them — and a cancellation turns on a fulfilment status no phrasing can settle. **The embedding decides the intent, the evidence decides the state.** Nullable is load-bearing: a rule naming only conditions still fires when no exemplar matched, so coverage does not depend on the matcher's recall.
- **The situation outranks condition depth in selection.** Without that ordering a generic two-condition rule would beat the rule written for this exact request, and the specific answer would be unreachable whenever a broader one happened to name more needs. `sameDepthAs` moved with it, so the two are not reported as an ambiguous tie.
- **`route`, tighten-only, enforced by the schema.** `answerable` is absent from the check constraint by design: a rule may hand a ticket to a person or turn it into a question, never declare one safe. `05_exemplars.test.mjs` asserts the list equals `VERDICTS` minus `answerable` rather than hard-coding the pair, so adding a fourth verdict fails the test instead of silently making it un-routable.
- **`ask` carries a `MISSING_FIELDS` key, never a sentence.** `case-file.mjs` owns the wording; prose here would be a second copy of it.

**The constraint that looked right and was not.** `check (ask is null or route = 'needs_customer_input')` accepted exactly the row it exists to refuse. With `route` null the comparison is NULL, `false or NULL` is NULL, and **a CHECK evaluating to NULL passes**. It was caught by inserting the offending row against the live table rather than by reading the clause — the verification found it, not the review. Now `route is not distinct from 'needs_customer_input'`, which is total, and the migration test asserts the two-valued form cannot come back.

**Applied to the populated database as a forward step**, per `DECISIONS.md § Migrations`: `support_answers` held 0 rows, so the table was dropped and recreated from SQL **extracted programmatically from the baseline rather than retyped**, in one transaction, with every extracted statement asserted to be about `support_answers` before running. No `alter table`, so none of the column-order divergence recorded on 2026-08-18. The script was discarded. Baseline and database are identical.

## The order family can be branched on (2026-08-29)

Phase 0 of the situation → policy layer. `support_answers` and `answer-selection.mjs` have been built and unused since they were written, and the reason was mechanical: the order-family needs had **no findings**, so `order_state`, `delivery_state` and `payment_state` all resolved `null` and no rule could branch on any of them.

- **`orderStates()` in `order-context.mjs`** projects the bundle into one closed value per axis. It lives beside the bundle deliberately — deriving these in the investigation would be a second reading of `fulfillments` and `financial_status`, free to disagree with the one the model was shown, which is the split that module exists to close.
- **Five findings added** in `evidence-rules.mjs`: `order_state`, `delivery_state`, `payment_state`, `purchase_verified`, `photo_evidence`. They read `data.states` off the tool ledger, never prose — the rule that file already states. `getOrderContext`'s ledger `data` was widened to carry them; its French prompt text is untouched.
- **`return_eligibility` and `refund_state` deliberately left unwired.** "Still returnable" needs a returns window, which is policy, and hardcoding it in a deriver would be a second copy of the returns article.
- **`dispatched_no_scan` is its own state, not a flavour of `in_transit`** — and the corpus says it is the dominant one.

**Measured over every built bundle (`npm run eval:order-states`, 78 tickets), and it changed two things:**

```
order_state              delivery_state             payment_state
  73  dispatched           73  dispatched_no_scan     74  paid
   4  delivered             4  delivered               4  partially_refunded
   1  not_dispatched        1  not_dispatched
                            0  in_transit
                            0  stale_in_transit
```

- **`in_transit` and `stale_in_transit` are unreachable today**, at 0 of 78 — no carrier feeds scan events into Shopify for this store, the same gap `delivery_unscanned` exists to stop the model discussing. They are declared and unwired on the `checkout_state` principle, so the count argues for the carrier integration rather than hiding the need for it. **`escalationTriggers`' 10-day stale-parcel rule is dormant for exactly the same reason** — that was not previously written down.
- **`not_dispatched` looks dead at 1 of 78 and is not.** No bundle in the corpus was built for an order under 7 days old (p25 35, median 60): these are historical tickets whose orders had long since shipped. A cancellation arrives hours after the order, which is precisely when this state is true. **The consequence for the plan is that Phase 2's shadow comparison cannot validate the cancellation branch — there is no historical ticket where the order was still unfulfilled.**

## A reply in Italian now ends in Italian (2026-08-29)

The brand voice is French and the prompt said « reproduite exactement ». The model obeyed: **all 5 non-French drafts ever written — 3 it, 1 es, 1 en — had a correct foreign-language body and a French sign-off, and all 5 passed their checks**, because the check compared them to the French text and they matched it perfectly. 25 of 400 tickets are not in French.

- **The approved wording is now presented as a source text to translate**, and the framing is what does the work. Measured against the real drafting model: « traduite … ne pas la recopier en français » under a *Signature* heading produced the French verbatim; the same block under `--- source (français) ---` with « il ne doit apparaître nulle part dans la réponse » produced « Cordiali saluti, / Servizio Clienti Qiriness ». Brand names are named as proper nouns and stay put.
- **A `STRUCTURAL_RULES` clause was quietly overriding it.** That block is declared « prioritaires sur tout ce qui précède » and said the approved closer « est la seule autorisée » — the Signature section changed nothing until that rule also distinguished French from a translation.
- **The signature check has three states now**: French compared character for character as before; another language advisory (`null`) with "read it", because a pattern loose enough for seven languages accepts anything; another language *ending in the exact French wording* a real failure. That last one is the reported bug, and it fires.
- **`asks:*` had the same defect** and was made advisory outside French. `ASK_TERMS` is French vocabulary — « numero d'ordine » contains no « commande » — so the first foreign-language question would have been held back for missing words it had no reason to carry. Never hit, only because no non-French draft has been `needs_customer_input` yet.
- **Verified live**: Italian closes « Cordiali saluti, / Servizio Clienti Qiriness », English closes « Best regards, / Customer Service Qiriness ». No French regression — 6 of 6 sampled French drafts still reproduce the signature exactly, against a historical 1 failure in 87.
- **Per-language approved wording, authored in the dashboard, is the proper fix** and is a brand-voice feature rather than a drafting one. Until it exists the model translates and a human reads it.

## Tracking numbers became links, everywhere a number is shown (2026-08-29)

`TicketDetailPanel`'s Order block was the only place a parcel number was clickable. The same number in the customer's own email, in the draft, and in a rehearsal transcript was text to select and paste into La Poste by hand.

- **Four surfaces now, through one component.** `TrackingText` over `splitTrackingText` in `scripts/lib/tracking-number.mjs` — the email chain, the dropped-mail dialog, the draft, and the test chat transcript. The splitter sits beside the normaliser because matching is by normalised form: Shopify stores `6C20723002488`, Colissimo prints `6C 2072 3002 488`, and a customer pastes either. 14 tests, including that the segments always rebuild the original text exactly.
- **Only where we hold a fulfilment URL**, which is also what `TrackingList` has always done. Guessing the carrier from the number's shape was rejected — 84% Colissimo is a good guess, and a wrong one sends someone to a page saying their parcel does not exist.
- **The valuable case is the ticket with no confirmed order.** `parcelsInText` parses the thread with the agent's own tracking parser and resolves the numbers in one `ov` query against the `orders.tracking_numbers` GIN index. **Measured over 600 inbound messages: 60 quote a tracking-shaped number.** Verified end to end against live data — Colissimo and GLS both link, and a quoted number matching no order we hold correctly stays plain text.
- **The reply names the parcel by number and never carries a URL.** Built the other way round first — given the fulfilment URL, the model pasted seventy characters of carrier URL into the prose, and once wrote « [Suivi Colissimo](https://…) », markdown that nothing renders in a plain-text reply. The number is what `TrackingText` makes clickable, so the URL never needs to be in the text: the draft now reads « le numéro de suivi 6C21108711964 » and the reader clicks the number.
- **`no_web_link` joins `FORBIDDEN_PATTERNS`**, catching a bare URL, a bare host, markdown and an HTML anchor. Nothing in a case file is a URL, so any link in a draft is invented. **Measured first: of 92 stored drafts, zero contain one** — it forbids nothing the drafting has ever done.
- **Verified end to end on a live rehearsal.** The order tool's answer reads « Suivi : 6C21108711964 (COLISSIMO). » with no URL anywhere in the transcript text, and both that number and the one in the draft render as links to La Poste.
- **The test chat's order-facts step was reporting zero.** `summariseOrder` read `context.fulfilments`, a key `buildOrderContext` has never produced, so every transcript ever recorded said "0 shipments" for orders that had one. It now carries the parcels themselves; the field is `parcels`, and the renderer still reads the old `fulfilments` key so opening an old run is not a blank field.

## Reuse this message, in the test chat (2026-08-29)

An opened run's name, subject, body and order number go back into the composer in one click. Changing one word and running again meant retyping the whole message.

- **The address is deliberately not restored.** `agent_test_runs` stores `requester_email_masked` and neither the plaintext nor a hash (08_testing.sql), so there is nothing to restore. The notice above the composer says which mask it was and why the field is empty — a rerun that silently dropped the identity would resolve no customer and no order, and the transcript would read as a regression in the agent rather than a missing input.

## The test chat's order number was written in the one form the parser rejects (2026-08-29)

The rehearsal appends a typed order number to the message body rather than stamping it on the ticket, so `shopifyOrderCandidates` has to find it exactly as it would in real mail. It appended it as `Ma commande : 6513` — and that parses to **nothing**.

- **The colon breaks the one adjacency the parser needs.** A bare number is never a candidate by design; it counts only behind `#`, or directly behind `commande`/`order` (`/\b(?:commande|order)\s+(?:n[°ºo]\s*)?(\d{3,10})\b/`). `\s+` does not match `` : ``, so the number the operator typed into the field never reached the resolver.
- **It reads as a drafting failure and is not one.** `order_resolution` recorded `no_candidate` / "No order number in the message", `getOrderContext` answered « Aucune commande confirmée », the case file carried `order_unconfirmed`, and the run escalated. Every pass behaved correctly for a ticket with no order — the ticket only looked like one because the harness lost the number on the way in.
- **Only runs where the operator typed the `#` themselves ever worked.** Across eight runs on 2026-08-29: `6513`, `6257`, `4406` → `no_candidate`; `#6257`, `#4406` → parsed and looked up. Nobody could have known which half they were in from the transcript.
- **The unit test always passed `#1006`**, so the bare form was never exercised. The new test builds a body from both forms and asserts the real parser finds the order in each — the contract that was actually missing, since appending the number is only half of it.
- **Fixed in `ORDER_LINE` and not in the parser.** The parser's strictness is a measured decision (French support mail is full of numbers that are not orders); the harness was the side writing an order number in a shape the corpus does not use. `#` is added when the operator omits it — 1152 messages write it that way against 225 spelled out.
- **Verified on the case that found it.** Same inputs re-run through the test chat: `order_resolution` now returns `confirmed #6513`, `verifiedBy=email`, the order context builds, `getOrderContext` answers `found`, and the draft names the order. The verdict stays `needs_human` for a new and real reason — the return address is not in the knowledge library — which is the finding the run was trying to make in the first place.

## The order passes moved ahead of the investigation (2026-08-22)

The poll ran `categorise → investigate → orders → context`. `getOrderContext` is a **reader** — it returns what the order passes stored on the ticket and never queries for itself — so on the first message of every thread the investigation ran against an empty `resolved_context` and could not see an order however clearly the customer had quoted its number.

- **Found by the test chat on its first real use**, which is the strongest thing that can be said for the harness. Order `#5144`, quoted in the message, registered to the sender's own address: `getOrderContext` answered « aucune commande confirmée », the case file recorded the order as *unverified*, the verdict came out `needs_human` — and then the resolver confirmed it `verifiedBy=email` and built the bundle. The deterministic check had the answer with certainty; the expensive one had already written the conclusion.
- **The failure was invisible by construction.** Every step behaved correctly in isolation: the tool reported what it saw, the model refused to assert an unverified claim, the ticket went to a person. Nothing anywhere said the answer was in the database the whole time.
- **Sized before fixing.** 60 case files on order-family tickets: 24 investigated with the order in hand, 35 blind with no order number to know (correct), **1** blind while the order was known. The backlog escaped because it was ingested in bulk and the passes ran repeatedly, so most tickets were investigated a cycle after their order resolved. For live mail, where one poll does everything, every first email quoting a number would have hit it.
- **New order: `customers → categorise → orders → context → investigate → forward → close`.** After categorisation rather than before it, deliberately: the only constraint is "before the pass that reads its output", and moving further would have changed what `--stop-after=categorise` runs — the documented cheap corpus-building path. `--stop-after=orders` changed meaning instead (it now stops before the investigation), which nothing uses.
- **Two dormant escalation rules woke up.** A parcel in transit with no scan for 10+ days, and a carrier reporting *delivered* on a `delivery/problem` ticket, both raise to level 3. Neither could fire on a first message while the order context was always null. Both cap at 3, so nothing is newly blocked from drafting.
- **`agent/src/poll-order.test.mjs` is the guard**, and its absence is why this drifted: the order was documented as load-bearing and asserted nowhere. It checks what the stage list *declares*, what the poll body *does*, and that the two agree — verified to fail against the old ordering before being kept.
- **The rehearsal harness was reordered to match**, or the test chat would have stopped mirroring the worker the moment the worker changed. Its own ordering assertions moved with it.
- **Verified on the case that found it.** Same email, same customer, re-run through the test
  chat: `getOrderContext` now answers `found` with the order, the tracking number and the
  carrier; the case file moves from `needs_human` with nothing established to `answerable`
  with four established facts; and the output moves from a handoff reading « vérifier
  manuellement la commande #5144 » to a customer-ready reply quoting the tracking number.
  ~$0.014 a run.
- **A bug in the test chat's own stream, found by running it from the command line.** The
  route wrote `{ type: "step", ...event }`, and a trace event carries its own `type` — so the
  spread overwrote the envelope, the client matched nothing, and every step was dropped in
  silence while the run itself worked. The envelope is now `stream` with the payload nested,
  a key that cannot collide.
- Suites green: 1724 root, 1082 agent.

## Agent test chat: a rehearsal of the whole pipeline, writing no ticket (2026-08-22)

The **Test the agent** button on `/agent-setup` (the header slot that rendered a dead "View agent preview") opens a chat. A message you write goes through the gate, identity, categorisation, investigation with real tools, order resolution and context, and drafting — and the transcript shows every tool call, the exact French text each one returned, every model call's prompt and response, and the reply.

- **It fakes the database, not the passes.** `createTicketRecord` and `createDraftRecord` already took their PostgREST calls as an injectable `transport`; `agent/src/testing/memory-transport.mjs` fakes the DATABASE and the real records run over it unmodified. So every claim filter, flag transition and metadata trail in a rehearsal is the worker's own code, not a second implementation of it. `memory-transport.test.mjs` drives a whole claim → complete → claim cycle through the real record: that test is what the feature rests on. `createCaseFileStore` gained the same `transport` parameter — it was the one store still calling `supabaseUpsert` directly.
- **Nothing is written to `tickets`, `ticket_messages`, `ticket_investigations` or `ticket_drafts`**, so the queue, the `/tickets`–`/conversations` partition, auto-close, forwarding and all 21 Insights views are untouched by a test. The alternative — real rows behind `tickets.is_test` — was rejected: one missed filter puts an invented customer in front of a human.
- **Five additive observability changes, all defaulting to today's behaviour**: `onToolCall` on the investigator (the whole ledger entry, including the `promptText` the model read), pre-built `openai`/`embeddingsClient` on `createInvestigationStack`, a decorator around the OpenAI client that records what was actually sent, `summariseMatches` returning `candidates` (the whole ranking beside the banded `chunks`, in `data`, which the model never sees), and the `transport` on the case-file store.
- **The poll's order is copied verbatim, including its one surprise.** Order context is built AFTER the investigation, so a first message is always investigated without order facts and the DRAFT is the first pass that sees them. The transcript says so rather than leaving somebody to file it as a bug.
- **Identity is fields, the order number is not.** Name and address stand in for the envelope (no parser in production reads an address out of a body); a typed order number is appended to the message so `shopifyOrderCandidates` has to find it exactly as it would live.
- **Gate 2 runs first and stops the run** when it would have dropped the message, with a *Run it anyway* override. "This would never have become a ticket" is the finding.
- **Testing a knowledge article** — from the article's own rail — asks one more question and answers it five ways: `used` / `retrieved_withheld` / `outranked` / `not_retrieved` / `not_searched`. Readiness (approved, chunked, embedded) is checked before any model call. `not_searched` is the one people will not expect: `allowedTools` gives `searchKnowledge` to five subjects, so a message that lands on `delivery` cannot reach the library at all.
- **New `08_testing.sql` → `agent_test_runs`**, taking the baseline to eight files. It references no ticket, message, investigation or draft — a rehearsal writes none — and keeps only the MASK of the address, not the plaintext and not a hash. `trace` jsonb is the record; the flat columns beside it index it so the history list never parses one.
- **`ideal_body_text` is the memory.** What you would have sent instead, typed in the same view that showed you the draft: the invented-situation twin of `ticket_draft_edits`, so a gap can be written down before a customer hits it. Nothing reads it yet, and the UI says so.
- **Cost is reported on the run and deliberately kept out of `llm_usage`**, whose `pass` constraint admits only the worker's passes and whose figures answer what handling the real mailbox costs. The trade is stated: test spend is invisible to Insights and visible in the tool that spent it.
- 59 new unit tests, including a smoke test that **executes the orchestrator** against a stubbed
  `fetch` and a scripted model: it asserts the poll order, that a gate block ends the run, that a
  model failure is absorbed by the pass rather than failing the run, and that no row is created in
  the support schema. Whole suite green: 1718 root, 1076 agent. Web typecheck, lint and build clean.
- **`08_testing.sql` applied 2026-08-22 and verified against the database**, not read: 30 columns,
  14 checks and 2 foreign keys, 3 indexes, RLS on with no policies, the `updated_at` trigger firing,
  and a round trip in which all four of the interesting constraints refused a bad row.

## Re-delivery is no longer treated as arrival — the reopen rule is idempotent (2026-08-20)

A delta re-enumeration used to undo the corpus's own history. Ingestion's message
upsert is idempotent; the two ticket state changes beside it were not, so every
inbound message the writer saw counted as "the customer wrote back" — including
mail that had been in the database for days.

**Measured, on the run that exposed it.** Of 139 tickets auto-closed for
inactivity, **136 returned to `open` with `closed_at` nulled**: 10 from a
genuinely new message, **128 from a message already stored**. The same fault
re-raised `needs_categorisation` on **374 of 400** tickets. It then cascaded —
`shouldAutoClose` refuses a ticket still flagged, so the Closed section could not
be rebuilt until the entire corpus had been re-categorised first.

**The fix.** `knownMessageIds` asks once per page which Graph ids the shop
already holds; only `needs_categorisation` and the status reopen consult it.
Everything else in that branch is untouched **because it is already
idempotent** — the message window is a min/max, the subject fills a null, and the
requester backfill is a repair that a re-sync *should* re-run.

- **Fails open.** A failed lookup returns an empty set, every message reads as
  new, and the old behaviour returns. The opposite default would silently drop
  the reopen for a real reply and strand a live ticket in `closed`.
- **One query per page**, chunked at 100 ids because the filter rides in the URL
  and Graph ids are ~150 characters each. A full enumeration must not become a
  round trip per email.
- **Optional by contract**: a store without the method behaves exactly as before,
  so no existing caller changes.

5 regression tests over the measured failure. Suites: **1629** from the repo
root, **1017** in `agent/`.

**Not repaired by the code fix**: the 136 tickets already reopened, and their
lost `closed_at`. That was a separate, ordered data repair, **run 2026-08-21 on
the owner's instruction**: the categorisation queue drained (371 → 0; 155 first
reads, 202 re-reads, 14 skipped, 0 failed, $0.22), which cleared the
`needs_categorisation` exemption, then `tickets:autoclose` closed **327 of 329,
2 exempt, 0 failed**. Sections went Backlog ~355 → 41 and Closed 3 → 319.

Two consequences are carried in `VALIDATION_LOG.md` item 11b rather than being
treated as settled: every one of the 327 carries `closed_at` of the repair date,
and 313 of the 357 tickets flagged `needs_investigation` are now behind a closed
status, reachable only via `--include-closed`. The investigation queue was not
run. The corpus also gained its **first two level 4 tickets**, both open, both
exempt from auto-close, and both unreviewed.

---

## Categorisation gained `--ticket`, and 22 tickets were run categorise → draft (2026-08-20)

### `runCategorisation` takes a `ticketId`

`record.claim` has supported naming one ticket since the investigation pass
needed it; the categoriser was the one flag-driven pass that never passed the
argument through. It does now — and it **narrows rather than bypasses**: the
pending flag, the status filter and the soft-delete filter all still apply, so
naming a ticket that is not due returns nothing.

**Why it was needed today, which is the general case.** The claim is oldest-first
over a corpus that keeps gaining *older* mail. A backlog ingest put ~200 tickets
from February–April in front of the 22 recent ones somebody actually wanted read,
so categorising those 22 through the queue meant paying for everything ahead of
them first. One test asserts the filter reaches the transport with the queue
filters intact.

### The run, end to end

22 uncategorised tickets, named explicitly rather than claimed from the queue:

| Pass | Result |
|---|---|
| **Categorise** | 22/22, **0 failed, 0 fallbacks**. L1 ×1 · L2 ×13 · L3 ×8, no L4 |
| **Order number** *(deterministic)* | 331 considered → 26 confirmed · 9 mismatch · 18 not_found · 276 no_candidate |
| **Order context** *(deterministic)* | 26 considered, **26 resolved**, 0 order_missing |
| **Investigate** | 10 investigated, **12 skipped** (subjects the registry gives no tools), 0 failed |
| **Draft** | **10/10 drafted**, 0 skipped, 0 failed, **10/10 mechanical checks passed** |

Verdicts drafted: `needs_customer_input` 6 · `needs_human` 3 · `answerable` 1.
Disposition **9 intermediary / 1 terminal**; 2 auto-send eligible and inert under
`DRAFT_ONLY`. One reply was written in **Italian** off an Italian email
(*Mancata consegna*) — the language is read from the thread, not defaulted.

**Whole run: $0.21 over 73 calls** — investigate $0.126, draft $0.072,
categorise $0.010, decompose $0.002. Costed from `llm_usage` through
`llm-rates.mjs`, which is the first end-to-end run priced from the ledger rather
than estimated. Note the shape: **drafting cost 7× categorisation** and the
mid-tier passes are ~95% of the bill.

### What the run exposed

**Six of ten case files came back with 0 established facts** (corpus norm: 12 in
80), because customer resolution had never run on those tickets — the poll died
before its `customers` stage. Four of the five unattempted turned out to be
genuine `no_match`, so one ticket was actually affected. **The near-miss is the
finding**, and it is `VALIDATION_LOG.md` item 11b: a pass that dies leaves no
marker, so "never attempted" and "attempted, found nothing" are only
distinguishable by a `metadata` key being absent.

---

## "Add as ticket" writes: a dropped email can be overturned into the queue (2026-08-19)

The Irrelevant section's button has been disabled since it was drawn. It now
promotes one `spam_audit` row into a real ticket, and the agent reads it on its
next poll. **Built and unit-tested; not yet clicked against the live database —
`VALIDATION_LOG.md` item 0b.**

### The blocker was gone and nobody had noticed

It waited on the agent re-fetching the message from Graph, which the mailbox-id
mismatch blocks. That requirement existed only because the body was not stored —
and it has been since `spam_audit` started keeping it. Measured on the live
project: **all 49 blocked rows carry a body and a conversation id**, which is
everything `ticket_messages` is written from. The Graph round trip buys nothing
that is not already in hand.

### It writes through ingestion, not around it

`agent/src/ingestion/promote-dropped-mail.mjs` owns exactly one thing: turning a
`spam_audit` row into the shape `mapGraphMessage` produces. The write itself is
`writeIngestedMessages`, so threading on `conversationId`, idempotency on
`(shop_id, graph_message_id)`, the message window, `needs_categorisation`, the
reopen rule and the requester backfill are ingestion's rules and not a second
copy of them. **2 of the 49 belong to a conversation that already has a ticket**
— the blocklist matches senders, including on replies into live threads — so
joining an existing ticket is a normal outcome, not an edge case, and is one of
the 12 tests.

**The workflow is applied by ticket state, not by the click.** Nothing new was
needed to make the agent pick it up: every pass drains a queue defined by state
rather than by what the poll just wrote, so `needs_categorisation` is the whole
handover. Next poll (60 s) it is categorised, its customer resolved, then
investigated, order number resolved and context bundle built. Drafting stays its
own pass.

### No schema change, and the audit row is never touched

No `promoted_at` column, for two reasons that agree: one is an `alter table … add
column` by hand on a populated table (what the drafting queue avoided by deriving
`withoutDrafts()`), and `spam_audit` records what the **gate** decided — rewriting
it to say a person disagreed edits the audit trail instead of adding to it.
Promoted is derived: a blocked row whose `graph_message_id` now exists in
`ticket_messages`. One `in.()` query over 49 rows, and it cannot disagree with
itself. Provenance travels on the new message
(`raw_graph_payload -> promotedFromSpamAudit`), never a second copy of the body.

### What it deliberately does not do

- **No triage.** A person overruling the gate is the decision; asking the gate
  again asks the thing that was just overruled.
- **No duplicate detection.** A duplicate link takes a ticket out of the drafting
  queue, so a wrong link on a hand-promoted email answers nobody.
- **Nothing about the sender.** No blocklist edit, no `sender_directory` row — the
  next email from that address is dropped again, and both surfaces say so rather
  than letting an operator infer they have fixed the gate.
- **No promotion without a body.** Never-captured and captured-then-expired are
  one answer: the agent reads bodies. The button is disabled for the same reason
  the write refuses, so no offered action can fail when used.

### The surface

`POST /api/dropped-mail/:id/promote` → `dropped-mail-service.ts`. The action is on
the row and in the dropped-mail dialog — the dialog is where the body is read, so
it is where the question is actually answered. The promoted ticket comes back in
the list's **own** projection (`getTicketListItem`, off `ticket_queue`), so it
joins the queue complete rather than as a thinner row than the ones beside it,
and a promoted own-side thread is not added to /tickets at all because that
partition is the server's.

Suites: **1623** from the repo root, **1011** in `agent/`. `tsc --noEmit`,
`next lint` and `next build` clean.

---

## Deduplication, Phase C: semantic matching measured, and deliberately not built (2026-08-19)

Phase C was specified as "measure, then decide". Measured — **decision is not to
build it**, and the measurement is worth keeping because the tier is an obvious
thing to re-propose.

No new code was needed: every ticket message is already embedded, so all 124
sender pairs inside 30 days were scored with `<=>` directly.

### The false positives score higher than the true positives

| | Similarity |
|---|---|
| Genuine split conversations | 0.795 · 0.893 · 0.928 |
| B2B reorder POs — separate weekly transactions | 0.996 – 0.998 |
| Partner delayed-order reports — separate reports | 0.996 |

A threshold at 0.95 catches **none** of the real ones and **all thirteen** B2B
POs. Embeddings measure wording; duplication is about identity. A split
conversation is one person writing *different* text twice; a repeated business
process is *different* transactions in identical wording.

### The finding that settles it: duplicate versus chase

Of the pairs inside 30 days, **12 have byte-identical text and only 2 are
duplicates**:

| | |
|---|---|
| Identical text, within the hour → duplicate | **2** |
| Identical text, hours or days later → **chase** | **10** |

An embedding scores all twelve at ~1.0. Only elapsed time separates them, and
they need **opposite** treatment: suppress a duplicate, and answer a chase *with
an apology for the delay*. A similarity-linked tier would have silenced ten
customers who were already waiting and had written again.

**Phase B's hour-long window is therefore not a tuning parameter but the entire
discrimination** — right for a reason the embeddings made visible rather than
despite them.

Split conversations remain the reply chain's job (Phase A/B), which cannot be
evaluated yet because the headers predate their capture. That is a reason to
wait for data, not to reach for similarity.

---

## A duplicate is visible on the dashboard (2026-08-19)

The link existed and nothing showed it: a reviewer opened a linked ticket, saw a
draft, and had no way to know the agent had already refused to write a new one.

- **A `Duplicate` chip on the row**, so somebody working the queue knows before
  opening it. A boolean on the list, not the linked id — which ticket it
  duplicates is a question answered by opening it.
- **A banner in the thread dialog, ABOVE the heading.** If the ticket is a
  duplicate the whole draft section is something not to act on, and a warning
  underneath the reply arrives after the reader has decided it looks fine. It
  names the reason in plain words and says where to answer instead.
- Both on the **warning** ramp rather than the error one: a duplicate is not a
  fault, it is a row not to work.

`ticket_queue` gained `duplicate_of_ticket_id` and `duplicate_reason` (view
recreated on the live project from the baseline definition), and
`record.findSubject` became `findForThread` — it now carries the link, because
the dialog is where somebody decides to send.

Suites: **1552** root, **940** agent.

---

## Deduplication, Phase B: two deterministic rules, and the drafting queue obeys them (2026-08-19)

Detection runs at ingestion, links rather than merges, and **2 real duplicates
in the corpus are now linked**.

### The rules

- **Reply chain** — `In-Reply-To` / `References` naming a Message-ID we already
  store. The strongest evidence there is: the sending client stating which
  conversation this belongs to. No time window.
- **Double-post** — identical text from one sender within an hour. The window is
  the whole rule: the same text three days later is a chase, owed an apology
  rather than silence.
- **Not a rule: sender + quoted order number.** A customer may legitimately open
  a delivery ticket and then a refund ticket about one order, and linking those
  would silence the second.

No model, no embedding. A hit means a ticket is skipped by drafting, and a
customer wrongly skipped gets no reply at all.

### Replayed over the corpus before being trusted

203 ticket-opening messages against the live candidate pool: **2 links, both
verified by hand** — Bavita NOBIN (1 second apart) and Christine Alexandre
(32 seconds apart), each two Message-IDs under two Graph conversation ids.
**Zero false positives.** Zero `reply_chain` hits, which is expected: the stored
corpus predates header capture, so that rule only fires on mail from now on.

### What the link does

`tickets.duplicate_of_ticket_id` + `duplicate_reason` + `duplicate_detected_at`,
moving together by check constraint — a link with no reason is unreviewable.
A ticket cannot be its own duplicate.

**The drafting queue skips a linked ticket**, which is the harm being prevented:
one customer, two replies. Verified on the linked Bavita ticket —
`skippedBy: { duplicate: 1 }`, no model call spent. The skip is counted rather
than filtered in the query, so anybody can see the detection firing, or firing
too much.

Both existing pairs linked (later → earlier). Ingestion never fails on a
duplicate check: a missed link costs a second reply somebody notices, a failed
ingestion loses the email.

Suites: **1551** root, **940** agent.

---

## Deduplication, Phase A: the reply chain is captured (2026-08-19)

Groundwork only — **nothing detects a duplicate yet**. What changed is that
ingestion now keeps the two headers any detection will need, because a header
not requested at ingestion cannot be recovered afterwards.

### What the corpus actually contains

| | |
|---|---|
| Inbound messages | 296, **all** with an `internet_message_id` |
| Same Message-ID in two tickets | **0** |
| Identical body across tickets | 12 clusters |
| Sender pairs within 30 days | **72** (48 same category) |
| Sender pairs beyond 30 days | **0** |

**Two problems, not one.** A true double-post exists and is rare — Bavita
NOBIN, identical body **one second apart**, two Message-IDs, two conversation
ids. The common and more damaging shape is a **split conversation**: contact-form
ticket plus the customer's emailed reply under a different `conversationId`,
investigated twice and answered twice.

**Message-ID detects neither**, despite being fully populated: a double-post gets
two of them, and a split thread is genuinely two emails.

### `in_reply_to` + `reference_ids`

- The column `in_reply_to` **already existed and was always null** — declared
  when `ticket_messages` was written, never filled, because the header was never
  fetched. `reference_ids text[]` is new, plus a partial index on
  `(shop_id, internet_message_id)` for the lookup.
- Graph has no `inReplyTo` property, so the delta `$select` now asks for
  `internetMessageHeaders`. **Only In-Reply-To and References survive the
  mapper**; a test asserts relay IPs and DKIM never reach `raw_graph_payload`.
- Headers are read **case-insensitively** and References is parsed to a
  deduplicated id list with the angle brackets kept, so a match against
  `internet_message_id` is a plain string comparison.

**Verified against the live Graph API**, not assumed: delta does return the
header set (51–68 headers per message), at ~**10 KB per message** in transit.
Ongoing that is per *new* email, not per stored one. **46% of stored inbound
messages have a reply-style subject**, so the chain will be present often enough
to earn the bytes.

Schema forward-applied; 451 existing rows defaulted to `{}`.

### Corrections to the proposed strategy, from the data

- **Candidate pool keys on the sender hash, not `customer_id`** — 145 of 214
  tickets carry a customer, 203 carry a hash, so gating on the customer misses
  **24%** of pairs.
- **30 days is a real boundary**, not a guess: zero pairs fall outside it.
- **Closed tickets must stay in the pool.** 51 of the 72 priors are already
  closed or resolved, because auto-close retires a thread after 28 days.
- **Link, never merge**, when detection lands: a wrong merge is unrecoverable, a
  wrong link is a column.

Suites: **1535** root, **924** agent.

---

## A reviewer can edit a draft, and the edit is recorded to learn from (2026-08-19)

Approve / Edit / Reject in the thread dialog, and every edit appended to a new
`ticket_draft_edits` table.

### The edit log exists because the two columns on the draft row are not a pair

`ticket_drafts` already holds `body_text` (the model's) beside
`approved_body_text` (a person's rewrite), and that is right for review. It is
wrong as a learning signal: **a re-draft replaces `body_text` and deliberately
leaves `approved_body_text` alone**, so the two stop being a pair the moment the
agent revises something a person had already corrected. Read later they still
look like one — the agent's second attempt beside a human's correction of the
first, a pair that never existed.

So each edit is recorded as it happens with the model text **copied in beside
it**. Verified live: after an edit and then a re-draft,
`edit.model_body_text` still held the text that was corrected while
`ticket_drafts.body_text` had moved on.

- **Append-only** — a reviewer who edits, sends, and edits again on the next
  inbound message leaves two rows. "What do people keep changing" is a question
  about repetition.
- **An edit that changed nothing is refused**, by check constraint and by the
  record module. Whitespace-only differences are not edits, and a row implying
  the agent's text needed correcting into itself is the most misleading training
  pair available.
- **`source` already accepts `mailbox`**, so editing a review copy in Outlook
  needs no migration when that path is built.
- **`edited_by` is null on every row** and stays null until the dashboard has
  authentication. The column exists because a signal that cannot tell two
  reviewers apart is weaker; nothing can fill it yet.
- **Nothing reads it.** Phase 7 memory is the consumer. Capture had to start
  first — same argument as `auto_send_eligible`.

### The dialog

Read first, edit second: the textarea is opt-in, seeded from the reviewer's own
version when one exists so editing an edit continues rather than restarting from
the agent's text. Three outcomes and no fourth — nothing here can send.

`PATCH /api/tickets/[id]/draft` -> `decideOnDraft` -> `draft-record.decide`.

Suites: **1530** root, **919** agent.

---

## The last-order candidate stops being a tool, so product tickets get it too (2026-08-19)

The candidate was fetched in `getOrderContext`'s unresolved branch, which meant
two things went wrong for the subjects that need it most: it only ran when the
model chose to call that tool, and **`product` has no order tool in
`allowedTools` at all** — so product tickets never got one.

**The obvious fix would have caused the failure the request warned about.**
Adding `GET_ORDER_CONTEXT` to `product` and `return_exchange` puts an order tool
in front of the model on tickets that are not about an order, and a model shown
an order tool starts asking customers for order numbers.

### So it is no longer a tool

`lastOrderLookup` moved out of the registry onto the investigation stack. The
model cannot call it, is never told it ran, and never sees its result. The runner
calls it **after the case file is complete**, so it cannot touch the verdict or
`missing`.

- **Conditions are properties of the ticket** — no `shopify_order_number`, a
  linked `customer_id` — not of which tools the model happened to pick.
- `buildCaseFile` now takes `candidateOrder` as an input instead of deriving it
  from the ledger; `deriveCandidateOrder` is gone.
- A failed lookup logs and leaves the field empty: a lead is never worth losing a
  case file for.

**Verified on a live `product` ticket**: candidate `#6074`, `FULFILLED`, placed
15 June, two items, Colissimo `6C20980980642` — while `missing` stayed
`["product_name"]` and the tools the model ran were `lookupProduct`,
`searchKnowledge`, `lookupProduct`. **No order tool offered, no order number
demanded.**

**Empty is often correct.** A `return_exchange` ticket with a linked customer
returned nothing because that customer has zero orders — the `known_no_orders`
state, a newsletter signup or an address given in a shop.

Suites: **1520** root, **916** agent.

---

## A customer who had to write twice is apologised to (2026-08-19)

A general drafting rule, and the measurement decided how to implement it. Across
the 81 drafted tickets: **12 threads hold consecutive inbound messages with no
reply between them** — a chase we can prove — while only **4** say so in words,
overlapping on 2. A prompt instruction alone would have missed 10; thread
structure alone would have missed 2. So it is both.

- **`describesChase`** reads the thread's ENVELOPES — `direction`,
  `received_at`, `sent_at`, no bodies — and reports the longest run of inbound
  messages with nothing sent back. Consecutive, not a count: a customer
  answering our question is a normal exchange, not a chase.
- **The fact reaches the prompt** as « Le client a écrit N fois sans avoir reçu
  de réponse de notre part. » The rule that says what to do about it is a
  general rule in the system prompt, so it also covers the cases only the
  customer's own words reveal.
- **The apology is for OUR delay**, one sentence, opening the reply, without
  justifying it — and apologising for the delay is explicitly not conceding the
  substance of the case.
- **`apologises_for_delay`** is narrower than the rule by design: it fires only
  where the thread proves the chase, because a check has to rest on something
  checkable.

**Result: 10 of 12 chased drafts now apologise**, and the 2 that do not are
flagged rather than shipped.

**The check was wrong once, and the corpus caught it.** The first pattern matched
French only and failed an Italian draft opening « Ci scusiamo per il ritardo
nella risposta » — a correct reply marked wrong, which is how a check earns
being ignored. It now covers all four languages the corpus drafts in (fr 77 ·
it 2 · es 1 · en 1).

Suites: **1521** root, **916** agent.

---

## « Aucun scan transporteur » was reaching customers, and it is a fact about us (2026-08-19)

Found by review of a draft. `toOrderContextText` rendered a dispatched parcel to
the model as « expédiée, mais aucun scan transporteur pour le moment ».
Everything in that projection is presented as established, so the model treated
it as one.

**Measured before the fix: 17 of 82 case files held it as an ESTABLISHED fact,
and 8 of 81 drafts said it to the customer** — several naming the carrier:

> « il n’y a pas encore de scan de suivi disponible de la part de Colissimo »
> « nous n’avons pas de confirmation de livraison de la part de GLS, car aucun
> scan transporteur n’est disponible »

**Wrong twice.** No carrier feeds scan events into Shopify for this store
(`delivered_at` on 1 order in 2 006, `in_transit_at` on none), so it blamed
Colissimo and GLS for a gap in our own integration — and it implied a stuck
parcel where there is only an absent feed.

### Fixed at the source, not at the output

- **The model is told what is true**: dispatched, and how many days ago.
- **What we cannot see is a PROHIBITION**, `delivery_unscanned`, which
  deliberately does not explain itself — writing "no carrier scan is available"
  inside a `do_not_claim` line is still writing it where the model can read and
  paraphrase it, which is what happened before.
- **`no_carrier_scan_wording`** refuses that vocabulary on **every** reply,
  caveat or not: it describes our integration and is not the customer's business
  on any ticket.
- `signals.awaitingCarrierScan` still carries it for the dashboard and the human
  brief — internal audiences.

### Regenerated

17 tickets re-investigated and re-drafted. **0 case files still claim it, 0
drafts still mention it**, and 17 now carry the prohibition instead. Checks stand
at 75/81 — lower than the previous 78 because re-investigation moved some
verdicts, and the new failures are the checks working, including one draft caught
saying « le suivi indique » by the new prohibition.

Suites: **1512** root, **908** agent.

---

## The last-order candidate becomes a full bundle, in the order tool's own fallback (2026-08-19)

Three corrections to the entry below, all from review.

### The ordering is now structural, not a rule

The candidate was derived from `verifyPurchase`. It is now fetched in
**`getOrderContext`'s unresolved branch** — so it runs only after the order
lookup, only when that lookup confirmed nothing, and costs no extra tool call.
There is no arrangement of the loop in which a confirmed order and a candidate
both appear: the duplication is *unreachable* rather than forbidden.

### It carries what a reviewer actually needs

`verifyPurchase` reads three columns (`name,processed_at,line_items`) because its
job is product matching. The candidate now comes from `buildOrderContext` with
the full order projection, so it holds **order number, status, items, tracking
and delivery state** — the same shape as a confirmed order, from the same
builder.

The dashboard therefore renders it with the projection it already has, under
different headings: **Last order · Last order status · Last order items · Last
order tracking · Last order delivery**, above a line saying the customer gave no
number so this may not be the order they mean. `TicketOrderFacts` gained `items`
for it; the confirmed block does not render them, because there the order is
already known to be the right one.

Verified on the ticket that prompted this: **#6576**, `FULFILLED`/`PAID`, six
items, Colissimo **6C21109130351**, dispatched, placed 21 July — against a
customer writing about "une commande fin juillet".

**The tracking number is a link, and the two blocks now share one renderer.**
The last-order markup was written by hand rather than reused, and the copy
dropped the carrier link — so the candidate showed a bare number a reviewer had
to paste into La Poste themselves. `TrackingList` is now one component used by
both blocks: the drift two copies of a rendering produce is exactly why it is a
component.

### It changes no decision, and the verdict flip was not it

Asked directly, and worth stating plainly: `candidate_order` is derived in
`buildCaseFile` **after** the verdict is settled and is read by nothing in the
investigation loop. A test now asserts that the same model answer with and
without a candidate yields the same verdict and the same `missing`.

**The observed change from `needs_customer_input` to `needs_human` was the
investigation model varying between runs**, measured three times on one ticket
— including once before the field existed: `needs_customer_input`/missing=1,
then `needs_human`/missing=1, then `needs_human`/missing=0. That instability is
real and is tracked separately; it is not caused by this field.

End to end: the drafted reply for that ticket contains no order number and no
tracking number.

Suites: **1509** root, **905** agent.

---

## The last-order search had already run, and its answer was being thrown away (2026-08-19)

Found from one real ticket: Cathy Faure writes « je vous ai passé une commande
fin juillet », gives no order number, `getOrderContext` resolves nothing, and the
ticket goes to a person — who opens Shopify and searches for her most recent
order by hand.

**That search had already run.** `verifyPurchase` fetches the last order to
cross-check the product a customer describes, and the registry already put its
name in the ledger's `data`. `buildCaseFile` then mapped the ledger to
`{id, tool, argsHash, outcome}` and dropped it. Every ticket of this shape paid
for the lookup and discarded the result.

### `ticket_investigations.candidate_order`

- **Derived in code from the ledger**, like `deriveDoNotClaim` — never
  model-authored.
- **Internal by construction.** Rendered in `toHumanBrief` and in the dashboard's
  Action block; **absent** from `toDraftingPrompt` and from
  `investigationForDrafting`. A test asserts the absence rather than trusting the
  renderer. The customer named no order, so the number may be the wrong one, and
  quoting the wrong order number at a customer is worse than quoting none.
- **Empty when an order was confirmed** — the bundle already says everything it
  could, and a second candidate would invite the reader to wonder which is real.
- **Shown apart from the findings**, captioned by what the product cross-check
  concluded: "contains the product they describe" and "the product is not in it"
  are different confidences in the same number.

Verified on Cathy's ticket: **#6576**, six products, `not_in_last_order`. That is
the order a reviewer would otherwise have gone and found.

Schema applied forward to the live table (the fourth alteration; clause extracted
from `04_support.sql`, one transaction, 81 existing rows defaulted to `{}`).

### `npm run investigate -- --ticket <id>`

Needed to prove the above: the investigation queue is oldest-first, and 109
imported tickets carry a flag no poll can reach, so re-running one recent ticket
meant paying for everything ahead of it. `record.claim(pass, { ticketId })`
**narrows the queue and never bypasses it** — the pass's flag and `where` still
apply, so naming a ticket that is not due returns nothing rather than running it
anyway. That keeps it an operator convenience, not a second way into a pass.

Suites: **1508** root, **904** agent.

---

## The closing line is approved rather than forbidden (2026-08-19)

A correction to the same day's entry below. The advisory added there recorded
that **31 of 81** drafts ended with an invented courtesy line, and read that as
the model doing something it had been told not to. It was the model filling a
real gap: « N’hésitez pas à revenir vers nous si vous avez d’autres questions »
is worth saying, and on an `answerable` reply it is the exact caveat the intent
rules ask for. Nobody had approved a wording, so it wrote a new one every time.

- **`closingLine` joins `signature`** as a stored, editable field on the Brand
  voice page, seeded with that sentence, reproduced verbatim in the prompt just
  above the signature. Clearing the box means no closing line at all.
- **Same mechanism as the signature, because the mechanism is proven** — the
  signature check passes 81/81, so a verbatim block plus an exact check is
  reliable enough not to need code that appends it after the fact.
- **`closing_line`** is a real check: the approved wording must be present.
- **`empty_closer` stays advisory** and now runs against the text **with the
  approved line removed**, so what it reports is a *second*, invented closer.
  Without that removal, approving a wording would have flagged every draft that
  used it. It also now recognises « n’hésitez pas à revenir vers nous », the
  variant the brand voice names and the old pattern missed.
- The structural rule flipped from "do not end with a courtesy formula" to "do
  not invent one — the approved closing line is the only one allowed".

**The advisory strips every approved block, not just the new field.** The live
brand-voice row already carried the sentence inside `signature` — written there
before a Closing line field existed — so scanning only for the new field would
have flagged an approved sentence as invented on every draft. Text a person
approved is not text a model invented, whichever field it was approved in, so
both are removed before the scan. Either arrangement works; keeping them in
separate fields is tidier but nothing forces it.

**No re-draft.** The existing 81 keep their text; this takes effect on the next
drafting run. Suites: **1502** root, **899** agent.

---

## The drafting behaviour is now three real behaviours, not one with a mute button (2026-08-19)

**The acknowledgement was generic because it was told to be.** It was instructed
to resolve nothing and to stay inside three or four sentences, and it obeyed: 49
drafts saying « votre demande est en cours de traitement », written from case
files that held the product, its two-year warranty and exactly what could not be
confirmed. The material for a specific reply was already in the prompt — the
instructions forbade using it.

All 81 drafts re-written. **0 of 49 handovers still say « en cours de
traitement ».** Median length by verdict is now 559 / 526 / 565 characters —
a handover carries the same substance as an answer, where before it was 293.

### The three rule sets, rewritten to one shape

Every verdict now **answers what it can first**, and the unresolved part follows
rather than replaces it.

| Verdict | The reply |
| --- | --- |
| `answerable` | Resolve completely; no follow-up question; the customer should have no reason to reply |
| `needs_customer_input` | Explain what is established, say why the missing fact is needed, then ask for exactly that. Never turn the whole reply into a request |
| `needs_human` | Answer what is established, **name the specific point needing a check**, say the team is taking that point |

Nothing was loosened: `established` is still the only source of facts and
`unverified` is still only ever attributed to the customer.

**Reordering alone was not enough, and the measurement is why the rules say more
than the reorder.** Across eight handover drafts only **4 of 24** established
facts reached the reply — "answer what can be answered" reads to a model as
"acknowledge the topic". A rule naming the obligation (*a useful established fact
not passed on is one the customer will have to ask for again*) roughly doubled
it. On the LED-mask ticket that is the difference between a reply that states the
two-year warranty and one that does not.

### Asking is licensed by the case file, not by the verdict

One rule replaced three: **a reply may ask for a fact only if the case file named
it.** It implements « ne pas demander d'information supplémentaire » on an
answer, « demander uniquement cette information » on a question and « ne demander
une information que si le dossier en nomme une » on a handover, because those are
one rule seen from three sides.

It also closes the contradiction flagged on 2026-08-18: `toDraftingPrompt`
renders « À demander au client » whenever `missing` is non-empty regardless of
verdict, so 9 of 49 handovers were handed a question to ask *and* told never to
ask. All 9 resolved the safe way, which was luck. A named field now licenses the
question and the check scores which fact was asked for; an unnamed one fails as
invented.

### One new check, one new advisory

- **`no_completed_action`** — « Après vérification, nous avons constaté… » is real
  text from this desk's own outbound mail, and on a handover it is false: the
  verification is the thing that has not happened. Keyed on the verbs of checking,
  so « nous avons bien reçu votre message » stays allowed. It caught one live
  draft.
- **`empty_closer`, advisory.** The brand voice forbids empty courtesy, a
  structural rule repeats it, and the model still closed **31 of 81** drafts with
  « nous restons à votre disposition » or « merci de votre patience ». It is a
  weak sentence, not a wrong one, and `checks_passed` gates auto-send — so it is
  recorded (`passed: null`) and never refused.

### Result

**78 of 81 pass; the 3 failures are the checks working** — two handovers asked a
question the dossier had not named, one wrote « Nous avons constaté ». The
handoff stays withheld: `action` names a refund or replacement on 10 of 49, and
"what needs attention" is derivable from `unverified` without it.

Suites: **1496** from the repo root, **893** in `agent/`.

---

## Every verdict now gets a reply, and a draft says whether sending it ends the thread (2026-08-18)

Two changes, one reversal and one new axis. **81 drafts now exist over the whole
investigated corpus** — 15 `answerable`, 17 `needs_customer_input`, **49
`needs_human`** — and **81 of 81 pass the mechanical checks**.

### `needs_human` gets an acknowledgement — the original rule was wrong

Drafting shipped with `needs_human` producing nothing, because a case file that
resolved nothing has nothing to say. That reasoning was about the agent, and the
cost fell on three other parties: the **customer** heard nothing at all while a
colleague worked the ticket; the **colleague** opened a blank page instead of an
editable draft; and a wait that turned out to be long was indistinguishable from
being ignored.

- **`REPLY_INTENTS.needs_human` has read `acknowledge` since the case file was
  designed**, with a note that Phase 5 would decide whether it meant sending one.
  This is that decision.
- **`INTENT_RULES`, keyed by verdict**, replace a single flat instruction set.
  The three contradict each other by design — the reply that must ask is
  forbidden from answering — so sending all three would hand the model a prompt
  that argues with itself. Only the matching set travels.
- **The acknowledgement is safe because of what it may not contain.** No answer,
  no deadline, no promise, no question. That matters more here than anywhere
  else: **7 of the 49** are written from a case file with **zero** established
  facts.
- **`ACKNOWLEDGEMENT_PROHIBITIONS` checks two of those mechanically**, plus any
  invented question. A promised deadline is the one that costs money — « nous
  revenons vers vous sous 24 heures » is the most natural way to end a holding
  reply, it is a commitment nobody agreed to, and the customer who does not hear
  back has a second complaint that is entirely ours.
- **Never auto-send eligible, at any level.** The verdict says a person owns the
  next move, and what they need first is the chance to answer properly rather
  than to follow an automated note the customer has already read.

Measured: acknowledgements average **293 characters** against **595** for an
answer — brief, as instructed.

### `disposition`: terminal or intermediary

Every draft now records whether sending it **ends** the exchange:

| | |
|---|---|
| `terminal` | nothing expected back, nothing left to do. **The send is what closes the ticket** |
| `intermediary` | the customer owes us an answer, or a colleague owes them one. Sending closes nothing |

**15 terminal · 66 intermediary.**

- **Derived in code, never asked of the model.** "Is this exchange finished"
  decides whether a ticket closes, and it is the judgement a drafting model has
  the least evidence for — it sees the reply it just wrote, not the work behind
  it.
- **Two conditions**: `answerable` AND no `handoff` on the case file. Measured
  2026-08-18, all 49 `needs_human` case files carry a handoff and none of the 15
  `answerable` ones do, so today the verdict alone would agree. Both are checked
  because the direction they could disagree in is the dangerous one — an
  answerable case file that also names an action must not close on send.
- **Two check constraints say the same thing in the database**, so a careless
  change to the derivation fails at the write rather than at the send.
- **`handoff` is selected and reduced to a boolean at the store boundary.** It is
  the one internal column the drafting projection would otherwise exclude; the
  derivation needs to know *whether* a human owes an action, never *what*. The
  text exists for one line and never reaches the runner, let alone the prompt.

**The auto-close on send is what this exists for and is NOT built** — the send
path is still blocked on the mailbox question. What is built is the record a send
would read.

### Schema, forward-applied

`07_drafting.sql` widened its verdict check and gained `disposition` (the third
alteration; see `DECISIONS.md § Migrations`, updated). Column added nullable,
32 existing drafts classified from their verdict, then set `not null` — a default
would have labelled them silently.

### Also

- **A rate limit, not a bug.** The 49-draft backfill failed 10 on the first pass
  with HTTP 429: gpt-4o is capped at **30 000 TPM** here and a draft costs ~2 400,
  so a sustained batch outruns the retry backoff at roughly 12/minute. Failure
  isolation worked as designed and the derived queue converged on re-run. **A
  large backfill needs pacing the runner does not have** — worth adding before
  any run much bigger than this one.
- The thread dialog names an acknowledgement as one ("resolves nothing") and
  states the consequence of sending under every draft: approving one is
  approving what it does to the ticket.

Suites: **1477** from the repo root, **877** in `agent/`.

---

## The drafting agent writes its first 32 replies (2026-08-17)

`agent/src/drafting/`, `npm run draft`. **32 drafts over the whole draftable set**
— 15 `answerable`, 17 `needs_customer_input`, levels 1×3 · 2×22 · 3×7 — at
**67 768 tokens for 33 calls (≈ $0.02 per draft)**, all recorded in `llm_usage`
under the new `draft` pass. **32 of 32 pass the mechanical checks; 19 are
`auto_send_eligible`**, which nothing acts on while `DRAFT_ONLY` is true.

**No Graph call anywhere in the pass.** Input is stored rows, output is a stored
row, so the whole prompt-iteration loop runs without a mailbox — which is why
drafting was never blocked by the mailbox question that blocks sending.

### The system prompt is the Brand voice article

`brand-voice.mjs` composes it: role description verbatim and first (it is written
as a prompt, not a field), then tone, framework, guardrails, general context,
signature, the reply language, and last `STRUCTURAL_RULES` — the seams code owns,
declared as outranking everything above them.

**Approval gates the prompt**, the same way it gates the vector for knowledge and
exemplars, and the run refuses before the first ticket rather than per ticket: a
missing brand voice is a property of the run, and discovering it on ticket 40 of
91 would mean 39 replies in a voice nobody signed off.

**One structural rule exists because of the brand voice, not despite it.** The
approved role description tells the model to prefer answering over asking, with a
worked example — correct advice about writing, and wrong if applied to the
verdict, which the investigation already decided. The prompt says the decision is
not open.

### The checks, and the two measurements that shaped them

`draft-checks.mjs` checks the drafted text in code, because `do_not_claim`
otherwise reaches the model only as lines in a prompt.

- **6 of the 10 caveats have a textual signature** and are checked as patterns
  matching the *claim* the caveat forbids, not its subject — a reply correctly
  saying stock cannot be confirmed contains the word "stock".
- **4 do not, and are recorded as `passed: null`, never as passes.** "Ne rien
  inventer sur ce point" has no signature. A suite reporting 100% while testing
  60% is worse than one that says which 60%.
- **Withheld identifiers, any email address, and internal machinery** are refused
  outright. `#6686` is not an identifier — it is what the customer reads on their
  own confirmation.
- The signature must **end** the reply; one in the middle is a model that carried
  on writing after signing off.

**The stored-question check was rebuilt twice, both times from a measurement.**
Exact containment of `MISSING_FIELDS[field].ask` fired on **6 of 6**
`needs_customer_input` drafts and **0 of 6** `answerable` ones — a 100% alarm
rate on the only verdict it applies to. The reason was instructive: on
`shopify_order_number` the model had reproduced the stored sentence *verbatim* and
lowercased its first letter to embed it mid-sentence. Byte-exact insertion and
the approved brand voice (« éviter les formulations robotiques ») are in direct
conflict, and the voice is what a person signed off. Word coverage was tried next
and is not good enough either: a correct « l'adresse e-mail utilisée pour passer
cette commande » scored **43%** against **15%** for a draft about the wrong field
— a real gap, far too narrow for a threshold. What separates them cleanly is
whether the words that *name the fact* are present at all, so `ASK_TERMS` holds
one or two per field and all must appear. Verified to discriminate across all
seven fields. Whether the question was reproduced word for word is kept as an
advisory: **11 verbatim, 16 reworded** across the 32.

### `--redraft`, because the queue is derived

A ticket leaves the queue as soon as a draft exists — right by default, since a
re-run must not spend the mid tier on replies nobody has read. But the loop of
this phase is "change the prompt, look at the same tickets again", and a change to
the checks leaves stored results describing a rule that no longer applies. Found
by hitting exactly that: one draft carried a failure from the pre-change check and
nothing could refresh it.

### Also

- `AGENT_DRAFTING_MODEL`, default **`gpt-4o`** — the only stage whose output a
  customer reads, and one call per ticket.
- `llm_usage.pass` accepts `draft` (forward-applied; see `DECISIONS.md § Migrations`),
  and `06_analytics.test.mjs` now asserts the constraint against `USAGE_PASSES` —
  two copies of that list had been drifting with nothing watching, and the failure
  was silent because the sink degrades an unrecognised pass to `other`.
- `DRAFT_DELIVERY` / `DRAFT_REVIEW_MAILBOX` exist in config and default to `none`.
  **The review-mail path itself is not built yet.**

**Not built:** the review copy to the reviewer's inbox, approve/edit/reject in the
dashboard, and the send path (still blocked on the mailbox question). Suites:
**1464** from the repo root, **864** in `agent/`.

---

## Phase 5 groundwork: somewhere to store a draft, and a system prompt that is stored rather than compiled in (2026-08-17)

The first two build steps of the drafting phase. **No model call and no email
yet** — this is the storage and the prompt material, not the drafting agent.

### The brand voice is now five stored fields, not two plus two constants

- **`Response framework` and `Guidelines and guardrails` were `web/lib/types.ts`
  constants rendered read-only**, which meant the Node worker could not read them
  at all: a TypeScript constant in `web/` is not reachable from `agent/`. They are
  now part of `VoiceProfile`, seeded from the same defaults by
  `normalizeVoiceProfile` and written into `voice_profile` on the next save, so
  the database is the one source the drafting stage reads.
- **`signature` is new and editable.** The response framework's last step is
  "apply the approved signature" and nothing in the system stored one.
- No migration: `voice_profile` is jsonb and already existed. An unsaved row
  keeps rendering exactly what it rendered before.
- **The row is still empty and still `draft`** — `voice_profile` is `{}` and
  `content_text` is 0 characters on the live project. The fields exist; the
  writing is a content task.

### `ticket_drafts` (`07_drafting.sql`, applied to the live project)

- **Keyed on the message, not the ticket** — `unique(shop_id, trigger_message_id)`,
  the same rule as `ticket_investigations`: re-running rewrites one row, and a
  customer's reply lands as a new draft instead of overwriting the one somebody
  is reviewing.
- **Two bodies.** `body_text` is what the model wrote and is never edited;
  `approved_body_text` is a reviewer's rewrite. The distance between them is the
  only honest read on drafting quality, and graduating L1/L2 auto-send turns on
  it.
- **What the schema refuses.** `needs_human` is not a valid `source_verdict`, so
  the table cannot hold a customer-facing draft for a ticket the agent said needs
  a person. `level` is constrained to 1–3, because level 4 is never drafted.
  There is **no recipient column, no address and no send action** — a test
  asserts the absence, because that is the property the review channel rests on.
- **The human decision and the machine outcome are separate columns.** `status`
  is what a person decided; `checks_passed` is whether the mechanical checks
  passed. A draft can be clean and rejected, or edited *because* a check caught
  something.
- **`auto_send_eligible` is recorded from the first draft**, while `DRAFT_ONLY`
  keeps everything inert. How often the level gate would have been right cannot
  be answered retrospectively.
- **The queue is derived, not flagged.** No `needs_draft` column on `tickets`:
  that would mean an `alter table … add column` the baseline forbids, applied by
  hand to a populated table. `withoutDrafts()` subtracts what already exists from
  the candidate trigger messages, which is affordable because the candidate set
  is bounded by the case files.

### `scripts/lib/draft-record.mjs` — the module that owns the row

- Beside `ticket-record.mjs` and for the same reason: the worker writes a draft
  and the dashboard decides about it, and `web/` cannot import from `agent/src`.
- **`sent` is not a decision it accepts.** It is in the column's check constraint
  so the lifecycle reads completely, and absent from `DECISIONS` because nothing
  here can send an email — accepting it would record a send that never happened.
- A re-run revises the agent's text and never touches `status` or
  `approved_body_text`: a pass that reset them would move a rejected draft back
  into the queue, or discard an operator's rewrite, while somebody is working
  through the list.
- 17 tests over a recording transport, asserting the written bodies rather than
  return values.

### The dashboard reads it

`tickets-service.ts` no longer returns `draft: null` with a note. The thread
dialog renders the stored draft, names failed checks **above** the text (a
reviewer who reads a fluent draft first has already decided it is fine), and
shows a reviewer's rewrite as a second block rather than in place of the model's.

**Not built, and next:** the drafting call itself, the system prompt composed
from the brand voice, the mechanical checks, and the review copy to the
reviewer's own inbox. Suite: 1361 from the repo root.

---

## The usage sink was never constructed, and there is no investigation backlog (2026-08-17)

Two findings from one session, and the second cancels a step this file added earlier the same day.

### `llm_usage` held 0 rows because nothing ever built a sink

- **The cause was the first link, not a broken write.** `usageSink` defaults to
  `noopUsageSink` in `createOpenAIClient`, `createEmbeddingsClient` and
  `createInvestigationStack`, and the worker's poll and every CLI took the default.
  Only the three `embed:*` reconcilers passed one. Everything downstream was
  correct and tested — one entry per HTTP call at the transport, `pass` and
  `ticketId` from all four call sites, a bulk insert at the store — so the chain
  was complete except for its beginning.
- **`createShopUsageRecording({supabase, shopId, logger})`** now hands out the sink
  and its flush together, because a buffer nobody drains is silently identical to
  no buffer. Wired into `agent/src/index.mjs` — one buffer per process, drained at
  the end of every poll, outside `--stop-after` for the same reason retention is:
  the calls were already billed. And into `run-investigation.mjs`, the most
  expensive pass in the project.
- **A dry run reports the spend and stores nothing.** `flush({write: false})`
  totals the calls and tokens without writing, so `investigate:dry-run` can say
  what it cost while keeping its no-rows contract. It drains either way — the
  entries describe calls that already happened, so holding them back would
  double-count them on the next flush.
- **Evals keep the no-op deliberately:** re-running the same 40 cases would
  pollute per-pass cost with measurement rather than work.
- **Verified against the live project.** One real cheap-tier categorisation call →
  exactly one row: `categorise · gpt-4o-mini · 2415 in / 44 out / 2459 total ·
  succeeded`. The table went 0 → 1. That 2 415-token prompt is also the first real
  input to the unmeasured cost questions in `VALIDATION_LOG.md` items 4b and 9.
- **Tests:** four new (the pairing, `write:false`, a failed write still drains, an
  empty poll costs no request). Agent **775 pass**, root **1314 pass**.

### `investigate --include-closed`, so a backfill can reach imported history

- **The open-only queue is right for the worker and wrong for a backfill**, and the
  fix is an opt-in rather than a change to auto-close. `claim({anyStatus: true})`
  drops the status narrowing and nothing else; the flag, the categorisation
  requirement, `archived_at` and the soft-delete all still apply. No pass descriptor
  can set it — only a CLI flag a person typed, because it is a bill.
- **A widened run never moves a ticket.** 65% of verdicts map to `awaiting_human` /
  `awaiting_customer`, so acting on them here would resurrect dozens of settled
  threads into the live queue. `nextStatus` is now computed only when the ticket was
  open. **The status write had no test at all** — the existing one asserted the
  lookup table rather than the patch — so tests were added in both directions along
  with the change that could have silently broken it.
- **`status` joins `COLUMNS.ticketForInvestigation`**, because the runner cannot
  tell an open ticket from a claimed closed one without it.
- **Verified live on 3 tickets:** 1 investigated (`promotions/problem` →
  `needs_customer_input`), 2 skipped as subjects with no tools, the thread still
  `closed` with `closed_at` untouched, its flag cleared (113 → 110), and 4 rows in
  `llm_usage`. It reaches **91 investigable tickets, 28 carrying an order-context
  bundle no case file has read**.
- **The first measured unit cost in this project:** one investigated ticket is 4
  model calls, 5 464 in / 520 out, **≈ $0.016** at the current rate card — so the
  remaining 90 are ≈ $1.45. Both fixes in this entry had to land for that sentence
  to be possible.

### The 91-ticket backlog this file described does not exist

- **113 tickets carry `needs_investigation` and 0 are claimable.** Every one is
  `closed`. `PASSES.investigation.where` is `{status: 'open', needs_categorisation:
  false}`, and auto-close retires a thread after 28 days of silence **without
  clearing the flag it strands**. On a corpus of historical mail (last messages
  2026-05-22 → 2026-08-08) that closed 139 tickets, flag raised.
- **`--backfill` is not the fix.** `raiseFor` also requires `status = 'open'` *and*
  the flag already false, so a closed ticket is out of reach from both directions.
  Run today it raises **9** tickets, all of which already have case files.
- **The 29 order-resolved tickets with no case file are all closed too**, so the
  order-context bundles nobody has read cannot be read without reopening them.
- **Filed as a decision, not patched:** auto-close clears the flags it strands, or
  `claim` stops requiring `open` for investigation, or closed threads are reopened
  deliberately. `VALIDATION_LOG.md` item 16.
- **The measurement that matters for Phase 5:** 70 of the 80 case files sit on live
  tickets, and the live drafting set is **22** — 9 `answerable` and open, 13
  `awaiting_customer`. Nine case files sit on threads that later auto-closed, which
  is an artifact of importing three-month-old mail into a dev database rather than a
  finding: on live mail a thread is read minutes after it arrives. What Phase 5
  needs from this corpus is the **verdict mix**, not its queue state.

## The planning files re-measured against the database (2026-08-17)

No code changed. `AGENT_INTEGRATION_PLAN.md`, `README.md` and `VALIDATION_LOG.md`
were describing a state the database had moved past, in the direction of
understating what is built.

- **The correction that matters: the order family is resolved where it is
  resolvable.** Three files said `shopify_order_number` was null on all 214 tickets
  and that `orders:resolve` had never run. Measured: **52 tickets carry a confirmed
  number and a populated `resolved_context`**. The other 138 order-family tickets
  report `no_candidate` — no order reference in the text and no sender match — which
  is the resolver's designed answer, not a pass waiting to be run.
  `getOrderContext` is the most-called tool in the whole ledger (52 calls across 80
  case files).
- **The investigation has not caught up with that data, which two matching counts of
  52 nearly hid.** Only **23** of the 52 resolved tickets carry a case file; 28 are
  still pending, holding an order-context bundle nothing has read. And 29 of the 52
  *investigated* order-family tickets were read before they had a number. Resolution
  runs after investigation within a poll, so this is a backlog rather than a bug —
  `npm run investigate -- --backfill` clears it, and it should be cleared before
  Phase 5 reads case files.
- **The pipeline has run further than the docs claimed** on every axis: 80 case
  files (was 40), 145 customer links (was 141), 451 messages all embedded (was
  348), 61 knowledge chunks all embedded (was 54 with 11 embedded), 15 approved
  knowledge documents (was "one of nine"), 1310 root tests and 771 agent tests (was
  873 / 569).
- **Three tables are empty where prose assumed rows**, and each is now filed:
  `llm_usage` 0 rows although three LLM passes have run since the sink shipped
  (item 14); `categorisation_review` 0 rows, so the 77% / 90% / 73% real-mail
  accuracy figures rest on labels that no longer exist (item 15); and
  `category_forwarding` / `ticket_forwards` 0 rows, so forwarding has never routed
  anything here and its 42-message backlog is gone (item 1).
- **Two open questions closed by measurement rather than by work.** `not_attempted`
  is **3** across 80 case files, so the evidence-needs report's "steering" half is
  not worth building. And the model **does** call `verifyPurchase` (17) and
  `checkPhotoEvidence` (3) — the latter against 36 tickets that mention a photo
  without attaching one, so it is under-called rather than ignored.
- **Live parcel status is answered, not pending:** `delivered_at` on 1 order in
  2 006, `in_transit_at` on none. The ten-day stale-parcel rule cannot fire because
  there is no timestamp to compute it from, so the level 2/3 delivery boundary needs
  a delivery feed, not a prompt change.
- **`AGENT_INTEGRATION_PLAN.md` is now a phase plan again.** The implemented
  embedding, retrieval and exemplar design essays were removed in favour of pointers
  to `DECISIONS.md`, which owns that rationale; what stayed is status, evidence, the
  Phase 5 build, and the two genuinely forward-looking pieces (the blended-vector
  upgrade trigger, and clustering). Migration references to `011`–`014` are gone —
  the six-file baseline replaced them.
- **Also corrected:** `APP_SCHEMA.md` said 15 Insights views where `06_analytics.sql`
  creates 21, and `support_answers` now says it holds no rows.

## Contact rate per carrier (2026-08-16)

- **The carrier table has a `Contacted support` column.** Per carrier: how many
  of its shipments produced at least one ticket, as a count and a share, with
  the raw thread count beside it when the two differ.
- **Counted per order, not per thread.** One parcel chased four times is one
  unhappy delivery; threads-over-shipments would have put `AUTRE` (6 shipments,
  4 threads) past 100%. `fulfilment_by_carrier` gained `orders_with_ticket` and
  `tickets`, joined through `tickets.shopify_order_number` — the only confirmed
  link between a thread and a parcel.
- **The rate ships with its denominator.** New `fulfilment_ticket_coverage` view
  (one row per shop) reports that **52 of 214 tickets carry a resolved order
  number**, and the panel states it under the table. Every figure in the column
  is a lower bound; a `1.2%` cell with nothing beside it would be the exact
  plausible-but-wrong number these views exist to prevent. It is a view rather
  than copy so the caveat shrinks by itself when the resolver next runs.
- **What it shows.** **GLS is contacted about 4.1× as often as Colissimo** —
  5.1% of its 198 shipments against 1.2% of Colissimo's 1,311 — despite a
  slightly *faster* median dispatch (23.3h vs 24.5h) and a lower past-3-days
  rate (13.1% vs 16.1%). The under-counting hits both carriers alike, so the
  ordering survives the caveat even though the absolute rates do not. The note
  ranks only carriers with 100+ shipments, since a 6-shipment carrier tops any
  ratio.
- **Validated:** views applied forward to the dev database in one transaction
  and read back through PostgREST; carrier shipment counts unchanged at
  1,311 / 198 / 6 after the ticket join was added (the lateral does not multiply
  rows); `/insights/fulfilment` rendered the column and the note; `web`
  typecheck, lint and build passed; root `npm test` passed (**1271 pass**).

---

## Fulfilment per sales channel — Amazon (2026-08-16)

- **The Fulfilment panel now measures Amazon on its own, directly below the
  store-wide figures.** Same tiles, same six bucket boundaries, same 72-hour
  line, same monthly trend — reused from one `FulfilmentBreakdown` component
  rather than copied, so the two blocks cannot drift into measuring subtly
  different things.
- **Three additive views** (`fulfilment_summary_by_channel`,
  `fulfilment_by_channel_month`, `fulfilment_by_channel_bucket`) cut the
  existing three by `orders.sales_channel_handle`, which
  `order_fulfilment_timing` now carries alongside the display label. The
  store-wide views keep their one-row-per-shop shape untouched. The views group
  by every channel and filter to none; `fulfilment-service.ts` names `amazon` in
  a constant, so a second channel costs a constant and no migration.
- **What it shows.** Amazon is 467 of 2,006 orders (23.3%), median 23.0h against
  the store's 23.8h, p90 69.1h against 78.1h, and 8.4% past three days against
  13.8% — marginally *better* than the book as a whole, which was not the
  expected answer. July 2026 is its outlier at 31.7% past three days and a p90 of
  137h, the same month the store-wide trend degrades.
- **The finding worth acting on is not speed.** 402 of 467 Amazon orders (86%)
  carry no tracking number, against 4 of 1,487 on the online store. The panel
  states this as a marketplace data gap and `VALIDATION_LOG.md` item 12 carries
  the check that would confirm it — it is inferred, not verified.
- **Validated:** views applied forward to the dev database in one transaction
  and read back through PostgREST; channel counts sum to the whole book
  (1500 + 467 + 36 + 3 = 2006) and the Amazon histogram sums to its measured
  467; `/insights/fulfilment` rendered 200 with both figures populated; `web`
  typecheck, lint and build passed; root `npm test` passed (**1271 pass**).

---

## Supabase new-key REST auth fix (2026-08-16)

- **Fixed server-side Supabase REST requests for `sb_secret_*` keys.** The shared
  REST client now sends new Supabase API keys as `apikey` only, and keeps
  `Authorization: Bearer ...` only for legacy JWT-shaped keys.
- **Updated the Support topic-map corpus count** to use the same header helper,
  so the direct `HEAD` request cannot drift from the rest of the client.
- **Validated:** direct Supabase REST probe with server user-agent returned 200;
  fresh network-enabled dev server on port 3002 rendered `/insights/support`
  without the Supabase panel error; browser check found `Message volume by
  cluster`, one cluster table, and 46 topic-map tiles; focused REST-client test
  passed; `web` typecheck, lint and build passed; root `npm.cmd test` passed
  (**1271 pass**).

---

## Topic map cluster tiles (2026-08-16)

- **The Support heatmap now renders actual clusters, not category buckets.** Each
  tile is one persisted `ticket_clusters` row; category remains visible only as
  context and as the source of the existing subject-level happiness colour.
- **Cluster labels are less query-shaped.** `clusterLabel()` now strips common
  greeting/query frames and order-number fragments from the representative
  excerpt before truncating, so tiles start closer to the recurring issue.
- **Validated:** `npm.cmd run typecheck`, `npm.cmd run lint`, and
  `npm.cmd run build` in `web/`; root `npm.cmd test` (**1269 pass**).

---

## Insights dashboards, token accounting and a persisted topic map (2026-08-16)

Four analytics panels behind `/insights`, plus the two things that had to start being recorded before they could be read. Rationale in `DECISIONS.md § Insights`.

### The measurement that shaped it

Read from the live database before any code was written. **Fulfilment timing was already fully computable and had never been looked at**: `processed_at` → first `fulfillments[].created_at` is populated on 1,993 of 2,006 orders, giving a median of 23.8h, a p90 of 78h, and 276 orders (13.8%) past three days. Broken down by month it shows **July 2026 at 30.7% past three days with a p90 of 149h**, against 4–14% and ~70h in every other month — the worst fulfilment month on record, and also the heaviest support month (85 new threads). Nobody had seen it.

Delivery timing, by contrast, is genuinely unavailable: `delivered_at` is set on **1 order in 2,006** and `in_transit_at` on none, because no carrier feeds scan events back to Shopify here. Treating those two durations as one blocked lump is what had kept the measurable half unbuilt.

### `06_analytics.sql`

Three tables and **fifteen views**, all `security_invoker` and revoked from the anon roles like the rest.

- **`llm_usage`** — one row per model call. Nothing recorded what the agent spent; OpenAI returns `usage` on every response and `completeWithTools` already handed it to a caller that ignored it, while `completeJson` discarded it before the caller could see it.
- **`cluster_runs`** + **`ticket_clusters`** — the topic map, which previously printed to a terminal and persisted nothing.
- **`normalise_carrier()`** — the live table holds `COLISSIMO`, `Colissimo` and `LA POSTE COLISSIMO`; a raw breakdown reports three carriers.
- Applied forward to the dev database and **each view checked against an independent JavaScript computation of the same figure** over the same rows. All fifteen agree.

### Token accounting

- Captured at the **transport** — one `usageSink.record` in `request()` covers every call from every pass. The sink defaults to a frozen no-op, so every existing caller is unchanged.
- **Retries within one call are not separate rows** (a retried 429 was never billed) but a call that exhausts its retries **is** one, because the last attempt may have been served and charged.
- The store is best-effort and swallows its own failure: a poll that categorised twenty tickets and then failed to write cost rows has still categorised twenty tickets.
- **Tokens are stored; money is applied at read time** from `scripts/lib/llm-rates.mjs`, overridable with `LLM_RATES`. `estimateCost` returns `rated: false` rather than 0 for an unpriced model. **The default prices are list prices recorded so the panel has a number, and are explicitly not authoritative.**
- Wired into the spam gate, categoriser, decomposer, investigation and all three `embed:*` reconcilers.
- **Nothing can be backfilled** — usage exists only on the response — which is why this shipped before the panel that reads it.

### Topic map persistence

`cluster:tickets` stays print-only; **`cluster:tickets:save`** persists a run. A rebuild is a deliberate act — the 0.68 threshold is hand-tuned and corpus-specific — so the map records its own age rather than refreshing behind the reader. Runs are pruned to the last 10, an orphaned run row is deleted if its clusters fail to insert, and a zero-topic run is still written because "nothing repeated above the threshold" is a real result.

### Verified

- Root `npm test`: **1269 pass**. `agent/` `npm test`: **732 pass**. Includes 37 new tests over the sink, the store and the rate table, and 26 over the cluster store.
- All 15 schema invariants in `_shared.test.mjs` pass with the sixth baseline file.
- Every column the two new stores write confirmed to exist against the live schema.
- `cluster:tickets:save` run once for real: 248 messages, 13 subjects, 46 topics persisted.

### Support route completion

- **`/insights/support` is now routed.** The support service and view existed, but the App Router page was missing, so the Support tab could link to a 404 and the substantial `SupportView`/`TopicMap` code was outside the compiled route graph.
- **Added the missing CSS module** for the support panel's figures and wide tables, matching the restrained Insights table/figure vocabulary and keeping horizontal overflow inside the panel.
- **Finished the panel polish pass:** the Insights tab order now matches the `/insights` landing route, unmeasured fulfilment months render as missing rather than zero, uncategorised mail cannot become the "sore subject" callout, and a saved zero-topic map gets an explicit measured-empty state.
- **Removed side-stripe note/banner styling** from the Insights kit and topic-map provenance banner; state is now carried by full borders, tint and text colour instead.
- **Validated:** `npm.cmd run typecheck`, `npm.cmd run lint`, `npm run build` in `web/`, the local design detector over Insights, HTTP 200 checks for all four panel routes, and root `npm test` (**1269 pass**).

---

## Backlog auto-close window (2026-08-15)

- **Auto-close now waits 28 idle days instead of 21.** That gives tickets at least two weeks in the Backlog before automatic closure, while still using `last_message_at` so a new customer reply or desk reply keeps the thread open.
- **Updated lifecycle docs and tests** for the 4-week boundary.
- **Validated:** `node --test .\agent\src\lifecycle\auto-close.test.mjs` and root `npm.cmd test`.

---

## Tickets backlog section (2026-08-15)

- **Added a Backlog section** between Irrelevant and Closed. It uses the same `TicketTable` format and close action as Queue, and derives membership client-side from open tickets waiting 14 days or more (`waiting_since`, falling back to `first_message_at`).
- **Open-ticket filters now cover Queue + Backlog together.** Level tabs, search, category and sort apply once to open tickets, then the result is split into the two sections.
- **Validated:** `npm.cmd run typecheck` and `npm run build` in `web/`.

---

## Queue priority scorer module (2026-08-15)

- **Priority scoring is now a tested pure function**, not a stored column: `scripts/lib/ticket-priority.mjs` scores level, customer wait, inbound contacts, `awaiting_human`, and VIP at read time.
- **Wired into the Tickets UI:** `ticket_queue` now supplies `inbound_count` and `waiting_since`, the server maps `priorityScore` and `priorityBand`, and the table shows a Priority column before mood/subject.
- **Priority owns row borders:** high/medium/low rows get restrained red/orange/green outlines. The VIP gold row border is gone; VIP remains a crown beside the requester name.
- **Weights tuned:** level 1/2/3 are `10 / 18 / 25`, level 4 stays a hard `1000` band, and customer wait is the strongest ordinary factor at `35`, logarithmic and capped at 14 days.
- **Applied to the dev database forward** with the same `CREATE OR REPLACE VIEW` definitions now in the baseline; verified `ticket_queue` exposes `inbound_count` and `waiting_since`.
- **Tests:** 22 focused root tests cover the hard level-4 band, the new wait-over-level behavior, the wait curve, priority bands, uncategorised fallback, explanation parts, and stable sorting.

---

## VIP is a gold ticket (2026-08-15)

- **The whole row, not a chip.** A VIP was a teal pill under the requester's name; it is now a gold rule on all four edges of the row, with a crown beside the name. Eight rows are visible at a time and a chip in the fourth column is missed — knowing you are about to open a champion's ticket is worth seeing from the row.
- **This reverses a recorded call, and the reasoning it reversed was sound**: teal is the app's one accent, and a VIP is a fact about the customer rather than a warning about the ticket.
- **Filled first, then pulled back to a border.** The first version washed the row gold as well and put the crown in its top-right corner. **75 of 214 tickets are VIP (35%)** — a third of the queue tinted is more of the screen than the fact deserves, and it is exactly the competition with level and mood the old rule warned about. The border carries it; the crown reads as the person's rather than the ticket's next to the name.
- **The rules are inset box-shadows, not borders, and that is load-bearing.** Drawn as borders, a VIP row measured 68px against its neighbours' 67 and its mood face sat 2px right — a visible limp down a column of 214 rows. Shadows paint in the same place and take no space. The bottom edge stays a real border, since every row already has one and a border paints over an inset shadow.
- **Gold is its own token pair** (`--gold-strong`, `--gold-100`), not `--warning` — that ramp is orange and owns "something is wrong". Two steps, not the usual three: dropping the fill orphaned the wash and the text-on-tint colour, and they went with it rather than sitting unused.
- **The crown is the set's only filled icon.** At the 14px it renders, a 1.6px outline turns to mush; it has to read as a crown at a glance or it is a gold smudge. The requester cell is a flex row so the NAME truncates and the crown never does — the one thing worth spotting must not be what a long name pushes out — and the name is `flex: 0 1 auto`, since letting it grow shoves the crown to the far side of the cell where it reads as its own column.
- **The pictogram announces nothing on its own**, so it is `aria-hidden` with visually-hidden "VIP customer" beside it — it replaced a chip that literally read "VIP", and the RFM segment is still on the `title`.
- **Verified in the browser, not just typechecked:** collapsed and expanded, with the gold carried around the detail panel (which paints its own background and teal rule over the cell, so the panel root is overridden); row heights and the mood-face position confirmed identical to ordinary rows.

---

## The database layer gets owners (2026-08-15)

Four refactors, chosen from an architecture review of everything that touches Supabase. No behaviour was intended to change; the tests that encode the behaviour were kept and extended.

- **`tickets` had eight writers and no owner.** Ingestion, categorisation, investigation, three resolution passes, auto-close and the dashboard each held a private store over the same row, each naming its own columns and building its own patch — and the investigation's backfill wrote past its own store with a raw `supabaseUpdate`. **`scripts/lib/ticket-record.mjs` is now the only writer**, in `scripts/lib` because `web/` cannot import `agent/src` and the dashboard's status write touches the same three lifecycle columns auto-close does.
- **The two flagged passes turned out to be one protocol.** Categorisation and investigation run the identical cycle, so it is written once — `claim / complete / skip / retry / abandon` over a descriptor naming the flag, the flag it raises, the stamp and the metadata trail. **9 raw column patches, 3 copies of the queue predicate, 2 copies of `mergeMetadata` and 2 of `attemptsSoFar` became 5 methods and 2 descriptors.** The crash-safety rule ("clear the flag LAST, in the same patch as the result") was a comment repeated beside each site and is now a thing the code does once, with a test.
- **Four projections moved into SQL.** `ticket_message_counts`, `ticket_first_inbound`, `ticket_queue` and `order_number_range()`. The queue was counting messages by reading **every message id in the shop**; order resolution was reading **every inbound body in the shop** to keep one per ticket and discarding the rest; the order-number range was two round trips. Joins and aggregates only — `shouldAutoClose`, the level ratchet and the evidence rules did not move, and `ticket_queue` deliberately omits VIP because that is derived at read time.
- **Every view is `security_invoker`, and that is the load-bearing part.** A view created without it runs as its owner and reads straight past RLS — and every table here has RLS on with no policies precisely so only the service role can read. An owner-rights view over `tickets` would have been the one way an anon key could read the whole support mailbox. Asserted on every view, along with the revokes.
- **The baseline is now applied by a test rather than only read by one.** Every other assertion in `supabase/migrations/` is a regex over the `.sql` text, which cannot tell whether a join is right. `_live.test.mjs` applies all five files into a throwaway schema, seeds the smallest population that distinguishes each projection, asserts the output and drops the schema. Skipped without `SUPABASE_DB_URL`, so `npm test` still needs no database. It makes permanent the catalogue check that proved the 8→4 split, which had been run once from a terminal.
- **Three embedding reconcilers became one loop and three descriptors.** ~490 lines of copied loop around a 133-line tested gate. The copy had already drifted: **the knowledge and exemplar orphan sweeps used a plain `supabaseSelect`**, which PostgREST caps at 1000 rows with a 206 and no error — past a thousand embedded rows they stopped seeing orphans. The message reconciler had been fixed for this; now all three page. The three `embed:*` commands and their reports are unchanged.
- **The schema is named once.** 217 table-name literals across 65 files and three packages, with no compiler and no test behind a rename. `scripts/lib/tables.mjs` holds the 24 tables, 3 views, 4 RPCs and the projections asked for in more than one place; `_shared.test.mjs` asserts it against the DDL **in both directions**, so a table the baseline creates and the module does not name also fails.
- **Two live defects found on the way, both fixed.** The raw write past the investigation store, and `ticket_messages` having copied the embedding determinism quadruple from `knowledge_chunks` without its `embedding_dimensions = 1536` check. The constraint is now inline in the baseline, and `_shared.test.mjs` asserts the **clause** — not merely the constraint's presence — on every table holding a vector, so a fourth embedded table cannot permit something else.
- **Applied to the dev database forward, not by rebuilding.** The baseline is a definition and re-applying it means an empty database, which would have cost the 214 ingested tickets every measurement here was taken against. The three views, `order_number_range()` and the check were applied in one transaction, with the SQL **extracted from the baseline files rather than retyped**, and the script discarded afterwards — a forward step checked in beside the baseline is how a baseline turns back into a history. Verified after: all four objects present, `security_invoker` on every view, no `anon`/`authenticated` privileges, 0 rows violating the new check, row counts unchanged (214 / 451 / 2014 / 58 201), `ticket_message_counts` summing to the live message count exactly (451), `ticket_first_inbound` at one row per ticket with inbound mail (203), the queue readable **through PostgREST** at 214 rows with 141 customers linked, and `orders:resolve:dry-run` running end to end (159 considered, 6 confirmed).
- **One behaviour change worth naming:** `order_number_range()` excludes soft-deleted orders, which the asc/desc pair it replaces did not. No effect today — the store holds 0 soft-deleted orders — so it is a guard for when retention starts deleting, not a correction. The range now reads `#4771`–`#6790` against the `#4716`–`#6770` recorded on 2026-08-11; that is four days of store drift, not this change.
- **Tests:** +109 (1161 root, 691 agent), including the first executed-SQL test and the first tests the embedding reconcile loop has ever had.

---

## Two agent judgements corrected (2026-08-14)

- **Level 4 narrowed to two triggers**, on the merchant's definition: an explicit **legal** threat (court, complaint, lawyer, formal notice), or **grave harm to the person** (hospitalisation, or a life-threatening condition). **A threat to go to the press or post on social media no longer qualifies** — it is neither a legal exposure nor an injury, it is a very unhappy customer, which `happiness` already measures on its own axis. Conflating them put reputational annoyance in the same queue as hospitalisation. Costs nothing retroactively: no ticket in the corpus has ever been labelled 4.
- **`VALIDATION_LOG` 6c was filed with the wrong root cause, and reading the email corrected it.** The entry blamed `CODE_PATTERN` for matching a capitalised product name. The source message contains **no all-caps run of four characters anywhere** — the customer wrote « votre Masque LED visage » in ordinary case, and extraction correctly found nothing. **The model composed the argument**, calling `lookupPromotion({ code: 'MASQUELEDVISAGE' })` itself. Tightening the regex would have fixed nothing.
- **The fix is a guardrail on the argument, not the parser.** When a code is not found in the shop AND does not appear as a word the customer typed, `lookupPromotion` reports `no_code_in_message` instead of `not_found` — so a fabricated argument settles no finding at all. Only the `not_found` branch is reinterpreted: a real code resolves however it was punctuated, and a genuine typo the customer typed still gets suggestions.
- **Reading the whole email corrected a second guess.** 6c also called the routing suspect — a *product* ticket split into a `promotions` task. It was not a mis-split: the customer's last paragraph asks « avez-vous une offre ou une remise en cours sur ce masque, ou un code promotionnel ? ». Binding the promotion tools was right, and **`listActivePromotions` answered it well**, establishing `UKLED20` — 20 % off that exact mask. The fault is one spurious extra call, not a misrouted ticket, and nothing a customer would see changed.
- **The first version of that guard was wrong and its own test caught it.** Flattening both sides and asking whether the message contained the code passes `MASQUELEDVISAGE` against « Masque LED visage » — with the spaces gone, that *is* the string, and any multi-word product name collapses into exactly the code a model would invent from it. Comparing **token by token** keeps `qiriness-20` matching `QIRINESS20` while a three-word name matches nothing.
- **Tests:** +8 (1052 root, 689 agent).

## The queue learns to wait, and every family gets facts a human can read (2026-08-14)

- **A single tool result was 259,874 characters, and it failed an investigation outright.** `listActivePromotions` answered per REDEEM CODE rather than per offer: this shop's 25 active offers carry **3,619 codes**, and one 284-character promotions email produced a 68,771-token request against a 30,000 TPM ceiling. Found by instrumenting `fetch` and tracing the request bodies, after a spend measurement turned up a 1-in-5 failure rate.
- **It was not only cost — 3,614 of those were single-use codes belonging to other customers**, handed to the model in one blob, one turn from a drafted reply. The size was hiding the shape. `listActive` now reads the unflattened rows: one entry per offer, a code named only where the discount has exactly one (which is what an advertised code looks like), and `(code personnel, 600 générés)` otherwise. **259,874 → 1,991 chars, bulk codes exposed 3,614 → 0.** The flattening stays correct for `lookupPromotion`, which needs per-code usage to answer "you have already used this one".
- **Measured spend, since the question was asked and the answer was not guessable:** ~10,100 gpt-4o prompt tokens and 2.6 calls per investigated ticket, ~$0.029 each, **~$5 for all 174 in scope**. The constraint is not money — at 30,000 TPM the org can sustain about three tickets a minute, so a full pass is an hour of steady 429s and wants batching.
- **`getOrderContext` was serialising the UI's data structure into the model's prompt**, and `context.promptText || JSON.stringify(context.order)` was not a fallback — **0 of 44 stored contexts carried a `promptText`**, so the dump was the only path that had ever run. `toOrderContextText` now renders it: 515 chars median against 1,693, withholding `sku` and `productId` (join keys, not facts a customer recognises) and naming money only where a reply turns on it.
- **The general rule behind that is now stated once and enforced across every tool:** a structure with several audiences owns a projection for each. One test runs all eight tools over four subjects and asserts no `promptText` begins with `{` or `[`.
- **`namedSample`** caps the one remaining unbounded renderer — `describeItemRestriction` enumerated every product a discount covers. Dormant on this data (no promotion carries an item scope), which is exactly why it was capped now: nothing will announce when it wakes up. `buildVariants` was deliberately left alone — variants top out at 3 per product, and a cap that can never fire is machinery pretending to be a safeguard.
- **The verdict now decides where a ticket waits.** `needs_customer_input` → `awaiting_customer`, `needs_human` → `awaiting_human`, `answerable` stays `open` because nothing sends yet — that is drafting's hook, not the investigation's.
- **Setting that alone would have stranded every replying ticket for ever.** The categoriser *and* the investigation runner both select on `status = 'open'`, so a ticket parked `awaiting_customer` would never be re-read once the customer answered. `ticket-writer` now returns **any** non-open status to open on an inbound message — reversing an earlier rule that was correct while nothing set those states.
- **`awaiting_human` is exempt from auto-close.** Silence there means nobody did the work, not that it resolved; closing it files a service failure as a completed ticket. Before this, **67 level-3 tickets** would have closed that way. The backlog is counted separately from `exempt` so it is visible rather than deleted.
- **`orders.customer_email_masked`** — `j***l@orange.fr`, derived beside the hash from the same input. A hash answers "is it the same address?"; the desk's question is "which address is this?", and **all 15 order mismatches are now reviewable**. Several point at `@example.com`, which is a different cause than assumed: placeholder addresses no requester could ever match. Never sent to a model.
- **Evidence gaps now carry `details`** — which product, which code, why it was refused — declared per need beside the finding derivers, extending `evidence_gaps` rather than adding a column. `summariseFacts` renders them in the ticket panel for **every family**, closing the gap where only orders could be judged without opening Shopify.
- **P2 caught two bugs by refusing to be a formality.** The first attempt returned zero details because all three tickets matched nothing — a verification that can only pass is not one. Re-run against tickets naming a real product or code, it found (a) the customer extractor reading `account` where the identity lives in `profile`, storing `{name: null, isVip: null, ordersCount: null}`: an object that passes every existence check and says nothing; and (b) `MASQUELEDVISAGE` looked up as a discount code on a *product* ticket. **The finding alone read as unremarkable; only the detail showed the subject was nonsense**, which is the argument for the whole feature. Filed as `VALIDATION_LOG` 6c — ~~blaming the extraction pattern~~, **which the entry above corrects: the pattern never matched it, the model composed the string itself.**
- **Order sync re-run** to populate the mask: 2,714 orders synced, 700 purged by retention (0 of the 44 confirmed-order tickets lost their row), **1,969 of 2,014 carrying a masked address**.
- **Tests:** +26 (1048 root, 685 agent), plus the dashboard typechecks, lints and builds.

## Exemplars reach the agent, and the order family is switched on (2026-08-13)

- **The whole exemplar layer is live end to end.** 31 exemplars approved, **94 phrasings embedded**, and `match_support_exemplars()` answering from the investigation loop. Verified against a real ticket: « pourquoi je n ai pas reçu de code pour les -20% » → **P-15 at 0.824**, P-18 second at 0.693.
- **Wired reported-not-enforced, and that is the design.** The match reaches `ticket_investigations.exemplar_match` and nothing else — `investigate()` is never told, and a test asserts the key never appears in its input. Two independent declarations of what a ticket requires now exist, and comparing them is only meaningful while neither feeds the other. `npm run eval:exemplar-needs` is the report, and it excludes rows where the exemplar supplied the needs.
- **It costs no extra API call and cannot break a run.** `findInboundMessages` now selects `embedding`, so matching reuses the vector ingestion already wrote (`"embedded":false` on every live run). Every failure path returns `{}` and logs `investigate.exemplar_failed`.
- **The one place the exemplar does act:** when the decomposer's call *fails*, its authored needs stand in. `decompose.mjs` invents nothing on failure by design; a list a person wrote for a matched situation is not that guess. `caseFile.needsSource` records which source spoke so the comparison stays honest.
- **Storing only the committed match was wrong, and the first dry run said so.** Both live tickets came back `near`, so `exemplar_key` was null and the row said nothing — while *which situation nearly won* is the entire diagnostic on a near miss. Added `closest`, populated whatever the verdict.
- **`ENABLED_SUBJECTS` now contains every subject that has tools** — `order`, `delivery`, `payment` and `return_exchange` joined the five already there. Before this, **21 of 31 exemplars and 116 of 158 messages of measured demand were unreachable**: two-thirds of the corpus we had just approved and embedded could never be retrieved.
- **Enabled with 15 mismatches unexamined, knowingly.** `isSafeToWrite()` gates the column, so a refused resolution leaves `shopify_order_number` null — the agent cannot answer about the wrong order because it never learns which one it was. The cost is asking a customer for a number they already sent. Tracked as an open audit in `VALIDATION_LOG.md` item 6b, which closes by *counting* how often that happened rather than by observing that nothing broke.
- **A test now asserts the enabled set and the tool table agree exactly.** They deliberately disagreed until today and the gap was the mechanism; with it closed, the invariant worth protecting is the agreement — dormant tools nobody notices, or a subject routed nowhere.
- **Three phrasings were carrying two situations each**, found by a new audit that scores stored vectors against each other and costs no API calls. P-18's split half moved to P-15, R-22's drop-off question to R-21, and PR-28's « Avant de me décider, je… » was a truncated fragment carrying no situation at all. The eval structurally cannot see this class of error: a bad phrasing still wins the ticket it was lifted from.
- **P-18 was a question invented from its own answer.** Across 296 stored messages and a curated review folder, no customer has ever asked whether codes stack — every "cumulable" sentence is one the desk wrote. Rewritten as « mon code promotionnel ne fonctionne pas » with five real phrasings, and it went from never winning a ticket to **7 at median 0.740**.
- **The P-16 merge was reversed on a better axis.** Reading all 21 promotions tickets end to end: **14 are "no code arrived", 3 are "the code will not apply"** — different *observations*, not two diagnoses of one. P-15 sharpened from 21 tickets at 0.696 to **14 at 0.773**. Both sides rose, which is the tell that a split is right.
- **Two new situations from a curated review folder:** `D-33` (which countries do you ship to — split out of D-07, which was asking two questions behind one vector) and `S-34`, the **first exemplar for `product_stock`**, a subject that had been switched on the whole time with nothing to match against.
- **Order numbers stay in the phrasings, measured.** Three variants of all 92 phrasings scored against unchanged ticket vectors: as-is 0.633, stripped 0.635, placeholder 0.634. Differences inside noise, so kept literal — a placeholder is a token no real email contains, which moves the library *away* from the query side.
- **Tests:** +12 (1011 root, 656 agent).

## A forwarded order confirmation now resolves the order (2026-08-12)

- **6 of the 15 `mismatch` tickets become `confirmed`**, taking order-number coverage from 44 to 50 of 214 tickets. Each had parsed its number correctly against a real order and been refused because the *envelope* sender did not own it — while the address that order is registered to was sitting in the message the customer sent. Merchant decision recorded in `DECISIONS.md`: an email mismatch here is ordinary (a gift, a partner, a second mailbox), not a security concern.
- **`confirmation-evidence.mjs` parses no template, and that is the design.** It hashes every address in the text and asks whether one equals `orders.customer_email_hash`. The received mail is the notification template after the customer's client re-rendered the forward, after `htmlToText` flattened it, and possibly after a merchant reworded it — every step moves the labels, and there are no tags to anchor on because Liquid (`{{ order.name }}`, `{{ email }}`) renders before the mail is sent. A label-reading parser would have been built against a document we never receive.
- **Measured against the corpus first.** 18 messages across 10 tickets carry the full confirmation; the order number was already extractable from **18 of 18** — the number was never the missing piece, the identity was. Only hashes leave the module, so third-party addresses reach no caller, log or metadata column.
- **Named `message_email`, not `confirmation_email`, because the data said so.** Of the 6 rescued tickets only **3** carry a recognisable confirmation; the other 3 quote the address another way. A layout parser would have found 3 and called the rest mismatches. `metadata.order_resolution.confirmation_markers` records the template-marker count as a diagnostic — never a gate — so a reviewer can tell the two cases apart.
- **Known gap, deliberately not closed:** the order-status URL, the one identifier that is a platform invariant rather than a template choice, survives in **0 of 296** stored messages — `htmlToText` drops every `href` and the raw body is not retained. Using it needs the href kept at map time plus a token column on `orders`; the hash check needs neither.
- **Not built:** attachment reading. 38 inbound messages carry attachments and **29 of those have no order number anywhere in the text**, but nothing fetches `/messages/{id}/attachments` — `has_attachments` is a boolean and always has been.
- **Tests:** +18 (645 agent), covering hash comparability, punctuation and `mailto:` normalisation, a bounded address count, both confirm paths and their ranking, and a reworded template still yielding the address.

## Exemplars merged, and the language gap given somewhere to live (2026-08-12)

- **Three merges, 32 exemplars → 29.** `O-09/O-10` and `D-03/D-04` each resolved to a *single shared answer* in `Email-Example-Responses.md` — the split was simply wrong, and the eval agreed from the other side (O-10 and D-04 never won a ticket). `P-15/P-16` spans three answers and was merged anyway, on the stronger claim that which of the three applies is a **finding, not a question**: the customer knows only that they were promised 20% and do not have it. Merging exemplars does not merge answers, because answers are keyed by evidence position.
- **The retired rows were not inert, and that is the lesson.** The importer upserts and never deletes an exemplar that leaves the document, so `O-10`, `D-04` and `P-16` survived as drafts holding *copies of the phrasings that had just been merged into their survivors*. Median margin fell 0.037 → **0.032** and ambiguity rose to **23%** — the merges looked actively harmful until the three rows were deleted.
- **Cleaned up, the merges did what they were meant to.** Median margin **0.040** (from 0.037), ambiguity **17%** (from 19%), subject agreement **63%**, silent exemplars **6 → 3**. `MATCHED` and `NEAR` did not move.
- **`diagnose-exemplars.mjs` now says WHY a silent exemplar is silent** — the rival that beat it, the median gap, and the language of its closest tickets — because "never wins" has causes wanting opposite fixes. `COLLISION` wants a merge and more phrasings would only sharpen the tie; `ABSENT` wants leaving alone; `MID-PACK` means the field already covers it; and a gap of exactly **0.000** is `DUPLICATE`, the signature of a retired key still in the table. Post-merge, P-18 and R-23 lose *clearly* (0.130 and 0.162) rather than narrowly, so neither is a merge candidate — they are under-phrased.
- **R-22 was neither rare nor mis-worded: it was measured somewhere it cannot appear.** Pulling the source message out of the corpus found *"RE: RE: PROBLEME MASQUE LED"* — the **fourth message of a thread**, and the eval scores only first inbound messages, so its one real phrasing is never a query. The truncated quote had also cut the load-bearing clause: « je ne suis pas responsable si le produit a un problème » makes it a **defective-goods** return, a different answer to the same sentence. Restoring the full quote was enough for it to start winning tickets. Recorded as a general property — return costs, refund timing and "any news?" are follow-up questions by nature, and this eval is blind to all of them.
- **`support_exemplar_phrasings.language` + `translated_from_index`, and `translated` as a third phrasing kind.** French tickets match at median **0.637** and English at **0.476** — a gap wider than the whole distance between `NEAR` and `MATCHED`. Nothing writes anything but `fr` yet; the column exists because none of that is reportable or regenerable without knowing what language a row is in. `match_support_exemplars()` now reports which language matched and still **never filters on it**: an English email matching a French phrasing weakly beats not matching it.
- **Translations live at `phrasing_index >= 100`, and the database enforces it.** `import-exemplars.mjs` prunes by position — anything past the end of the authored list is text nobody wrote — so a translation appended after the authored phrasings would be destroyed on the next import. Two index spaces, a check constraint rather than two scripts agreeing by habit, and `TRANSLATION_INDEX_BASE` asserted from the module in the migration test.
- **The translate-the-query recommendation is reversed.** Its premise was already false — R-21 is English, D-08 and R-23 Spanish, so the library has been mixed-language since it was written — and query translation trades one mismatch for another, since machine-translating a messy email produces *tidy* French against variants that exist precisely to be messy. Library-side instead: real non-French phrasings where the corpus has them, translation to fill the rest. Suggestive: `es` median **0.814**, highest of any language, on n=2, and D-08 is the one carrying a real Spanish phrasing. **Deliberately not built yet** — translating before every question has its full verbatim set means paying for the same work twice.
- **Applied to the live database as a hand-written delta**, because the migrations are a baseline and cannot be re-run over populated data. `05_exemplars.sql` is the definition and was edited to match; verified after: 79 phrasings, all `fr`, all authored, max index 4.
- **`agent/eval/README.md`** — every measurement in one table, with the column that matters most: *what it is judged against*. Three are labelled sets, two are proxies, none writes to the database.
- **Tests:** +7 (983 root, 628 agent), covering the language vocabulary element-wise against `REPLY_LANGUAGES`, the two index spaces, and the translation shape constraint.

## Order family unblocked, and the exemplar bands measured (2026-08-11)

- **`orders:resolve` has now run against real data** — the pass `VALIDATION_LOG` item 6 was waiting on. 203 tickets considered, **44 confirmed**, 15 `mismatch`, 4 `not_found`, 140 `no_candidate`. Then `context:build`: **44 of 44 resolved, 0 missing**. `getOrderContext` can finally answer, which was the last thing standing between the order family and `ENABLED_SUBJECTS`.
- **15 mismatches want a look before the subjects are enabled.** That is item 6's own check (b): a mismatch is a confirmed-looking order number whose requester hash does not match the order, which is either a customer writing from a second address or a thread that is not theirs. Subjects like *"RE: remboursement commande #5229"* suggest the former.
- **`npm run eval:exemplars`** — calibration without approval. Embeds the 79 phrasings **in memory** and scores them against the first inbound message of **190 real customer tickets**, whose vectors ingestion already wrote. Approval gates the vector, so this breaks what would otherwise be a deadlock: the numbers a reviewer needs to approve are the ones that only exist after approving.
- **The relevance signal is a proxy and is labelled as one:** whether the winning exemplar's subject agrees with the subject the categoriser independently assigned. Overall agreement **62%**; the distributions separate cleanly (agreeing p25 0.629 vs disagreeing p75 0.621).
- **`MATCHED` 0.62 → 0.65, `NEAR` 0.52 → 0.55.** The sweep put the knee at 0.65 — restraint 80% → 88% for the recall it costs, where 0.70 buys 7 more points at nearly half the remaining recall.
- **`minMargin` 0.03 → 0.01, and this one was simply wrong.** The median margin is 0.037, so 0.03 would have called **45% of all matches ambiguous**. At 0.01 it is 19%, and that residue is a corpus problem — the source document already names O-09/O-10 and P-15/P-16 as merge candidates.
- **The variants thesis held.** Six exemplars never win a ticket; two of them are D-07 and P-18, exactly the two with no real phrasing. Predicted by the importer, confirmed by the eval.
- **Still not proven:** nothing is approved, nothing is embedded in the database, and no exemplar has reached the investigation loop. The bands rest on a proxy, not a labelled set.

## Exemplar layer, part 1 — storage, embedding, retrieval (2026-08-11)

- **`05_exemplars.sql`, the first new baseline file since the reorganisation.** `support_exemplars` (canonical question, `exemplar_key`, subject + kind, `requirement_needs text[]`, `approval_status`, measured `demand_message_count`) and `support_exemplar_phrasings` (one row per real phrasing, each with its own vector and the determinism quadruple). `requirement_needs` is constrained to the `evidence-rules.mjs` vocabulary, held in step by a migration test — the same device that keeps `knowledge_documents.category` from drifting off the taxonomy.
- **`match_support_exemplars()` returns one row per exemplar, not per phrasing**, scored by its best phrasing. Five phrasings of one situation are five ways of saying the same thing, and without the grouping a caller asking for three matches gets one exemplar three times. The phrasing pool is over-fetched ×8 because the inner limit counts phrasings while the caller counts exemplars.
- **A phrasing is embedded alone** — the only composer in the codebase that adds no context. `buildExemplarEmbeddingInput` collapses whitespace and stops; a phrasing is already a complete question and the query it meets is a bare email, so prefixing the canonical question would pull variants of *different* exemplars together via their least discriminating text.
- **`exemplar-rules.mjs` — one exemplar or none, never a shortlist.** A near-tie (margin < 0.03) resolves to `ambiguous` rather than to the higher score, and the margin is reported because a persistent near-tie is the corpus saying two situations want merging. Bands are `MATCHED 0.62` / `NEAR 0.52`, **separately calibrated from knowledge and currently unvalidated** — the knowledge numbers came from a prose library and do not transfer. Subject filter only, deliberately the opposite of `categoriesToSearch()`.
- **`exemplar-retrieval.mjs` reuses the stored message vector** when the ticket carries one, so the usual cost is a single RPC and no embedding call at all; it falls back to embedding on demand because that ingestion write is best-effort.
- **`npm run embed:exemplars[:dry-run]`** — the reconciler, mirroring the knowledge one. Clears vectors from phrasings whose parent left `approved` **or was soft deleted**; on this corpus a missed clear is a reachability bug rather than a quality one, because approval *is* the retrieval gate.
- **`npm run import:exemplars[:dry-run]`** — reads `Email-Example-Queries.md` into the tables. The parser is pure (`scripts/lib/exemplar-import.mjs`) and the script is a shell, so every judgement is unit-tested: two categories on one entry keeps the first and notes the second, a need outside the investigation vocabulary is dropped loudly rather than failing a check constraint at insert, and the one "variant" that quotes *our own reply* is skipped by name — embedding an answer into a corpus of questions is what the separate-tables decision exists to prevent. Idempotent: phrasings upsert on `(exemplar, index)` so unchanged text keeps its vector, and phrasings past the end of a shortened list are deleted rather than left orphaned. **It never approves anything** — approval gates the vector, so nothing imported is retrievable until a person has reviewed it, which is also where the order numbers inside real phrasings get looked at.
- **Measured on the real document:** 32 exemplars parsed, 0 skipped, **79 phrasings** (32 canonical + 47 real variants). By subject: delivery 8, order 8, product 5, promotions 4, return_exchange 3, payment 3, account 1. Two exemplars (D-07, P-18) carry no real phrasing and will match a messy email worst — reported by the importer rather than left to be discovered.
- **Answers are shared, not nested** (`support_answers`). Nesting a variant set inside each exemplar multiplies to 100–160 drafts, most of them duplicates — « pas encore expédiée » answers both D-01 and O-09. Because a `when` clause is a conjunction over *closed* findings enums, the space of distinct evidence positions is bounded by the vocabulary rather than the question count: the promotions family collapses to four positions serving five questions, and the estimate across all four families is 10–15 answers. An exemplar names its `answer_set`; conditions pick the state within it.
- **`answer-selection.mjs` — selection and the stopping rule are the same computation.** Most-specific wins with `priority` breaking ties (never first-match-wins, which makes authoring order silently load-bearing); an unbreakable tie reports `ambiguous` rather than resolving by sort order; no match with no fallback routes to a person. `nextNeed()` picks the need the live answers most *disagree* on, then walks the dependency graph back to what must come first — which is how `promotion_identity` gets collected even though no answer branches on it. Collection halts when one answer remains, before the tool budget rather than by exhausting it.
- **Applied and imported.** `SUPABASE_DB_URL` still pointed at the retired IPv4 direct host (`db.<ref>.supabase.co`, now IPv6-only, and this machine has no IPv6 route); repointed at the session pooler `aws-0-eu-north-1.pooler.supabase.com:5432`. `05_exemplars.sql` applied, then **32 exemplars and 79 phrasings imported** — all `draft`, so nothing is retrievable yet. Re-running the import produced no duplicates.
- **Not built yet:** the answer *content* (0 rows in `support_answers`; `answer_set` is null on every exemplar), the dashboard editor, and the band calibration. Nothing calls exemplar retrieval from the investigation loop yet.
- **Tests:** +56 (944 root, 601 in `agent/`), covering the vocabulary constraints against their source modules, the retrieval function's grouping/over-fetch/gates, the band-and-margin decision table, and the parser's forgiving-shape/strict-vocabulary split.

## Evidence findings — the value a need took (2026-08-11)

- **Needs now resolve to a value, not only to a state.** `resolveNeeds()` gains a `finding` alongside `state`: `promotion_validity` is no longer just *satisfied*, it is `active` / `expired` / `not_yet_started` / `inactive` / `not_found` / `unknown`. Nine needs carry a vocabulary — the ones the 32 questions in `Email-Example-Queries.md` actually branch on; the rest resolve `finding: null`, which reads as "no answer depends on the value" and is deliberately distinct from `'unknown'`.
- **Derived from structure, never prose.** `promotion-rules.mjs` checks gained an optional machine-readable `reason` (`expired` / `not_yet_started` / `open`, `active` / `inactive`), because expiry and a future start date were both `FAIL` on the same check and separable only by reading French. `tool-registry.mjs` now passes `checks` through as `{id, status, reason}` triples — never the `detail` sentences, which stay in `promptText` where the model reads them. Existing check shapes are unchanged when no reason applies.
- **A universal dependency graph.** `requires` and `moot` sit beside `satisfiedBy`: eligibility requires validity requires identity, and eligibility is *moot* once validity is `expired` / `not_found` / `not_yet_started` / `inactive` — there is nothing to be eligible for. `orderNeeds()` is a stable topological sort over a declared set; a prerequisite that was not declared does not block its dependent. The order family's edges are written and dormant with it.
- **Nothing consumes any of this yet.** No verdict, prompt or stored column changes: `evidence_gaps` simply carries an extra field. This is the axis the exemplar answer-variants will branch on, landed first because conditions cannot be authored against values the tools cannot produce.
- **Tests:** +15 (888 root, 584 in `agent/`), covering derivation totality (every deriver returns a value inside its own vocabulary, across nine ledger shapes), the expired/not-yet-started split, `satisfied` co-existing with `unknown` when the tool is too coarse, and the sort's stability and completeness over the whole vocabulary.

## Environment correction (2026-08-11)

- **The dev-store premise was stale across seven files.** `SHOPIFY_STORE_DOMAIN` is `qiriness.myshopify.com`; measured against Supabase: **2052 orders spanning `#4716`–`#6770`** (was 12, `#1001`–`#1012`), 58 201 customers, 116 products, 327 promotions. That range contains every order number the mail corpus quotes, so the "zero overlap" blocker recorded throughout is over. Customer resolution has run and links **141 of 214** tickets.
- **The order family is still gated, for a new reason.** `shopify_order_number` is null on all 214 tickets because `orders:resolve` has never run, so `getOrderContext` reports `not_resolved` regardless. Enabling `ENABLED_SUBJECTS` before that pass reproduces the old empty answer. Corrected in `investigation-rules.mjs`, `DECISIONS.md`, `VALIDATION_LOG.md`, `README.md`, `AGENT_INTEGRATION_PLAN.md`, `order-resolution-runner.mjs` and `abandoned-checkout.mjs`. **No validation item was closed** — none of the checks has been run.

## Agent worker staged ingestion (2026-08-09)

- **Backlog ingestion can now stop after categorisation.** `npm run ingest:once -- --limit=500 --stop-after=categorise` runs ingestion, customer resolution and categorisation, then deliberately skips investigation, order resolution, context assembly, forwarding and auto-close. Retention still runs. The same `--limit` now caps the categorisation batch too, so the intended 500-message review run does not stop after the normal 25-ticket daemon batch. A bad stage name fails closed and logs the reason; the worker error paths on this route now use the logger-safe `error` field instead of the reserved `message` field.
- **The staged backlog run has now been executed against the real mailbox.** Command: `node .\src\index.mjs --once --limit=500 --stop-after=categorise` from `agent/`, completed 2026-08-09. Result: 451 messages ingested, 214 tickets created, 451 message embeddings written, 25 blocklisted spam drops, 24 LLM spam/irrelevant drops, 175 spam audit decisions flushed, and the Graph limit was reached. Customer resolution ran before categorisation. Categorisation labelled 203 tickets, skipped 11 outbound-only/unclassifiable tickets, and had 0 failures / 0 fallbacks. The staged stop held: no investigation, order resolution, context assembly, forwarding, or auto-close pass ran.

## Dashboard

- **Agent Setup** (`/agent-setup`) — two-pane knowledge workflow: article library with search, status filters, a 6-slot core-topic checklist and category grouping; a workspace editor with Shopify page/policy import, resync, save/approve/delete, and a dedicated brand-voice workspace. Full state and a11y coverage. "Optimize" is still a local placeholder with no AI behind it.
- **Knowledge API** (`web/app/api/knowledge/*`) — exercised end-to-end through the real browser UI, not just curl: page import, policy import, edit-converts-to-manual (Resync correctly disappears), and delete.
- **Tickets dashboard** (`/tickets`) — four header cards over three collapsible sections: Queue (565), Irrelevant (260) and Closed. Level tabs, search, category filter and sort apply to the queue. **Every row opens with a traffic-light mood face** read from `tickets.happiness`: green 1-2, amber 3, red 4, dashed where unscored. Neutral (2) is folded into green on purpose — it is the commonest score, and an amber row for every ordinary email would turn the whole column amber and signal nothing. Drawn on the app's own icon grid rather than as a Unicode emoji, which would render as each operator's OS artwork and ignore the palette. **Close** and **Reopen** work end-to-end; the round trip was exercised against the live dev database and the row verified moving between sections both ways. Every card figure and row count matches a direct Supabase query.
- **A queue row expands into the agent's reading of it** — Results / Order / Action, fetched per ticket on expand rather than shipped with all 565 rows, always the latest run. **Not yet exercised against the live database**: the investigation pass has run over 40 real tickets from the CLI, but this panel has only been type- and lint-checked.
- **The Order block carries Shopify's own status and tracking**, read from `tickets.resolved_context` rather than the case file, so it fills in for tickets the agent never investigated. Order status, tracking number (linked to the carrier where the fulfilment has a URL) and tracking status appear **only when there is data**. **Not yet seen against real data** — type- and lint-checked, build passes.
- **Clicking a ticket's subject opens the conversation in the app** (`GET /api/tickets/:id/thread`): a draft-reply section, then the full email chain, both directions, oldest first. It exists so an operator stops flicking to Outlook to read a case; **sending still happens in Outlook**. A deep link into the mailbox was considered and is not buildable — see `DECISIONS.md`. The **draft section is a placeholder and says so** (drafting is Phase 5). The route returned 200 against the live dev database for two real tickets; the rendering has not been checked field by field.
- **A ticket row shows the matched Shopify customer and badges VIPs.** The queue embeds the customer over `tickets.customer_id` in the same request (no extra read) and marks a **VIP** where the RFM segment is `CHAMPIONS` or `LOYAL`. Verified end to end by temporarily linking one ticket to a `LOYAL` customer, confirming the badge and resolved name rendered, and reverting.
- **But nothing is linked yet, and the reason is the dev store.** `customers:resolve:dry-run` reports **500 considered, 0 linked, 500 `no_match`** — the pass had in fact never run against this data (0 of 565 tickets carried a `customer_id`, and 0 carried the `metadata.customer_resolution` record it writes on *every* outcome). Zero address overlap between the 15-customer dev store and the live inbox.
- **The Irrelevant section's subject opens the dropped email itself** — the message and nothing else, since verdict/gate/reason/timing are already columns in the row. `failed_open` is the one exception, kept as a banner.
- **Dropped mail keeps its body** (`08_spam_audit_body.sql`, applied to dev), reversing 02's "never the body". Kept only on a `blocked` outcome and under its own 90-day expiry, purged per poll by a PATCH rather than a DELETE. Migration applied and the dashboard's read of the new columns verified against dev; **no email has been ingested since, so nothing has yet written a body through the live path.**
- **The backfill for pre-existing rows exists and currently cannot run here.** It stops immediately with `ErrorInvalidMailboxItemId`, because every `graph_message_id` was captured from `contact@qiriness.com` while `SUPPORT_MAILBOX` now points at `onouailhetas@lap-groupe.com`, and Exchange item ids are mailbox-scoped. Verified as a mailbox mismatch and not deleted mail by probing ids of *kept* messages, which fail identically. **Not specific to the backfill** — no stored id can address a message today, so Graph's `/forward` cannot work for the existing corpus either.
- **Saved changes survive a reload.** The dashboard used to show pre-edit values after F5 while Supabase held the correct data. Next.js patches global `fetch` in Server Components and Route Handlers and was storing every Supabase REST response in its Data Cache with a one-year revalidate, keyed on URL. `export const dynamic = "force-dynamic"` does not prevent this; only an explicit `cache: 'no-store'` does. Now set on every request in the Supabase and Shopify clients.

## Sync and schema

- **Shopify sync scripts** — products/metaobjects, customers, orders, promotions, the unified page+policy content catalog, and nightly orchestration.
- **Support taxonomy pinned** — one shared vocabulary in `scripts/lib/support-taxonomy.mjs`. The rename of the 9 existing articles and 54 chunks ran once against dev; the constraints on both the knowledge and ticket sides are applied and their enforcement verified live.
- **Level 4 means severity, not subject.** The database column comments carry this rule; an earlier version had shipped a subject-implied one, and the correction is applied to dev.
- **Schema fully applied to dev.** The migrations are a **baseline** run in order against an empty database, replacing the 15 numbered files that built dev incrementally (kept in git history). The baseline was verified to reproduce the live dev schema exactly: 384 columns, 147 constraints and 136 indexes, zero differences.
- **The baseline is now four files by domain, not eight by history** (2026-08-07). The eight had accreted as a changelog — 05 patched 04, 07 mirrored a flag 03 created, 08 rewrote a comment 02 wrote, and `tickets` was created in 01 then altered twice more — so reading one table meant reconstructing it from up to four places. Now `01_foundation` → `02_shopify` → `03_knowledge` → `04_support`, with **every table created complete**: there is no `alter table … add column` in the baseline, and a test asserts it. **Proved rather than reviewed** — both sets were applied into throwaway schemas on the dev Postgres and the catalogue diffed: 425 columns, 172 constraints, 152 indexes, 17 triggers, 3 functions, 20 RLS tables, 20 table comments and 139 column comments, **identical**. The 89 old tests became 110, reorganised so the cross-file invariants (RLS everywhere, nothing referenced before it is created) are asserted once in `_shared.test.mjs` rather than partially in each file.

## Ingestion (agent Phase 1)

- **Verified against the real mailbox** — cursor idempotency, delta cursor persisted in `shops.sync_cursors` — then end-to-end against the live `contact@qiriness.com` inbox: 500 messages → 125 blocklisted, 27 LLM-filtered, 348 stored as 171 threaded tickets, all categorised with no failures.
- **Four defects found by running it on real mail**, none visible on synthetic data:
  - *Direction.* 123 of 348 messages were sent by the support address and stored as customer mail, putting Qiriness's own reply at the end of 43% of threads.
  - *Contact-form identity.* 53% of support mail arrives through the Shopify form. 95 tickets shared 2 `requester_email_hash` values. After the fix, distinct requesters went from 76 to 108 and the worst collision from 73 tickets to 8.
  - *`first_message_at`.* Late on 93 of 171 tickets (5 days on average, 24 at worst), and the categoriser queue sorts on it.
  - *Queue starvation.* 11 unclassifiable threads took 11 of every 25 slots on every pass.
- **Quoted reply history is stripped** before embedding and classification. **104 of 348 messages carry a reply chain and it is 53% of the stored text.** Every cut comes from an unambiguous structural marker; the loose `>`-line heuristic fires on none of them.

## Spam gate

- **Pass 1** — the `email_blocklist` check inside the poller; blocking a sender live dropped their 5 messages and purged their stored mail.
- **Pass 2** — the LLM classifier on new-conversation mail, failing open on any error. The first 100-message pass filtered 91 as spam, correctly: the inbox is flooded with DMARC aggregate reports. Adding the report senders to the blocklist moved them off the LLM path entirely (91-per-100 down to 27-per-500).
- **`irrelevant` now drops, not just labels.** Guard-railed by a measurement: 17 of the 20 purely internal threads turned out to be *customer work forwarded between colleagues*, so the prompt states explicitly that internal mail about a customer is not irrelevant. Only 1 ticket in the corpus was genuine ERP coordination.
- **Spam audit trail** — every gate decision writes a `spam_audit` row. The write path was exercised against the live table: idempotent re-flush, one-line reason collapsing, and the `unsure` default all confirmed, then the test rows removed.

## Embeddings and retrieval

- **Embedding pipeline, built and run end to end.** `text-embedding-3-small` at 1536 dims across two corpora sharing one determinism gate. **Knowledge chunks:** 11 of 54 hold vectors — exactly the chunks of the one `approved` document, the invariant holding on real data. **Ticket messages:** all 351 embedded. Both verified idempotent, and verified working together: clearing six vectors, the ingest pass refilled three inline and the reconciler swept up the rest. Retrieval sanity-checked by hand: an account login question matches the password-reset FAQ at 0.624, and "commande le 17 mai, montant débité" matches "Ma commande 5669 du 17 mai n'est toujours pas partie" at 0.859 across two different tickets.
- **Topic clustering over the embedded inbox** (`cluster:tickets`) — read-only, no model calls. Average-link, not single-link: single-link chained and put 52 of 55 `order` messages in one blob. Threshold 0.68, tuned by eye.
- **Two faults surfaced once the corpus reached 1111 messages**, both invisible at the ~225 it was built on. **It was reading 1000 of them:** PostgREST silently caps a response at `db-max-rows`, returning 1000 rows and a 206 with nothing for the caller to notice — `supabaseSelectAll` now pages by the rows actually returned. **And 30% of "customer demand" was us:** 331 messages from our own domain counted as inbound and dominated the topics; five of the top ten `delivery` clusters were staff chasing the carrier. Net effect: 4 of the top 8 "write this next" suggestions were internal threads; now none are. The same cap was also truncating **`embed:tickets`**, whose redaction sweep clears vectors from redacted and soft-deleted messages — past row 1000 it was not looking. It now considers all 1383 (0 stale, 0 to clear, so nothing had slipped through; the safety net was blind, not breached).
- **Knowledge retrieval** — one embedding call plus one HNSW-indexed `match_knowledge_chunks()` RPC. Three bands, not a boolean: **answerable ≥ 0.60, weak ≥ 0.45, otherwise nothing** — calibrated on the measurement that a genuinely correct match scored 0.62 while topics with *no article at all* still scored 0.38-0.48. **Measured on 12 real product/account tickets: 1 answerable, 8 weak, 3 nothing.** That is the library being empty, not the tool failing.

## Hybrid retrieval and the eval set (2026-08-09)

- **A labelled retrieval set exists, so retrieval changes are now measured rather than argued.** `npm run eval:retrieval` scores 16 cases — 6 answerable, 10 that must return *nothing* — on recall@k, precision@k, MRR, band accuracy, **restraint** (scored separately from recall, because a retriever that answers everything scores 100% recall) and **entity precision/recall/F1**, micro-averaged. Labels are at DOCUMENT level, not chunk: chunk ids regenerate on every re-chunk and a chunk-level label set would rot silently. `npm run eval:diagnose` reports the relevant-vs-irrelevant score distributions and how often the two retrievers agree.
- **Lexical search alongside the vectors, fused by rank.** `knowledge_chunks` gained a generated `tsvector` (`setweight` A on the heading, B on the body) over a custom `french_unaccent` configuration — `unaccent` + `french_stem` — with a GIN index, and `search_knowledge_chunks_text()` beside the existing HNSW RPC. Results are combined by **Reciprocal Rank Fusion at k=20**: rank-based, never score-based, because cosine sits at 0.45–0.60 here while `ts_rank_cd` runs 0.1–4.6 and normalising them would invent a relationship that does not exist. A chunk found by *both* retrievers accumulates both contributions.
- **The lexical half was returning zero results for every real query, and the diagnostic is what caught it.** `websearch_to_tsquery` **ANDs** its terms, so a nine-word French support question required all nine stems in one chunk — 0/80 retriever agreement, and "hybrid" search that was silently dense-only. It now ORs the lexemes. The earlier claim that fusion had produced three new `answerable` cases was wrong and is retracted: that improvement came from the user adding 7 chunks, not from the fusion.
- **`brand_story` is searched again.** The rule excluding it claimed those chunks were never embedded. They were — the embedding gate is `core_topic !== 'brand'` (the singleton brand-voice row), not `category !== 'brand_story'` — so the exclusion left 9 real vectors permanently unreachable. Two different things had been conflated: the drafting *voice*, which now has its own mechanism, and the brand *category*, which is ordinary knowledge answering real questions.
- **The `weak` floor moved 0.45 → 0.50, re-derived against the labelled set** on a 61-chunk library. Measured: relevant chunks 0.298–0.662 (median 0.517), irrelevant 0.171–0.578 (**p75 0.458**) — so 0.45 sat *below* the irrelevant p75 and a quarter of the noise was reaching a model. Swept: 0.45 → restraint 30% / band accuracy 44%; **0.50 → 70% / 69%, at no recall cost**; 0.55 → 90% / 81% but loses a real answer. `answerable` stayed at 0.60, which no irrelevant chunk in the run reached. **16 cases is a small set** — the sweep is to be re-run as the library grows, and 0.55 revisited once specific content lands.

## Task decomposition (2026-08-09)

- **An email that contains two requests is now investigated as two.** The investigation splits a ticket into at most 3 tasks, each clamped to the existing (subject, kind) taxonomy, and takes the **union** of their tools, opening moves and evidence checklist. This is what `tickets.secondary_category` was always for; nothing downstream had ever read it. Chosen over multi-query rewriting because this corpus has a routing problem, not a vocabulary one — see `DECISIONS.md`.
- **Bounded so it can only add, never re-route or widen.** A one-task result keeps the ticket's own labels (the categoriser stays the authority); a task landing on a subject outside `ENABLED_SUBJECTS` is dropped from routing and *declared* to the model rather than silently ignored; a failed or unusable decomposition degrades to exactly the pre-decomposition behaviour. The tool budget grows +2 per extra task and the turn budget does not, because tool calls here are cached database reads and model turns are the expensive bound.
- **It only runs when the email looks like it needs it** — a second subject from the categoriser, ≥320 characters, or ≥2 question marks — so an ordinary one-question ticket costs nothing. `AGENT_DECOMPOSER_MODEL=` (empty) turns it off entirely.
- **Not yet run against real mail.** 35 tests cover the pure half, the model half and the wiring, including that a single-task ticket produces byte-identical moves and prompt to the pre-decomposition path. The eval case `two-questions-at-once` is what will measure it.

## Evidence needs — step 1, measurement (2026-08-09)

- **The system can now tell "there was nothing to find" from "the agent never looked".** It could not before, and both produced a case file that read as complete. `evidence-rules.mjs` holds a closed vocabulary of **19 facts** a reply might rest on; the model declares which ones a ticket requires (in the same call that splits it), and code scores each against the tool ledger as `satisfied` / `attempted` / `unavailable` / **`not_attempted`**. Stored on `ticket_investigations.evidence_gaps`, summed per batch by the CLI, logged per ticket by the runner.
- **A documentation claim was found to be false and corrected.** `DECISIONS.md` stated that `requiredEvidence` was *"stated in the prompt **and** checked afterwards"*. A grep showed it appears in exactly one place outside its own tests — the prompt builder. It was never checked. That per-subject checklist is also static (two `product` tickets asking different things get the same list) and its `other` entry — *"the knowledge base was consulted"* — cannot fail. It remains a guideline; the new mechanism is what does the checking.
- **Closed enum, not free text**, because scoring free-text needs against the ledger would take a second model call — a judge marking its own homework. The model picks *which*; code owns *what satisfies*. Same split as `MISSING_FIELDS`.
- **`other_fact` can never be satisfied, by design.** A closed vocabulary's real risk is a false green — a ticket whose actual requirement is unnameable declaring two easy needs and reading as complete. It is logged so the vocabulary grows from real tickets. `checkout_state` is the same shape for a different reason: `abandoned-checkout.mjs` exists and is validated but is not in the investigation registry, so it always resolves `unavailable`, and counting how often it is *needed* is the argument for wiring it.
- **Deliberately reported, not enforced.** The verdict is untouched. Downgrading an `answerable` that left a need open, and ending the loop early when the set is complete, are **step 2** — both depend on this vocabulary being trustworthy and nothing has measured whether it is. A list that over-declares would downgrade good case files for reasons about the list rather than the ticket.
- **The decomposition call lost its gate as a direct consequence.** It used to skip short tickets; needs must exist for every investigated ticket or the report has a hole exactly where the ordinary tickets are. Now one `gpt-4o-mini` call per investigated ticket, against the two `gpt-4o` calls already made.
- **Not yet run against real mail** — the new Supabase holds 0 tickets until ingestion is unblocked. 37 new tests (858 total), and `evidence_gaps` applied to the live database and verified present with its check constraint.

## Retrieval tools (Phase 4)

- **Forwarding non-customer mail to the right colleague.** Measured, that is **38 of 330 customer-facing tickets (12%)** — careers 11, partner_collaboration 14, b2b 13. Configured at `/settings`; a category with no address forwards nothing, the default for all 14.
- **Running it for real found two bugs the tests could not.** The first live pass forwarded **0 of 42** — Exchange was mid-mailbox-move and every send returned `ErrorMailboxMoveInProgress`. **Failures were not actually retryable:** selection excluded any message with a ledger row regardless of status, so 42 genuine emails were permanently locked out by a transient error. **And the retry cap fought the poll interval:** 5 attempts against a 60-second poll would have burned every attempt in five minutes. Transient Graph errors no longer consume an attempt. **A third came from counting the real pending set:** 9 of 51 messages were colleagues forwarding things *into* the inbox with `TR:` subjects. Net: 42 messages across 38 tickets, matching the measured figure exactly.
- **Product lookup and stock tools** — matching runs on the **title column only**, folding accents and typographic punctuation, weighting tokens by **IDF across the catalogue** so `creme` (a third of titles) barely counts while `led` (one title) is nearly decisive. **Ambiguity returns every candidate's full context, not a refusal.** Running it on real tickets caught a live failure: the `unlisted` sample *"Caresse Temps Sublime Nuit - échantillon"* beat the real €89.50 coffret at 0.88; only `active` products are candidates now. Required a **Shopify rich-text flattener** — `product_faqs[].answer` is a nested rich-text document stored as a JSON *string*. Stock reads `purchasable` rather than the raw count: Shopify allows overselling and one real row sits at **-1**.
- **Promotion tool.** Targets 34 `promotions` tickets, 29 of them level 2; the biggest single cluster in the inbox is the newsletter welcome code (20 messages). **The verdict is three-valued — `blocked` / `undetermined` / `eligible` — never a boolean.** The promotions sync was extended to make eligibility real: `minimumRequirement`, `customerGets`, `customerBuys` and `customerSelection` were fetched as `__typename` only, so the snapshot recorded *that* a discount had a minimum but never what it was.
- **Abandoned-checkout lookup** — carts are not synced and the Admin API does not expose an in-progress cart, but `AbandonedCheckout` does. Fetched **live per ticket, never synced**; addresses dropped on the way in. See `VALIDATION_LOG.md` item 2 for what validating it uncovered (a real discount-subtotal bug, and that Shopify mutates one record per session in place).
- **Order-number resolver.** The prerequisite for 172 of 330 customer-facing tickets (52%). **Parsing is deliberately narrow**; over the corpus that is 1152 `#NNNN` plus 225 written-out forms, and the 911 `Q00` references are classified rather than dropped. **Measured on the corpus: 488 tickets, 139 with a parsed order number, 0 confirmed** — the corpus quotes 101 distinct numbers from 302 to 70853 while the dev store holds twelve. Validated end to end with a real-data fixture across six scenarios.
- **Order-context bundle** — verified by assembling the real `#1006`: a 1.7 KB bundle with tracking number, carrier, Colissimo link, `daysSinceDispatch: 17`, full-refund detection and the customer's RFM group, with no street address or phone.
- **Customer/CRM lookup — the first tool that needs no order number.** Two ways in, one bundle out: `findByEmail` and `findByEmailHash`. The customer shaping was **extracted, not copied** — `buildCustomerContext` backs both this tool and `tickets.resolved_context.customer`, with a test asserting the two produce the identical object. Every lookup writes a `data_access_events` row with the customer id hashed, and that write **fails open**.
- **The CRM lookup now runs by itself, on every ticket.** A pass runs immediately after ingestion and before any LLM stage, because identity is what a ticket has from its first message. Built, and now run for the first time: 500 considered, 0 linked, 500 `no_match` (see the dashboard section).

## The investigation agent (Phase 4b)

- **The first thing that actually calls the tools.** Six retrieval tools existed and nothing invoked them. **Measured on 40 live tickets: 9 answerable, 6 needs_customer_input, 25 needs_human, 0 failures, 0 unsourced claims stored, 0 handoff leaks**, and a maximum of 3 tool calls in any run against a ceiling of 6. The `needs_human` share is the knowledge library being nearly empty, not the agent being cautious. Scope is deliberately `product, product_stock, promotions, account, other`.

## Categorisation (Phase 3)

- **Run on real mail:** 171 tickets categorised across two passes with no failures and no fallbacks. Measured twice. Against 40 invented cases: ~38-39/40 on all three axes. Against **30 hand-labelled real emails**: subject 70%, kind 93%, level 77% (re-scored 2026-07-27 after the review bodies were normalised to match what ingestion now stores; the previous 77/90/73 was measuring input the pipeline no longer produces). Those movements are 2 cases or fewer on n=30 and sit well inside the noise — the set is too small to resolve changes of that size, which is itself the finding. Five of the nine subject errors are the `order`/`delivery` boundary Phase 4 order data should settle; four of the seven level errors are `delivery/problem` L3-vs-L2.
- **Re-categorisation as threads grow** — re-flagged on a new *inbound* message, re-read **blind**, level ratcheted so it may rise but never fall.
- **Two per-ticket signals** — `language` (on live mail it correctly caught 5 English, 1 Italian and 1 Spanish among 163 French) and `happiness` 1-4.
- **A third signal was built, measured, and removed.** The categoriser was asked how confident it was and answered `high` on 171 of 171 live tickets and 40 of 40 review cases. The per-band accuracy report added to the eval is what caught it.
- **Human review set on real mail** — 40 emails randomly sampled from the live inbox (Nov 2025 / Dec 2025 / Jan 2026, 40 of 1,027) sit in `categorisation_review`. The sampler is read-only on the mailbox and the agent's own labels stay empty until after review, so the labelling is blind.

## Not built

Dashboard authentication, deployed webhook routes, and the agent's drafting stage (Phase 5). Backend/deploy config is still pending.

## Tickets: the conversation shows each sender's address (2026-08-17)

- **Every message block in the thread dialog now prints the sender's email beside their name.** Previously `from_email` was only a fallback for a missing name, so the address was invisible on almost every message.
- **Suppressed where the name already is the address.** Measured over 451 stored messages: 444 have a name that differs from the address, 7 do not. Those 7 render the address once, not twice. The comparison is trimmed and case-insensitive, because `Jean@Qiriness.com` in the name field is the same sender as `jean@qiriness.com` in the address field.
- Verified in the browser on both branches: `Catherine Monteil · catherine.monteil@yahoo.fr` renders the pair, `poline4@wanadoo.fr` renders once.

## Tickets: the expanded panel wears its ticket's priority colour (2026-08-17)

- **Fixed: opening a ticket turned its priority bar green.** The row's left bar is red/orange/green by priority band, and `TicketTable.module.css` was already passing `--priority-edge` down to the detail row — but `TicketDetailPanel.module.css` drew `border-left: 3px solid var(--teal)` over it. `.detailCell` has `padding: 0`, so that border landed exactly on top of the cell's own priority inset and won every time. A high-priority ticket looked low-priority at the moment someone was reading it.
- **One line**: the panel's rule is now `var(--priority-edge, var(--teal))`. Verified in the browser across all three bands — row bar and panel border return the same computed colour (`#e81010`, `#ff8c00`, `#00a651`), and the bar now runs unbroken from row into panel.

## Agent panel: cost leads the page (2026-08-17)

- **`What it costs` moved to the top of `/insights/agent`**, above the pipeline funnel and the blocker ranking. A pure reorder — the section moved verbatim, no markup or logic changed.

## Reverted: staff-sent threads stay in the ticket queue (2026-08-17)

Same-day revert of the Conversations routing below. Built, measured against real data, and withdrawn.

- **All 14 routed threads turned out to be customer work** — `return_exchange/problem` L3, `delivery/problem`, `order/problem`, team `logistics`: the back office coordinating real returns, not internal chatter.
- **3 of 14 were still open at L3** (needs a human) behind a nav item nobody had opened. **1 was an orphan** — `TR: Retour Colissimo` names a consumer with no ticket of their own, so that forward is the only record of their return. **7 quoted no consumer address at all**, so coverage could not even be checked.
- **Root cause: `NON_DEMAND_LABELS` was reused out of context.** It was written for `cluster:tickets`, where excluding our own prose from a topic map is right. A forward is a change of messenger, not a change of subject.
- **`/conversations` and `ConversationsView` removed**, sidebar item back to `SOON`. The queue holds every ticket again.
- **Kept as a label, not a route**: a sender chip on the row (teal for internal/contractor, directory `note` as tooltip, `flex: none` so a long name cannot push it out) and an Anyone / Consumers only / Staff & partners only filter.
- **The agent's skip on non-demand senders is removed too.** It was argued as saved spend on "threads nobody is drafting a reply for"; the measurement showed they are L3 customer returns needing a human, and the case file is the context that human wants. The sender still reaches the model as context via `buildInput`, so a colleague is not read as the customer.
- The classification machinery stays — `ticket_first_inbound.from_email`, `ticket_queue.requester_email`, server-side resolution so the address never reaches the browser. Only the consequence changed.

## Conversations: our own mail leaves the ticket queue (2026-08-17)

- **New `/conversations` page** for threads that are not customer demand — colleagues, the 3PL, carriers, contractors. **14 of 214 tickets** move there (3 open, 11 closed). The sidebar item stops being a `SOON` placeholder.
- **Routed, not dropped.** These threads carry forwarded customer requests, so the blocklist treatment would discard real work irreversibly. One row in `sender_directory` moves a domain either way.
- **`sender_directory` drives it** — the table and `NON_DEMAND_LABELS` already existed for `cluster:tickets`; they simply never touched the queue. Added `qiriness.com` (internal, also derived from `SUPPORT_MAILBOX`), `colissimo.fr` and `laposte.fr` (courier). Directory now holds 9 rows.
- **`retailer` stays in the queue.** Nocibé and Marionnaud open 14 tickets between them and those are reorders — real B2B demand. Covered by a test.
- **Classification is read-time and hash-free.** `ticket_first_inbound` now carries `from_email` and `ticket_queue` surfaces it as `requester_email`; the service resolves it to a label and **the address never reaches the browser**. A ticket with no inbound message stays in the queue rather than being assumed internal.
- **The agent skips non-demand threads** — flag cleared, no LLM call, same treatment as an out-of-scope subject. Checked in the runner, because the sender lives on the message and `isInvestigable` only sees the ticket row.
- Conversations deliberately shows no priority sort: priority is a customer-waiting-time judgement and means nothing here.

## Support panel: consented contacts CSV (2026-08-17)

- **Download icon in the top-right corner of the reachability tile** (28x28, no visible text), columns Name / Email / Tickets / First contact / Last contact / Ticket categories. Its `aria-label` and tooltip both name the count and the filter, because the tile's headline figure is 22 while the file holds 8 — an unlabelled icon would read as exporting everything above it.
- **Consent is the query filter, not a column** — the file holds the 8 marketable people, not all 22. The 14 who may be replied to but not solicited are absent rather than flagged, because a flag gets ignored.
- **One row per person, not per ticket.** Two of the eight wrote three times each; their subjects are joined into one cell so a mail merge cannot send them the same campaign three times.
- **Contact dates come from `first_message_at`, never `created_at`.** All 214 tickets carry `created_at = 2026-08-09` — the single day the corpus was synced — so that column would print one date on every row and read as a bug. `first_message_at` spans 69 distinct days. Two columns rather than one because a row is a person: the two three-ticket contacts span 2026-05-28 to 06-25 and 2026-05-25 to 06-08, and picking either end silently would drop the other. ISO `YYYY-MM-DD`, which sorts as text and is not reinterpreted day/month by a French Excel.
- **Built in a route handler, never in the page.** The panel stays pure aggregates; names and addresses leave the database only when someone asks for the file. Each download writes one `data_access_events` row with the count (`purpose: marketing_outreach_list`) — verified in the table. `no-store` on the response.
- **UTF-8 BOM** so Excel does not mangle French names, and cells starting `= + - @` are apostrophe-prefixed against formula injection — the values are whatever a customer typed into a name field.
- Adds an optional `action` slot to `StatTile`, absolutely positioned top-right and out of the label -> figure -> foot reading order. The label reserves right padding so it wraps before reaching the icon. New `DownloadIcon` in the shared set, on the same 24x24 / 1.6px grid.

## Support panel: "Who is writing to us" (2026-08-17)

- **New section splitting tickets by whether the sender's purchase is visible: 111 verified buyers, 34 from customers with no orders, 69 unmatched**, of 214.
- **Reachability is reported twice, because it is two questions.** Those 34 tickets come from **22 distinct people; 22 have a deliverable address, only 8 have marketing consent.** Everyone in the group may be replied to about their own ticket; 14 of them may not be solicited. Counts are of people, not threads — a list built from ticket counts would be 1.5× too long.
- **The copy never lets a zero-order customer become a non-customer.** A physical-shop sale never reaches Shopify, so an unmatched address is silence about our records, not a denial about the person.
- **Per-subject table, filtered to subjects where someone unverified wrote.** The finding it surfaces: **13 of 21 `promotions` tickets (62%) come from people who have never ordered** — the highest share on the board. `order` 11 of 49, `product` 4 of 22, `return_exchange` 4 of 18.
- **Two new views** (`support_purchase_states`, `support_purchase_by_category`), taking `06_analytics.sql` to 21. They count raw facts; the state *names* stay in `purchase-verification.mjs`, the same rule that keeps `is_vip` out of the customer views. The per-category cut carries ticket counts only, since distinct-customer counts do not sum across subjects.

## Purchase verification and photo evidence (2026-08-17)

Two new investigation tools, plus the attachment metadata that makes the second one possible.

- **`verifyPurchase` — three states, not a boolean.** `known_buyer` / `known_no_orders` / `unknown`. Measured over the 214 live tickets: **111 / 34 / 69**. Those 34 are real addresses in `customers` with zero orders — newsletter signups, or an email given at a till — and a binary check would have had to call them either verified or unknown, both wrong. Only `known_buyer` satisfies the new `purchase_verified` need.
- **Neither unverified state is allowed to become "not a customer".** A physical-shop sale never reaches Shopify, so the `purchase_unverified` caveat prohibits the denial outright and the unmet need asks the new `purchase_channel` question (our site, or a shop?) instead of concluding.
- **The product cross-check runs against the last order's line items**, not the 116-product catalogue — but borrows the catalogue's IDF weights via a new `productLookup.catalogueIndex()`, because an index over three titles makes every word equally rare. Ambiguity is tested before absence: `matchProduct` returns `match: null` on a tie, and reading that as "not in the order" would contradict a customer about an order containing both candidates.
- **`checkPhotoEvidence` — what they said, and what arrived, kept separate.** After backfill, over 203 tickets: **7 carry a real photo, 36 mention one and attached nothing, 160 neither.** The 36 are the drafting case. 6 of the 7 photos sit on `delivery`/`return_exchange`/`order`/`product` problems.
- **New `ticket_messages.attachments jsonb` — metadata only, never bytes.** Ingestion now fetches `name`/`contentType`/`size`/`isInline` from Graph after the blocklist gate (so blocked mail costs no round trip) and `$select`s around `contentBytes`. **Nullable on purpose**: NULL = never fetched, `[]` = fetched and empty, and the check reports the first as `attachment_type_unknown` rather than "no photo".
- **The boolean could never have done this.** The dry run's first 12 rows held an LED-mask manual, invoices, a packing list, two POs and the T&Cs — all identical to a photo under `has_attachments`. Signature logos (`image001.jpg`, 30 KB, inline) are excluded by name pattern plus a 50 KB inline floor; the real photos run 400 KB–2 MB.
- **`npm run attachments:backfill[:dry-run]`** — filled **48 of 48** historical messages, 10 carrying a photo, 0 failures. `attachment_type_unknown` is now zero across the corpus. This also confirms the `README.md` item-2 mailbox mismatch is resolved: Graph accepted every stored id.
- Both tools stay out of `cosmetovigilance`, whose tool set remains deliberately empty.

## Fulfilment panel: a returns/refunds tile in the Delivery section (2026-08-17)

- **`Returned or refunded` is the first measured figure in an otherwise blocked section: 3 of 2,006 orders, 0.1%, €44.49.** One refunded in full (`#6398`, €32.03) and two in part (€6.23 each). Counted per order, not per refund line.
- **Returns and refunds are reported separately and never summed, because they disagree: 3 refunds, 0 returns.** `return_status` reads `NO_RETURN` on all 2,006 orders — a value Shopify recorded, not an empty column — so the zero is real. But all three refunds were issued with no return record, which is what a return agreed over email and settled by hand looks like. The tile never takes a `good` tone and a note beside it says 0.1% is a floor until someone confirms whether returns are meant to be raised in Shopify at all.
- **Four columns added to `fulfilment_summary` and its per-channel twin** (`refunded_orders`, `fully_refunded_orders`, `returns_opened`, `refunded_amount`), fed by `total_refunded` and `return_status` newly selected in `order_fulfilment_timing`. Added to both summary views deliberately: they back the same TypeScript type, and a column on one alone is a channel section silently reporting zero.
- **Read with `num`, not `count`, so a database whose views predate this renders a blocked tile naming the fix rather than "0 orders were ever refunded".** Verified in that state — the deployed views still need re-applying, and the drop-and-recreate is required because the baseline uses `create view` with eight views depending on `order_fulfilment_timing`. See `VALIDATION_LOG.md` item 0.

## Fulfilment panel: carriers moved under Delivery, outcome columns stubbed (2026-08-17)

- **The carrier table now renders after the Delivery section rather than before it.** Dispatch timing barely varies by carrier (Colissimo 24.5h, GLS 23.3h); what the table is asked at is a delivery question. It is a peer section, not nested inside Delivery — the blocked delivery tiles keep their own section so a working table does not read as broken tiles among them.
- **Three new columns — `Lost`, `Damaged`, `Delivered late` — ship empty on purpose.** They are wired to the table and to no data source. Nothing in the system can fill them today: no carrier scan events reach Shopify, and a ticket stores only that its subject was `delivery`, so a lost parcel, a broken bottle and a late one are the same row.
- **Typed `number | null` and mapped to `null`, never through `count()`.** A coerced `0` would print "COLISSIMO: 0 lost", which is an unmeasured claim about a carrier. The cells render as em dashes over the same hatch used for a missing bar, with a note under the table explaining the gap. Wiring a real source later is one `read` per column in `mapCarrier`.

## Support panel: tickets per month as a contact rate (2026-08-17)

- **Every bar on *Tickets per month* now carries its share of that month's orders in brackets**, and it reverses the reading. The bare counts make July the worst month at 85 tickets; against 450 orders that is **18.9%**, while June's 76 over 324 is **23.5%**. Measured on the dev store: May 7.5%, June 23.5%, July 18.9%, August 20.8% so far.
- **No migration.** The denominator is `fulfilment_by_month.orders`, joined to `support_by_month` in `support-service.ts` rather than in SQL — the two views group on different clocks (`first_message_at` against `processed_at`), so a join either way drops the months the other side owns. See `DECISIONS.md § Insights`.
- **The first month of mail is marked as a floor.** Orders start Feb 2026 and the synced mailbox starts May 2026, so May's 7.5% is a partial mailbox over a whole month of trading — the lowest bar on the chart, and indistinguishable from a genuinely quiet month. The panel derives this from the two series rather than hard-coding a date, the same way the current month is already marked partial.
- A month with no order row prints the count with no rate, never `(0.0%)`.

## Dashboard fixes (2026-08-16)

- **Insights dev page no longer depends on Google Fonts.** The root layout stopped using `next/font/google` because the local dev environment blocks the font fetch with `EACCES`, which can leave the dev page behind a blank/error overlay. The app now uses the existing system/Satoshi fallback stack from CSS with no network font request.
