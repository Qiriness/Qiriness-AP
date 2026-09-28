-- ============================================================================
-- 42 — THE CASE MANAGER READS EVERY MESSAGE
--
-- Stage 5 of codex_plans/Case_State_Plan.md.
--
-- WHAT THIS CHANGES on `ticket_case_state`:
--   - `case_relationship` may be null: a reading of OUR message or of a
--     colleague's or partner's has no customer relationship to state;
--   - five columns: `actor`, `effect`, `asked`, `obligations_opened`,
--     `obligations_cleared`, each with its check.
--
-- NO DATA IS WRITTEN. The existing rows keep their relationship and get empty
-- arrays; the fold treats a reading with no `effect` exactly as stage 4 did.
--
-- COPIED FROM 04_support.sql (42_case_state_every_message.test.mjs asserts the
-- constraints are identical).
--
-- IDEMPOTENT: every statement is guarded.
--
-- Requires: 04_support.sql, 34_case_state.sql.
-- ============================================================================

alter table public.ticket_case_state
  alter column case_relationship drop not null;

alter table public.ticket_case_state
  drop constraint if exists ticket_case_state_relationship_check;

alter table public.ticket_case_state
  add constraint ticket_case_state_relationship_check check (
    case_relationship is null or case_relationship in ('continuation', 'new_information', 'new_issue', 'unclear')
  );

alter table public.ticket_case_state
  add column if not exists actor text,
  add column if not exists effect text,
  add column if not exists asked jsonb not null default '[]'::jsonb,
  add column if not exists obligations_opened jsonb not null default '[]'::jsonb,
  add column if not exists obligations_cleared jsonb not null default '[]'::jsonb;

alter table public.ticket_case_state
  drop constraint if exists ticket_case_state_actor_check;

alter table public.ticket_case_state
  add constraint ticket_case_state_actor_check check (
    actor is null or actor in ('customer', 'support', 'colleague', 'partner')
  );

alter table public.ticket_case_state
  drop constraint if exists ticket_case_state_effect_check;

alter table public.ticket_case_state
  add constraint ticket_case_state_effect_check check (
    effect is null or effect in ('continuation', 'chase', 'new_information', 'new_issue', 'closes_case', 'internal_note', 'noise', 'answers', 'asks_customer', 'holding', 'internal_request')
  );

alter table public.ticket_case_state
  drop constraint if exists ticket_case_state_asked_array_check;

alter table public.ticket_case_state
  add constraint ticket_case_state_asked_array_check check (
    jsonb_typeof(asked) = 'array'
  );

alter table public.ticket_case_state
  drop constraint if exists ticket_case_state_obligations_opened_array_check;

alter table public.ticket_case_state
  add constraint ticket_case_state_obligations_opened_array_check check (
    jsonb_typeof(obligations_opened) = 'array'
  );

alter table public.ticket_case_state
  drop constraint if exists ticket_case_state_obligations_cleared_array_check;

alter table public.ticket_case_state
  add constraint ticket_case_state_obligations_cleared_array_check check (
    jsonb_typeof(obligations_cleared) = 'array'
  );

comment on column public.ticket_case_state.effect is
  'What the message did, from agent/src/casework/effects.mjs (inbound or outbound list by actor). Null on a reading from before stage 5.';

comment on column public.ticket_case_state.obligations_opened is
  'Checks this message opened: { owner: support | colleague | partner, need (NEED_KEYS), quote }. Only owners this brand has (obligationOwners).';
