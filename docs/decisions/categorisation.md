<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Categorisation

Runs after ingestion in the same poll, as a separate batch pass selecting on the pending flag rather than on what the poll just wrote — so anything missed by a crash or a key-less run is caught up automatically.

`categorise.mjs` is classification-only (no tools, no DB) and sends subject + first/latest inbound body — never the sender's address or name. A failure leaves the ticket pending and counts the attempt in `metadata.categorisation`; after 3 it is written as (other, problem) → level 3, team contact, flagged `failed`, so it lands in front of a human instead of retrying forever — unless the ticket already had labels, in which case those are kept and only marked low-confidence.

### Re-categorisation is blind

A ticket's labels describe the conversation so far, not the email that opened it, so ingestion re-raises `needs_categorisation` whenever a new **inbound** message joins a thread (never on our own outbound replies, which also move `last_message_at`).

The re-run never shows the model its previous answer, which would only make it defend a first call that may have been wrong. Stability comes from the ratchet instead. Superseded labels are kept in `metadata.categorisation.history` (newest first, capped at 5) so a ticket shows its trajectory.

### `needs_categorisation` is a boolean, not a timestamp comparison

PostgREST cannot compare two columns, and our own outbound replies also move `last_message_at`.

### Backlog `--limit` is shared with categorisation

The daemon keeps categorisation at its normal 25-ticket batch when no CLI limit is supplied. A staged backlog run is different: `npm run ingest:once -- --limit=500 --stop-after=categorise` is meant to build a review corpus in one deliberate pass. If `--limit` capped only Graph ingestion, that command would store hundreds of messages but label only 25 tickets, and the next step would look like the knowledge gaps were measured against the whole batch when they were not.

### The categoriser is never asked how confident it is

It was, and answered `high` on 171 of 171 live tickets and 40 of 40 review cases — Structured Outputs emits fields in order, so the model rated an answer it had already committed to in the same forward pass, with nothing pushing it toward calibration. A constant field carries no information, and a constant field *called confidence* invites the wrong decision downstream.

`tickets.categorisation_confidence` survives as a **known-untrustworthy marker**: only `low` is written, only by the failure paths (retries exhausted, or stale labels after a failed re-categorisation), and a clean categorisation clears it to NULL. Until a calibrated signal exists (sampling for agreement, or token logprobs), Phase 5 should gate auto-drafting on `level` and `happiness` instead — on this mailbox, level 1 alone is 17 of 160 tickets and every one of them is calm.

### Measured, not assumed

Two review sets. **Synthetic** (`agent/eval/categorisation-cases.mjs`): 40 dummy emails, ~38–39/40 on all three axes — guards against regressions only. **Real** (`categorisation_review`): 30 hand-labelled emails from the live mailbox — subject 77%, kind 90%, level 73%.

The real set is what drives the rules. The boundary definitions in the prompt (dispatch splits order/delivery; `complaint` only without an actionable request; `contact` only for a first approach; L3 = something must change) and the level floors all come from measured disagreements with human labelling, not from intuition.
