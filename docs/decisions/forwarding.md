<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Forwarding

Runs last, after categorisation, because it reads the category and kind that step assigns.

**Superseded 2026-09-29** (§ *Destinations, not one address per category* and § *Forwarding goes live on destinations*). Until then `forward-rules.mjs` forwarded on `request_kind = 'contact'` **and** an address in `category_forwarding` — the kind was meant to keep genuine `b2b` reorder problems in the inbox, and the taxonomy restricts `contact` to b2b, partner_collaboration and careers (38 of 330 customer-facing tickets on the measured corpus).

The covering note is in French (internal mail, French company), and sidesteps both tu/vous and gender agreement by never addressing the reader and referring to `le message` rather than a pronoun agreeing with the category phrase.

Sends via Graph's own `/forward` action, so the recipient gets the original mail with attachments intact (a CV arrives as a CV) rather than a re-composition of the stripped `body_text` we store. **Needs the `Mail.Send` Graph application permission**; without it every attempt lands as a `failed` row rather than silently doing nothing. Since 2026-09-28 it is one of two writes to Graph: the other is the outbound worker's reply (§ Sending), which never goes through here.

### A null address is the off switch

There is deliberately no separate `enabled` flag, because two ways to express the same state can disagree. Keyed by category rather than `responsible_team`: the team mapping sends `careers` to `contact`, the generic bucket the mail just came from.

### Destinations, not one address per category (2026-09-29)

Only the contact team works in the dashboard, so everything another team owns has to leave it. The business supplied its own directory: comptabilité, marketcom, RH, the Export and France sales desks, cosmétovigilance, défectueux — each with a sentence saying what it handles.

**A category cannot carry that.** The 19 real `b2b` tickets split five ways: 11 Nocibé reorder POs (no owner yet, they stay), 5 invoice and accounting mails (« DEMANDE DE DUPLICATA DE FACTURE », « URGENT: RAPPEL FACTURES IMPAYÉES », an In Extenso balance audit), 2 new trade enquiries split by *geography* (« UK distribution enquiry » is Export, a French beautician asking for a pro account is France), 1 export shipping request and 1 PFAS regulatory question. So a destination names who receives mail, the categories it may take, and a description in the business's words. One destination on a category takes all of it without a model call; several make the router choose from the descriptions, or keep the ticket.

**Split the taxonomy was rejected.** b2b_invoice / b2b_reorder would move the categoriser, the level rules and both review sets to serve one routing need; the taxonomy describes support work, not the org chart.

**`match_description` exists because of defects.** Défectueux is the only destination on `product`, which would make it fixed — and `product` problems also hold « jai essayer d'appeler le numéro 0811701748 mais pas attribué ». Marked, a lone destination is still checked against its description.

**Decided with the business, and not yet built into the router:**
- **Comptabilité is B2B only.** Consumer billing (« Cadeau facturé par erreur », chargebacks) stays with the contact team. Two business mails filed under `payment` (« Courrier de relance - Ref 01178417 », « Code client C0004184 ») are missed until a person corrects the category.
- **Only partnerships go to marketcom.** The 12 `promotions` tickets are customers whose code failed; the agent answers them.
- **Cosmétovigilance and défectueux forward after our first reply**, which asks for the batch number, photos and place of purchase; the customer's answer follows by the per-message ledger. **Forwarding never changes the ticket's status.**
- **The others get a fixed acknowledgement**, never model-written, sent after the forward succeeds, once per ticket. Comptabilité's carries a line sending future invoicing requests straight to its address. It is the first mail the system would send with no person approving it, so `ack_enabled` defaults to false.
- **The `request_kind = 'contact'` gate goes** when the router lands: the 11 identical Nocibé POs were labelled `contact` 5 times and `problem` 6 times, so the kind is noise for routing.

### A small router, for b2b only (2026-09-29)

`planRoute` needs no model for most of it: no destination → stays, one → fixed. Only a category with several destinations (b2b: Comptabilité, Marché Export, Marché France) — or a lone one marked `match_description` — reaches `createDestinationChooser`: `gpt-4o-mini`, the candidates by id with their descriptions, the sender's **domain** and Senders-directory label (never the address), language, subject, first and latest inbound message. « garder » is always offered and is the answer when unsure. Défectueux is switched off (address cleared): product problems stay in the normal flow.

**Rules on existing fields were tried first** and scored 17 of 19 (retailer → stays, invoice words → Comptabilité, language → Export/France). The router was chosen instead on the business's call.

**Measured with `route:preview` on the 19 real b2b tickets.** First run: every non-Nocibé ticket right, but **all 10 Nocibé reorder POs went to Marché France** (« réassort pour un institut en France ») although the prompt said the sender is a known retailer. Fixed in the DATA, not the prompt: both sales descriptions now end « Pas les commandes ni les réassorts des enseignes déjà clientes (ex. bons de commande Nocibé) : ils restent au service client ». Then 19 of 19 on the business's own answers: 5 Comptabilité, UK enquiry → Export, the beautician → France, PFAS and the POs kept. Over five runs at temperature 0 one ticket varies — TCC Logistics' export shipping question, Export or kept — which has no owner and is harmless either way.

### Forwarding goes live on destinations (2026-09-29)

The pass now reads `forwarding_destinations`, routes through `planRoute` and the chooser, and **no longer requires `request_kind = 'contact'`**: the 11 identical Nocibé POs were labelled `contact` 5 times and `problem` 6, and the router keeps them anyway. `category_forwarding` is no longer read.

