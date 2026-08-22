# Agent Test Chat — integration plan

**Status: BUILT 2026-08-22, and not yet run against the live database.** What shipped is recorded in CHANGELOG.md, the rules it settled in DECISIONS.md (§ Agent test chat), and what remains unproven in VALIDATION_LOG.md item 17. This file is kept as the reasoning that produced it; where the two differ, the built thing wins — notably the harness fakes the *database* under the real ticket record rather than reimplementing the pass protocol, and run history plus the ideal-answer capture were in scope after all. Read `APP_SCHEMA.md § Agent Worker` for the
pass order this reproduces, and `DECISIONS.md` before changing any rule it
touches.

## What it is

A rehearsal harness on `/agent-setup` that puts a typed message through the real
pipeline — gate, identity, categorisation, investigation with real tools, order
resolution and context, drafting — and shows every decision, every tool call,
every piece of text the models were actually given, and what the reply came out
as. Two entry points, one engine:

| Entry | Where | Extra |
| --- | --- | --- |
| **Free test** | button top-right of Agent Setup | nothing — the run *is* the output |
| **Article test** | "Test this article" in the article workspace | the run, plus one assertion: was *this* article retrieved, and did it reach the drafting prompt |

The top-right button already exists as dead UI: `SetupHeader.tsx` renders
`View agent preview` with no handler. That is the slot.

## The governing choice: same modules, same order, no rows

The value of this tool is that it is **not a simulation**. Every module the poll
runs, the harness runs — `runCategorisation`, `runInvestigation` (so
`isInvestigable`, the decomposer, the tool budget and the case-file contract all
apply), `runCustomerResolution`, `runOrderResolution`, `runOrderContext`,
`runDrafting` (so `draftDecision`, `draft-checks` and the brand-voice gate all
apply). Same prompts, same models, same Supabase reads for products, orders,
customers, promotions and knowledge.

What differs is exactly one layer: **where the writes go**. The passes take their
stores by injection already, so the harness supplies in-memory ones and no row is
written to `tickets`, `ticket_messages`, `ticket_investigations` or
`ticket_drafts`.

**The rejected alternative** was real rows carrying `tickets.is_test`. It fails on
blast radius: the flag would have to be honoured by `ticket_queue`, the
`listTickets`/`listConversations` partition, `ticket_message_counts`,
`ticket_first_inbound`, auto-close, forwarding, the drafting queue's derived
candidate set and a share of the 21 Insights views. One missed filter puts a
made-up customer in front of a human or into a monthly figure. The in-memory
route's cost is a second implementation of the pass protocol; that is bounded and
testable, and the mitigation is below.

### The order is copied verbatim, including its warts

The harness runs the poll's own order, and one consequence must be stated in the
UI rather than discovered as a bug report:

> **Order context is built *after* the investigation.** In the real poll, stages
> run `customers → categorise → investigate → orders → context`. A first message
> is therefore investigated with `resolved_context` still null —
> `getOrderContext` reports "commande non confirmée" — and the order facts only
> reach the **draft**, which reads `tickets.resolved_context` directly in
> `draft-runner.mjs`.

That is production behaviour for every newly-arrived email, so the harness
reproduces it and labels it. Faking an earlier order lookup would make the test
disagree with the thing it exists to test.

## New code

### `agent/src/testing/` — the harness

| Module | Holds |
| --- | --- |
| `memory-ticket-record.mjs` | the ~12 methods the passes call on `ticket-record.mjs`: `claim` · `complete` · `skip` · `retry` · `abandon` · `inboundMessages` · `findUnlinkedCustomers` · `linkCustomer` · `findAwaitingOrderNumber` · `linkOrder` · `findAwaitingContext` · `setResolvedContext`. Honours the same flag/status/`needs_categorisation` predicates, because `claim`'s filters are what make a pass skip or run |
| `memory-stores.mjs` | in-memory case-file store (`saveCaseFile`) and draft record (`save`) |
| `synthetic-message.mjs` | `{name, email, subject, body, orderNumber?}` → one mapper-shaped message plus its ticket, modelled on `mapAuditRowToItem` in `promote-dropped-mail.mjs`. Hashes the address with `hashIdentifier` so customer resolution matches a real `customers` row exactly as it would for real mail |
| `trace.mjs` | the trace recorder and the OpenAI decorator (below) |
| `run-rehearsal.mjs` | the orchestrator: builds the stores, runs the passes in poll order, emits trace events |

