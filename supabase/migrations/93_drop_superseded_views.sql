-- ============================================================================
-- 93 — DROP THE WHOLE-BOOK VIEWS THE RANGED FUNCTIONS REPLACED
--
-- WHAT THIS REMOVES. Sixteen views from 06_analytics.sql. Each was the
--   whole-book, pre-range version of an Insights figure; 11_insights_ranges.sql
--   gave every one a ranged function twin (fulfilment_summary ->
--   insights_orders_summary, agent_pipeline_funnel -> insights_agent_funnel, ...)
--   and the dashboard has read only the functions since.
--
-- CHECKED 2026-10-12 BEFORE DROPPING:
--   · no reference in agent/, scripts/, web/ or storefront-app/ code, prompts or
--     tests (tables.mjs named them; it no longer does)
--   · no other view or function, in public or in the chat schema, reads any of
--     them (body scan on production) — their twins read the base tables
--   · none is a dependency of another dropped view, so plain DROP VIEW suffices
--
-- KEPT: order_fulfilment_timing, ticket_reply_times, support_by_month,
--   customer_ticket_facts, customer_segment_totals, and everything in 04.
--
-- The baseline (06_analytics.sql) no longer creates them. Their design notes are
-- in git history and docs/decisions/insights.md; the rules they carried (contact
-- rate per order, counts without state names) live on in the ranged functions.
--
-- IDEMPOTENT. Requires: 06_analytics.sql.
-- ============================================================================

drop view if exists public.fulfilment_summary;
drop view if exists public.fulfilment_by_month;
drop view if exists public.fulfilment_by_carrier;
drop view if exists public.fulfilment_ticket_coverage;
drop view if exists public.fulfilment_by_bucket;
drop view if exists public.fulfilment_summary_by_channel;
drop view if exists public.fulfilment_by_channel_month;
drop view if exists public.fulfilment_by_channel_bucket;
drop view if exists public.support_by_category;
drop view if exists public.support_purchase_states;
drop view if exists public.support_purchase_by_category;
drop view if exists public.investigation_evidence_gaps;
drop view if exists public.agent_pipeline_funnel;
drop view if exists public.investigation_verdicts;
drop view if exists public.llm_usage_by_month;
drop view if exists public.llm_usage_summary;
