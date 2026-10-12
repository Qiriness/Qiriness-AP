<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

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

### A reply is now written knowing what we already said (2026-09-21)

Drafting read the trigger message and the thread's **envelopes** — `'ticket_id,direction,received_at,sent_at'`, no bodies — and that read answered one question, `describesChase`. So a draft could re-ask a question our previous mail had already asked, re-explain what it had already explained, and contradict what it had promised, with nothing in the pipeline able to notice.

**The envelope read was right for its question and became the whole view by default.** It was written to answer "did they write again before we answered", and pulling bodies for that would have shipped every email in the thread to a pass that reads one. It is now `threadForDrafting`, and `describesChase` takes exactly the same rows it always did.

**Our replies go ABOVE the new message**, on the same argument that puts the customer's words before the case file: the model should read what they wrote already knowing what it answers. Placed after, our own reply arrives as a footnote to a question the model has finished interpreting.

**Two blocks with separate budgets**, ours and their earlier messages, so a long complaint cannot crowd out the answer we gave it. Older messages give way **whole** rather than being head-sliced: the commitment — « nous revenons vers vous dès que le transporteur répond » — is usually in a reply's last paragraph, which is exactly what a head-slice drops.

**The related ticket's mail is deliberately not in the transcript.** `thread` merges a sibling ticket's envelopes because the chase spans both, and that is right for the chase. The transcript is a different question — what did we say on *this* thread — and a second conversation spliced into it would read as one.

**This widens the prompt's personal-data surface, deliberately.** An outbound body averages 1,758 characters and carries the customer's name and order numbers. The existing narrowing holds: still no `from_email`, still no `from_name`, because the reply is composed from the case file and an address in the prompt is an address the model can quote back.

**The sign-off is removed from every history message, and that is measured rather than tidy.** Ticket `718086fd` is a Spanish thread whose middle replies are French and end « Bien cordialement, Service Client Qiriness ». Shown those, the model ended its Spanish reply with the French signature and failed the `signature` check, which requires the approved wording *translated* outside French. **Framing did not fix it** — the block already said not to recopy, and the draft recopied anyway. The signature and closing line are approved, stored fields reproduced from the system prompt on every reply, so in the history they carry no information at all and the only thing they can do is be imitated. Same removal `draft-checks` performs before looking for an invented closer.

**The inbound block is « reçus sur ce fil », never « du client ».** It said `du client` for one run, which is wrong for the reason § *Direction: the Inbox is not only inbound* and § *A colleague is not a customer* already give. `c5ec7404` is the case: **four of its five inbound messages are internal staff and Deret coordination**, and the trigger message is a colleague's. Labelling that as the customer writing invites a reply to the wrong person, and the block now says so in as many words.

### What the thread in the prompt is actually worth, measured (2026-09-21)

Re-drafted the 19 threads that carry both a customer reply and one of ours. **All 19 drafts changed.** The result is a real improvement in continuity and a narrow imitation risk, and the honest summary is that the mechanical checks cannot see either.

**The check count is not a usable signal at this size.** `checks_passed` went **14 → 12 of 19**, and `718086fd` passed on one run and failed on the next **with identical code**. A two-point move over 19 samples is inside the model's own variance; anyone quoting it as a regression is quoting noise.

**Register drift is narrow, not general.** Across all 19: the French closer appears in a non-French reply on **1** (`718086fd`), and the title salutation is lost on **1** (`d6d0d1c3`, where our own earlier reply used the first name). Average length 500 → 529 characters.

**What the reading shows.** `8236165a` now says « Je vous confirme que votre commande nous est bien revenue » in the first person our previous reply established, where it used to open as though nothing had been said. `d6d0d1c3` newly acknowledges the mask that is still missing *and* the replacement already sent. `1e4890dd` volunteers the dispatch date and parcel number.

**The one clear content regression is a thread that was already broken.** `c5ec7404` now asks for a screenshot and a photo — a question the case file does not license — on a ticket whose case file was written from a colleague's message and does not know we had already shipped the replacement with a tracking number. The history made an existing data problem visible rather than causing it.

### A re-ask guardrail was built, measured, and removed (2026-09-21)

The obvious check on top of the history block: read our own sent replies through `ASK_TERMS` and flag a draft that asks again. It does not work, and the numbers are why rather than an opinion.

**Measured over the 25 threads carrying both a customer reply and one of ours.** Whole-body matching claimed **2.4 fields per thread** — `product_name` and `reaction_product_name` each fired on 10, always together, because they share the single term « produit », which any reply mentioning a product contains. Narrowed to sentences carrying a request cue it fell to **0.3 per thread**, and about half of what survived was still wrong: « Avez-vous effectué un retour de produit ? » is not a request for the product's name.

