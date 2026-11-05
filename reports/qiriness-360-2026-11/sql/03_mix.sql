-- name: q03_range_periods
-- Net product revenue (ex-VAT, after discounts and refunds) by range, by window. Paid lines only.
with /*BASE*/
select range_,
  round(sum(net_ht)) net_full,
  round(sum(net_ht) filter (where m >= '2025-11-01')) net_t12,
  round(sum(net_ht) filter (where m between '2025-03-01' and '2025-10-01')) net_mar_oct25,
  round(sum(net_ht) filter (where m between '2026-03-01' and '2026-10-01')) net_mar_oct26,
  round(sum(net_ht) filter (where m >= '2026-05-01')) net_t6,
  count(distinct order_id) orders, count(distinct cid) buyers, sum(qty) units,
  round(100.0*sum(net_ht) filter (where has_promo)/sum(net_ht),1) pct_rev_on_promo_orders
from bp group by 1 order by 2 desc

-- name: q03_need_periods
with /*BASE*/
select need,
  round(sum(net_ht)) net_full,
  round(sum(net_ht) filter (where m >= '2025-11-01')) net_t12,
  round(sum(net_ht) filter (where m between '2025-03-01' and '2025-10-01')) net_mar_oct25,
  round(sum(net_ht) filter (where m between '2026-03-01' and '2026-10-01')) net_mar_oct26,
  count(distinct order_id) orders, count(distinct cid) buyers
from bp group by 1 order by 2 desc

-- name: q03_products
-- Product scoreboard over the full window (product = Shopify product; variants pooled).
with /*BASE*/,
tot as (select count(*) n_orders from bo),
p as (
  select pkey, min(title) title, min(range_) range_, min(need) need, bool_or(is_set) is_set,
    round(sum(net_ht)) net_ht, sum(qty) units, count(distinct order_id) orders, count(distinct cid) buyers,
    round(sum(net_ht) filter (where m >= '2025-11-01')) net_t12,
    round(sum(net_ht) filter (where m between '2026-05-01' and '2026-10-01')) net_t6,
    round(sum(net_ht) filter (where m between '2025-11-01' and '2026-04-01')) net_prev6,
    round(100.0*sum(net_ht) filter (where has_promo)/nullif(sum(net_ht),0),1) pct_rev_promo_orders,
    round(100.0*(1 - sum(net_ht)/nullif(sum(gross_ht_line),0)),1) realised_discount_pct,
    count(distinct order_id) filter (where seq = 1) first_order_appearances
  from (select *, gross_ttc/1.2 gross_ht_line from bp) x group by pkey),
rep as (  -- buyers who bought the same product again in a later order
  select pkey, count(*) filter (where n_ord >= 2) rebuyers from (
    select pkey, cid, count(distinct order_id) n_ord from bp group by 1,2) y group by 1)
select p.*, round(100.0*orders/(select n_orders from tot),2) order_penetration_pct,
  coalesce(rep.rebuyers,0) same_product_rebuyers, round(100.0*coalesce(rep.rebuyers,0)/buyers,1) same_product_repeat_pct,
  round(net_ht/orders,2) net_per_order_line
from p left join rep using (pkey) order by net_ht desc

-- name: q03_concentration
with /*BASE*/,
p as (select pkey, sum(net_ht) v from bp group by 1),
r as (select v, row_number() over (order by v desc) rk, sum(v) over () tot from p)
select count(*) products_sold,
  round(100.0*sum(v) filter (where rk<=1)/max(tot),1) top1_pct,
  round(100.0*sum(v) filter (where rk<=5)/max(tot),1) top5_pct,
  round(100.0*sum(v) filter (where rk<=10)/max(tot),1) top10_pct,
  round(100.0*sum(v) filter (where rk<=20)/max(tot),1) top20_pct,
  round(10000*sum((v/tot)^2)) hhi
from r

-- name: q03_country
with /*BASE*/
select cc, count(*) orders, count(distinct cid) buyers, round(sum(net_ht)) net_ht, round(avg(net_ht),2) aov_ht,
  round(100.0*count(*) filter (where seq>1)/count(*),1) pct_repeat_orders
from bo group by 1 order by 4 desc

-- name: q03_lifecycle_mix
-- Revenue by order rank (1st, 2nd, 3rd, 4th+) and customer type.
with /*BASE*/
select case when seq=1 and legacy then '1 first (legacy)' when seq=1 then '1 first (new)' when seq=2 then '2 second'
  when seq=3 then '3 third' else '4 fourth+' end stage,
  count(*) orders, round(sum(net_ht)) net_ht, round(avg(net_ht),2) aov_ht,
  round(100.0*avg(case when has_promo then 1 else 0 end),1) pct_promo,
  round(100.0*sum(disc_ttc)/sum(sub_ttc+disc_ttc),1) discount_rate_pct
from bo group by 1 order by 1

-- name: q03_promo_status_month
with /*BASE*/
select m, round(sum(net_ht) filter (where has_promo)) net_promo, round(sum(net_ht) filter (where not has_promo)) net_full_price,
  count(*) filter (where has_promo) orders_promo, count(*) filter (where not has_promo) orders_full
from bo group by 1 order by 1
