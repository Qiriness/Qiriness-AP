-- ============================================================================
-- 24 — A RULE MAY SET THE TONE OF ITS REPLY
--
-- WHAT THIS CHANGES. `support_answers` gains `tones`: the tones, from
-- `scripts/lib/reply-tones.mjs`, the drafting prompt should give a reply when
-- this rule wins. Picked in the rule editor; several may be picked.
--
-- COPIED FROM 05_exemplars.sql, NOT RETYPED. The column, the check and the
-- comment are the baseline's, and 24_rule_tones.test.mjs holds them equal.
--
-- NO RULE CHANGES. Every existing row takes the default `{}`, which means the
-- Brand voice alone — exactly how every draft is written today.
--
-- IDEMPOTENT: `add column if not exists`, the constraint dropped and re-added —
-- a no-op on a fresh baseline.
--
-- Requires: 05_exemplars.sql.
-- ============================================================================

alter table public.support_answers
  add column if not exists tones text[] not null default '{}'::text[];

alter table public.support_answers drop constraint if exists support_answers_tones_check;

alter table public.support_answers
  add constraint support_answers_tones_check check (
    tones <@ array[
      'reassuring', 'empathetic', 'factual', 'firm', 'apologetic', 'understanding'
    ]::text[]
  );

comment on column public.support_answers.tones is
  'The tones this rule''s reply should take, as keys of scripts/lib/reply-tones.mjs, which owns their wording. Empty means the Brand voice alone. PER RULE, NOT PER SITUATION: D-01 late wants an apology and D-01 within the window forbids one, and only the branch knows which. When an email carries two requests their rules'' tones are unioned. A tone adjusts the Brand voice in the drafting prompt and never overrides its structural rules.';
