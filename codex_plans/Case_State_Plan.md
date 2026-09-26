# Case state — from "new email → draft" to "new event → case → next action"

Plan, started 2026-09-26. **Stages 1–4 are built and applied; stage 5 is next.** It is the proposal
of 2026-09-26, questioned against the code and the database, with the answers the
business gave the same day. When a stage ships, its rule moves to `DECISIONS.md`,
its build to `CHANGELOG.md`, and its map to `APP_SCHEMA.md`, as usual.

**The principle.** Models read events, extract facts, investigate ambiguity and
write replies. Code controls chronology, state transitions, obligations, draft
freshness and when a pass runs. This is an evolution of the Case Manager, the
investigation and drafting, **not a redesign**, and it keeps the rule from
2026-09-22: *the Case Manager records what a message changed; it decides nothing
else.* What decides is a fold, written in code, over what it recorded.

---

## Where it starts from (measured 2026-09-26)

| | |
| --- | --- |
| `shops.sync_cursors` | `{}`: **no mailbox cursor has ever been saved** |
| `ticket_case_state` | **4 rows** |
| `ticket_investigations` / `ticket_drafts` | 138 / 123 |
| outbound messages stored | 360, all from the Inbox. **Sent Items is never read** |
| tickets | 489 `open`, 127 `closed`, 22 `awaiting_human`, 7 `awaiting_customer` |
| multi-turn labels (`eval/casework-cases.mjs`) | 52 cuts over 17 tickets, 26 inbound / 26 outbound; the Case Manager's next action agrees **7 of 14** |

**Why the cursor is never saved.** `runDeltaPoll` (`ingestion/delta-poller.mjs`)
writes the `deltaLink` only when it reaches the last page, and never saves a
`nextLink`. Any run that dies during the first full read therefore starts again
from nothing, and `--limit` runs deliberately save nothing. So the cursor can only
appear after one uninterrupted full read, and that has never happened.

---

## Decided 2026-09-26

| # | Question | Answer |
|---|---|---|
| Q1 | A Graph resume link expires | Log it and start a fresh full read. Safe, because a message already stored does not retrigger its ticket (§ *Re-delivery is not arrival*). |
| Q2 | Outbound mail sent from Outlook | **A second cursor on Sent Items.** Without it a reply typed in Outlook is invisible and the case state is wrong. |
| Q3 | The 440 old threads | Kept. **Not eligible for automatic drafting** until a genuinely new event arrives on them. |
| Q4 | An events table | **A view over the rows that already exist**, plus one small table for events that have no row today. |
| Q5 | Actor mapping | own mailbox → `support`; `internal`/`contractor` → `colleague`; `logistics`/`courier` → `partner`; anyone else → `customer`. **Deret = `partner`.** |
| Q6 | Order and delivery change events | Dropped for now. **Refund changes only.** |
| Q7 | An older event arriving late | Replay the affected state from that point. Arrival order is not accepted as chronology. |
| Q8 | What is authoritative | `ticket_case_state` stays one reading per message. **A derived `case_current` is the current source of truth.** The Case Manager does not become the workflow engine. |
| Q9 | Obligations | Created by the model, from a closed schema. Cleared by explicit evidence, by system evidence, or by a person in the dashboard. They become **overdue**; they never expire into "done". |
| Q10 | New statuses | None yet. `colleague` and `partner` both map to `awaiting_human`; the UI shows the real `next_action.actor`. |
| Q11 | A stale draft | **Regenerated automatically** when a material state change made it stale. |
| Q12 | The review mail | Sent again for the new version, **once per version**. |
| Q13 | What bumps the version | Every state-relevant event, **including a reply typed in Outlook**. |
| Q14 | Approval vs sending | Separate. A later outbound message is a new event of its own; **nothing fuzzy-matches it to a draft.** |
| Q15 | An approved draft goes stale | The approval is withdrawn and a fresh review is required. |
| Q16 | Evidence values | No sensitive values stored. Customer and order evidence stays as outcome buckets and metadata. |
| Q17 | What evidence work is for | **Consistency and contradiction control**, not saving tool calls. |
| Q18 | When to build the evaluation | **Before** the case-state redesign. 7 of 14 is not a base to build on. |
| Q19 | Enforced evidence reuse | **Out of this phase.** It may come back later. |

## Configurable, not coded (decided 2026-09-26)

The code must work for a company other than Qiriness, so **anything that
varies from one business to another is configuration or data, never a
literal.** This applies to every stage below. Following the existing
convention:
- per-deployment knobs are environment settings read once in `config.mjs`,
  each with a default;
