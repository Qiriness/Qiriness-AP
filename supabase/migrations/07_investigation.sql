-- ============================================================================
-- 07 — INVESTIGATION
-- The stage between labelling a ticket and answering it: an agent calls the
-- Phase 4 retrieval tools and writes down what it established, what it could
-- not, and what is missing. Runs after 06, and depends on 03 (the taxonomy
-- columns and the needs_categorisation pattern this mirrors).
--
-- WHAT THIS IS FOR. Six retrieval tools existed with nothing calling them: the
-- pipeline labelled a ticket and stopped. This is the consumer. Its output — the
-- case file — is the same object at every level, and the level only decides who
-- reads it: L1/L2 it is the answer, L3 it is the handoff a human acts on, L4
-- never reaches it at all.
--
-- WHY THE CASE FILE IS A TABLE AND NOT A COLUMN ON tickets. A ticket is
-- investigated once per inbound message, not once. Threads grow, and the reading
-- of a thread that has grown is a different reading — the same reason
-- categorisation keeps a history. A row per investigation makes the trajectory
-- legible and makes the pass safe to re-run; a column would overwrite the
-- previous answer and lose the fact that it changed.
--
-- WHAT IS DELIBERATELY NOT HERE. No column holds the reply intent (it is derived
-- from the verdict), and none holds a confidence score. The first would let two
-- stored fields disagree about the same decision; the second was measured on
-- this mailbox and found constant.
-- ============================================================================

-- ============================================================================
-- tickets — the queue flag and its timestamp
-- ============================================================================
--
-- Exactly the shape 03 gave categorisation, and for the same reasons: a boolean
-- flag rather than a `investigated_at < last_message_at` comparison, because
-- PostgREST cannot compare two columns and our own outbound replies also move
-- last_message_at.
--
-- ONE WRITER RAISES IT: the categoriser, in the same patch that clears
-- needs_categorisation. Ingestion does not touch it — a new inbound message
-- raises needs_categorisation, the categoriser re-labels the thread and then
-- re-raises this. That ordering is what stops a ticket being investigated with
-- a tool set chosen from the previous conversation's subject.
--
-- Default false, not true: a ticket that has never been categorised has no
-- subject to choose tools from, so it must not enter this queue on insert.

alter table public.tickets
  add column needs_investigation boolean not null default false,
  add column investigated_at timestamptz;

-- Partial index: the queue reads only the flagged rows, and on a table where
-- almost none are flagged at rest a full index would be mostly dead weight.
create index tickets_needs_investigation_idx
  on public.tickets (shop_id, first_message_at)
  where needs_investigation;

comment on column public.tickets.needs_investigation is
  'Pending flag for the investigation pass. Raised by the categoriser when it finishes labelling a ticket (and again on each re-categorisation), cleared by the investigation pass. Default false because an uncategorised ticket has no subject from which to choose tools.';

comment on column public.tickets.investigated_at is
  'When the last case file was written. Not a queue predicate -- needs_investigation is; this is for reporting and for spotting a ticket whose case file predates its latest reply.';

-- ============================================================================
-- ticket_investigations — the case file
-- ============================================================================
--
-- IDEMPOTENCY, keyed on the message that triggered the run. `unique (shop_id,
-- trigger_message_id)` means one investigation per inbound email: a re-run over
-- the same thread rewrites its own row instead of adding a second, and a
-- customer's reply produces a new row rather than overwriting what was concluded
-- about the earlier message. Same reasoning as ticket_forwards keying on the
-- message rather than the ticket.
--
-- THE FOUR EVIDENCE COLUMNS ARE SEPARATE ON PURPOSE. established / unverified /
-- missing / do_not_claim could be one jsonb blob; they are not, because the
-- distinction between them is the entire safety property. A fact and a doubt in
-- one list get read as two facts -- measured on the promotion tool, where a
-- merged rendering produced "votre code est valide, réessayez" for a customer
-- whose basket was under a minimum nobody can see.
--
-- PERSONAL DATA. The claims are prose written from tool output, so they inherit
-- the tools' own scope: a customer's name and order state can appear, a street
-- address and a phone number cannot, because no tool returns them. The order
-- bundle itself is NOT copied here -- context_ref points at
-- tickets.resolved_context, so personal data is not duplicated across a row per
-- investigation.

