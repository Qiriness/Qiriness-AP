# The ticketing agent: architecture as of 26 September 2026

The agent reads the support mailbox, turns mail into tickets, works out who is writing and about which order, investigates with tools, and writes a draft reply for a person to review. **Nothing is ever sent to a customer**: there is no send path. The `DRAFT_DELIVERY` setting is only printed; nothing uses it.

It runs in two parts:

- **The worker** (`npm start` in `agent/`) runs 9 stages in order on every poll.
- **Drafting** (`npm run draft`) is started by hand and is not part of the poll.

For where things are in the code, see `APP_SCHEMA.md`; for why they are that way, see `DECISIONS.md`. `Agent_Workflow.md` is the original plan from July.

## Overview

```
 Outlook mailbox (Graph delta)
        │
 ┌──────▼─────────────────────────────── WORKER POLL ──────────────────────────────┐
 │ 1 ingest ─► 2 customers ─► 3 casework ─► 4 categorise ─► 5 orders ─► 6 context  │
 │                                                                     │           │
 │            9 close ◄── 8 forward ◄── 7 investigate ◄────────────────┘           │
 └──────────────────────────────────────────────────────────────────────────────────┘
        │  case file + verdict (ticket_investigations) → ticket status
        ▼
 MANUAL: npm run draft ─► draft decision ─► closure check ─► compose ─► checks ─► ticket_drafts
        │
        ▼
 Dashboard: a person reviews, edits and sends from Outlook
```

## The workflow, stage by stage

### 1. Ingest (`ingestion/delta-poller.mjs`), no model except the spam triage

- **Graph delta:** it resumes from the saved position in the mailbox (`shops.sync_cursors.mail_ingest_delta_link`), or from the last page written if a read was interrupted (`mail_ingest_resume_link`, since 26 September). With neither, it re-reads the whole mailbox, which is what happened on 25 September. A saved position Graph refuses is dropped and the read starts over.
- **Message ids:** REST ids until `npm run ids:translate` has run, immutable ids after (`mail_id_type`).
- **Direction:** mail our address sent is stored as `outbound`, everything else as `inbound`.
- **Spam gate 1 (rules):** the blocklist drops senders. Anyone in the sender directory is exempt (colleagues at `lap-groupe.com`, Deret, retailers such as Nocibé…).
- **Spam gate 2 (`gpt-4o-mini`):** drops spam and mail that isn't about support. Dropped mail never becomes a ticket, only a `spam_audit` row.
- **Only genuinely new mail changes a ticket.** Mail already stored and delivered again never reopens a ticket or re-queues it for categorisation.
- **Tickets:**
  - new thread → new ticket, `open`, `needs_categorisation`;
  - a customer reply on any non-open ticket → reopened;
  - our own reply never reopens a ticket.
- **Duplicate detection:** two fixed rules (e.g. identical body). A duplicate is linked, never merged, and linked tickets are neither investigated nor drafted.
- **Embedding:** `text-embedding-3-small` on every message, used for situation matching and knowledge search.

### 2. Customers: who wrote in, by the hash of the sender's address

Sets `customer_id`. A contact-form notification is linked to the customer named in the form, not to Shopify, which sent it.

### 3. Casework, the Case Manager (`casework/`, `gpt-4o-mini`)

- **Runs only on** a ticket that already has a case file and a new inbound message nobody has read yet.
- **Records** in `ticket_case_state`:
  - how the message relates to the case: `continuation`, `new_information`, `new_issue` or `unclear`;
  - which of our questions it answered, and which stay pending;
  - new facts, what we promised, and contradictions.
- **Decides in code:**
  - whether categorisation re-runs: skipped only on `continuation`;
  - which situation carries forward: dropped on `new_issue`;
  - which earlier evidence is still valid, stale (order, delivery, shipping) or out of date because the confirmed order changed (`evidence_reuse`).
- **Doesn't read:** our outbound mail, or checks owed by colleagues or partners.

### 4. Categorise (`gpt-4o-mini`)

Assigns the subject, the kind of request, a level from 1 to 4, how happy the customer is, and a second subject where the mail has one. Categorisation doesn't see earlier labels, so it's a fresh reading every time. Then it queues the ticket for investigation.

### 5. Orders: which order the ticket is about

Uses the order number in the text, an address quoted in the message (compared by hash), the order number alone for anonymous marketplace buyers, or an order a person linked. A newly confirmed order sends an already-investigated ticket back through investigation, once.

### 6. Context: builds the order bundle

Status, fulfilment, tracking, refunds and promotions, stored in `tickets.resolved_context`. Tools read this; they don't re-derive it.

