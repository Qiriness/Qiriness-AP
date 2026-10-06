-- ============================================================================
-- 77 — A COLLECTION CAN BE A RANGE (« GAMME »)
--
-- `advice_collections.axis` gains `range`, beside `concern` and `category`. A
-- range collection is a product line the shop curates in Shopify (« Temps
-- Sublime », « Source d'Eau », « Active Énergie », « Exception »). The storefront
-- advisor reads its membership as THE answer to « la gamme X »; before this the
-- advisor could only guess a range from shared title words.
--
-- THE SUPPORT AGENT IGNORES RANGE COLLECTIONS (agent/src/retrieval/
-- advice-collections.mjs). Its intersection treats every non-category
-- collection as a concern, so a range there would silently change its
-- recommendations; whether support should read ranges is a separate decision.
--
-- The check is dropped and re-added under its own name, in one transaction.
-- The clause in 27_advice_collections.sql is that file's state; this is the
-- state after it. 77_collection_range_axis.test.mjs asserts the list.
--
-- NO DATA IS WRITTEN. IDEMPOTENT.
--
-- Requires: 27_advice_collections.sql.
-- ============================================================================

begin;

alter table public.advice_collections drop constraint if exists advice_collections_axis_check;
alter table public.advice_collections add constraint advice_collections_axis_check check (
  axis is null or axis in ('concern', 'category', 'range')
);

comment on column public.advice_collections.axis is
  'Local: concern (rides, taches, cernes), category (serums, cremes de nuit) or range (a product line: Temps Sublime, Source d''Eau). Concern and category are intersected and relaxed by the support agent; range is read only by the storefront advisor, for « la gamme X ».';

commit;
