# Map: agent/

The always-on worker package: ingestion, casework, investigation, drafting, lifecycle, tools, rehearsals, eval. Part of the schema map; the index is `APP_SCHEMA.md`. Why things are this way: `DECISIONS.md`.

```text
|-- agent/                       # always-on worker (own package.json; reuses scripts/lib/*)
|   |-- src/
|   |   |-- index.mjs config.mjs # entrypoint (--once) · env/tunables + Graph gate
|   |   |-- lib/ llm/            # logger (JSON, no PII) · shop · openai-client
|   |   |                        # lib/job-waker: between polls, LISTEN on mail_jobs and
|   |   |                        # sleep until the next job is due (direct connection);
|   |   |                        # hasDue every JOB_CHECK_INTERVAL_MS over REST
|   |   |                        # (records every call's tokens into) usage-sink
|   |   |                        # -> usage-store (best-effort; never fails a pass)
|   |   |-- mail/                # THE PROVIDER BOUNDARY. mail-provider (the
|   |   |                        # MailProvider contract, CursorExpiredError,
|   |   |                        # replyHtml) · outlook-graph-adapter (graph-client
|   |   |                        # + mapper behind the contract; the poller and the
|   |   |                        # outbound worker see nothing else) ·
|   |   |                        # subscription-manager (Graph subscriptions per
|   |   |                        # folder; no-op without MAIL_WEBHOOK_URL)
|   |   |-- reports/             # sales-report-mail: the monthly sales report,
|   |   |                        # mailed from the support mailbox on the 1st
|   |   |                        # (fetched from /api/reports/sales; recorded in
|   |   |                        # integration_events, one key per shop + month)
|   |   |-- outbound/            # THE ONLY SENDER OF CUSTOMER REPLIES. outbound-rules
|   |   |                        # (preSendCheck, pure) · outbound-store (reads) ·
|   |   |                        # outbound-runner (confirmSentActions after the
|   |   |                        # mailbox read; createAutoSendActions + runOutbound
|   |   |                        # in the `send` stage)
|   |   |-- ingestion/           # graph-client · graph-message-mapper · contact-form ·
|   |   |                        # auto-reply (out-of-office detection → `automated` actor) ·
|   |   |                        # delta-poller · ticket-writer · message-embedder ·
|   |   |                        # immutable-ids (plan + proof for `ids:translate`) ·
|   |   |                        # spam-gate + blocklist-store + spam-classifier ·
|   |   |                        # sender-directory (who a sender is: context for
|   |   |                        # the case file, filter for the demand report,
|   |   |                        # and the gate on related-rules; `senderRole`
|   |   |                        # resolves a role PER MESSAGE -- client /
|   |   |                        # collègue (LAP Groupe) / prestataire logistique
|   |   |                        # -- for every renderer that shows a thread to a
|   |   |                        # model, and the address never travels with it) ·
|   |   |                        # duplicate-rules (same message twice -> silence) ·
|   |   |                        # related-rules (same conversation again -> context
|   |   |                        # + apology; consumers only, never suppresses) ·
|   |   |                        # contact-form-repair (undoes a form parse that
|   |   |                        # fired on a reply quoting the notification) ·
|   |   |                        # requester-repair (moves a colleague's identity
|   |   |                        # off a ticket a customer is on) ·
|   |   |                        # spam-audit (rows, body cap/clock, retention purge) ·
|   |   |                        # spam-body-backfill · attachment-backfill
|   |   |-- pipeline/            # categorise (classify-only) · categorise-runner
|   |   |-- retrieval/           # retrieval-rules (categoriesToSearch: the subject,
|   |   |                        #   its search group — order/delivery/promotions —
|   |   |                        #   then faq + brand_story for every subject) ·
|   |   |                        #   knowledge-retrieval (dense 20
|   |   |                        #   + lexical 20, fused by rank, banded three ways) ·
|   |   |                        # exemplar-{rules,retrieval} (which situation is this) ·
|   |   |                        # situation-chooser (a small model settles a near
|   |   |                        #   miss / tie among the matcher's candidates, or
|   |   |                        #   none; skips our own side; before the rules load) ·
|   |   |                        # product-{matching,context,lookup} (four shapes:
|   |   |                        #   one product / a range / ambiguous / nothing,
|   |   |                        #   ranges derived from shared title bigrams;
|   |   |                        #   samples are never candidates) ·
|   |   |                        # product-concerns (customer cues <-> catalogue tags) ·
|   |   |                        # advice-collections (activated collections,
|   |   |                        #   requirement -> collection in 3 passes,
|   |   |                        #   one group per type of care, concerns rank
|   |   |                        #   inside it; best tier only) ·
|   |   |                        # care-cues (the types of soin, read from the
|   |   |                        #   message; cue -> token -> every matching
|   |   |                        #   active category, one group per cue;
|   |   |                        #   dry skin resolves here) ·
|   |   |                        # concern-cues (what is wrong, read from the
|   |   |                        #   message; one entry = one concern however
|   |   |                        #   many collections it covers) ·
|   |   |                        # cue-matching (shared by both cue lists:
|   |   |                        #   fold, whole-word, token/phrase in title) ·
|   |   |                        # product-lines (name - what it does - who it suits) ·
|   |   |                        # promotion-{rules,lookup} (lookup.identify: code
|   |   |                        #   or automatic offer, from typed codes + the
|   |   |                        #   decomposer's described offers; the
|   |   |                        #   identifyPromotion tool; lookup.outcome: why
|   |   |                        #   one applied or not, the checkPromotionOutcome
|   |   |                        #   tool, chained after identification) ·
|   |   |                        # promotion-outcome (pure: promotion + order or
|   |   |                        #   abandoned basket -> applied / expired /
|   |   |                        #   outside_destination / not_combinable / ...;
|   |   |                        #   rewardProductIds + rewardStock: the free
|   |   |                        #   item, and whether it is in stock now ->
|   |   |                        #   need promotion_reward_stock) ·
|   |   |                        # stock-by-id (stock of products named by id —
|   |   |                        #   a gift, an order's samples; one reader so
|   |   |                        #   both mean the same "in stock"; samples NOT
|   |   |                        #   excluded) ·
|   |   |                        # abandoned-checkout (the ONLY view of a basket;
|   |   |                        #   live Shopify Admin, never synced; a tool
|   |   |                        #   since 2026-09-16, see checkout_state) ·
|   |   |                        # customer-{context,lookup} ·
|   |   |                        # purchase-{verification,lookup} (three-state
|   |   |                        #   customer check + last-order product match)
|   |   |-- investigation/       # case-file (THE output contract) · investigation-rules ·
|   |   |                        # decompose{,-rules} (tasks + needs, one call) ·
|   |   |                        # case-delta (a follow-up's « Dossier connu »: what
|   |   |                        #   stands, what to refresh, what the message brought;
|   |   |                        #   only when the Case Manager read THIS message) ·
|   |   |                        # answer-selection (which answer the findings
|   |   |                        #   select, and the next need to collect) ·
|   |   |                        # evidence-rules (23 needs, scored vs the ledger;
|   |   |                        #   + findings = the value each took, + a
|   |   |                        #   requires/moot DAG and orderNeeds) ·
|   |   |                        # photo-evidence (re-exports scripts/lib/photo-evidence-rules) ·
|   |   |                        # tool-registry (14 tools; the checkout lookup is
|   |   |                        #   optional and unbound without Shopify creds) ·
|   |   |                        # investigate (bounded loop) ·
|   |   |                        # investigation-runner · create-investigation
|   |   |-- resolution/          # customer-resolution-runner · order-number-parser ·
|   |   |                        # tracking-number-parser (the second way into an
|   |   |                        #   order, via orders.tracking_numbers) ·
|   |   |                        # confirmation-evidence (every address in the
|   |   |                        #   message, as hashes; no template parsing) ·
|   |   |                        # order-verification · order-resolution-runner
|   |   |                        #   (first message + the customer's own words in
|   |   |                        #   later ones, via laterInboundByTicket; later
|   |   |                        #   numbers count only when they confirm) ·
|   |   |                        # order-identity (the order_identity situation:
|   |   |                        #   no number known/unknown sender, number not
|   |   |                        #   found, other_email[_same_name]) ·
|   |   |                        # (checkOrderPromotion reads the bundle promotions
|   |   |                        #  block: gifts, reductions, samples) ·
|   |   |                        # order-context + order-context-runner
|   |   |                        #   (orderStates: order_state, delivery_state,
|   |   |                        #    delivery_delay_state, dispatch_state,
|   |   |                        #    payment_state, refund_state,
|   |   |                        #    return_eligibility — derived against the
|   |   |                        #    ticket's latest inbound message, not `now`;
|   |   |                        #    the router and a routed run use `now`).
|   |   |                        #   The bundle carries sourceUpdatedAt +
|   |   |                        #   sourceSignature; the context pass rebuilds
|   |   |                        #   a bundle whose order carries another stamp
|   |   |-- routing/             # forward-rules · forwarding-store · forward-runner · destination-router (planRoute + the model chooser)
|   |   |-- drafting/            # brand-voice (the Brand voice row -> the system
|   |   |                        #   prompt + INTENT_RULES per verdict: answer /
|   |   |                        #   answer-then-ask / answer-then-hand-over;
|   |   |                        #   approval gates it) · draft-rules (verdict +
|   |   |                        #   level gates and terminal/intermediary, pure) ·
|   |   |                        # compose-draft
|   |   |                        #   (per-ticket message, the thread so far — ours
|   |   |                        #   and theirs, above the new message — and the
|   |   |                        #   answer schema) ·
|   |   |                        # draft-checks (the prohibitions, in code) ·
|   |   |                        # health-topic + health-terms (the customer names
|   |   |                        #   a health condition -> never auto-sent) ·
|   |   |                        # draft-runner (+ the derived queue). NO Graph call
|   |   |-- cases/               # the `link` pass (61_cases.sql): case-link-rules
|   |   |                        # (pure: tracking / order_family / unique_match,
|   |   |                        # families) · case-linker-runner (store + runner,
|   |   |                        # candidates ≤ 5, embedding = retrieval only) ·
|   |   |                        # case-linker-model (LINK:<id> | NEW_CASE, off
|   |   |                        # unless CASE_LINKER_ENABLED)
|   |   |-- casework/            # case-fold (the current state of a case, pure) ·
|   |   |                        # case-current-store (the fold pass) ·
|   |   |                        # change-router (pure: what a moved order state
|   |   |                        #   or an elapsed window means for a case we owe
|   |   |                        #   a reply on -- none / redraft / reinvestigate)
|   |   |                        #   + change-router-runner (the `route` pass) ·
|   |   |                        # actors (message -> customer/support/colleague/
|   |   |                        # partner via sender_directory + AGENT_ACTOR_BY_LABEL) ·
|   |   |                        # case-manager (what a new message changed: a
|   |   |                        #   closed relationship, which of OUR questions it
|   |   |                        #   answered, what we promised) · case-manager-rules
|   |   |                        #   (pure: whether the categoriser re-runs, which
|   |   |                        #   situation the case is in, which prior evidence
|   |   |                        #   may be reused, the situation plan, whether the
|   |   |                        #   order changed) · case-runner (the pass; derived
|   |   |                        #   queue, no third flag; createSituationPlanner, which
|   |   |                        #   the investigation reads as planSituation) ·
|   |   |                        # closure (does the customer's last message end
|   |   |                        #   their request? code gate first -- nothing
|   |   |                        #   outstanding in the dossier -- then one cheap
|   |   |                        #   call on the message) ·
|   |   |                        # reconstruct (a finished thread -> where the case
|   |   |                        #   stands: situation from the shop's own library or
|   |   |                        #   none, what we asked, what we promised, what is
|   |   |                        #   still open; the model reads the PROSE and
|   |   |                        #   `backendPosition` reads `resolved_context`, and
|   |   |                        #   the two are never merged). READ ONLY ·
|   |   |                        # snooze-rule (pure: after a SENT reply of ours,
|   |   |                        #   snooze while someone else owes the next step;
|   |   |                        #   wake when the case comes back to us; an auto
|   |   |                        #   snooze follows a switch to another party)
|   |   |-- lifecycle/           # auto-close (28d idle, level 4 and snoozed exempt) ·
|   |   |                        # snooze-wake (the deadline sweep, no model)
|   |   |-- tools/              # one CLI per pass -- see Agent CLIs below
|   |   `-- testing/            # THE REHEARSAL HARNESS behind /agent-setup's test
|   |                           # chat. memory-transport (a PostgREST-shaped fake
|   |                           # DB, so the REAL ticket-record and draft-record
|   |                           # run unchanged over it) · synthetic-message ·
|   |                           # trace (+ the OpenAI decorator) · article-check
|   |                           # (the five verdicts) · run-rehearsal (the passes,
|   |                           # in the poll's order, writing no row)
|   `-- eval/                    # categorisation-cases (40 dummy) · score-categorisation ·
|                                # sample-mailbox (review:sample) · compare-review-labels
```
