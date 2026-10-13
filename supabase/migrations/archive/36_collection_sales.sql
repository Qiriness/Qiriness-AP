-- 36_collection_sales.sql
--
-- The Sales panel's Collection mix card: what each Shopify collection sold in a
-- date range, and what sold outside every collection we hold products for.
--
-- One new function, insights_collection_sales(), copied byte-for-byte from
-- 06_analytics.sql (36_collection_sales.test.mjs asserts it). A new name, so
-- nothing is dropped and `create or replace` is idempotent. No table, no data.

-- ------------------------------------------------- sales: by collection

-- Per collection for a date range: distinct orders, units and net line revenue,
-- on the same line rules as insights_product_sales (zero-value lines are
-- samples, not sales), plus one row with a null id for the paid lines that
-- belong to no collection we hold.
--
-- COLLECTIONS OVERLAP, AND THAT IS NOT A BUG. `advice_collections.product_ids`
-- puts a product in every collection that carries it — measured 2026-09-23,
-- 270 memberships over 62 products that sold, so roughly four each. A product's
-- revenue is therefore counted once in EACH of its collections and the shares
-- do not sum to the range. The caller says so on the card; summing these rows
-- would double-count and is never right.
--
-- ONLY THE COLLECTIONS WHOSE PRODUCTS ARE SYNCED can be counted:
-- `sync-shopify-collections.mjs` fetches memberships for `is_active`
-- collections only (28 of 176 today), which covered 94% of August's product
-- revenue. The null-id row is the rest, so the card can state what it misses
-- rather than implying the collections are the whole catalogue.
create or replace function public.insights_collection_sales(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_channels text[] default null,
  p_not_channels text[] default null,
  p_limit integer default 10
)
returns table (
  collection_id text,
  title text,
  handle text,
  products bigint,
  orders bigint,
  units bigint,
  revenue numeric
)
language sql
stable
set search_path = public
as $$
  with ranged_lines as (
    select
      o.id as order_id,
      li.value ->> 'product_id' as product_id,
      coalesce((li.value ->> 'current_quantity')::int, (li.value ->> 'quantity')::int, 0) as units,
      (li.value ->> 'discounted_total')::numeric as revenue
    from public.orders o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end
    ) as li
    where o.shop_id = p_shop
      and o.deleted_at is null
      and o.cancelled_at is null
      and li.value ->> 'product_id' is not null
      and coalesce((li.value ->> 'discounted_total')::numeric, 0) > 0
      and o.processed_at >= (p_from at time zone p_tz)
      and o.processed_at < (p_to at time zone p_tz)
      and (p_channels is null or o.sales_channel_handle = any(p_channels))
      and (
        p_not_channels is null
        or o.sales_channel_handle is null
        or not (o.sales_channel_handle = any(p_not_channels))
      )
  ),
  known as (
    select c.shopify_collection_id, c.title, c.handle, c.product_ids
    from public.advice_collections c
    where c.shop_id = p_shop
      and c.deleted_at is null
      and cardinality(c.product_ids) > 0
  ),
  per_collection as (
    select
      k.shopify_collection_id as collection_id,
      max(k.title) as title,
      max(k.handle) as handle,
      count(distinct l.product_id) as products,
      count(distinct l.order_id) as orders,
      coalesce(sum(l.units), 0)::bigint as units,
      coalesce(sum(l.revenue), 0) as revenue
    from known k
    join ranged_lines l on l.product_id = any(k.product_ids)
    group by 1
    order by 7 desc, 2
    limit greatest(coalesce(p_limit, 10), 0)
  ),
  uncollected as (
    select
      null::text as collection_id,
      null::text as title,
      null::text as handle,
      count(distinct l.product_id) as products,
      count(distinct l.order_id) as orders,
      coalesce(sum(l.units), 0)::bigint as units,
      coalesce(sum(l.revenue), 0) as revenue
    from ranged_lines l
    where not exists (select 1 from known k where l.product_id = any(k.product_ids))
  )
  select * from per_collection
  union all
  select * from uncollected;
$$;

revoke all on function public.insights_collection_sales from public, anon, authenticated;
grant execute on function public.insights_collection_sales to service_role;

comment on function public.insights_collection_sales is
  'Per collection for a date range: distinct orders, units and net line revenue, on insights_product_sales line rules, plus one null-id row for paid lines in no synced collection. Collections overlap — a product counts in each of its collections — so the rows never sum to the range.';