Every module gets a sibling `.test.mjs`, per repo convention.

**Drift mitigation.** `memory-ticket-record.test.mjs` asserts that
`createTicketRecord()` still exposes every method name the memory record
implements — so a rename or a signature change in the real record fails the
memory one's test rather than silently producing a rehearsal that no longer
matches the worker.

### Observability — five additive changes, all defaulting to today's behaviour

Nothing in the pipeline currently reports *what the model was shown*. The stored
`tool_calls` are `{id, tool, argsHash, outcome}`; `prompt_inputs` are counts and
ids. That is right for storage and useless for this. Five changes, none of which
alter a run that does not opt in:

1. **`createInvestigator(openai, registry, { onToolCall })`** — called with the
   whole ledger entry: tool, args, `outcome`, `caveats`, the exact `promptText`
   the model received, and `data`. Default no-op.
2. **`createInvestigationStack({ ..., openai, embeddingsClient })`** — accept
   pre-built clients instead of always constructing them from `config`, so the
   harness can pass traced ones. Falls back to today's construction.
3. **A traced OpenAI decorator** wrapping `completeJson` / `completeWithTools`,
   recording per call: pass, model, system prompt, messages, tool definitions
   offered, raw response, tokens, duration. This is what makes "what info is
   given to the drafting agent" literally answerable — no change to
   `compose-draft.mjs` is needed, because the composed prompt *is* the user
   message the decorator sees.
4. **`summariseMatches` gains `candidates`** — the full ranked list above the
   retrieval floor, beside the existing banded `chunks`. `knowledge-retrieval`
   returns it; the registry's `searchKnowledge` handler puts it in `data`, which
   the model never sees (`fromModel` sends `promptText` only). Without this the
   article test cannot distinguish "your article was never found" from "found,
   scored 0.52, withheld because the band is `weak`" — and those want opposite
   fixes.
5. **`runDrafting({ onDraft })`** already exists and needs nothing.

### Cost accounting: reported, not recorded

Test runs spend real money (`gpt-4o` for investigation, up to four turns, plus
drafting). They will **not** write `llm_usage`: its `pass` check constraint
admits only the worker's seven passes, so tagging test spend needs a migration,
and folding it in untagged corrupts `llm_usage_summary`'s per-ticket figures and
the Agent panel's cost tiles — the numbers that answer "what does handling real
mail cost".

Instead the harness uses its own sink and the run header shows the tokens and the
euro figure via `estimateCost` in `scripts/lib/llm-rates.mjs`. One line in
`DECISIONS.md` records the trade: **test spend is invisible to Insights and
visible in the tool that spent it.**

### The gate

Gate 2 (the LLM triage that drops `spam` and `irrelevant`) runs and is reported
first. If it would have dropped the message, the run **stops there with that as
the answer** and offers *Run anyway* — because "your test email would never have
become a ticket" is the single most useful thing the harness can tell someone,
and continuing past it would be the tool lying about the pipeline.

## Web surface

| Piece | Path |
| --- | --- |
| Route Handler | `web/app/api/agent-test/run/route.ts` — POST, streams NDJSON trace events |
| Service | `web/lib/server/agent-test-service.ts` — loads config, Supabase client, `shopId`, brand voice; wires the harness. Mirrors `knowledge-service.ts`, which already imports `scripts/lib/*` and `agent/src/*` directly |
| Components | `web/components/agent-test/` — `TestChatDialog` (over the existing `ui/Dialog` shell) · `IdentityBar` · `Composer` · `RunTranscript` + one card per stage |

**Streaming, not polling.** A run is tens of seconds across five or six model
calls; the point of the tool is watching the decisions land. A `ReadableStream`
of NDJSON events from the Route Handler, rendered as step cards as they arrive.