create table public.ticket_investigations (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,

  -- Denormalised from the ticket, and the seam Phase 7 memory hangs off:
  -- "what did we find and conclude for this customer last time" is a query on
  -- this column. Null for a sender who has never been matched to a customer.
  customer_id uuid references public.customers(id) on delete set null,

  -- The inbound message this run was triggered by. THE IDEMPOTENCY KEY.
  trigger_message_id uuid not null references public.ticket_messages(id) on delete cascade,

  verdict text not null check (
    verdict in ('answerable', 'needs_customer_input', 'needs_human')
  ),

  -- Facts, each carrying the tool-call ids it rests on. A claim whose ids are
  -- not in tool_calls is dropped before it gets here (see dropped_claims).
  established jsonb not null default '[]'::jsonb,
  -- What the customer asserted, or what no tool could settle. Never a fact.
  unverified jsonb not null default '[]'::jsonb,
  -- The specific facts only the customer can supply. The question that asks for
  -- each one is written in code, not stored -- the model names the field.
  missing jsonb not null default '[]'::jsonb,
  -- Derived prohibitions. Generated from the caveats the tools raised, never
  -- asked of the model: it is least likely to remember the caveat covering the
  -- gap it has just filled in.
  do_not_claim jsonb not null default '[]'::jsonb,

  -- Approved knowledge chunks that cleared the answerable band. Weak matches are
  -- deliberately absent rather than included and flagged.
  knowledge jsonb not null default '[]'::jsonb,
  -- A POINTER to tickets.resolved_context, not a copy of it.
  context_ref jsonb not null default '{}'::jsonb,

  -- INTERNAL. What a human must do, and why. Never rendered into anything a
  -- customer receives -- the drafting projection of a case file omits it.
  handoff jsonb,

  -- The ledger: which tools ran, with what outcome. This is what makes an
  -- established claim checkable after the fact.
  tool_calls jsonb not null default '[]'::jsonb,
  -- Claims that cited a call that never ran. Kept rather than discarded: a run
  -- that keeps producing them is a prompt problem worth seeing.
  dropped_claims jsonb not null default '[]'::jsonb,

  -- Why the level moved, in words. Computed from the evidence by
  -- investigation-rules, never judged by the model.
  escalation_reasons jsonb not null default '[]'::jsonb,
  -- What the evidence implied before the ticket's level ratchet was applied,
  -- mirroring metadata.categorisation.proposed_level: without it a ticket pinned
  -- at 3 by an earlier message hides the fact that this reading was calmer.
  proposed_level smallint check (proposed_level is null or proposed_level between 1 and 4),

  model text,
  investigated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  unique (shop_id, trigger_message_id),

  constraint ticket_investigations_established_array_check check (
    jsonb_typeof(established) = 'array'
  ),
  constraint ticket_investigations_unverified_array_check check (
    jsonb_typeof(unverified) = 'array'
  ),
  constraint ticket_investigations_missing_array_check check (
    jsonb_typeof(missing) = 'array'
  ),
  constraint ticket_investigations_do_not_claim_array_check check (
    jsonb_typeof(do_not_claim) = 'array'
  ),
  constraint ticket_investigations_tool_calls_array_check check (
    jsonb_typeof(tool_calls) = 'array'
  ),
  constraint ticket_investigations_context_ref_object_check check (
    jsonb_typeof(context_ref) = 'object'
  )
);

create index ticket_investigations_ticket_idx on public.ticket_investigations (ticket_id);
create index ticket_investigations_shop_verdict_idx on public.ticket_investigations (shop_id, verdict);
-- The memory seam: prior case files for one customer, newest first.
create index ticket_investigations_customer_idx
  on public.ticket_investigations (customer_id, investigated_at desc);

alter table public.ticket_investigations enable row level security;

comment on table public.ticket_investigations is
  'One case file per investigation run: what the agent established from the retrieval tools, what it could not verify, what is missing, and what must not be claimed. Consumed by the drafting stage and by the human queue. unique(shop_id, trigger_message_id) makes the pass safe to re-run and keeps a thread''s successive readings as separate rows.';

comment on column public.ticket_investigations.trigger_message_id is
  'THE IDEMPOTENCY KEY. The inbound message that put the ticket into the investigation queue. Per message rather than per ticket, so a reply produces a new reading instead of overwriting the previous one.';

comment on column public.ticket_investigations.established is
  'Facts, each with the tool-call ids it rests on. A claim citing a call absent from tool_calls never reaches this column -- it is moved to dropped_claims.';

comment on column public.ticket_investigations.unverified is
  'What the customer asserted, or what no available tool could settle. Kept apart from established because a doubt merged into a list of facts is read as a fact.';

comment on column public.ticket_investigations.do_not_claim is
  'Derived prohibitions for the drafting stage, generated in code from the caveats the tools raised and from the missing fields. Never model-authored.';

comment on column public.ticket_investigations.handoff is
  'Internal instruction for a human when the verdict is needs_human. Excluded from every customer-facing rendering of this row.';

comment on column public.ticket_investigations.context_ref is
  'Pointer to tickets.resolved_context (order name, customer id, whether a bundle exists) rather than a copy of it -- so personal data is not duplicated per investigation, and a rebuilt bundle is not shadowed by a stale copy.';

comment on column public.ticket_investigations.customer_id is
  'Denormalised link to the customer, and the seam for future per-customer memory: prior case files for this customer are a query on this column.';
