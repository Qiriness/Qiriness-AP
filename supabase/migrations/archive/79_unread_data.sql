-- ============================================================================
-- 79 — WHAT NOTHING READS IS NOT KEPT
--
-- The database stood at 314 MB of the free plan's 500 on 2026-10-06. This
-- drops what was stored or indexed and never read:
--
--   · eight indexes no query has used since statistics began (2026-08-07):
--     the two HNSW vector indexes (26 MB; the vectors stay, and the index is
--     rebuilt in the migration that ships retrieval), and six GIN / btree
--     indexes over columns nothing filters on (15 MB);
--   · `raw_shopify_payload` on customers (39 MB) and orders (12 MB), which no
--     code read and whose fields are all typed columns. The mappers write `{}`
--     from the same date;
--   · the nightly syncs' one-row-per-page access log (47,134 customer rows,
--     6,391 order rows): each run's pages become one row with their counts, as
--     the syncs now write them (`createSyncAccessLog`).
--
-- The space is returned by a VACUUM FULL run after this (not in a migration:
-- it cannot run in a transaction). Copied into 02_shopify.sql, 04_support.sql
-- and 05_exemplars.sql (79_unread_data.test.mjs). IDEMPOTENT.
--
-- Rewriting the payloads moves `updated_at` on every customer and order once:
-- Insights' « customers synced » reads as now until the next nightly sync.
-- ============================================================================

drop index if exists public.ticket_messages_embedding_hnsw_idx;
drop index if exists public.support_exemplar_phrasings_embedding_hnsw_idx;
drop index if exists public.orders_line_items_gin_idx;
drop index if exists public.orders_fulfillments_gin_idx;
drop index if exists public.customers_shop_amount_spent_idx;
drop index if exists public.products_structured_facts_gin_idx;
drop index if exists public.promotions_rule_snapshot_gin_idx;
drop index if exists public.shopify_metaobjects_fields_gin_idx;

update public.customers set raw_shopify_payload = '{}'::jsonb where raw_shopify_payload <> '{}'::jsonb;
update public.orders set raw_shopify_payload = '{}'::jsonb where raw_shopify_payload <> '{}'::jsonb;

comment on column public.customers.raw_shopify_payload is
  'Not written since 2026-10-06 (always {}): nothing read it, and its fields are typed columns. Kept as a column so a reader that names it does not break.';
comment on column public.orders.raw_shopify_payload is
  'Not written since 2026-10-06 (always {}): nothing read it, and its fields are typed columns. Kept as a column so a reader that names it does not break.';

-- One row per sync run instead of one per page. A page row without a run id is
-- grouped by day, which is how the syncs ran.
with pages as (
  select
    shop_id,
    integration_event_id,
    action,
    resource_type,
    purpose,
    actor_type,
    actor_id,
    min(occurred_at) as first_at,
    jsonb_strip_nulls(jsonb_build_object(
      'pages', count(*),
      'customers', case when action = 'shopify_customers_sync_page' then sum((metadata ->> 'page_count')::int) end,
      'orders', case when action = 'shopify_orders_sync_page' then sum((metadata ->> 'page_count')::int) end,
      'discounts', case when action = 'shopify_promotions_sync_page' then sum((metadata ->> 'discount_count')::int) end,
      'promotions', case when action = 'shopify_promotions_sync_page' then sum((metadata ->> 'promotion_count')::int) end,
      'dry_run', false,
      'last_page_at', max(occurred_at),
      'collapsed_from_pages', true
    )) as metadata
  from public.data_access_events
  where action in ('shopify_customers_sync_page', 'shopify_orders_sync_page', 'shopify_promotions_sync_page')
  group by
    shop_id, integration_event_id, action, resource_type, purpose, actor_type, actor_id,
    case when integration_event_id is null then date_trunc('day', occurred_at) end
),
runs as (
  insert into public.data_access_events
    (shop_id, integration_event_id, actor_type, actor_id, action, resource_type, resource_id_hash, purpose, occurred_at, metadata)
  select
    shop_id, integration_event_id, actor_type, actor_id,
    replace(action, '_sync_page', '_sync_run'), resource_type, null, purpose, first_at, metadata
  from pages
  returning 1
)
-- Same statement, same snapshot: the rows deleted are exactly the rows summed.
delete from public.data_access_events
where action in ('shopify_customers_sync_page', 'shopify_orders_sync_page', 'shopify_promotions_sync_page');