### 7. Investigate (`investigation/`)

Runs only on open tickets that have been categorised.

1. **Out of scope** → no tools, and a case file that hands the ticket to a person:
   - level 4 or `contact` mail;
   - duplicates and trade senders;
   - `legal_privacy`, `b2b`, `partner_collaboration`, `careers`.
2. **Situation**, from the 40 approved situations:
   - carried from the case state on a follow-up;
   - on a new request in the thread, matched on that message;
   - otherwise matched on the opening message by embedding: 0.65 or more is a match; a near miss or a tie goes to the chooser (`gpt-4o-mini`).
3. **Policy rules:** loads the answer set for the subject (`orders`, `returns`, `promotions`, `products`, `payments`, `accounts`, `cosmetovigilance`).
4. **Decomposer (`gpt-4o-mini`):** splits the email into separate requests and names the evidence each needs. The situation's own list stands in only if this call fails.
5. **Opening lookups:** fixed tool calls that run before the model (see *Which tool runs when*).
6. **Follow-ups only:** the "Dossier connu" section (added 25 September; asks, doesn't enforce). It lists facts already established, facts to recheck, what the message brought, what we're still waiting for and what we promised. It appears only when the Case Manager read this exact message, and not on a new request.
7. **Model loop (`gpt-4o`):** at most 6 tool calls, +2 per extra request, over 4 turns. The last turn must produce the case file.
   - A rule planner can add calls for situations switched to `rule_directed`.
   - A repeated call is served from cache.
8. **Case file:**
   - verdict `answerable`, `needs_customer_input` or `needs_human`;
   - `established` facts (each must cite a tool call), `unverified`, `missing` (a fixed list of fields to ask the customer) and `handoff` (internal only);
   - saved to `ticket_investigations`, one row per triggering message, with each tool call recording who asked for it (opening lookup, planner or model).
9. **Rule selection:** picks the rule the findings point to, which can supply a reply structure, a tone, a question to ask or a link.
10. **Status:**
    - `needs_customer_input` → `awaiting_customer`;
    - `needs_human` → `awaiting_human`;
    - `answerable` stays `open`.

### 8. Forward

Sends `contact` mail to the address set for its subject. **No addresses are set today, so this does nothing.**

### 9. Close

Closes after 28 days of silence. Exempt:

- level 4;
- `awaiting_human`;
- anything not yet categorised.

### Drafting (manual, `npm run draft`)

1. **Whether to draft.** No draft when:
   - the message was already answered (we replied after it);
   - a colleague opened the thread (`sender_label`, which reads only the opener);
   - it's a duplicate or level 4;
   - the verdict is to ask the customer, but nothing was named to ask for.
2. **Closure check:**
   - in code: only an `answerable` case with nothing missing and no handoff can be read as closed;
   - then `gpt-4o-mini` decides whether the customer's message ends the request;
   - if so, a short closing reply.
3. **Compose (`gpt-4o`), from:**
   - the brand voice;
   - the case file;
   - the thread (our replies first, signatures removed);
   - the case state: what the customer already gave us, what's pending, what we promised;
   - the rule's structure, tone and link.
4. **19 automatic checks** (listed below).
5. **Terminal or intermediary:** a draft is *terminal* when nothing is expected back, *intermediary* otherwise. Worked out in code, and meant to decide whether sending closes the ticket, once sending exists.
6. **Review:** a person reviews in the dashboard, and edits are recorded in `ticket_draft_edits`.

## Models

| Step | Model |
|---|---|
| Spam gate 2, categoriser, Case Manager, situation chooser, decomposer, closure | `gpt-4o-mini` |
| Investigation, drafting (and `cases:reconstruct`, offline) | `gpt-4o` |
| Embeddings | `text-embedding-3-small` |

## The 15 investigation tools

| Tool | What it returns |
|---|---|
| `searchKnowledge` | An approved knowledge article close enough to the question, or "none answers" |
| `lookupCustomer` | The sender's customer record: order count, account state, newsletter |
| `lookupProduct` | The product the message is about: description, usage, ingredients, FAQ |
| `lookupStock` | Stock for that product, nothing else |
| `lookupProductOffer` | Whether an offer covers that product, and whether it's specific to it or a general sale |
| `extractPromotionCodes` | Promotion codes in the text that really exist in the shop |
| `lookupPromotion` | One code: status, dates, usage limit, minimum spend, which products it covers |
| `listActivePromotions` | The shop's current promotions |
| `getOrderContext` | The confirmed order: status, delivery, tracking, refunds (from the order bundle) |
| `checkOrderPromotion` | Which promotion, gift or discount was applied to the order (gift vs sample) |
| `lookupAbandonedCheckout` | The last cart the customer abandoned at checkout |
| `verifyPurchase` | Whether the sender has bought online, and whether their last order contains the product ("can't be checked" for in-store purchases) |
| `checkPhotoEvidence` | Whether a photo is attached, or mentioned but missing |
| `identifyReactionProduct` | Records the product the customer blames and the reaction they describe (the model must give the arguments) |
| `recommendProducts` | Products the shop has approved as recommendations, by product or skin type |

## Which tool runs when

The **opening lookups** always run, before the model's first turn. The model may then call the rest of its subject's tools within the budget.

| Subject | Opening lookups | The model may also call |
|---|---|---|
| `product` | lookupProduct, searchKnowledge | lookupStock, verifyPurchase, checkPhotoEvidence, recommendProducts, lookupProductOffer |
| `product_stock` | lookupStock | lookupProduct, lookupProductOffer |
| `promotions` | extractPromotionCodes, lookupCustomer | lookupPromotion, listActivePromotions, lookupProductOffer, searchKnowledge, lookupAbandonedCheckout |
| `account` | lookupCustomer, searchKnowledge | — |
| `other` | searchKnowledge | — |
| `order` | getOrderContext, lookupCustomer | checkOrderPromotion, searchKnowledge, verifyPurchase, lookupAbandonedCheckout, checkPhotoEvidence |
| `delivery` | getOrderContext, lookupCustomer | searchKnowledge, verifyPurchase, checkPhotoEvidence |
| `payment` | getOrderContext, lookupCustomer | searchKnowledge, verifyPurchase |
| `return_exchange` | getOrderContext, lookupCustomer | searchKnowledge, verifyPurchase, checkPhotoEvidence |
| `cosmetovigilance` | lookupCustomer, searchKnowledge | identifyReactionProduct |
| `legal_privacy`, `b2b`, `partner_collaboration`, `careers`; any level 4 or `contact` | none: goes to a person | — |

On a follow-up the Case Manager has read, the model is also told which of these facts are already established and which to recheck. Nothing is skipped yet.

## The 19 draft checks

- `signature`, `closing_line`, `empty_closer` (advisory);
- `no_promise`, `no_promised_deadline`, `no_certain_delivery`, `no_completed_action`;
- `no_invented_question`, `apologises_for_delay`;
- `tracking_number_given`, `link_placed`, `no_orphan_link_marker`, `no_web_link`;
- `no_email_address`, `no_internal_identifier`, `no_internal_machinery`, `no_internal_selection_name`, `no_carrier_scan_wording`, `no_unsuitability_claim`.

## Tests and measurement

| Command (in `agent/`) | What it checks |
|---|---|
| `eval:categorise`, `eval:retrieval`, `eval:exemplars` | Categorisation, knowledge search, situation matching |
| `eval:closure` | The 16 threads where a customer wrote after our reply |
| `cases:label` → `cases:import` → `eval:casework` | Multi-turn decisions: 52 labelled messages so far; the Case Manager's reading agrees 18 of 21 times, the next action 7 of 14 |
| `eval:delta` | What follow-up investigations do with "Dossier connu" (no data yet) |
| Agent test chat (`/agent-setup`) | One invented message through the real pipeline, every decision shown |

## Known gaps

1. ~~**The mailbox cursor is missing.**~~ Committed on 26 September after the first complete read; the next poll read 1 page. That read also imported older history (347 tickets from Sept 2025–Jan 2026). Old threads are kept, and are not drafted automatically until something new arrives on them.
   ~~**Staff replying from personal inboxes were filed as customer mail.**~~ Since 26 September, a staff address writing to the customer is `outbound` (124 stored messages re-filed).
2. **A colleague or Deret writing on a customer's thread gets a customer draft**, because the skip checks only who opened the thread.
3. **Our outbound mail is stored but not yet read by the Case Manager.** Since 26 September Sent Items is ingested (98 replies added) and staff replies from personal inboxes are filed as ours. What remains is stages 3–5: reading those messages for questions, promises and closes.
4. **Checks owed by colleagues or partners aren't tracked,** so the closing rule ("nobody owes anything", decided 25 September) can only use the case file, which goes out of date.
5. **Closures:** a thank-you after we've closed still gets a closing reply, and the Case Manager has no "closes the case" value.
6. **Drafting isn't automatic, and no sending exists.**
7. **The Case Manager has run on only 4 tickets,** so carrying the situation forward and "Dossier connu" are barely tested on live mail.