- business facts live in tables (`sender_directory`, the rulebook).

What this plan introduces, and where each one lives:

| Value | Where |
| --- | --- |
| Who is staff, a partner, a courier or a retailer | `sender_directory` rows (already data) |
| Which directory label is which actor (Q5: `internal`/`contractor` → colleague, `logistics`/`courier` → partner, `retailer` → customer) | `AGENT_ACTOR_BY_LABEL`, defaulting to that map |
| The support mailbox | `SUPPORT_MAILBOX` (already config) |
| When an obligation is overdue (2 working days for a colleague, 3 for a partner) | `AGENT_OBLIGATION_OVERDUE_DAYS`, defaulting to `colleague:2,partner:3` |
| The live window kept out of the backlog clear-out | a `--keep-after` argument, not a date in code |
| Label vocabularies (effects, next actors, obligation owners) | generic words in `casework-vocabulary.mjs`; business-specific needs come from the evidence vocabulary, not from new literals |

Measurements and examples in comments and `DECISIONS.md` may cite Qiriness.
Code paths must not branch on a Qiriness value, and tests use example domains.

**Order:** ingestion → Sent Items → timeline evaluation → `case_current` →
obligations and next action → draft versioning and drafting in the poll →
(later) evidence consistency.

---

## Stage 1: make the Inbox cursor stick

> **Built and applied 2026-09-26.** Cursor committed; 0 existing tickets
> touched; the second poll read 1 page (`VALIDATION_LOG.md` item 29).

**Change.** Save progress page by page, not only at the end.

- `sync_cursors.mail_ingest_resume_link`: the `nextLink` of the last page **fully
  written**. It is saved after `processBatch` for that page returns, never before.
- When the `deltaLink` arrives, save it and clear the resume link in the same
  write.
- On start the order is: resume link, then `deltaLink`, then a fresh full read.
- **Expiry (Q1).** When Graph rejects a saved link, clear it, log
  `ingest.cursor_expired` with which key failed, and start a full read. *Check the
  exact error against a real response before matching on it.* Do not guess a
  status code.
- `--limit` keeps saving nothing. That rule is deliberate
  (§ *`--limit=N` means the newest N*).

**The cutover time (for Q3).** When the first `deltaLink` is committed, also write
`sync_cursors.mail_ingest_cutover_at` once, and never overwrite it. Stage 6 derives
draft eligibility from it: a ticket is eligible only when it has an event with
`received_at > cutover_at`. There is no per-ticket flag to backfill or forget, in
line with the rule of deriving the boundary rather than hard-coding it.

**Immutable ids: switch before the first cursor, and translate what is stored.**
(Decided 2026-09-26.) A normal Graph id can change when mail moves folders.
Asking for `Prefer: IdType="ImmutableId"` on every Graph request fixes that. **But
switching the header alone would repeat the 2026-08-20 incident:**

- `graph_message_id` is the idempotency key. `ticket_messages`, `spam_audit` and
  `categorisation_review` are all `unique (shop_id, graph_message_id)`.
- It is also what `knownMessageIds` compares against (`ticket-writer.mjs`).

With new-format ids and old-format rows, every re-delivered message looks new.
All 1,516 would be inserted a second time, closed tickets would reopen, and
`needs_categorisation` would be raised again.

The switch therefore happens in this order:

1. **Translate the stored ids** with Graph's `translateExchangeIds` (REST id →
   immutable REST id, in batches). Cover every table that holds a
   `graph_message_id`: `ticket_messages`, `spam_audit`, `categorisation_review`.
   The forwarding rows point at `ticket_messages` and hold no Graph id. It is a one-off script with `--dry-run`, and it
   reports how many ids failed to translate (mail deleted since). Those keep their
   old id and are counted, not dropped.
2. **Send the header on every delta request.** Measured while building: a plain
   GET accepts an immutable id without the header, so attachments and forward
   need nothing; delta is the only call whose returned ids are stored. The
   poller reads the marker `mail_id_type` at every poll, so the header can never
   run ahead of the translation.
3. **Then** the first full read that commits the cursor. Since no cursor exists
   yet, no saved `deltaLink` in the old format has to be migrated.

Done when a full read after the switch inserts **0** duplicate rows and reopens
**0** tickets.

