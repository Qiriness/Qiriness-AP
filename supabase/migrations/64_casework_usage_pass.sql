-- ============================================================================
-- 64 — CASEWORK AND CLOSURE ARE COSTED UNDER THEIR OWN PASS
--
-- The Case Manager (agent/src/casework/case-manager.mjs) and the closure check
-- (casework/closure.mjs) already tag their calls `casework` and `closure`. The
-- constraint did not accept either, so the usage sink recorded them as `other`
-- (usage-sink.mjs maps any unknown pass there rather than fail the bulk insert).
-- Seen on 2026-10-03, the first live poll with the casework stage on: 13 calls
-- under `other`.
--
-- WIDENS ONLY. Rows already recorded as `other` stay as they are.
-- APPLY BEFORE deploying the worker whose USAGE_PASSES lists the two new
-- passes: the other way round, a flush carrying `casework` is refused whole.
--
-- COPIED FROM 06_analytics.sql (64_casework_usage_pass.test.mjs asserts it).
-- IDEMPOTENT.
--
-- Requires: 06_analytics.sql.
-- ============================================================================

alter table public.llm_usage drop constraint if exists llm_usage_pass_check;
alter table public.llm_usage add constraint llm_usage_pass_check check (
    pass in ('spam', 'categorise', 'decompose', 'situation', 'investigate', 'draft', 'embed', 'case_link', 'casework', 'closure', 'other')
  );

comment on column public.llm_usage.pass is
  'Which agent pass spent this: spam | categorise | decompose | situation | investigate | draft | embed | case_link | casework | closure | other. Matches the passes in the worker poll order, and the USAGE_PASSES list in agent/src/llm/usage-sink.mjs.';
