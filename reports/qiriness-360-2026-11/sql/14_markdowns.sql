-- Compare-at-price markdowns do not appear as discounts: the line's original_total is already the sale price.
-- Detect them from the unit price paid before discounts vs the product's modal ("list") unit price.

-- name: q14_markdown_by_month
with /*BASE*/,
u as (select pkey, m, order_id, has_promo, qty, gross_ttc / nullif(qty,0) unit_ttc, net_ht from bp where qty > 0),
list as (select pkey, mode() within group (order by round(unit_ttc,2)) list_ttc, max(unit_ttc) max_ttc from u group by 1 having count(*) >= 20),
x as (select u.*, l.list_ttc, greatest(l.list_ttc, l.max_ttc) ref_ttc from u join list l using (pkey))
select m,
  round(100.0*sum(net_ht) filter (where unit_ttc < 0.97*ref_ttc)/sum(net_ht),1) pct_rev_marked_down,
  round(100.0*(1 - sum(unit_ttc*qty)/sum(ref_ttc*qty)),1) avg_markdown_pct,
  count(distinct order_id) filter (where unit_ttc < 0.97*ref_ttc) orders_with_markdown,
  count(distinct order_id) orders
from x group by 1 order by 1

-- name: q14_true_promo_share
-- Orders with ANY price incentive: a discount application (excluding free shipping) OR a marked-down line.
with /*BASE*/,
u as (select pkey, order_id, gross_ttc / nullif(qty,0) unit_ttc from bp where qty > 0),
list as (select pkey, max(unit_ttc) ref_ttc from u group by 1 having count(*) >= 20),
md as (select distinct order_id from u join list using (pkey) where unit_ttc < 0.97*ref_ttc)
select m, count(*) orders,
  round(100.0*avg(case when has_promo then 1 else 0 end),1) pct_discount_app,
  round(100.0*avg(case when md.order_id is not null then 1 else 0 end),1) pct_markdown,
  round(100.0*avg(case when has_promo or md.order_id is not null then 1 else 0 end),1) pct_any_incentive,
  round(100.0*avg(case when has_promo or md.order_id is not null then 1 else 0 end) filter (where seq=1 and not legacy),1) pct_any_incentive_new_first
from bo left join md on md.order_id = bo.id group by 1 order by 1

-- name: q14_first_incentive_retention
-- New customers (matured 180 d): any first-order incentive (discount OR markdown) vs none, within cohort quarter.
with /*BASE*/,
u as (select pkey, order_id, gross_ttc / nullif(qty,0) unit_ttc from bp where qty > 0),
list as (select pkey, max(unit_ttc) ref_ttc from u group by 1 having count(*) >= 20),
md as (select distinct order_id from u join list using (pkey) where unit_ttc < 0.97*ref_ttc),
c as (select b.cid, to_char(b.ts,'YYYY-"Q"Q') q, b.ts, (b.has_promo or md.order_id is not null) incent, b.net_ht,
        (select min(ts) from bo x where x.cid=b.cid and x.seq=2) t2,
        (select coalesce(sum(net_ht),0) from bo x where x.cid=b.cid and x.ts < b.ts + interval '180 days') v180
      from bo b left join md on md.order_id=b.id where b.seq=1 and not b.legacy and b.ts < timestamptz '2026-05-05 00:00 Europe/Paris')
select q, incent first_order_incentive, count(*) customers, round(avg(net_ht),2) first_aov_ht,
  round(100.0*avg(case when t2 < ts + interval '180 days' then 1 else 0 end),1) pct_2nd_180d, round(avg(v180),2) value_180d
from c group by 1,2 order by 1,2

-- name: q14_effective_discount
-- Net paid vs list value (list = highest unit price seen for the product in the window; a conservative anchor if prices only fell).
with /*BASE*/,
u as (select pkey, m, qty, gross_ttc, net_ht, gross_ttc / nullif(qty,0) unit_ttc from bp where qty > 0),
list as (select pkey, max(unit_ttc) ref_ttc from u group by 1 having count(*) >= 20),
x as (select u.*, l.ref_ttc from u join list l using (pkey))
select case when m >= '2025-11-01' then 'T12 Nov25-Oct26' else 'Mar-Oct 2025' end period,
  round(sum(ref_ttc*qty)/1.2) list_value_ht, round(sum(gross_ttc)/1.2) charged_before_discounts_ht, round(sum(net_ht)) net_ht,
  round(100*(1 - sum(gross_ttc)/sum(ref_ttc*qty)),1) markdown_pct, round(100*(1 - sum(net_ht)*1.2/sum(ref_ttc*qty)),1) total_price_reduction_pct
from x group by 1 order by 1

-- name: q14_product_markdown
with /*BASE*/,
u as (select pkey, title, qty, gross_ttc, net_ht, gross_ttc / nullif(qty,0) unit_ttc from bp where qty > 0 and m >= '2025-11-01'),
list as (select pkey, max(unit_ttc) ref_ttc from (select pkey, gross_ttc/nullif(qty,0) unit_ttc from bp where qty>0) z group by 1)
select min(title) product, sum(qty) units_t12, round(max(ref_ttc),2) list_ttc,
  round(sum(net_ht)*1.2/sum(qty),2) avg_net_unit_ttc, round(100*(1 - sum(net_ht)*1.2/sum(ref_ttc*qty)),1) total_reduction_pct,
  round(100.0*sum(qty) filter (where unit_ttc >= 0.97*ref_ttc)/sum(qty),1) pct_units_at_list
from u join list using (pkey) group by pkey having sum(qty) >= 40 order by units_t12 desc