**Done when:**
1. a full read killed halfway resumes from its page, not from zero;
2. two polls in a row: the second reads one page and ingests only new mail;
3. a corrupted resume link logs `ingest.cursor_expired` and then completes a full
   read;
4. `cutover_at` is set once and survives a later expiry.

Tests go in `delta-poller.test.mjs` with a fake Graph client; there is already a
cursor store to fake.

## Stage 2: read Sent Items

> **Reshaped 2026-09-26: the team replies from personal inboxes** (confirmed by
> the business). Measured the same day on the 1,516 stored messages:
>
> - Sent Items holds **115** items, while the Inbox holds **360** messages sent by
>   the support address. Sent Items is a minor source.
> - **105 messages from `@qiriness.com` / `@lap-groupe.com` addresses are
>   addressed to the thread's customer** (80 tickets). They are support replies
>   sent from a personal inbox with the support address copied, and they are
>   stored as **`inbound`**. Another 348 staff messages do not address the
>   customer: internal notes and forwards.
> - What that `inbound` costs today: such a reply raises `needs_categorisation`
>   and reopens a non-open ticket (`ticket-writer.mjs`), the Case Manager would
>   read it as the customer's message, and `answeredSince` counts only
>   `outbound`, so it does not count as an answer. **0 of the 123 existing drafts**
>   were written after one of these replies, but automatic drafting would
>   meet it.
> - Replies we never see (sent from a personal inbox without copying support):
>   of 179 customer replies carrying `In-Reply-To`, 63 answer a message we do not
>   hold, but 53 of those are the first message stored on their ticket (history
>   before our window). **At most 10 (about 6%)** look like a reply we missed.
>   Reading personal mailboxes is not proposed.
>
> **Refinement of Q5, decided 2026-09-26 and built the same day** (`isStaffReplyToCustomer`; 95 stored messages on 55 tickets re-filed by `staff-replies:backfill`): a staff address
> (`internal`) **writing to the customer** (customer in To/Cc) is actor
> `support`; a staff address not writing to the customer is `colleague`. This is
> deterministic from the stored To/Cc. It fixes the three effects above at
> ingestion (no reopen, no re-categorisation, counts as answered). This work
> moves ahead of the Sent Items cursor, which becomes the cheap second half of
> the stage.

**Change.**

- `graph-client.getDeltaPage` takes the folder (`inbox` | `sentitems`) instead of
  having `inbox` written into the URL.
- A second cursor, with the stage 1 behaviour, under
  `mail_sent_delta_link` / `mail_sent_resume_link`.
- The poll ingests **both folders before any other pass runs**, so events from the
  two folders are ordered by `received_at` within a poll (see stage 4, late
  events).

**Rules for a Sent Items message:**

- Direction is `outbound` and the actor is `support`. There is no spam gate:
  this is our own mail.
