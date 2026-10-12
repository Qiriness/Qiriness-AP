<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Agent test chat

The rehearsal harness behind `/agent-setup`'s **Test the agent** button: a message an operator types, put through the real pipeline, with every decision shown. `agent/src/testing/`, `web/lib/server/agent-test-service.ts`, `web/components/agent-test/`.

### It fakes the database, not the passes

A tool that shows what the agent does is worth nothing if it shows what a *copy* of the agent does. So the passes are the worker's own — `runCategorisation`, `runInvestigation`, `runCustomerResolution`, `runOrderResolution`, `runOrderContext`, `runDrafting` — called in the poll's order, with the same prompts, the same models, and real Supabase reads for products, orders, customers, promotions and knowledge. The only substitutions are the database underneath them and a decorator around the OpenAI client.

**The obvious implementation was a second ticket record**, in memory, that only the test chat uses. It was not built. `scripts/lib/ticket-record.mjs` is documented as the only writer of `tickets`, and its claim filters, flag protocol and metadata trail are where the pipeline's crash-safety lives; a second copy is a second place for them to be wrong, and the failure mode is silent — the rehearsal keeps working while the worker changes underneath it, which is the one thing a rehearsal cannot survive.

Instead the substitution happens one layer lower. `createTicketRecord` and `createDraftRecord` already take their PostgREST calls as an injectable `transport`, for their own unit tests — so `memory-transport.mjs` fakes the DATABASE and the real records run on top of it, unmodified and unaware. `createCaseFileStore` gained the same parameter; it was the one store still reaching for `supabaseUpsert` directly. `memory-transport.test.mjs` drives a whole claim → complete → claim cycle through the real record and asserts the flags move. That test is what the feature rests on.

**The transport throws on an operator it does not implement.** A silent "no rows" for an unknown filter looks exactly like a pass with nothing to do — in a tool whose only job is showing what the passes did. It also honours the projection rather than returning whole rows, so a pass that reads a column it did not select fails here instead of against PostgREST.

**The alternative — real rows carrying `tickets.is_test` — was rejected on blast radius.** The flag would have to be honoured by `ticket_queue`, the `listTickets`/`listConversations` partition, `ticket_message_counts`, `ticket_first_inbound`, auto-close, forwarding, the derived drafting queue and a share of the 21 Insights views. One missed filter puts an invented customer in front of a human, or into a monthly figure.

### The order is copied verbatim, including its one surprise

The poll runs `customers → categorise → investigate → orders → context`, so a first message is investigated with `resolved_context` still null: the order tool answers "commande non confirmee" and the order facts only reach the DRAFT, which reads `tickets.resolved_context` directly. That is what happens to every newly-arrived email. The rehearsal reproduces it and the transcript states it, because the alternative — resolving the order early so the case file looks better — would make the test disagree with the thing it exists to test.

### Identity is fields; the order number is not

On a real email the sender is the ENVELOPE — ingestion takes `from_email` off the Graph message, and no parser ever reads an address out of a body — so the operator supplies name and address as inputs. Asking them to write their identity into the message would mean inventing a parser production does not have, and then testing that instead of the pipeline.

An order number is the opposite case and gets the opposite treatment: on a real email it IS in the body, so what is typed in the field is **appended to the message** and `shopifyOrderCandidates` has to find it there. Stamping `shopify_order_number` directly would skip the pass being tested and report a confidence the pipeline has not earned.

### Gate 2 runs, and stops the run

"Your test email would never have become a ticket" is the most useful thing this tool can say, so the spam classifier runs first and a `blocked` verdict ends the run with that as the answer. There is a **Run it anyway** button, because an operator who has seen the finding may still want the rest. Gate 1 (the blocklist) is skipped: it is a rule about addresses that have written before, which an invented one has not.

### Cost is reported, never recorded in `llm_usage`

Five or six model calls a run, two on the mid tier. `llm_usage` answers one question — what does handling the real mailbox cost — and its `pass` check constraint admits only the worker's seven passes. Folding rehearsal spend in untagged would move `llm_usage_summary`'s per-ticket figures and the Agent panel's cost tiles with nothing saying why; tagging it needs a migration and a wider constraint, for a number that panel should not carry anyway. So the trace totals its own tokens through a sink of the same shape, and the dialog prices them at read time from `llm-rates.mjs`. **The trade is explicit: test spend is invisible to Insights, and visible in the tool that spent it.**

### The article test reports five states, because four failures want four fixes