**Identity is fields, not prose.** Name, email and an optional order number sit
above the composer as inputs, because that is what they are on a real email — an
envelope, not body text. Parsing them out of the typed message would exercise a
parser production does not have and would make `from_email` a fiction.

The transcript cards, in order: **Gate · Identity · Categorisation ·
Decomposition · Tools · Case file · Order resolution + context · Draft.**

- **Tools** is the centrepiece: one row per ledger entry showing the tool, the
  arguments (and whether they were the model's or an opening move), the outcome,
  and the exact French `promptText` that went back into the conversation.
- **Case file** renders `established` / `unverified` / `missing` / `do_not_claim`
  / verdict / handoff / `evidence_gaps` / `dropped_claims`.
  `web/lib/ticket-detail.ts` already projects a stored case file into three
  blocks; reuse it where the shape matches rather than writing a second renderer.
- **Draft** shows the composed prompt, the body, `checks_passed` with the failed
  check names, `disposition`, and `auto_send_eligible`. Where `draftDecision`
  refuses, it shows the reason (`internal_sender`, `duplicate`, `level_4`,
  `nothing_to_ask`, `no_case_file`) instead of a body.

## The article test

Same run, one flag: `expectArticleId`.

**Preconditions checked before spending anything** — and these alone will catch
most failures:

- is the document `approved`? (`match_knowledge_chunks` reaches a chunk only if
  its parent is approved and not brand voice — the null-embedding check *is* the
  approval gate)
- how many chunks does it have, and how many carry an embedding?
- which `category` are those chunks in, and does `categoriesToSearch` reach it
  from a plausible subject?

**Then the verdict**, one of five, derived by a pure function with its own test:

| Verdict | Means | The fix it points at |
| --- | --- | --- |
| `used` | a chunk of this document is in `caseFile.knowledge` | none — it worked |
| `retrieved_withheld` | in the candidates, but the band was `weak`/`none`, so it never reached a model | the wording, or the 0.60 bar in `retrieval-rules.mjs` |
| `outranked` | in the candidates, below the top-3 cut | a competing article, or thin content |
| `not_retrieved` | no chunk of this document in the candidate pool at all | wrong category, not embedded, or genuinely unrelated |
| `not_searched` | `searchKnowledge` was never called — the subject's `allowedTools` excludes it, or the model chose not to | the *category* the test message lands in, which is not a knowledge problem at all |

Plus the downstream half: did `prompt_inputs.knowledge_titles` carry it into the
drafting call, and does the draft body rest on it.

**What it deliberately does not do:** grade the answer. Whether the retrieved
article was the *right* one is the operator's judgement — the tool reports
mechanism, and says so in the UI.

## Testing and docs

- Unit tests beside each new module; the article verdict is pure and
  table-driven across all five states.
- The drift test described above.
- `APP_SCHEMA.md` — the new route, the `agent/src/testing/` directory, the new
  components, the `SetupHeader` button becoming live.
- `DECISIONS.md` — three entries: why no rows, why no `llm_usage`, why the gate
  stops the run.
- `CHANGELOG.md` — what shipped.
- `VALIDATION_LOG.md` — the unproven claim, with its check: **"the rehearsal
  reproduces the poll"** — run one real ingested email through both paths and
  diff the category, the tool ledger and the verdict.

## Risks and open questions

1. **A second implementation of the pass protocol.** `ticket-record.mjs` is
   documented as the only writer of `tickets`; the memory record is a second
   reader/writer of the same protocol and can drift. Mitigated by the
   name-coverage test, not eliminated.
2. **Money, with no auth on the dashboard.** Each run is five or six calls, two
   of them `gpt-4o`. Worth a per-run cost estimate before the send button, or a
   simple cap.
3. **`ENABLED_SUBJECTS` will surprise people.** A test message that categorises
   as `cosmetovigilance` or `b2b` gets an empty tool set and a `needs_human` case
   file by design. The transcript must say *why* rather than look broken.
4. **Open — run history.** v1 keeps nothing: close the dialog, the run is gone.
   Persisting runs is what turns a scratch tool into a regression suite you can
   diff across a prompt change. Deliberately out of scope until asked for,
   because it is the part that needs a table.