- **Deduplicate on `internet_message_id` where it is present.** A reply that also
  comes back to the Inbox (the source of today's 360) exists as two Graph ids
  with one internet message id. Measured 2026-09-26 on all 1,516 stored messages:
  **0 null** (inbound and outbound), **0 values shared by two rows**. The check is
  in code (look it up before inserting), and there is **no unique index** until
  the data with Sent Items in it has been inspected (decided 2026-09-26).
- It attaches to its ticket by `graph_conversation_id`, as inbound mail does.
  **It never creates a ticket** (decided 2026-09-26: outbound mail adds to an
  existing case and does not open one). A thread we started ourselves (writing to
  Deret, for example) is skipped and counted in the totals.
- It never reopens a ticket and never raises `needs_categorisation`. That is the
  existing outbound rule, unchanged.
- It is embedded like every stored message (§ *Every stored message is
  embedded*). Check the cost of the first full read of Sent Items before running
  it.

**The first full read** inserts historical outbound mail onto old tickets. Their
`received_at` is before `cutover_at`, so no old ticket becomes eligible for
drafting because of it.

**Done when:** a reply typed in Outlook on a test thread appears on its ticket
within one poll, exactly once, even when a copy also lands in the Inbox.

## Stage 3: timeline evaluation, before building anything it scores

The labelled set is already a timeline: it has cuts on both directions, an
`effect` per message, `waitingCustomer`, `waitingInternal`, `caseState` and
`nextAction`. What it lacks is **who** owes each internal check, and the actor
of each message.

**Changes to the vocabulary (`eval/casework-vocabulary.mjs`):**

- `actor` on every cut. It is derived (stage 4 computes it), shown on the
  labelling page, and only corrected by hand.
- `waitingInternal` becomes `obligations: [{ owner: 'support' | 'colleague' |
  'partner', need }]`. `need` stays within `NEED_KEYS`, for the reason already
  written there.
- `nextActor`: `customer | support | colleague | partner | nobody`, on every cut
  (outbound cuts too: after we write, somebody still owes the next step).
- `NEXT_ACTIONS` is kept as the drafting expectation. `draftStale` is added on
  cuts that land while a draft is pending.
- Existing labels are imported with `obligations` built from `waitingInternal`
  and the owner left empty to fill.

**The threads to add.** Deret has never opened a thread, only replied on them
(§ *The 3PL is our own side*). Find the threads with a colleague or partner
message after the opener by querying `sender_directory` against
`ticket_messages`, and label those first. The target is enough threads for
`nextActor` to be scored on each of its five values. Write down the number
reached, and do not pad it with invented mail.

**The scorer.** `eval:timeline` gives agreement per cut on `nextActor`,
`obligations` (set match per owner) and `caseState`, plus stale-draft agreement.
**Record today's pipeline as the baseline** before stage 4 starts. Every later
stage reports against it.

## Stage 4: actors, events and `case_current`

> **Built and applied 2026-09-26.** Fold agrees with 79 of 132 labelled next
> actors (pipeline: 45). **Moved to stage 5:** status from `next_actor`,
> `ticket_case_actions`, and re-reads on late events (reasons in DECISIONS.md
> § *The case has a current state*).

**The actor is stored per message, at ingestion** (`ticket_messages.actor`). It
is deterministic from the address, using the Q5 mapping. It is stored rather than
joined in a view for the same reason `sender_label` is: a label is a fact about
when the mail arrived, and relabelling the directory must not rewrite history. It
comes with a backfill script. It also closes known gap #2: the skip in
`draftDecision` reads the **trigger message's** actor, not only the opener's.

**Events (Q4).**

- `ticket_events`: a view over `ticket_messages` (both directions, with `actor`),
  the draft transitions in `ticket_drafts`, and one new table.
- The new table is `ticket_case_actions`, for what has no row today: a dashboard
  action (an obligation cleared, a person's note).
- **No refund-change events in this phase.** Checked 2026-09-26: the poll calls
  `runOrderContext` without `refresh`, and `findAwaitingContext` then selects only
  tickets with `context_resolved_at` null. A bundle is built once and never
  rebuilt by the worker, so there is no before/after to compare. As decided, no
  new polling is added just for this. When a refresh does join the poll, the
  event is a comparison of the refund bucket before and after the overwrite.

**`case_current`: one row per ticket, overwritten in place**, like
`resolved_context`, because "the current state of the case" has one correct
value. The per-message readings stay the trajectory. Columns:

- `version`
- `as_of_event_id`, `as_of_event_at`
- `issues`
- `pending_customer_inputs`
- `commitments`
- `contradictions`
- `obligations` (stage 5)
- `next_action { actor, type }` (stage 5)
- `resolved`
- `material_hash`
- `folded_at`

**The fold is a pure function** (`casework/case-fold.mjs`): the readings sorted by
the `received_at` of their event, the latest case file, and the case actions go
in; `case_current` comes out. It uses no model and is cheap enough to recompute
from the start of the thread on every event.

**The version (Q13).** Increment `version` only when `material_hash` changes. The
hash covers issues, pending inputs, obligations, `next_action` and `resolved`, and
not summaries or timestamps. A thank-you that changes nothing does not stale a
draft.

**Late events (Q7).** With two folders polled separately, a late event is
**common**, not rare: a Sent Items reply can be ingested after a customer message
that followed it.

- Readings that came after the late event were taken against the wrong prior
  state. The Case Manager re-reads them in `received_at` order, **on that thread
  only**, then folds.
- A re-read **overwrites** its reading and stamps `replayed_at` (decided
  2026-09-26). A reading interprets its message in its correct chronological
  context; it is not a historical artefact. A log of the replaced version is
  kept only if the evaluation needs it.
- Ingesting both folders before casework (stage 2) keeps this to events that
  cross polls.

**Status from `next_action` (Q10).**

| `next_action.actor` | status |
| --- | --- |
| `customer` | `awaiting_customer` |
| `support` | `open` |
| `colleague`, `partner` | `awaiting_human` |
| `nobody` | eligible to close (stage 5) |

Only statuses the agent set are rewritten. `resolved` and `closed` set by a person
in the dashboard are never overridden, which is the guarantee the verdict map
already gives.

**Done when:** the fold is unit-tested on the labelled timelines, stage 3 scores
`nextActor` from `case_current`, and the result is compared with the baseline.

## Stage 5: obligations and next action

**The Case Manager reads every event, not just inbound customer mail.** Today it
runs only on an inbound message with an earlier case file. It will also read
outbound and colleague/partner messages, with the closed vocabularies already
used for labelling (`OUTBOUND_EFFECTS`, and `internal_note` for inbound). It
still has no field for a situation, and it still decides nothing. Following the
note about internal threads and a cheaper model, a colleague or partner message
may run on a cheaper reading.

**The obligation schema (Q9).**

```
{ id, owner: support | colleague | partner, owner_ref (sender_directory entry, nullable),
  need (NEED_KEYS), opened_by_event, opened_at, due_at,
  status: pending | fulfilled | overdue | cancelled,
  cleared_by: { kind: message | system | manual, ref } | null }
```

- **Created** by a reading: « je transmets à Deret » in our outbound becomes
  `{ owner: partner, need: delivery_state }`. The model picks the owner and the
  need from closed lists and gives the quoted sentence. Code writes the row.
- **Cleared** in one of three ways:
  - **explicit evidence:** a reading of a message *from that owner* that marks
    that open obligation id answered (the model picks from the ids it is shown);
  - **system evidence:** none exists in this phase. A refund-change event would
    clear a `refund_state` obligation once the refresh joins the poll (stage 4);
  - **manual:** a dashboard action row.

  Nothing else clears one. A reply from Deret that answers something else leaves
  it pending.
- **Overdue** is computed in the fold once `due_at` has passed: **2 working days
  for a colleague, 3 for a partner** (decided 2026-09-26; one setting). It is an
  **operational alert only**: shown on the ticket and in the queue. It never
  escalates, never reassigns, never clears the obligation and never changes the
  status.

**`next_action`, derived in code, first match wins:**

1. A customer event with no support event after it: `support`. The type is
   `investigate` if `needs_investigation` is raised, otherwise `reply`.
2. A draft awaiting review: `support / approve`.
3. A pending `support` obligation: `support / perform_action`.
4. A pending or overdue `colleague`/`partner` obligation: that actor,
   `provide_information`.
5. Pending customer inputs: `customer / provide_information`.
6. Otherwise: `nobody / close`, and `resolved = true`.

*Check this order against the labels in stage 3 before shipping it. It is the
thing being measured.*

**Closure.**

- `resolved` is the business rule of 2026-09-25: *nobody owes anything, on
  either side*. `closure.mjs` reads `case_current` instead of the case file alone.
- A customer's thanks on a case that was already `resolved`, where our last
  outbound message closed it, gets **no reply**. That fixes known gap #5 and the
  three cases labelled « no reply ».
- Closing on inactivity stays as housekeeping, with its exemptions unchanged. A
  case with an overdue obligation is `awaiting_human`, which is already exempt.

**Dashboard.**

- The ticket shows `next_action.actor` and the obligations, with overdue ones
  marked.
- "Mark done" and "cancel" on an obligation write a case action. The API route
  checks the action, and business logic stays out of the route.

**Decided 2026-09-26, added to this stage:**

**A. Who is an operations partner is set on a Senders screen.** Today the 11
`sender_directory` rows were written straight into the database; there is no
screen and no command-line tool, so a new brand needs a developer. Add
**Agent Setup → Senders**, beside Parameters and the Rulebook:
- add a domain or an address, pick what it is (our team, agency, logistics/3PL,
  carrier, retailer, commercial partner…) and a note. Subdomains count;
- the screen says what each choice means for a case, through the actor map, e.g.
  « counts as an operations partner: can owe checks; its replies are not
  drafted »;
- it shows whether this brand has any operations partner at all.

It reads and writes `sender_directory`; validation reuses the matcher in
`scripts/lib/sender-patterns.mjs`. **On screen the actor is « operations
partner »**, never « partner »: the directory's own `partner` label means a
commercial partner (mapped to customer by default). The stored key stays
`partner`.

**B. No operations partner, no partner obligations: derived, not a switch.**
The owners the Case Manager may choose come from the data. `partner` is
offered only when the actor map sends at least one label that has a directory
row to it. A setting (`AGENT_OBLIGATION_OWNERS`) overrides this for a brand
whose partner writes from no listed address. With none, a reply such as « nous
vérifions auprès du transporteur » stays a support obligation.

**D. When a holding reply is due (decided 2026-09-26).** `next_action.type`
gains `holding_reply`: « we have your message, someone is on it and will come
back to you ». It is due:
1. the first time a case needs a person to act before a real answer;
2. when the customer chases and our last message to them is **older than N
   working days**;
3. always on a level 3 case, whatever the timing.

It is **not** due when we sent one within the last N working days and nothing
has changed; the next action is then « no reply, a person acts first ».
**N = 5 working days** for Qiriness. It becomes a parameter
(`holding_reply_interval_days`, in `/agent-setup/parameters`) when the drafting
that reads it is built; the parameter catalogue only holds what something
reads. The labels already use the value (label schema 4).

**C. The order of obligations is declared by the rule.** A rule may open
obligations in sequence (D-36: `partner: delivery_state`, then
`support: refund_state`), so the Deret check is created when the case opens,
not only when someone writes « je transmets à Deret ». It is a new
`support_answers` field plus a Rulebook editor change. A brand without an
operations partner declares no partner step, so there is nothing to turn off.
Only owners allowed by B may be declared.

## Stage 6: draft versioning, then drafting in the poll

**Schema.**

- `ticket_drafts` is `unique (shop_id, trigger_message_id)` and rewritten in
  place. It becomes **one row per case version**:
  - add `case_version` and `trigger_event_id`;
  - unique on `(shop_id, ticket_id, case_version)`;
  - add `stale` to the status check, with `stale_reason`.
- A row per version keeps what each reviewer saw and what each edit in
  `ticket_draft_edits` corrected (§ *A human edit is recorded against the text it
  corrected*). It also gives "review mail once per version" (Q12) for free:
  `review_sent_at` is per row.

**Staleness.**

- On a version bump, every draft for the ticket in `pending`, `approved` or
  `edited` becomes `stale` (Q15 withdraws the approval).
- An outbound event produces `stale_reason = superseded_by_outbound`, with no
  guess about whether it was this draft that went out (Q14).
- `rejected` and `sent` are left alone.

**Drafting joins the poll**, closing the TO DO under § *An order confirmed after
the investigation*. It goes after `investigate`, and drafts only when all of
these hold:

- `next_action = support / reply`;
- `needs_investigation` is not raised;
- the ticket has an event after `cutover_at` (Q3);
- the trigger event's actor is `customer`;
- the existing `draftDecision` skips do not apply.

A regenerated draft follows the same gates (Q11). It sits behind a setting
(`DRAFT_IN_POLL`), off by default.

**Before switching it on, a dry run** (decided 2026-09-26; no estimate by hand).
`npm run draft -- --dry-run --gates=poll` makes no model call and reports:

- tickets eligible under the cutover rule;
- drafts that would actually be generated, after every gate;
- the median input and output tokens per draft, from the historical `llm_usage`
  rows of the drafting pass;
- the estimated API cost: count × median × current `gpt-4o` prices.

Because of the cutover rule, the first automatic run should be a handful of
tickets, not hundreds. If the dry run says otherwise, a gate is wrong.

**Nothing is sent.** There is still no send path.

**Done when:** on a test thread, draft v1 is pending; a reply typed in Outlook
makes it `stale`; the next customer message produces v2; the reviewer is mailed
once for each version.

## Later: evidence for consistency, not economy (Q17, Q19)

Out of this phase. What would come back: before a draft is saved, compare its
claims with the buckets `case_current` holds as established, and flag any
contradiction to the reviewer (for example « délai dépassé » against a `delivery_state`
that says otherwise). It stores buckets only (Q16), enforces no tool skipping,
and changes no investigation budget.

---

## Still open

All six questions from the first pass were answered on 2026-09-26; the answers
are in the stages above. What remains is a matter of measuring, not deciding:

1. **Stage 1:** how many stored ids `translateExchangeIds` cannot translate.
2. **Stage 2:** whether `internet_message_id` can be made unique once Sent Items
   is in the data.
3. **Stage 6:** the dry-run numbers.

## Docs to move as each stage ships

- `APP_SCHEMA.md`: cursors, `ticket_messages.actor`, `ticket_events`,
  `ticket_case_actions`, `case_current`, the draft columns and the pass order.
- `DECISIONS.md`: each Q-answer above becomes a rule in the section it belongs
  to, once it is built rather than planned.
- `Agent_Architecture.md`: known gaps 1–6 close one by one.
- `CHANGELOG.md` and `VALIDATION_LOG.md` as usual.
