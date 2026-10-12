<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

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

**No gate ever promotes one back, but a person may.** The heading still holds of the pipeline — nothing automatic turns a drop into a ticket — and the dashboard's "Add as ticket" is the deliberate human override, which the stored body is what made possible. See § Add as ticket writes, and it writes through ingestion.

### Who a sender is lives in a table, not in an env var

`sender_directory` maps an email address or domain to a label — internal, contractor, logistics, courier, retailer, distributor, supplier, partner, other. It replaces `INTERNAL_EMAIL_DOMAINS` for the demand report, and the reason is a measured failure rather than a preference.

**Config did not survive a project move.** Switching to a new Supabase project carried the data across and left the env file behind, so `lap-groupe.com` — our own second domain, and the second-largest sender in the inbox at 43 inbound messages — was counted as customer demand. The clustering report that decides which knowledge article to write next ranked an internal reorder thread sixth, and `return_exchange` was half internal ops coordination. Who we work with is a business fact; it belongs with the business data, where it travels.

**A boolean could not express the corpus anyway.** Nocibé sends 10 of the 13 `b2b` messages and every one is a real request. Marking it internal hides real work; leaving it unmarked pollutes the consumer writing order. So `NON_DEMAND_LABELS` is `internal, contractor, logistics, courier` — retailers, distributors, suppliers and partners stay *in* the demand set, as B2B demand that a consumer FAQ does not answer.

**Labels are context, not behaviour.** Exactly one pass branches on them, and it is a report rather than a customer outcome. Everywhere else the label is read *to* the investigation, never *by* it: it lands in the case file deterministically before the model is asked anything, because the sender is already in hand and a tool call would spend a round trip — and a slot of the six-call budget — on a question that was already answered. Nothing here may ever gate a reply.

**The address never reaches a prompt.** A matched *domain* is named, because "un revendeur (nocibe.fr)" is the useful half and a company domain is a business fact. A matched *address* is not: the label is stated and the address withheld, since the case file is stored and re-read.

The table shares `email_blocklist`'s shape and its matcher (`scripts/lib/sender-patterns.mjs`) — exact address before domain, subdomains belonging to their parent. Two copies of that rule would have drifted silently. Rows are exceptions: an unlisted sender is an ordinary consumer, so this stays a dozen rows a person maintains rather than a directory of every address.

### A mailbox-id mismatch is a configuration answer, not missing mail

Exchange item ids are mailbox-scoped. `getMessage` separates `ErrorItemNotFound` (that email is gone — permanent, per row) from `ErrorInvalidMailboxItemId` (the id was never valid for *this* mailbox, so every row fails identically, kept mail included). The backfill stops at the first mismatch rather than reporting hundreds of rows as unrecoverable and sending an operator to fix the wrong thing for ever.
