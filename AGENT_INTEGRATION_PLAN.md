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

**Exit:** blocklist drops known senders pre-storage (validated live); LLM second pass drops
fuzzy spam pre-storage on new conversations, fail-open and cheap-tier (built + unit-tested;
live run pending).

### Phase 3 — Categorising agent
**Goal:** fill `category` + `level` and thus the routing decision.

- Category: order question / delivery issue / product question / B2B-invoice-marketing / etc.
- Level: 1 (question only) · 2 (data lookup) · 3 (state-changing) · 4 (sensitive).
- Restricted to classification only (least-privilege — the brief's "first blocker").
- Structured output; writes back to the ticket row.

**Exit:** categoriser agrees with human labelling on a review set.

### Phase 4 — Tools layer (least-privilege, progressive retrieval)
**Goal:** the reusable custom tools the agents call. Each queries narrow
columns/tables — never full scans (per `AGENTS.md`).

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
- **Tracking-number tool** (from `orders.fulfillments`).
- **Knowledge retrieval** (reuse existing embeddings for product questions — no order
  number needed).
- Tools with side effects (any Level 3/4 action, sending mail) are **gated** — the Tool
  Runner returns a "needs approval" result instead of executing.

**Exit:** each tool has typed inputs/outputs, error handling, and audit logging.

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