**The direction is what breaks it.** `ASK_TERMS` exists to check that a draft DOES ask for something, where a false positive costs a reviewer a minute. Read backwards the failure inverts — a wrong hit suppresses a question the case file licensed, and the customer is never asked for the one fact that would let us help them.

**Not kept as an advisory counter either.** A count nobody can trust is the `categorisation_confidence` mistake: a field that reads like information and is not. The prompt carries the instruction instead, and a real guardrail needs the question recorded when it is **asked** rather than recovered from prose afterwards — which is the case state, not a regex.

### An inbound message is not a customer, and the renderer now says which (2026-09-21)

Three prompts had been told, separately and in prose, that an inbound message might not be from the customer — the drafting history block, the closure check, the reconstruction. A correction repeated in three places is a correction the DATA should have been making.

**`tickets.sender_label` describes the THREAD, from the address that opened it.** A conversation is not made of one sender. Measured: **38 inbound messages from `lap-groupe.com` across 22 tickets**, **14 from Deret across 10**, and **10 from Nocibé** — most of them arriving on threads a customer opened, where the ticket's own label says nothing about them.

**Rendered as « client » or « reçu », they were read as the customer speaking, and three times they were.** A draft asked the customer for a screenshot on `c5ec7404`, whose trigger message is a colleague's. The closure check reported « le client confirme que la commande a été traitée » about `fcf4ca11` — `tlamzouki@lap-groupe.com` writing to another colleague. And `e8903620`, which I had labelled a genuine customer closure, turns out to be `dnouali@lap-groupe.com`: the customer wrote once, at the start, and never closed anything.

**So `senderRole` resolves a role per MESSAGE**, from the directory that already exists, and every renderer uses it: the investigation transcript, the drafting history, the closure prompt, the reconstruction. The vocabulary is the one a reader needs — « client », « collègue (LAP Groupe) », « prestataire logistique », « transporteur », « revendeur », « prestataire » — not the table's internal labels.

**The address travels and is never rendered**, which reverses the narrowing on `messageForDrafting` in letter and keeps it in spirit. That column excluded `from_email` because *an address in a prompt is an address a model can quote back to a customer*; it is now selected, resolved to a role, and dropped. `messageForInvestigation` has always worked this way for the sender-directory lookup.

**An unclassified domain is a customer**, deliberately. A sender nobody has filed is read as demand rather than quietly discounted, and a label with no display name falls back the same way rather than leaking a raw key into a reply.

**The closure check refuses a non-customer in CODE, not in the prompt.** The instruction is the belt and `senderRole !== 'customer'` is the braces — the half that cannot be talked out of it, and the half that costs no model call. It took the code gate from 11 of 16 to **13 of 16** settled before any call, and the eval from 15/16 with one unstable case to **16/16 stable over 5 repeats**.

**This does not fix the underlying problem, and should not be read as doing so.** Internal and 3PL mail is still landing on customer tickets — `45c0a2b7` is internal coordination about three different customers, reconstructed as one case. Naming the sender stops the agent mistaking it for the customer; keeping it off the ticket in the first place is `requester-repair`'s problem and is not solved here.

### A delivery date is what should happen, never what will (2026-09-22)

**Decided by the business, 2026-09-22: never promise a deadline, and a date is given only as an expectation** — « vous devriez le recevoir sous 2 à 3 jours ouvrés », never « vous le recevrez » or « il arrivera le 12 ». The carrier decides when a parcel arrives; we can only say what is usual.

This closes the conflict `5232645f` exposed, where « never contradict what we promised » and « never announce a deadline » appeared to disagree. They do not: our 2 September reply had promised « vous devriez le recevoir sous 2 à 3 jours ouvrés » — already hedged — and restating it hedged honours both.

**THE MODEL WAS RIGHT AND THE CHECK WAS NOT.** Measured over all 123 stored drafts: 29 sentences carry a date or a delay, **27 are past facts** (« a été expédiée le 13 août »), and the **one** future estimate was already hedged. `no_promised_deadline` failed it anyway, because its `sous \d+ à \d+` pattern cannot tell a carrier window from a promise about our own conduct.

**So the fix is a carve-out, not a loosening.** `no_promised_deadline` exists for « nous revenons vers vous sous 24 heures » — a commitment about us that nobody in the building agreed to — and it still catches every one. It now removes a HEDGED DELIVERY sentence before matching, through the `prepare` hook `FORBIDDEN_PATTERNS` already had. Sentence-scoped, so a hedge excuses its own sentence and not a response deadline in the next one.

**The other half is a new check on every verdict.** `no_certain_delivery` fails the future indicative — « arrivera », « sera livrée », « vous le recevrez », « parviendra ». Past forms are not matched, so « a été livrée » stays a fact. **It has never fired on a real draft (0 of 123)**, and is kept for that reason rather than despite it: the pattern is narrow enough that a hit means what it says. After the change, both checks fail **0 of 123** stored drafts.

