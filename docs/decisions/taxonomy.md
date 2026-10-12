<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

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
