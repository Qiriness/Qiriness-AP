-- name: q01_exclusion_funnel
-- Every Qiriness order, by the reason it is in or out of the analysis population.
select case
  when o.sales_channel not in ('Online Store','Shop') then 'out: channel ' || o.sales_channel
  when o.cancelled_at is not null or o.financial_status = 'VOIDED' then 'out: cancelled/voided'
  when o.subtotal_price <= 0 then 'out: zero merchandise'
  when coalesce(o.discount_codes,'{}') && array['LAPFAM26','pattest'] then 'out: internal/test code'
  when o.customer_id is null then 'out: no customer'
  when o.processed_at < timestamptz '2025-03-01 00:00 Europe/Paris' then 'out: before 2025-03 (pre-launch strays)'
  when o.processed_at >= timestamptz '2026-11-01 00:00 Europe/Paris' then 'out: Nov 2026 (partial month)'
  when o.subtotal_price - least(coalesce(o.total_refunded,0), o.subtotal_price) <= 0 then 'in base, not qualifying: fully refunded'
  else 'in: qualifying DTC order' end reason,
  count(*) orders, round(sum(o.subtotal_price),2) subtotal_ttc, round(sum(o.total_refunded),2) refunded_ttc
from orders o where o.shop_id = :shop group by 1 order by 2 desc

-- name: q01_reconciliation
-- Independent paths to the same totals: order headers vs summed lines vs customer lifetime counters.
with /*BASE*/
select
  (select count(*) from bo) qualifying_orders,
  (select count(distinct cid) from bo) buyers,
  (select round(sum(gross_ttc),2) from bl) lines_gross_ttc,
  (select round(sum(sub_ttc + disc_ttc),2) from bo) headers_sub_plus_disc_ttc,
  (select round(sum(net_ttc),2) from bo) headers_net_ttc,
  (select round(sum(net_ht)*1.2,2) from bl) lines_net_ttc_allocated,
  (select round(sum(net_ht),2) from bo) net_ht,
  (select round(sum(ref_ttc),2) from bo) refunds_ttc,
  (select round(sum(disc_ttc),2) from bo) discounts_ttc,
  (select sum(number_of_orders) from customers where shop_id = :shop) customers_lifetime_orders_all_channels,
  (select count(*) from orders where shop_id = :shop) orders_rows_all_channels

-- name: q01_quality_flags
with /*BASE*/
select
  (select count(*) from bl where is_sample) sample_lines,
  (select count(*) from bl where not is_sample and net_ht <= 0.01) gifted_zero_lines,
  (select count(*) from bl where pkey like 'title:%') lines_without_product_id,
  (select round(100.0*sum(net_ht) filter (where range_='Autre')/sum(net_ht),2) from bp) pct_revenue_unclassified_range,
  (select round(100.0*sum(net_ht) filter (where need='Autre')/sum(net_ht),2) from bp) pct_revenue_unclassified_need,
  (select count(*) from (select customer_email_hash from orders where shop_id=:shop and sales_channel='Online Store'
      and customer_email_hash is not null group by 1 having count(distinct customer_id) > 1) x) email_hashes_on_2plus_customers,
  (select count(*) from bo where legacy and seq = 1) legacy_first_orders,
  (select count(*) from bo where not legacy and seq = 1) new_first_orders,
  (select count(*) from bo_all where cc <> 'FR') non_fr_orders,
  (select count(*) from bo_all) base_orders_incl_full_refunds

-- name: q01_unclassified
with /*BASE*/
select title, range_, need, count(*) lines, round(sum(net_ht)) net_ht from bp
where range_='Autre' or need='Autre' group by 1,2,3 order by 5 desc
