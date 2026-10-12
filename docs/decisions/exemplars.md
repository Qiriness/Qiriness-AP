<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

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

### The chooser is told when to choose each situation, not only what it sounds like (2026-10-02)

The chooser decided from wording alone: a canonical question and up to three phrasings per candidate. Situations whose phrasings sound alike (D-01 / D-05 / D-37, P-17 / P-22, CV-01 / CV-04) could only be told apart by what the customer literally wrote.

- **One line per situation, `choose_rule`** (« Choose when … Do not choose … »), written by the owner for all 40. It sits in `Email-Example-Queries.md` under each entry's metadata and in `support_exemplars.choose_rule` (migration 57).
- **The chooser sees it** beside each candidate's question and phrasings, and is told to apply it over any resemblance in wording, including when NOT to choose.
- **It never moves the score.** It is not embedded; the matcher's bands, margin and the rules-based tie check are unchanged. The rule only matters on a near miss or a tie.
- **The document is the source.** The importer writes the column from the line, so an entry without one clears it.

### A near miss is settled by a model, and it went live without a shadow phase (2026-09-15)

**This narrows « one exemplar or none, never a shortlist » above, and the reasoning there still holds.** That rule refused to hand a shortlist downstream because the choice would land « somewhere with less information ». A model reading the full opening message beside the candidates has *more* information than the embedding score, so the shortlist now goes to it — and nowhere else. The investigation still receives one situation or none.

**Where it runs:** only when the matcher scored `near` (0.55–0.65) or `ambiguous`, only on the opening message, only among the matcher's own candidates (subject-filtered, top 3), and before the rules load — so the situation it picks drives the evidence collected and the rule selected, exactly as a mechanical match does. A score of 0.65+ stays mechanical unless the runner-up is within `minMargin` (0.05 since 2026-09-30); below 0.55 nothing is plausible enough to choose between.

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

**Raised to 0.05 on 2026-09-30, because what "ambiguous" costs changed.** The 0.01 cut was made when an ambiguous match was discarded. Since the situation chooser, an ambiguous match is read by a small model beside the candidates, and the rules settle it if the model says none and the tied situations answer alike (see « A near miss is settled by a model »). A wider band now costs a cheap-tier call, not the match — so the 0.01–0.05 close calls the score used to commit alone get a second reading. **The 45% the sweep predicts does not happen in production**, because production searches within the ticket's subject and the unfiltered sweep does not. Replayed through the real search on 2026-09-30, 158 opening messages with 77 at 0.65 or more: median margin **0.108**; ties under 0.01 = 5, the new 0.01–0.03 band = **3** (about 4% of matches). On those 3 the chooser kept the score's pick twice, both right when read (P-18 on a refused welcome code, D-06 on a chased re-shipment), and answered none to a customer's thank-you (« j'ai hâte de recevoir enfin ce colis ») that the score would have filed as D-36, the late-order-want-a-refund situation. 3 of 3 against the score's 2 of 3: the right direction, far too few to call a rate. The same day it went on to **0.05**, which sends 15 of the 77 (19%) to the chooser: below 0.10 would be 45%, below 0.30 94%. **The 0.03–0.05 band (10 tickets) has not been read** — the chooser agreed with 47 of 53 clear matches in the 2026-09-15 control, and whether those 6 disagreements were catches or overrides of a right match is still unknown. That is the check before going wider.

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
