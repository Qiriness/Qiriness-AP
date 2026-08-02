# Agent Workflow — Phased Integration Plan

Status: **proposal / not yet implemented.** Derived from `Agent_Workflow.md` (the raw brief).
Nothing here exists in code yet — this is the plan to refine and then build in phases.

Follow `AGENTS.md` throughout: migrations for every schema change, idempotent sync,
least-privilege data access, no personal customer data in AI prompts unless strictly
required, small reviewable changes, and keep `APP_SCHEMA.md` / `README.md` updated as
each phase lands.

---

## Where we are vs. what the brief needs

Everything built so far is the **data + knowledge foundation**, not the runtime that
consumes it:

- **Data sync** (Shopify → Supabase): orders, customers (incl. `rfm_group`), products, promotions.
- **Knowledge/RAG**: `knowledge_documents` + `knowledge_chunks` with `vector(1536)` embeddings; Brand Voice profile.
- **Agent Setup dashboard** (`web/`): curating the knowledge library.

The brief describes the **operating layer on top of this**, none of which exists yet:
ticketing, email ingestion, the categorising agent, the tools, level-based routing, and
team forwarding. This is largely greenfield on a solid base — hence phasing.

## Locked decisions

| Area | Decision |
|---|---|
| Email source | **Microsoft 365 / Graph API** — mailbox `onouailhetas@lap-groupe.com` (permissions already granted). |
| LLM provider | **OpenAI** — consistent with the existing knowledge embeddings (`text-embedding-3-small`), so one provider + one set of credentials across the stack. |
| Agent runtime | **Separate Node worker service** using **OpenAI function/tool calling** (Responses API, or the OpenAI Agents SDK) with custom tools; self-hosted so all DB/Shopify access + credentials stay in our infra. Not in `web/`. |
| Human channel | **Extend the existing Next.js dashboard** — ticket queue, approvals, escalations. |

### Model tiers (starting point — tune per phase; confirm exact model IDs against OpenAI's current catalog)

- **Spam gate + categoriser** → a **cheap/fast tier** model (the brief calls out token cost here). Use OpenAI **Structured Outputs** (`response_format` json_schema) for the category/level classification — deterministic, parseable.
- **Tool-using drafting subagents** → a **mid tier** model with strong tool-calling.
- **Level 4 / sensitive** → the **top tier** reasoning model.

These are cost/quality choices, not hard requirements — any tier can be raised. Pin exact
model names in a shared config so the whole worker upgrades in one place.

### Why Microsoft Graph shapes Phase 1

- Graph `message.conversationId` natively groups emails into conversations → direct
  backing for "tickets are conversations, not individual emails."
- Sending replies + forwarding uses the same Graph mailbox API.

### Email ingestion: delta polling vs. subscriptions (decision: **delta polling first**)

Two ways to learn a new email arrived. They differ in who initiates.

- **Delta polling (pull) — chosen for v1.** The worker calls Graph's delta endpoint
  (`GET /users/{mailbox}/mailFolders/inbox/messages/delta`) on a timer (~30–60s). The
  first call returns current state + a **`deltaLink`** (a "you've seen up to here" token);
  each later call returns **only what changed** since that link and hands back a fresh
  one. Simple, no public endpoint, **idempotent**, and **catch-up-safe** — if the worker
  is down, the next poll replays everything missed via the stored link. Cost: latency =
  poll interval.
- **Change notifications (push) — later, optional.** Graph POSTs a lightweight
  notification to a **public HTTPS endpoint** in near real-time; you then fetch the
  message. Downsides: needs the public endpoint + validation handshake, subscriptions
  **expire (~3 days for mail) and must be renewed**, and notifications are best-effort so
  a delta backstop is required anyway.

**Architecture consequence:** build the delta reconciliation as the *engine* (source of
truth). Subscriptions, if added later, are just a thin trigger that pokes the same engine
to run now — not a rewrite. So the choice is reversible and non-blocking.

---

## Proposed file structure

The agent worker is a **new top-level `agent/` service** with its own `package.json`,
kept separate from `web/` (dashboard) and `scripts/` (sync) per the separation rule in
`AGENTS.md`. It stays in the repo's Node ESM (`.mjs`) style so it can **reuse existing
`scripts/lib/` modules directly** (Supabase REST client, Shopify clients, mappers,
hashing) rather than duplicating them. Folders map onto the phases so the structure is
obvious as we build; `.test.mjs` files sit next to the modules they cover (existing
pattern). `APP_SCHEMA.md` gets updated as each folder lands.

```text
agent/                          # NEW — support-agent worker service (own package.json)
|-- package.json
|-- README.md                   # how to run the worker + required env vars
|-- src/
|   |-- index.mjs               # entrypoint: starts the scheduler/loop
|   |-- config.mjs              # env, model IDs, tunables (poll interval, DRAFT_ONLY flag)
|   |-- ingestion/              # Phase 1
|   |   |-- graph-client.mjs        # Microsoft Graph auth + REST wrapper
|   |   |-- delta-poller.mjs        # delta-query engine (stores/uses deltaLink) — the source of truth
|   |   |-- ticket-writer.mjs       # Graph message -> tickets/ticket_messages (idempotent)
|   |   `-- subscription.mjs        # (later) change-notification subscribe + renewal; pokes delta-poller
|   |-- pipeline/               # cross-phase orchestration per ticket
|   |   |-- triage.mjs              # Phase 2: spam/irrelevant gate
|   |   |-- categorise.mjs          # Phase 3: category + level (structured output)
|   |   `-- route.mjs               # Phase 5: level routing + team forwarding
|   |-- llm/
|   |   |-- openai-client.mjs       # OpenAI client wrapper
|   |   `-- structured.mjs          # json_schema structured-output helpers
|   |-- tools/                  # Phase 4: least-privilege custom tools
|   |   |-- order-number-resolver.mjs
|   |   |-- order-lookup.mjs
|   |   |-- customer-lookup.mjs
|   |   |-- tracking.mjs
|   |   |-- knowledge-retrieval.mjs
|   |   `-- index.mjs               # tool registry + schemas exposed to the LLM
|   |-- drafting/               # Phase 5: reply composition in Brand Voice
|   |   `-- compose-reply.mjs
|   `-- lib/
|       |-- audit.mjs               # data_access_events / integration_events logging
|       `-- dedupe.mjs              # idempotency helpers
supabase/migrations/
|   `-- 0XX_tickets.sql         # Phase 1 schema (tickets + ticket_messages)
web/                            # Phase 6 lives here (dashboard ticket queue + approvals)
```

