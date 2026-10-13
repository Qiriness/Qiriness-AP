-- ============================================================================
-- 74 — THE CASE MANAGER AND THE CLOSURE READER CAN BE GIVEN A MODEL IN SETTINGS
--
-- `agent_models.agent` gains `casework` (the Case Manager reading our,
-- colleagues' and partners' messages) and `closure` (« does this message close
-- the request? »). Both ran on the worker every poll but were missing from
-- Settings → Agent settings, so they stayed on AGENT_*_MODEL's default
-- (gpt-4o-mini) unless the env was changed. Their spend is already under these
-- passes in `llm_usage` (64).
--
-- DECISIONS.md § A model is chosen in Settings. NO DATA IS WRITTEN. COPIED FROM
-- 04_support.sql (74_agent_models_casework.test.mjs asserts they agree).
-- IDEMPOTENT.
--
-- Requires: 53_agent_models.sql, 61_cases.sql.
-- ============================================================================

alter table public.agent_models drop constraint if exists agent_models_agent_check;
alter table public.agent_models add constraint agent_models_agent_check check (
    agent in ('spam', 'categorise', 'situation', 'decompose', 'investigate', 'draft', 'chat', 'case_link', 'casework', 'closure')
  );
