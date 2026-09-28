-- ============================================================================
-- 44 — A RULE DECLARES THE CHECKS IT OPENS, IN ORDER
--
-- Stage 5 item C of codex_plans/Case_State_Plan.md. `support_answers.checks`:
-- `[{ owner, need }]`, opened one after another by the fold when a case file
-- selects the rule.
--
-- NO RULE CHANGES: every row arrives with '[]'. COPIED FROM 05_exemplars.sql
-- (44_rule_checks.test.mjs asserts the two agree). IDEMPOTENT.
--
-- Requires: 05_exemplars.sql.
-- ============================================================================

alter table public.support_answers
  add column if not exists checks jsonb not null default '[]'::jsonb;

alter table public.support_answers drop constraint if exists support_answers_checks_array_check;

alter table public.support_answers
  add constraint support_answers_checks_array_check check (
    jsonb_typeof(checks) = 'array'
  );

comment on column public.support_answers.checks is
  'The checks this rule opens on a case, in order: [{owner, need}], owner support / colleague / partner, need a NEED_KEYS key. The fold (agent/src/casework/case-fold.mjs) opens the first when a case file selects this rule and each next one when the one before it is done; a step marked no longer needed ends the sequence. Copied onto the case file (exemplar_match.policy.check_sequences), so editing the rule never changes a case already opened.';