---

## Phases

### Phase 1 — Ticket data model + email ingestion
**Goal:** every inbound email becomes/joins a ticket, threaded by conversation.

- Migration: `tickets` (the data table the categoriser fills) + `ticket_messages`
  (one row per email, linked by `conversation_id`).
  - `tickets` fields (categoriser-owned): `category`, `level` (1–4), `status`,
    `responsible_team`, `shopify_order_number` (the source-of-truth lookup key),
    `customer_id` (nullable link to `customers`), plus audit columns.
  - Minimise stored personal data; keep raw Graph payloads sanitised (mirror the
    orders/customers sync rules).
- Worker: Graph auth (client credentials), delta-poll the mailbox, dedupe by Graph
  `message.id` (idempotent), upsert into `ticket_messages`, create the ticket on first
  message of a `conversationId`.
- No AI yet — this phase is purely ingestion + schema.

**Exit:** inbound mail reliably lands as threaded tickets; reprocessing is a no-op.

### Phase 2 — Spam / triage gate
**Goal:** drop spam before it consumes storage or agent tokens. Spam is **never kept** —
blocked mail is dropped at ingestion, and adding a rule purges any already-stored mail.

- **First pass — deterministic, no LLM (built):** a per-shop `email_blocklist` (exact
  sender address or whole domain). Runs inside the delta poller *before* any write, so
  blocked senders never reach `tickets` / `ticket_messages`. Managed with
  `npm run blocklist:add -- <email|domain>` (which also purges existing mail from that
  sender via `ticket_messages.from_email`). Per-rule `hit_count`/`last_hit_at` for
  observability.
