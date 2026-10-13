-- ============================================================================
-- 57 — WHEN TO CHOOSE A SITUATION
--
-- `support_exemplars.choose_rule`: one line per situation saying when to pick it
-- over its neighbours and when not to. The situation chooser reads it beside the
-- canonical question and the phrasings when the matcher's score could not
-- separate the candidates. Authored in Email-Example-Queries.md.
--
-- NO DATA IS WRITTEN: the rules are filled by the import (or one update) after.
-- COPIED FROM 05_exemplars.sql (57_situation_choose_rule.test.mjs asserts it).
-- IDEMPOTENT.
--
-- Requires: 05_exemplars.sql.
-- ============================================================================

alter table public.support_exemplars
  add column if not exists choose_rule text;

comment on column public.support_exemplars.choose_rule is
  'When to choose this situation over its neighbours, and when not to: one line, shown to the situation chooser beside the candidate''s question and phrasings when the matcher could not separate them (near miss or tie). Authored on the **choose_rule** line of Email-Example-Queries.md. Never embedded and never read by the matcher''s score.';
