<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Cases

**Message → thread → case (2026-10-02, migration 61).** A ticket is still one email thread (one Graph `conversationId`) and nothing is ever merged or deleted. Above it, `cases`: several threads may share one `case_id`. The investigation and drafting read the whole case. The reply goes to one message of it, chosen by code. Decided with the business: **additive**. Case files, drafts, outbound actions, `case_current` and snoozes stay keyed per ticket, and only the case's reply thread is investigated and drafted. A full re-key to `case_id` waits until linking has been measured on real mail.

### Deterministic first; the model only between a handful of candidates

The `link` pass (`agent/src/cases/`) decides once per new thread, after categorisation and the order passes (the subject, the order and the parcel are what it decides on) and before the investigation (which then reads the whole case).

| Step | How | Result |
| --- | --- | --- |
| exact duplicate message | unique `graph_message_id`, re-delivery skipped (already built) | not processed again |
| who the customer is | `requester_email_hash`, **never `customer_id` or a name** (marketplace orders mint one synthetic customer per order; the hash is what the duplicate and related lookups were measured on) | |
| listed sender or one of our own threads | `sender_directory`, `sender_label` | new case (`excluded_sender`): a retailer's weekly order template is the false positive § *The semantic tier, revisited* measured |
| no other case of this customer in 60 days | query | new case (`first_contact`): no retrieval, no model |
| candidates | other cases sharing the parcel, the order, a family this one may continue, or a message the embedding scores ≥ 0.90, **or the same customer active on it within 14 days** (`recent_same_customer`); at most 5. A candidate is not a link: no rule links without an order or a parcel, so the same sender still never links on its own | |
| same tracking number on exactly one candidate, no contradicting order | rule | link (`tracking`) |
| same order on exactly one candidate of a compatible family | rule | link (`order_family`) |
| the only candidate on this order/parcel, family unknown on one side | rule | link (`unique_match`) |
| still plausible candidates | the Case Linker, if switched on | `LINK:<case_id>` or `NEW_CASE`, parsed strictly; anything else is `NEW_CASE` |
| nothing plausible | | new case (`no_candidates`) |

Every decision is a `case_links` row, a new case included, with the candidates and their reasons, so « why was this not linked » has an answer.

**There is no explicit-reference rule.** No reply we send carries an internal case reference, so nothing could match one. It is future work, not built.

### Three earlier rules are reversed, on purpose

1. **« Sender + quoted order number is deliberately not a rule »** (§ *Detection: two deterministic rules*). It was rejected because a link then **silenced** the second ticket: a delivery ticket and a later refund ticket about one order would have cost the refund its answer. A case link silences nobody. The case's reply target is the newest unanswered customer message on whichever thread, and the investigation reads every thread. So the same order is now a rule, guarded by the issue family. A delivery that becomes a refund is one case. A product question on that order is not linked by any rule.
2. **« If a semantic tier is ever revisited, it must surface rather than link »**. A model now links, under three limits: only between candidates the deterministic retrieval produced, with `NEW_CASE` as the answer to any doubt or failure, and **off by default** (`CASE_LINKER_ENABLED`). The embedding itself still decides nothing: it can make a case a candidate, never link it.
3. **« The related ticket's mail is deliberately not in the transcript »** (§ *Investigation*). The case is now one transcript in email-time order, because a customer who writes « toujours rien » on a new thread is having one conversation. What kept two conversations from reading as one is kept: every message from another thread is marked « AUTRE FIL DU DOSSIER : « subject » » in the investigation, and « autre fil » in the drafting history. Only the TEXT widens. The situation match, the trigger message and the clock stay on the thread's own inbound messages.

### The duplicate link becomes a case link; the related link stops being written

- **`duplicate_of_ticket_id`.** A new duplicate (reply chain, or identical body inside the hour) now **joins its original's case** instead of being silenced, and the reply target answers one message: one reply, on the thread the customer last wrote on. Existing links were folded in by migration 61, chains followed to their root. The column and its draft skip stay for those rows.
- **A thread still flagged as a duplicate never holds the reply target.** It is skipped by the investigation and by drafting, so if its copy of the message were the target, the original would be skipped too, as not the reply thread, and nobody would answer. Found reviewing the migration's risks before it was applied. **Mutual pairs** (each thread flagged as the other's duplicate: 3 pairs on 2026-10-02) were joined into one case by 61. Both threads stay flagged, so that case has no target. Nobody answered them before cases either: the double flag silenced both, and clearing one is a person's call.
- **A ticket inserted without a case opens one** (trigger `tickets_open_case`). The worker creates the case itself. The trigger is the net for a worker still running code from before 61, whose inserts would otherwise fail the NOT NULL and stall ingestion. Such a thread stays `pending`, and the `link` pass decides it once the new code runs.
- **`related_ticket_id`.** No longer written. A similar message is now a candidate for the `link` pass. The drafting merge that read it is replaced by the case's conversation. **Known cost while the Case Linker is off:** a chase with no shared order or parcel (the ~3 embedding-only pairs measured on 2026-08-19) becomes `model_off`, a new case. It loses the cross-thread apology it would have had through the related link. The candidates are logged, and `cases:replay` lists them.