- **Second pass — cheap LLM (built):** for spam a blocklist can't catch, a single
  cheap-tier structured-output call (`keep | spam | irrelevant`; OpenAI, default
  `gpt-4o-mini`) runs on **new-conversation** mail *before it is written*, so classified
  spam is dropped and never stored. Replies into an existing ticket are never triaged (a
  genuine follow-up can't be discarded), and the classifier **fails open** — any error, or
  a missing OpenAI key, keeps the email. Header-based heuristics (`Precedence: bulk`,
  `List-Unsubscribe`) remain a possible middle tier before the LLM.

- **Audit trail (built):** dropping mail before any write means a blocked email otherwise
  leaves *no trace*, so a wrong drop is invisible. Every decision either pass makes writes
  one `spam_audit` row: `outcome` (`kept`/`blocked`), `decided_by` (`blocklist`/`llm`), and
  a one-line `reason`. A keep the classifier was not confident about is recorded as
  literally `unsure`, and a keep caused by a classifier error sets `failed_open`, so the
  fail-open path is never mistaken for a judged pass. Decisions buffer through a poll and
  flush once; the write is best-effort (a failed audit write is logged, never fatal — a
  retried poll must not re-drop mail). Untriaged replies produce no row, so absence means
  "no decision made", not "kept".
  - **Deliberate exception to "spam is never kept":** the row stores the sender address and
    subject — never the body, and still no ticket/message row. That is the minimum needed
    to review a decision and turn a repeat offender into a blocklist rule. Treat it as
    decision metadata, like `integration_events`.

- **`irrelevant` handling (agreed, NOT built) —** today `irrelevant` is dead information:
  the classifier assigns it and the email is then kept exactly like `keep` (`dropLabels`
  defaults to `['spam']` only), so a judgement we pay for is thrown away. Agreed design:
  - **Store, don't categorise.** An `irrelevant` verdict still writes a ticket, but with
    `status = 'irrelevant'` (a new value on `tickets_status_check`, alongside the already
    unused `spam` slot), `archived_at = now()` so it never enters the active queue, and
    `retention_delete_after = now() + 1 month`. The categoriser and every later AI stage
    skip it entirely, so it costs no tokens.
  - **No new table and no new UI section.** `tickets` already has `archived_at` ("drops
    from active queue while retained") and `retention_delete_after`, so the mechanism
    exists. Phase 6 already specs the queue as "filter by team / level / status", so this
    is **one more filter value, default off**, plus a muted count (`12 irrelevant`) so it
    stays discoverable without becoming something a human must remember to check. A whole
    section would cost more attention than the filtering saves.
  - **Promotion** = clear `archived_at` + `retention_delete_after`, set `status = 'open'`.
    The categoriser then picks it up naturally, because it was never categorised.
  - **Do not embed irrelevant messages.** This matters more than the deletion:
    `ticket_messages.embedding` is `vector(1536)` (~6KB + index entries, far more than the
    body text), and irrelevant mail in the vector index would pollute similar-ticket
    retrieval with Teams/DMARC noise. Skipping the embedding is both the real cost saving
    and a correctness fix.
  - **Retention is deliberately anchored at the decision, not extended by new replies.**
    A recurring noise thread should still expire on schedule; the alternative keeps
    persistent noise alive forever and defeats the purpose. Cost: a reply arriving on day
    25 of an irrelevant thread goes with it. Acceptable for irrelevant mail, and the count
    badge plus a full month is the safety margin.
  - **Blocked on the retention cleanup job**, which does not exist — `retention_delete_after`
    is currently "the mechanism, not a fixed rule" with nothing sweeping it. The 1-month
    deletion needs that job (one reconciler for `orders` + `tickets` + this, durations in
    config, same shape as `embed-knowledge-chunks.mjs`). Without it nothing is deleted and
    storage grows anyway.
  - **Measure before building.** The 60–80% `irrelevant` rate seen in testing is an
    artifact of testing against a work inbox full of internal mail, not a support address.
    `spam_audit` already records every label, so one week of real-mailbox data gives the
    true rate for free. At ~5% this is over-engineering — leave them as ordinary
    low-priority tickets. At 30%+ build it as above.
  - **Prefer blocklist rules for recurring automated senders.** Most measured `irrelevant`
    volume was Teams notifications and internal threads, which a domain rule handles for
    free, deterministically, pre-storage — demonstrated live when adding
    `teams.mail.microsoft` moved two emails from `irrelevant` (stored, kept) to blocked.
    This feature is for *one-off* ambiguous mail (a supplier, a job applicant, a
    wrong-inbox human), which is a much smaller population.

**Exit:** blocklist drops known senders pre-storage (validated live); LLM second pass drops
fuzzy spam pre-storage on new conversations, fail-open and cheap-tier (built + unit-tested;
live run pending); every decision is recorded in `spam_audit` with a one-line reason.
`irrelevant` handling is designed and agreed but not implemented.

### Phase 3 — Categorising agent
**Goal:** fill the subject/kind pair and thus the routing decision.

**Taxonomy — pinned and constrained (`scripts/lib/support-taxonomy.mjs`, migrations 011/012).**
Two axes stored separately, never composed into one value:

- **Subject** (14, shared with knowledge categories): `order`, `delivery`, `return_exchange`,
  `product` (incl. advice), `product_stock`, `payment`, `account`, `promotions`,
  `cosmetovigilance`, `legal_privacy`, `b2b`, `partner_collaboration`, `careers`, `other`.
  `faq` and `brand_story` are knowledge-only and are **not** valid ticket subjects.
- **Request kind** (4): `question` · `problem` · `complaint` · `contact`.
- `secondary_category` + `secondary_request_kind` carry a second subject *with its own kind*,
  since one email can pair an order problem with a stock question.

Why separate rather than 23 composed values like `order_problem`: the subject is what
knowledge retrieval filters on (composed values would need stripping every time), and the
model picks 1-of-14 plus 1-of-4 instead of 1-of-23, which is measurably easier for a
cheap-tier model. `complaint` is a *kind*, so a delivery complaint is (delivery, complaint) —
a standalone "complaints" subject would have overlapped every `problem` value.

- **Level is derived, not guessed.** `defaultLevel(subject, kind)` gives the floor; the
  categoriser may escalate above it but never below (`clampLevel`). Two model-assigned
  fields on the same "needs action" axis would otherwise be able to contradict each other.
  Questions needing a data lookup (order, delivery, payment, account, product_stock) are 2,
  other questions 1; problems and complaints are 3; `contact` is 2.
- **Level 4 is a severity judgement, not a subject.** No `(subject, kind)` pair derives it.
  It is reserved for an explicit threat of legal action or public exposure, hospitalisation,
  or grave injury/danger, so it can only arrive as a model escalation read from the email
  text, and should be rare — "there should basically never be a level 4 email unless
  something really bad happens." The three triggers are pinned in the categoriser prompt and
  the model must name which one fired in its `reason`, so every 4 is auditable.
  - Consequence for `cosmetovigilance`: the formulations are natural, so a reported reaction
    is in practice a mild allergy or irritation — a **level 2** problem answerable with
    advice (its one entry in the override table), not an automatic manager escalation. A
    genuine hospitalisation still reaches 4 through the severity route.
  - Consequence for `legal_privacy`: an RGPD erasure/access request is routine human work
    (**level 3**); a threat to sue over it is the part that is 4.
  - Why it matters: a subject-implied 4 makes "level 4" mean *this topic* rather than *this
    is serious*, which fills the manager queue with routine mail and hides the genuinely bad
    emails inside it. Corrected in migration `013` (comments only — 012 shipped the old
    wording and stays as the record of what ran).
- **Team routing** comes from `defaultTeam(subject)` (Phase 5 consumes it).
- Restricted to classification only (least-privilege — the brief's "first blocker").
- Structured output, with the enums built from the taxonomy module so the model cannot
  return an off-list value; the database check constraints are the second line of defence.

**Built (`agent/src/pipeline/`, cheap tier, default `gpt-4o-mini`):**
- `categorise.mjs` — classification only: no tools, no database, no order lookup. The prompt
  carries the ticket subject and the first + latest inbound bodies, and **not** the sender's
  address or name (classification does not need them).
- Three layers keep the answer inside the taxonomy: enums generated from
  `support-taxonomy.mjs`, a `normaliseCategorisation()` pass for the pair rules a per-field
  enum cannot express, and the 012 check constraints. The pair rules: `contact` on a
  non-relationship subject is read as `question`; a secondary repeating the primary is
  dropped; a secondary kind is never written without its subject.
- **Level floor includes the secondary pair** — an order question that also reports a skin
  reaction is level 4, not 2. An unusable answer falls back to a kind that *raises* the
  floor (`problem`), never one that lowers it.
- `categorise-runner.mjs` — a batch pass in the same poll, selecting on `category is null`
  rather than on what the poll just ingested, so tickets missed by a crash or a key-less run
  are caught up automatically. Deliberately **not** fail-open like the spam gate: a failure
  leaves the ticket pending and counts the attempt in `metadata.categorisation`; after 3 it
  is written as (other, problem) → level 3, team contact, flagged `failed`, so it reaches a
  human instead of occupying a batch slot forever.

**Review set (`agent/eval/`, `npm run eval:categorise`):** 40 labelled emails covering every
subject, every kind, both level-4 triggers, the near-misses that must *not* reach 4,
two-subject emails, English, and phonetic French. Runs the real categoriser (same prompt,
same schema), writes nothing, scores subject / kind / level separately with per-case
`accept` alternatives — support mail is genuinely ambiguous, and scoring against one
arbitrary reading would measure conformity rather than correctness.

Tuning was measurement-driven: baseline 37/40 → 40/40, and each prompt rule beyond the
taxonomy exists to fix a specific measured failure (kind read from phrasing rather than the
action required, in *both* directions; over-eager secondaries, 5 spurious → 0; RGPD read as
level 4; a health report inverted into the secondary slot).

**Validated on real mail (`categorisation_review`, migration 014).** 40 emails randomly
sampled from `contact@qiriness.com` across Nov 2025 / Dec 2025 / Jan 2026 (40 of 1,027,
read-only GETs, no ingestion), 30 of them hand-labelled blind — the agent's columns stay
empty until after labelling, so its answer cannot anchor the reviewer.

First contact with real mail took the score from 100% (synthetic) to **67% subject / 70%
kind / 60% level**, and exposed four rules that were simply wrong:

| what was wrong | evidence | fix |
|---|---|---|
| Every `problem` floored at level 3 | 8 of 30 human labels sat *below* the floor, so `clampLevel` made agreement impossible | lookup subjects (incl. `promotions`) floor at 2 for problems too; the model escalates to 3 |
| `order` vs `delivery` undefined | 7 of 10 subject misses; the human labels split the same request two ways | **dispatch is the line** — before it `order`, after it `delivery` |
| `complaint` fired on tone | 4 misses; an angry customer demanding a refund was labelled `problem` by the human | `complaint` only when *nothing actionable* is asked; anger goes to the level |
| `contact` used for existing partners | 2 misses (a pharmacy asking for an account statement) | `contact` = first approach only |
| Level 3 read as "customer asked for an action" | agent said 2 for lost parcels, missing items, address changes | the prompt now lists what *resolving* it requires, not what the customer wrote |

After those: **subject 77% · kind 90% · level 73%.**

**Exit:** ⚠️ partially met. Kind agreement is good; subject and level are not yet. The
remaining error concentrates in two boundaries that are not settled: `order` vs `delivery`
mid-thread (the text often does not reveal whether the parcel shipped — this may only be
resolvable with order data in Phase 4, not by the model), and whether a pure status chase is
level 2 or 3 (the human labels themselves disagree — the same subject line is labelled both).
Ten sampled emails are still unlabelled.

### Phase 4 — Tools layer (least-privilege, progressive retrieval)
**Goal:** the reusable custom tools the agents call. Each queries narrow
columns/tables — never full scans (per `AGENTS.md`).

#### What each tool is worth (measured 2026-07-30)

**The objective, stated in the taxonomy's own terms:** auto-resolve **level 1**
(answerable from knowledge alone) and **level 2** (answerable by looking
something up — nothing changes), and for **level 3** (needs a state-changing
action) assemble everything a human needs to act, without acting. Level 4 goes
straight to a person untouched.

Across 330 customer-facing categorised tickets, that target is most of the
inbox:

| Level | Tickets | Share | Agent's job |
|---|---|---|---|
| L1 | 42 | 13% | answer from the knowledge library |
| L2 | 156 | 47% | look up, answer, change nothing |
| L3 | 131 | 40% | assemble context, hand to a human |
| L4 | 1 | 0% | escalate untouched |

Tools ranked by tickets unblocked — **build in this order**, because it is
roughly the reverse of the order the list below was originally written in:

| # | Tool | Unblocks | Why here |
|---|---|---|---|
| 1 | **Team routing** (no data access) | 25 (`careers` 11, `partner_collaboration` 14 — all L2 `contact`) | Needs no order data, no retrieval, no Shopify. Pure category → team → acknowledge. The cheapest 8% in the corpus. |
| 2 | **Knowledge retrieval** | ~45 (`product` L1 29, `account` L2 9, `other` 7) | Embeddings and the retrieval path already exist. `account` is already answered by the approved FAQ at 0.62. Gated on writing the ~46 messages' worth of product content (Next Step 3). |
| 3 | **Order-number resolver** | prerequisite for 172 (`delivery` 71, `order` 63, `payment` 21, `return_exchange` 17) | 52% of the corpus is unreachable until a ticket knows which order it is about. Currently `shopify_order_number` is set on **0 of 330** and `customer_id` on **0**. An order reference appears in the first message text of only **82** — the other 248 must resolve by sender identity or ask. |
| 4 | **Order-context bundle** | same 172 | The single payload that serves both goals: it *is* the L2 answer, and it *is* the L3 human handoff. Build it once, and level only decides whether the agent replies or routes. |
| 5 | **Tracking** | 71 `delivery` (29 L2 auto, 42 L3 handoff) | Largest single category. See the open question below — whether it reports what the parcel is *doing* or only its number decides whether those 29 L2s can actually close. |
| 6 | **Promotion/discount lookup** | 34 `promotions` (29 L2) | The `promotions` table is already synced. The biggest single topic here is the newsletter welcome code not applying (20 messages). |

Two consequences worth stating plainly:

- **Nothing in rows 3–5 can be built or validated yet.** Supabase holds the dev
  store — 12 orders, `#1001`–`#1012`, 15 customers — while the mail is from the
  live `contact@qiriness.com` inbox and references `#4854`, `#6216`, `#4613`,
  `Q00 26200111`. There is zero overlap. Syncing real order data is a hard
  prerequisite, not a later cleanup.
- **Rows 1 and 2 are not blocked by that** and cover ~70 tickets (21%) on data
  that already exists. They are the sensible place to start while the order data
  is sorted out.

- **Order-number resolver** — the brief's core flow: (1) parse `#XXXX` from email
  content → (2) match by sender email → (3) if still unknown, draft a reply asking for
  the order number (or, if never issued, name + billing address for a human to verify).
  Email match is "safe"; name/address match is not → routes to a human.
- **Order-context resolver** — once `shopify_order_number` is set, deterministically
  assembles the order/customer bundle (order name, tracking, order-customer name, RFM
  group, etc.) from the synced `orders`/`customers` rows and writes it to
  `tickets.resolved_context` (+ `context_resolved_at`). The drafting agent reads this
  bundle instead of querying each field — the LLM never assembles it piecemeal. Snapshot,
  re-resolvable, scoped, PII-minimised. **Billing/street address is excluded** — it is
  never synced; fetch it live from Shopify only when a task requires it, gated.
- **Order lookup** (by resolved order number → orders + linked customer/RFM).
- **Customer/CRM lookup** (order count, RFM group, registered name).
- **Tracking-number tool** (from `orders.fulfillments`). See the open question below —
  whether this tool can report what the parcel is *doing*, or only what its number is,
  depends on data we have not yet checked.
- **Knowledge retrieval** (reuse existing embeddings for product questions — no order
  number needed). See the embedding section below for what is embedded, when, and why the
  ticket text does *not* need storing to search with.
- Tools with side effects (any Level 3/4 action, sending mail) are **gated** — the Tool
  Runner returns a "needs approval" result instead of executing.

**Exit:** each tool has typed inputs/outputs, error handling, and audit logging.

#### Embedding and retrieval — the plan

**Sequencing (agreed 2026-07-28).** Incoming emails are embedded *first*; the knowledge
library is filled in and approved afterwards. The chunk counts quoted below are therefore
deliberately sparse and are **not** a measure of anything — they describe a library that has
not been written yet. The order matters because the email side is where the mechanics live
(composition, stripping, determinism, backfill), and it can be built and verified against
348 real messages that already exist.

##### 1. What embedding is for here

The email *must* be embedded — that is the connection mechanism. The customer's text becomes
a vector, and cosine distance against the stored `knowledge_chunks` vectors is what links
"my parcel hasn't arrived" to the delivery article without the two sharing a single keyword.
There is no retrieval without embedding the email.

##### 2. What is stored, and why both sides are

Strictly, a *query* vector could be computed and discarded — only the *corpus* being searched
has to persist. We store the email vectors anyway:

1. **Reproducibility.** OpenAI does not guarantee bit-identical floats across calls (this
   repo's own embedding principle). If a retrieval returns odd chunks, re-embedding to
   investigate would not search with the same vector. Storing makes a retrieval replayable,
   the same way `embedded_input_hash` makes the knowledge side deterministic.
2. **Re-use.** A ticket is categorised, re-categorised on reply, drafted, possibly
   re-drafted after a human edit. Each step may retrieve. Embed once.
3. **The Q→A corpus accumulates free** — ticket messages then *are* a corpus, so "find a
   similar past question and how we answered it" needs no backfill of the archive.
4. **Cost is not a factor.** All 348 existing messages come to roughly $0.0014.

| What | Stage | Role |
|---|---|---|
| Knowledge chunks (approved, non-brand) | on approval — inline best-effort + `embed:knowledge` reconciler | **corpus** |
| Inbound customer messages | at ingestion, inline best-effort + reconciler | **query** *and* corpus |
| Outbound team replies | same pass — the "A" half of Q→A | corpus, once Q→A retrieval is built |
| Brand voice (`core_topic = 'brand'`) | never | never retrieved — always included in full |

##### 3. When: at ingestion, mirroring the knowledge side

`ticket_messages` already carries the same determinism quadruple as `knowledge_chunks`
(`embedding_model`, `embedding_dimensions`, `embedded_input_hash`, `embedded_at`), so the
proven pattern drops straight in: an inline best-effort call when the row is written, plus an
`embed-ticket-messages` reconciler for retries, backfills and model changes.

**Inline failure must never fail ingestion.** A missing vector degrades retrieval to the
category filter; a failed ingestion loses an email. Ingestion is the right stage rather than
categorisation because the corpus is then complete whether or not categorisation ran, and
there is exactly one place a message becomes a vector.

##### 4. What text goes in

**Chunk input drops the category (decided 2026-07-28).** Chunks were composed as
`title → category → section_heading → chunk_text`; the category is now removed, leaving
**`title → section_heading → chunk_text`**. Reason: retrieval always filters by category
first, so embedding the category name into every chunk adds a near-constant to every
candidate inside the filtered set — by the same argument that lets blended queries survive
filtering, a constant contributes nothing to ranking while diluting the actual content.
`title` already gives a bare chunk its topical anchoring ("Livraison et retours"), which is
what stops a fragment like *"Comptez 3 à 5 jours ouvrés"* floating free.

Done **now** deliberately: changing the composition changes `embedded_input_hash` and
re-embeds everything. Today that is 54 chunks (11 embedded); after the library is written it
is thousands. Minor caveat accepted: with `faq` chunks always eligible a candidate set can
span two or three categories, so the token was not perfectly constant — but `title` covers
that discrimination.

An email's analogue is **`subject → cleaned, quote-stripped body`**. Support subject lines
carry real signal ("Colis bloqué", "remboursement commande #5229"), so dropping them loses
information. `embedded_input_hash` covers the whole composed string, so a subject
correction, a body edit or a change to the stripper all correctly invalidate the vector.

**Strip quoted history first.** Measured with the real stripper (an earlier SQL estimate of
"9 of 348" was badly low): **104 of 348 messages carry quoted history, and it is 53% of the
corpus by character count** — over half the stored text is duplicated conversation. Every cut
comes from an unambiguous structural marker (`De:`+`Envoyé:` header block 88, `a écrit :` 10,
`-----Message d'origine-----` 3, `From:`+`Sent:` 3); the loose `>`-line heuristic fires on
none of them. Size is not the real cost: re-embedding
a quoted original means the reply's vector is dominated by text already embedded on the
earlier message, so a follow-up reading "merci, et le remboursement ?" produces a vector
nearly identical to the question it quotes — the two become indistinguishable in the corpus
and a similar-question search returns the same conversation twice. Strip the
`Le … a écrit :` / `-----Message d'origine-----` / `De: … Envoyé:` block forms and
`>`-prefixed lines. The same stripper fixes the categoriser, which currently reads a quoted
original as the thread's *latest* message.

**Size: measured, and not a problem.** Over 348 real messages (tokens ≈ chars/4):

| direction | n | median | mean | p95 | max |
|---|---|---|---|---|---|
| inbound | 225 | 116 | 237 | 718 | **2 134** |
| outbound | 123 | 130 | 222 | 727 | 1 920 |

`text-embedding-3-small` accepts **8 191 tokens**; the longest email uses a quarter of that
and exactly one message exceeds 2 000. Therefore:

- **Do not chunk emails.** Chunking exists for long structured articles with headings.
  Splitting a 116-token median message yields fragments too small to carry meaning.
- **One message, one vector.** That is what `ticket_messages.embedding` is.
- **Cap at ~6 000 tokens anyway**, head-preserving (a reply puts new text at the top, quoted
  history below), and log when it fires. It should never fire; if it starts, that is a signal
  about the mail, not a knob to tune.

##### 5. How retrieval works

1. Ticket is categorised → `category`, and possibly `secondary_category`.
2. Take the **first and latest inbound** messages and their stored vectors (embed now if
   missing; never fail).
3. For each subject, cosine search `knowledge_chunks` where the chunk category matches
   **and** `embedding is not null`.
4. Merge, cap, and pass into the drafting prompt alongside the always-included brand voice
   and the Phase 4 order-context bundle.

**`faq` chunks are eligible for every subject.** `faq` is a knowledge-only category and is
never a ticket subject, so a strict subject match would make those chunks permanently
unreachable — and an FAQ article answers questions across topics by nature. The candidate set
is therefore `chunk.category IN (ticket.category, ticket.secondary_category, 'faq')`.

**Top-k, not a high similarity threshold** — see below; a high cut-off is exactly where
two-topic emails fail silently.

*Refinement from the first real run (2026-07-29).* A **low noise floor** is a different thing
from a high threshold, and looks necessary. Measured against the 11 embedded chunks: a ticket
whose answer exists scored **0.624** (an account login question matching the password-reset
FAQ), while tickets with no corresponding article scored **0.375–0.484** — the top-k of
nothing is still noise, and would reach the drafting prompt as if it were relevant. A floor
around 0.4–0.5 excludes that without approaching the range where a blended two-topic query
lives. Do not hard-code a number yet: n is 11 chunks and 5 samples. Calibrate once the
library is real.

##### 6. Two distinct topics — the mechanism, and where it breaks

An email raising a delivery problem *and* a stock question produces **one blended vector**.
Both per-subject searches use that same blended vector: filtering by category changes which
chunks are *candidates*, not the query.

**Why it still works.** Inside the `delivery` candidate set every chunk is about delivery, so
the query's stock component is about equally irrelevant to all of them — it adds a
near-constant offset to every score, and a constant offset does not change ordering. The
delivery component does the ranking. Blending destroys *absolute* similarity but largely
preserves *relative ranking within a filtered set*. That is the whole mechanism, and it is
why the category filter does the heavy lifting rather than the vector.

**Where it breaks — two consequences to design around:**

- **A similarity threshold breaks it.** A blended query can score below a fixed cut-off for
  *both* topics and return nothing, while its top-3 in each category are still the right
  chunks. Hence top-k, never a threshold. If a threshold is ever added, two-topic emails go
  silently empty.
- **It degrades when one topic dominates the text.** A 300-word delivery complaint with a
  one-line stock question yields a vector that is ~90% delivery; ranking within the stock
  chunks is then close to arbitrary, because the component is too weak for the offset to stay
  constant.

**The upgrade, when it is needed.** Have the categoriser emit a one-line restatement *per
topic* — it already reads the email and already produces `reason`. Embed those separately for
two clean, undiluted query vectors. Two tiny embeddings per multi-topic ticket.

**Trigger condition:** only worth building when a category holds enough chunks that ranking
matters. With three chunks in a category you take all three and ranking is irrelevant — so
the blending problem and the point where vector search earns its keep arrive together.
Roughly: revisit when a high-volume subject passes ~100 chunks. On real mail 28% of tickets
carry a secondary subject, so this is a real case rather than a hypothetical.

##### 7. First + latest — two searches, not one concatenation

**Decided: first + latest inbound**, matching what the categoriser reads.

Implement as *two searches using the two stored per-message vectors*, not as one embedding of
the concatenated text. Concatenating re-introduces the averaging problem above (an opening
question plus a terse chase averaged into one vector) and needs somewhere to store a
synthetic ticket-level vector belonging to no message.

**Merge on raw cosine score, unweighted (decided 2026-07-28).** Both vectors are cosine
against the same corpus, so the scores are directly comparable; pool the two result sets and
take top-k. No tuned constant, and the richer message wins naturally — which the data says is
usually the latest, inverting the assumption this started from:

| across the 41 multi-message tickets | first | latest |
|---|---|---|
| average tokens | 186 | **324** |

Only 3 of 41 have a latest under 30 tokens. Follow-ups *escalate* — they add the order
number, the history, the specific ask. Interleaving was rejected for this reason: it would
force the first message into the results even when stale, and re-categorisation already makes
the category filter track the *latest* topic.

**70% of tickets have a single inbound message** (119 of 171), so first and latest are the
same row and this degenerates to one search automatically.

| inbound messages per ticket | 1 | 2 | 3 | 4–5 |
|---|---|---|---|---|
| tickets | 119 | 27 | 8 | 6 |

##### 8. Curated exemplar threads — how the agent learns the *form* of a reply
**(decided 2026-07-28: curate, do not retrieve raw history)**

Three libraries, cleanly separated by what they carry:

| library | carries | reaches the prompt by |
|---|---|---|
| `knowledge_documents` / chunks | **facts** — what is true | retrieved, filtered by subject |
| `voice_profile` (brand) | **identity** — who we sound like | always included in full |
| **exemplar threads** (new) | **form** — how we answer this kind of thing | retrieved, filtered by (subject, kind) |

**Why curated rather than retrieved from history.** Two reasons, the second decisive:

1. Past replies are unvetted. Some are stale, off-brand, or written under time pressure. A
   live reply in the corpus reads *"Le code de bienvenue est BIENVENUE20, il n'est pas
   cumulable…"* — as a few-shot example for an unrelated promo question that invites the
   model to hand a specific code to a customer it does not apply to. Few-shot examples leak
   specifics, not just tone.
2. **Personal data.** Retrieving a real past thread puts *customer A's email* into the prompt
   that drafts a reply to *customer B*. Against `AGENTS.md` ("exclude personal customer data
   from AI prompts unless strictly required") that is hard to justify when what is wanted is
   the shape of a good reply, not that customer's details. Curated exemplars are scrubbed by
   construction — making one timeless means removing the order number and the name anyway —
   so the problem disappears rather than needing mitigation.

This also mirrors the knowledge library's founding rule: nothing auto-syncs, every row is an
explicit human decision.

**Shape.** An exemplar is an anonymised (customer message → approved reply) pair, labelled
with `category` + `request_kind` + **`happiness`**, so it is retrievable on the axes that
actually determine what a good reply looks like.

**Happiness is human-assigned (decided 2026-07-28)**, not copied from the categoriser. It is
curation metadata — "this is how we answer an angry one" — in the same way
`categorisation_review.human_category` is a human label rather than a model output. The
person curating knows which register the reply demonstrates.

**Retrieve on (subject, kind), then rank by tone proximity — do not filter on happiness.**
14 subjects × 4 kinds × 4 happiness values is 224 combinations; filtering on all three would
be empty almost everywhere. Instead filter on `(category, request_kind)` and order candidates
by `abs(exemplar.happiness − ticket.happiness)`. That degrades gracefully: with one exemplar
for the pair you get it regardless of tone match, and with several you get the closest
register first.

**Sourcing.** Seed from the real corpus — the mailbox already holds a large, representative
question space. Workflow mirrors the knowledge library's import path: pick a real ticket →
*promote to exemplar* → edit to strip specifics and generalise → approve. Which threads to
promote is itself a use for the ticket embeddings: cluster the corpus and promote the
representative thread from each cluster, so coverage is chosen by real demand rather than
guesswork.

**Do they need embedding?** Probably not at first. With 14 subjects × 4 kinds there are 56
combinations; 2–3 exemplars each is ~50 rows, so an exact `(category, request_kind)` filter
returns 2–3 and you take all of them. Same reasoning as the knowledge chunks: build the
table, the curation path and the filter first; add vectors when a combination holds enough
exemplars for ranking to matter.

**Sequencing.** The table and retrieval belong with Phase 5 drafting. Curation does **not**
need a UI to start — `categorisation_review` set the precedent of a table humans edit
directly in the Supabase editor. A proper editing surface in the dashboard can follow.

##### 9. Compliance

An embedding of a customer's message is a **derived representation of their personal data**,
and embeddings are partially invertible. A redact request must clear
`ticket_messages.embedding` and its determinism metadata, not only `body_text`. One line at
build time; an audit finding if retrofitted.

Exemplar rows are exempt by construction — they hold no personal data, because curation
removes it. That is a property to *enforce* at approval, not merely to hope for.

##### 10. Work items, in order

1. **Quote stripper** — pure module, shared by the embedder and the categoriser. Unit-tested
   against the French/Outlook forms above. Fixes a live categoriser bug on its own.
2. **Embedding input composition + hash** — `subject → stripped body` for emails;
   **drop `category`** from the chunk composition at the same time, while it is only 54
   chunks. Both feed `embedded_input_hash`; the stripper version is part of the hashed input.
3. **Inline best-effort embed at ingestion** — write the vector when the message row is
   written; never fail ingestion on an embedding error.
4. **`embed-ticket-messages` reconciler** — mirrors `embed-knowledge-chunks.mjs`: gates on
   the determinism quadruple, so a re-run over unchanged text is a no-op.
5. **Backfill** — re-embed the 54 chunks under the new composition, and embed the 348
   existing messages (~$0.0014 all in). Also the first real test of the pipeline.
6. **Retrieval tool** (Phase 4) — per-subject searches including `faq`, top-k, raw-score
   merge across first + latest, typed in/out, audit logging.
7. **Redaction clears vectors** — extend the compliance path.
8. **Exemplar threads** (Phase 5) — table with a human-assigned `happiness`, promote-from-
   ticket path, `(category, request_kind)` retrieval ranked by tone proximity. Curated in the
   Supabase editor first; dashboard UI later.
9. **Clustering script** (optional, any time after step 5) — prints clusters with a
   representative message per subject, to drive both what to write and what to promote.

##### 11. Deferred and parked (reviewed 2026-07-28)

- **Residual query/corpus asymmetry — parked, deliberately.** Chunk vectors still carry
  `title` and `section_heading` scaffolding while an email query is subject + prose.
  Dropping the category narrowed the gap; the rest is not worth engineering until retrieval
  quality is *demonstrably* bad against a library worth measuring. Revisit only on evidence,
  not on principle.
- **Personal-data enforcement on exemplars — deferred.** No approval-time check for now. The
  convention stands (curation strips names, order numbers and codes — which making an
  exemplar timeless requires anyway), it is simply not machine-enforced. Worth recording
  that the design's compliance advantage over retrieved history depends on the scrubbing
  actually happening, so this returns before anything is exposed beyond dev. Work item 7
  (redaction clears vectors) stays where it is — it is one line and belongs with the
  embedding write path.
- **Clustering — to explore.** See below; not on the critical path, and free once the corpus
  is embedded.

##### 12. Clustering the ticket corpus (agreed to explore)

Two questions the embedded corpus can answer that nothing else can, both feeding work you
are about to do anyway:

- **What should the knowledge library cover first?** Grouping by `(category, request_kind)`
  already ranks demand — `order` alone is 36 tickets against 0 chunks. Clustering adds the
  resolution that matters: *within* `order`, is the demand "cannot complete checkout",
  "wrong address entered", or "add an item before dispatch"? Those are three different
  articles, and the label alone cannot separate them.
- **Which threads to promote to exemplars.** Promote the representative of each cluster, so
  exemplar coverage follows real demand instead of intuition.

Practical shape: cluster the ~225 inbound message vectors, expect roughly 15–25 meaningful
groups — small enough to review by hand. Cluster *within* a subject rather than globally, so
the output is directly actionable per article. Nothing here needs to be automated or
productised; a script that prints clusters with a representative message per cluster is
enough to drive both decisions.

#### Open question — live parcel status (raised 2026-07-27, not yet investigated)

**Can the agent find out what a parcel is actually doing, not just what its tracking number
is?** This is the single largest lever on the level 2/3 error class, and it is *not* a
prompt problem — with parcel status the decision stops being a model judgement and becomes
arithmetic over data, which is how `level` is meant to work.

Measured evidence for why it matters: on the 30-email review set, 4 of the 7 level
disagreements are the same shape — human `delivery/problem` L3, agent L2 — and the human
notes each say some version of *"requires someone to intervene"*. The agent read "look up
the tracking and reply"; the reviewer knew the parcel was stuck. Neither can be right
without knowing the parcel's state.

What the rule would be, given a status:

| Customer says | Parcel status | Level |
|---|---|---|
| "where is my parcel?" | `IN_TRANSIT`, recently scanned | 2 — answer with tracking, no human |
| "where is my parcel?" | `IN_TRANSIT`, no movement for ~10+ days | 3 — someone must chase the carrier |
| "never arrived" | `DELIVERED` | 3 — investigation, possible resend |
| "never arrived" | `ATTEMPTED_DELIVERY` / `NOT_DELIVERED` / `FAILURE` | 3 — needs intervention |

The stale-in-transit case is pure arithmetic on `in_transit_at`; no model call involved.

**What is already synced.** `shopify-order-mapper.mjs` maps each fulfillment into
`orders.fulfillments` with `status`, `display_status`, `in_transit_at`, `delivered_at`,
`estimated_delivery_at` and `tracking_info[] { number, company, url }`. Shopify's
`displayStatus` enum already covers `IN_TRANSIT`, `OUT_FOR_DELIVERY`, `DELIVERED`,
`ATTEMPTED_DELIVERY`, `NOT_DELIVERED`, `FAILURE`. If those are populated, the tool is a
small read over data we already hold and costs nothing new.

**The unknown.** Those fields are only filled when the carrier or shipping app pushes
fulfillment events into Shopify. If it only writes a tracking number at dispatch,
`display_status` stays `FULFILLED` and the timestamps stay null forever. The dev store
cannot answer this — its orders are test data (`tracking_info.number` is literally
`"TEST"`, all status timestamps null).

**How to settle it:** open a recently shipped *production* order in Shopify admin. A live
status ("In transit", "Delivered") means the data is already there. Just "Fulfilled" plus a
tracking link means it is not, and status lives only at the carrier.

**If Shopify does not have it**, roughly in order of preference:
- **Carrier APIs directly** — La Poste/Colissimo, Chronopost, Mondial Relay, DHL all
  publish tracking APIs. Free and accurate, but one integration per carrier; note
  `deret.fr` appears in the support inbox, so a logistics partner may sit in the chain.
- **An aggregator** (AfterShip, 17track, EasyPost) — one API across carriers, free tiers
  around 100 shipments/month. This sends tracking numbers to a third-party processor, so it
  needs documenting under `SHOPIFY_PERSONAL_DATA_PROTECTION.md` before use.
- **Neither** — keep routing these to a human, which is today's behaviour.

### Phase 5 — Response generation + level-gated automation & team routing
**Goal:** turn a categorised ticket into the right action.

- **L1** auto-send · **L2** auto-send + suggested human action · **L3** human-approved
  action · **L4** manager escalation.
- **Start in draft-only mode** (global `DRAFT_ONLY` flag): *every* level, including L1,
  produces a draft a human approves — nothing is sent automatically. The level logic is
  built now; flipping `DRAFT_ONLY` off later graduates L1 (then L2) to auto-send once
  trust is established. This is a config change, not a rebuild.
- Drafting subagent (mid-tier model) composes replies in Brand Voice using the Phase 4 tools.
- **Team forwarding:** B2B / invoice / marketing / influencer / freelancer mail →
  finance · marketing · sales · logistics inboxes (+ the contact team that can filter
  tickets per responsible person). This is Graph forward + a `responsible_team` tag.

**Exit:** with `DRAFT_ONLY` on (the initial state), every level produces a
draft/escalation and nothing auto-sends; the flag is the single switch to graduate L1/L2
to auto-send later.

### Phase 6 — Human-in-the-loop dashboard surface
**Goal:** where humans review, approve, act (chosen channel).

- New dashboard route: ticket queue (filter by team / level / status), conversation
  view, approve/edit/send for L3, escalate for L4.
- The status filter carries Phase 2's `irrelevant` handling: an `irrelevant` filter value
  (default off) plus a muted count, and a promote action that clears `archived_at` +
  `retention_delete_after` and sets `open`. Deliberately **not** a separate section — see
  Phase 2. This is the UI half of that design; the data half lands in Phase 2.
- Reads/writes the same Supabase tables the worker uses; every human view writes a
  `data_access_events` row (existing audit requirement).

**Exit:** a human can clear an L3 ticket end-to-end from the dashboard.

### Phase 7 — Memory (deferred, as the brief notes)
Per-customer / per-ticket memory to enrich context. Explicitly out of scope until
Phases 1–6 are stable.

---

## Cross-cutting (every phase)
- **Audit + personal-data minimisation** per `AGENTS.md` and `SHOPIFY_PERSONAL_DATA_PROTECTION.md`.
- **Role guardrails** — each agent gets only the tools its category/level needs.
- **Idempotency** on all ingestion and side-effecting operations.
- **Tests** — Node built-in tests alongside each module, matching the existing pattern.

## Resolved decisions
- **Ingestion:** delta polling first; subscriptions later as an optional trigger on the
  same delta engine.
- **Send behaviour:** draft-only to start (`DRAFT_ONLY` flag), may graduate L1/L2 to
  auto-send later.
- **Team routing:** the worker **forwards the email out to the implicated person** (Graph
  forward) — i.e. the responsible individual in finance / marketing / sales / logistics —
  and tags the ticket `responsible_team`. Needs a config mapping (category → recipient
  address); the contact team can still see all tickets to reassign.

## Deferred (deploy-time, not design-time)
- **Where the worker runs + secrets management.** The worker is an always-on Node
  process; production needs a host that keeps it running (recommendation: **Azure**, same
  tenant as the Microsoft 365 mailbox), plus a secrets store for the Graph, Supabase, and
  OpenAI credentials (`.env` locally; host secret store in prod — never in git). Phase 1
  is built and tested **locally with a `.env`**, so this does not block development —
  decide hosting when we go unattended.