### A reply that has already been sent is not drafted again (2026-09-21)

`draftDecision` refused a duplicate link, an internal sender, a level 4 and a question with nothing to ask. It had no opinion on whether the message had **already been answered**, because nothing in drafting could see our own side of a thread.

**Measured once it could: 59 of 138 investigations sit on a thread carrying an outbound message newer than the trigger, and every one of them produced a draft.** The queue went 138 → 63 when the check went in. Nearly half of drafting was writing a reply to mail a person had already handled, which is exactly what it looks like from the review side — the last message in the thread is ours, and the draft says the same thing again.

**Strictly newer than the trigger, not "the thread ends with our reply".** The difference is the ordinary case: a customer who writes, is answered, and writes again has an outbound message in the thread and is owed a reply. What disqualifies a draft is a reply that came *after* the message being answered.

**Envelopes only, and no model call.** Direction and timestamp. This is a guardrail, so it is code — a question with one right answer, asked of data already loaded.

**It gets its own helper rather than reusing `timeOf`.** That one returns 0 for a message with no timestamp, which is right where it is used — ordering a thread, where an undated message sorting first is harmless. Here 0 would make an undated *trigger* older than every reply in the thread and suppress a draft on a ticket nobody had answered.

**On this corpus it is mostly history, and not only history.** The mail was imported after a person had worked it, so the human reply predates the agent's first look. On live mail the same shape appears whenever somebody answers in Outlook before a draft is reviewed — which, with drafting operator-triggered and 120 drafts unread, is the normal case rather than the edge one.

**Counted, not filtered in the query.** `skippedBy.already_answered` is how anybody finds out how far behind the queue is running, and a skip that leaves no number behind cannot be argued with later.

**A consequence for the review queue as it stands: 59 of the 123 stored drafts are on already-answered threads.** They were written before this check existed and are still there. Reading them is reading replies to settled mail.

### A case the customer has closed gets a closing reply, not a full one (2026-09-21)

« La commande a effectivement été livrée. Mes inquiétudes n'étaient pas fondées. Je vous remercie d'avoir répondu à mes messages. » was answered with a reply restating the dispatch date and the parcel number, and inviting the customer to get in touch again. Nothing in it was wrong. None of it was wanted.

**5 of the 16 threads where a customer wrote after our reply are closures** — about a third of exactly the population multi-turn work is for.

**The decision is made in two halves, and the order is the design.** `closureAllowed` asks in **code** whether anything is outstanding on our side: a `missing` entry, a handoff, any verdict but `answerable`. Only when the dossier is clear is the message itself read, by one constrained boolean on the cheap tier.

**`d6d0d1c3` is the case that fixes the order.** « J'ai bien réceptionné le colis. Merci encore » closes the delivery question — and the free mask is still missing, so the case file reads `needs_human`. Asked first, a model reading that message alone says the case is closed, and closes a case that owes the customer something. The code gate never lets the question be asked there. Two more of the seven shortest replies in that set, `5836ab80` and `bdc3f08c`, are short, follow our reply, contain no question mark and carry **new information** — so a structural heuristic would have wrongly closed 2 of 7 as well.

**A closure is not a verdict, and that is why `intent` overrides it rather than joining it.** Every other key in `INTENT_RULES` is a verdict, because until now what a reply should do was a property of the case file alone. Here the case file is `answerable` either way; what makes the reply three lines is the customer having said they need nothing more.

**The facts obligation inverts here, uniquely.** Every other intent set obliges the reply to pass established facts on, because a useful fact withheld is one the customer must ask for again (§ *Every verdict gets a reply*). Once they have said they need nothing, the same fact is padding — so `closing` forbids facts outright and says so, rather than leaving the structural rules to pull the other way.

**Nothing is sent silently and no ticket is closed by this.** A closing reply is still a reply, which is what the § above requires; `draftDisposition` already returns `terminal` for an `answerable` with no handoff, so the status behaviour is unchanged.

**A failure is never a closure.** A throw or a rate limit resolves to `closes: false` and the ordinary reply gets written. The other direction — a 429 quietly shortening a reply to a customer still waiting on us — is the one worth engineering against.

**The delay apology stands down on a closing reply, and is reported rather than dropped.** On `1e4890dd` the thread proves a chase, so the check fires; the message being answered thanks us for replying. An apology for our delay, in the reply that closes the case, answers a complaint the customer has just withdrawn. `passed: null` keeps the line and the reason visible.

**Off by one empty env var.** `AGENT_CLOSURE_MODEL=` leaves the reader unbuilt, and an absent reader means no closure is ever detected — the switch is the absence of the reader rather than a flag inside it, so there is no half-wired state.

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
