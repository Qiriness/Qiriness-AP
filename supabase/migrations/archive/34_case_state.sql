-- ============================================================================
-- 34 — WHAT A NEW MESSAGE CHANGED ABOUT AN ONGOING CASE
--
-- WHAT THIS ADDS. `ticket_case_state`: one reading per inbound message that
-- landed on a ticket already read once. The first message of a thread gets no
-- row — there is no prior case for it to change.
--
-- WHY A TABLE AND NOT A COLUMN ON `tickets`. Two shapes already exist side by
-- side in this schema and they answer different questions. `resolved_context`
-- is a snapshot overwritten in place, because "the current state of the order"
-- has one correct value. This is a READING of a message, and a thread's
-- readings are a trajectory — the same reason `ticket_investigations` is keyed
-- per trigger message. A mutable `metadata.case_state` would have lost which
-- message established what, which is the one thing a follow-up needs to know.
--
-- WHAT IT DELIBERATELY DOES NOT HOLD. Tool data. `evidence_reuse` records the
-- OUTCOME BUCKET of a prior call — `{ need, tool, argsHash, outcome, run_at,
-- status }` — and never what the tool returned. `ticket_investigations.tool_calls`
-- drops `data` on purpose and `context_ref` points at `resolved_context` rather
-- than copying it, both so personal data is not duplicated per run. This table
-- does not reopen that decision.
--
-- THE MEASUREMENT BEHIND IT. A regex reading our own sent replies to recover
-- what we had already asked claimed 2.4 fields per thread, and 0.3 once
-- narrowed to request sentences, with about half of the survivors still wrong
-- (see DECISIONS.md § "A re-ask guardrail was built, measured, and removed").
-- A question recorded when it is ASKED is a fact; recovered from prose
-- afterwards it is a guess. That is what this table is for.
--
-- COPIED FROM 04_support.sql, NOT RETYPED — 34_case_state.test.mjs asserts the
-- two create the same columns and constraints.
--
-- IDEMPOTENT: `create table if not exists`, and every index and policy guarded.
-- Applying it to a fresh baseline is a no-op.
--
-- NO DATA IS WRITTEN. Existing threads get a row the next time a message lands
-- on them; there is deliberately no backfill, because a reading invented for a
-- message nobody read at the time would be indistinguishable from one taken
-- when it arrived.
--
-- Requires: 04_support.sql (tickets, ticket_messages), 01_foundation.sql (shops).
-- ============================================================================

create table if not exists public.ticket_case_state (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  trigger_message_id uuid not null references public.ticket_messages(id) on delete cascade,

  case_relationship text not null,
  situation_key text,

  resolved_inputs jsonb not null default '[]'::jsonb,
  pending_customer_inputs jsonb not null default '[]'::jsonb,

  new_facts jsonb not null default '[]'::jsonb,
  commitments jsonb not null default '[]'::jsonb,
  contradictions jsonb not null default '[]'::jsonb,

  evidence_reuse jsonb not null default '{}'::jsonb,

  case_summary text,
  model text,
  read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  unique (shop_id, trigger_message_id),

  constraint ticket_case_state_relationship_check check (
    case_relationship in ('continuation', 'new_information', 'new_issue', 'unclear')
  ),
  constraint ticket_case_state_resolved_inputs_array_check check (
    jsonb_typeof(resolved_inputs) = 'array'
  ),
  constraint ticket_case_state_pending_inputs_array_check check (
    jsonb_typeof(pending_customer_inputs) = 'array'
  ),
  constraint ticket_case_state_new_facts_array_check check (
    jsonb_typeof(new_facts) = 'array'
  ),
  constraint ticket_case_state_commitments_array_check check (
    jsonb_typeof(commitments) = 'array'
  ),
  constraint ticket_case_state_contradictions_array_check check (
    jsonb_typeof(contradictions) = 'array'
  ),
  constraint ticket_case_state_evidence_reuse_object_check check (
    jsonb_typeof(evidence_reuse) = 'object'
  )
);

create index if not exists ticket_case_state_ticket_idx
  on public.ticket_case_state (ticket_id, read_at desc);

alter table public.ticket_case_state enable row level security;

comment on table public.ticket_case_state is
  'One reading per inbound message that landed on a ticket already read once: what the message changed about the case. Keyed per trigger message like ticket_investigations, because a thread''s readings are a trajectory rather than a current value. Records what was asked and answered, what was promised, and which prior evidence may be reused -- never what a tool returned.';

comment on column public.ticket_case_state.case_relationship is
  'continuation | new_information | new_issue | unclear. Drives whether the categoriser re-runs and whether the situation is carried forward; a closed vocabulary the model selects from and this codebase defines.';

comment on column public.ticket_case_state.situation_key is
  'The situation carried forward from the previous reading, so a follow-up is not re-matched on the opening message every run. Null when none was ever matched.';

comment on column public.ticket_case_state.resolved_inputs is
  'MISSING_FIELDS keys this message answered. Recorded when the question is answered rather than recovered from prose later, which is what makes it a fact rather than a guess.';

comment on column public.ticket_case_state.evidence_reuse is
  'Per need a prior run touched: { tool, argsHash, outcome, run_at, status }. Outcome buckets only, never tool data -- the same personal-data boundary tool_calls and context_ref already hold.';