`summariseMatches` gained a `candidates` field — the whole ranking, beside the banded `chunks` — and the knowledge tool carries it in `data`, which the model never sees. Without it, "your article scored 0.52 and the band withheld it" is indistinguishable from "your article was never found", and those want opposite fixes.

`used` / `retrieved_withheld` / `outranked` / `not_retrieved` / `not_searched`. The last is the one people hit and do not expect: `allowedTools` gives `searchKnowledge` to five subjects, so a message that categorises as `delivery` or `order` has no knowledge tool in its registry at all, and the best-written article in the library cannot be reached from it. Reporting that as "not retrieved" would send somebody off to rewrite an article that was never consulted. Readiness — approved, chunked, embedded, in a searchable category — is checked BEFORE any model call, because it is free and it is the common answer.

**It reports mechanism, not quality.** Whether the article that came back was the right one is the operator's judgement, and the UI says so.

### Runs are kept, and the ideal answer is why

A rehearsal you cannot look at again answers only "does it work right now". The two questions worth a table both need two runs: did changing the prompt, the article or the bands improve this, and **what should the agent have said**. The second is `agent_test_runs.ideal_body_text` — the same (model text, human text) capture `ticket_draft_edits` makes for real mail, with the difference that a rehearsal's situation can be INVENTED, so a gap can be written down before a customer has hit it. Nothing reads it yet and the UI says so: promising a feedback loop that does not exist is how a capture like this fills with text nobody trusts.

The row keeps the MASK of the address and neither the plaintext nor a hash — nothing here matches on one, so a hash would be a bare identifier with no reader. Re-running an old test means typing the address again, which is the correct price.

### The situation match is on the run (2026-09-15)

49 of the 52 `orders` rules name a situation and are candidates only once it matched, so a run that matched none reaches the three unconditional rules. The first run this was checked on (« Retard Commande », an overdue unshipped order) matched no situation and got `non_expediee` instead of `d01_expedition_en_retard` — and the trace could not say why, because `exemplar_match` is written only by the case-file store, which a rehearsal holds in memory and discards.

`runInvestigation` now passes `exemplarMatch` to `onResult`, and the rehearsal emits it on the `case_file` step as `situation`. The transcript shows the matched key, or on a miss the nearest situation with its canonical question, the similarity and the margin over the runner-up: a near miss wants more phrasings, nothing close wants a new situation. `{}` means the matcher threw or was not wired; a run saved before this has no field and says so.

`closest_question` was added to the stored `exemplar_match` summary for the same reason, and is therefore also written on real investigations — additive to a jsonb nothing reads by shape.

### A rule the transcript cannot show is a rule nobody reviews

The rehearsal has always run the REAL rules — `loadAnswers` reads the same table the worker does, because a transcript is worth nothing if the policy it shows is not the policy. What it showed of them was thinner than what it applied, in three ways, and each one hid the question a reviewer was there to ask.

**The `ask` field rendered on no rule at all.** `ask` became a list on 2026-08-30; the transcript read it with a helper that returns null for an array. A field that silently never appears is worse than an absent one — the block looked complete. It now tolerates the bare string too, exactly as the loader does, and says when the questions did NOT reach the case file: they join `missing` only where the final verdict is already `needs_customer_input`, so « asked » and « wanted to ask » are two different outcomes and the transcript now separates them.

**The findings were not rendered.** They are what SELECTS the rule — a `need -> finding` map derived from the tool ledger — so both « why this rule » and « why no rule » are unanswerable from the key alone. Shown whether or not a rule matched, because the run that matched nothing is exactly the one whose findings are the answer: a missing rule and a finding that came back `unknown` are indistinguishable without them, and they want opposite fixes.

**The skeleton was not rendered anywhere in the run.** It is the one field from this layer that reaches a model, and the failure mode it carries is documented — an instruction naming a fact the dossier does not hold is a reliable way to manufacture that fact, measured on `annulation_trop_tard` and a return-authorisation number this shop does not issue. That draft passed every mechanical check. **The review queue is what stands behind it**, and a reviewer who cannot see the skeleton is reviewing the reply without the instruction that shaped it.

**And no policy at all is a finding, not a blank.** `selectPolicy` returns null when the subject maps to no answer set, when the set holds no approved rule, and when the load threw — it cannot say which, because it returns before it knows. The transcript rendered nothing, which read as the rules layer not being wired. The rehearsal now emits the answer set beside the case file, from the same mapping the runner used, so the block always states what could have applied.