**`forward_since` is the master switch, and it is a date, not a flag.** Only inbound mail received from then on is forwarded, on the mail's own `received_at`. Without it the first run would have sent 23 messages from the last three months (measured with `forward:dry-run -- --since=2026-07-01`), and a delta re-enumeration replaying old mail (§ *Re-delivery is not arrival*) could do the same at any time.

**A decision is stored per ticket** (`ticket_routing`) and reused while the category and kind it was taken on hold: the model is asked once, and a follow-up goes where the first message went. A category correction re-takes it. A ticket nothing routes gets no row, so a destination added later sees it fresh.

**Forwarding never changes the ticket's status** (the business's rule). A forwarded ticket waits in the queue like any other.

**`after_first_reply` waits for an outbound message** on the ticket — what the outbound worker's send or a colleague replying with support in copy leaves behind. The note then says a first reply has gone out, so the colleague does not ask the same questions.

**The acknowledgement goes through the outbound worker's own path** (`createReplyDraft` + `sendDraft`), so it threads under the customer's message and lands in Sent Items, where ingestion reads it back as an outbound message on the thread. It is sent only after a forward succeeded, once per ticket; `requested` is written before the send, as the outbound worker does, so a crash is never retried into a second mail. Never to our own domains, never to a machine (`isAutomatedAddress`: noreply, mailer-daemon, notifications…). **Forwarded while acknowledgements were off means `skipped` for good**: switching them on must not send a week-old « we have passed it on » to everyone forwarded meanwhile.

**The rehearsal found one thing the router does not cover.** `partner_collaboration` is fixed to marketcom, and the categoriser files more than partnerships there: « (URGENT – FINAL REMINDER) EU Omnibus IX Regulation-ATP 23 – Feedback » (a regulatory questionnaire) and « Qiriness — partenaire industriel pour vos prochains soins » (a manufacturer's pitch) would both go to marketcom. Marking marketcom « only mail that matches this description » would send each through the chooser; left as the business's call.

### A switch per destination, and it is a date too (2026-09-29)

Clearing the address used to be the off switch (§ *A null address is the off switch*), chosen so a flag and an address could never disagree. Once the business wanted to switch destinations on and off individually it cost two things: the address was lost, and **switching back on would have delivered everything that arrived meanwhile**, because none of it had a forward row.

So `active_since` works like `forward_since`: null is off, otherwise the moment it was switched on, and the destination receives only mail received from then. On requires an address (a check constraint); removing the address switches it off. The address stays when it is off — Défectueux keeps `defectueux@qiriness.com`, switched off.

**Off means:** new mail is not routed to it (a lone destination's category stays with the contact team; one of several drops out of the model's choice, and a sole remaining one becomes a fixed route), and follow-ups on tickets already routed to it stay too. **Back on:** a ticket decided before it was switched on is decided again, so a b2b ticket kept while Export was off can reach Export with its next message; messages from while it was off are never sent.

A rehearsal (`--since`) treats destinations that are on as on since the rehearsal date, or it would show nothing.

**The French service name carries its own preposition** (« au service comptabilité »). A template writing « à {service} » produced « à le service comptabilité » in the first test; the contraction depends on the noun, so it belongs with the noun.

### The Closed section lists the earliest closure first (2026-10-05)

Asked for by the owner. Before, closed tickets came in the queue view's order, so nothing ranked them. The order is by when the ticket reached the status it is in: `closed_at` for a closed ticket, `resolved_at` for a resolved one, the other failing that, and the last message if neither is set. The times come through `ticket_queue` (migration 75, appended last so the view is replaced in place) rather than a second read. On the day, all 962 closed or resolved tickets had one.

### A ticket being forwarded is tagged in the queue (2026-10-01)

Forwarding never changes the ticket's status, so a forwarded ticket looked like any other. The owner asked for it to be marked. The tag (`scripts/lib/forwarding-tag.mjs`) reads only what the pass left: its decision (`ticket_routing`) and its attempts (`ticket_forwards`). It never works the route out again, so it cannot promise a forward the pass would not make.

- **Forwarded** stays shown once anything has been sent, even if the destination or the switch is turned off later: a colleague has the mail either way.
- **Before anything is sent**, it shows only while the decision would still be acted on: the switch is on, the destination is on, and the ticket's category is still the one the decision was taken on (a changed category is decided again by the next pass).
- **« After first reply »** is its own state, because a cosmetovigilance ticket waits there until a person sends our reply. Whoever reads the queue should know that sending that reply hands the thread on.

**The Rules page tags situations too** (asked for the same day). A situation is tagged when the worker's own `planRoute`, run on the situation's category and request kind, would forward it, and only while the master switch is on. The tag describes the category, because forwarding never reads the situation: a reaction ticket filed under `product` matches CV-01 and is still not forwarded. On 2026-10-01: CV-01 to CV-04, all « To Cosmétovigilance after 1st reply »; no situation sits in `careers` or `partner_collaboration`.

### `unique(ticket_message_id)` is what makes the pass safe to re-run

Per message, not per ticket, so a candidate's follow-up still reaches the recipient exactly once. The ledger snapshots the category + address used, so re-routing tomorrow does not rewrite where mail went yesterday. Failures are rows, not silence — a Graph rejection stays visible and retryable.