### Issue families are configuration

`issue_family_members` (subject or situation → family) and `issue_family_transitions` (which family may become which) are per-shop rows, seeded by migration 61 from `Email-Example-Queries.md` and the subject taxonomy. Another business draws the lines elsewhere without a code change. A subject with no family (`b2b`, `other`…) is never linked on family grounds. A candidate's family is read from its latest investigated situation, else its latest thread's subject. A new thread has no situation yet (it is matched during the investigation), so it uses its subject.

### The reply target is code's, and stores no address

`caseReplyTarget` (`scripts/lib/case-reply-target.mjs`) returns the newest message with `actor = customer` that no later outbound message on any thread of the case answers. It orders by the email's own time, never by ingestion order, the newest row or the oldest thread. A colleague or partner is never a target, and an undated message is neither target nor answer. It is stored on the case as `latest_actionable_inbound_message_id` + `reply_thread_id`, recomputed after the fold and on every link.

- **`reply_to_email` is NOT stored**, although the brief asked for it. `outbound_actions` deliberately stores no address and reads `from_email` at send time (§ *Sending*). A copy on the case would be a second place a personal address lives, for nothing the message id does not already give.
- **Who acts on it:**
  - drafting skips any case file whose trigger is not the case's target (`not_reply_target`);
  - the investigation skips a thread that is not the reply thread;
  - a person's own reply is refused on any other thread;
  - `preSendCheck` reads later messages across the whole case, so a customer writing again or a colleague answering on another thread cancels the send exactly as on this one.
- **A case whose target was never computed has no case gate**, rather than every draft refused. `cases:targets` computes them all.

### Everything that counted threads counts cases

**Same customer within 14 days is a candidate (2026-10-02).** This reverses « the same sender alone never makes a case a candidate ». On 25 Sep one customer opened five threads in five hours about one checkout problem. One of them, `f7f66386` (« I have changed my phone number three times »), shared no order, parcel, wording or subject family with the others, so it was decided `no_candidates` and the model never saw it.
- Now another case of the same customer active within `RECENT_SAME_CUSTOMER_DAYS` (14) is a candidate.
- **It is still not a link.** The rules link only on an order or a parcel. With the model off the thread is a new case, logged with the candidate; with it on, the Case Linker decides.
- **14 days, not 72 hours, by the owner's choice.** A customer who writes twice within two weeks is probably writing about the same thing. When they are not, it is a fair test of the model.

**A case with a live thread never leads with a finished one (62, 2026-10-02).** The lead was the reply thread, else the most recently active thread.
- **The failure:** `cddd49b6` and `93d7d9c3` are the same question, sent 5 minutes apart. We answered the second and resolved it, and the first stayed `awaiting_human`. Nothing was owed, so the case led with the resolved thread and went to Closed, with the awaiting thread hidden behind it.
- **Now:** the lead is the reply thread, else the most recently active thread still live, else the most recent.
- **Not done, on purpose:** linking still writes no status. A thread like `cddd49b6`, whose question was answered on its twin, comes back to the queue, and a person closes it. That only happens with statuses from before cases (the backfill): live, a thread that joins a case is new and owed a reply, so it leads.

- **The queue** shows one row per case, its lead thread (the reply thread, else the most recently active thread still live, else the most recently active), ranked on the case:
  - every customer message on every thread (`contactPoints`);
  - the case's unanswered wait;
  - the highest level and the folded status;
  - the situation and the order borrowed from the most recently investigated thread when the lead has none.

  The other threads are behind « Show every thread of a case ».
- **Auto-close** measures idleness on the case, and any thread that is level 4, awaiting a person or snoozed holds the whole case open.
- **A new message wakes every snooze of the case**, and a link wakes the target case's snoozes (`case_changed`).
- **A forwarding acknowledgement goes once per case.**
- **Insights support figures count cases** (`case_facts`; the output columns keep the name `tickets` so no panel contract moved; the labels say « Cases » / « Dossiers »). The rules folding several threads into one row live once, in that view:
  - the earliest thread's subject;
  - the highest level and the worst mood;
  - first reply measured across threads.

  The unread `support_by_*` views stay per thread. The fulfilment contact rate stays per order.
