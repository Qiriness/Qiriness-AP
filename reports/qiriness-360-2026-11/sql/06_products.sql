-- name: q06_entry_range
-- First-order primary range (largest net line) -> 2nd purchase within 180 d, 180-d value. NEW customers whose first
-- order is >= 180 d before the as-of date (first order before 2026-05-05). Also to-date rates for all new customers.
with /*BASE*/,
fo as (select distinct on (cid) cid, order_id, range_, need, title, pkey from bp where seq=1 and not legacy order by cid, net_ht desc),
c as (select b.cid, b.ts t0, b.net_ht first_net, b.has_promo first_promo,
        (select min(ts) from bo x where x.cid=b.cid and x.seq=2) t2,
        (select coalesce(sum(net_ht),0) from bo x where x.cid=b.cid and x.ts < b.ts + interval '180 days') v180,
        (select coalesce(sum(net_ht),0) from bo x where x.cid=b.cid and x.ts < b.ts + interval '365 days') v365
      from bo b where seq=1 and not legacy)
select fo.range_ entry_range, count(*) new_customers,
  count(*) filter (where t0 < timestamptz '2026-05-05 00:00 Europe/Paris') matured_180,
  round(avg(first_net),2) first_aov_ht,
  round(100.0*avg(case when t2 < t0 + interval '180 days' then 1 else 0 end) filter (where t0 < timestamptz '2026-05-05 00:00 Europe/Paris'),1) pct_2nd_180d,
  round(avg(v180) filter (where t0 < timestamptz '2026-05-05 00:00 Europe/Paris'),2) value_180d,
  round(avg(v365) filter (where t0 < timestamptz '2025-11-01 00:00 Europe/Paris'),2) value_365d_early_cohorts,
  round((percentile_cont(0.5) within group (order by extract(epoch from t2-t0)/86400) filter (where t2 is not null))::numeric) median_days_2nd,
  round(100.0*avg(case when first_promo then 1 else 0 end),1) pct_first_on_promo
from c join fo using (cid) group by 1 order by 2 desc

-- name: q06_entry_product
-- Same, by individual product present in the first order (a first order can count for several products). >= 25 matured.
with /*BASE*/,
fp as (select distinct cid, pkey, title from bp where seq=1 and not legacy),
c as (select b.cid, b.ts t0, b.net_ht first_net,
        (select min(ts) from bo x where x.cid=b.cid and x.seq=2) t2,
        (select coalesce(sum(net_ht),0) from bo x where x.cid=b.cid and x.ts < b.ts + interval '180 days') v180
      from bo b where seq=1 and not legacy and b.ts < timestamptz '2026-05-05 00:00 Europe/Paris'),
base as (select round(100.0*avg(case when t2 < t0 + interval '180 days' then 1 else 0 end),1) r from c)
select min(fp.title) product, count(*) matured_new_customers, round(avg(first_net),2) first_aov_ht,
  round(100.0*avg(case when t2 < t0 + interval '180 days' then 1 else 0 end),1) pct_2nd_180d,
  (select r from base) baseline_pct_2nd_180d,
  round(avg(v180),2) value_180d,
  round((percentile_cont(0.5) within group (order by extract(epoch from t2-t0)/86400) filter (where t2 is not null))::numeric) median_days_2nd
from c join fp using (cid) group by fp.pkey having count(*) >= 25 order by pct_2nd_180d desc

-- name: q06_entry_basket_shape
-- First-order shape vs retention (new customers, matured 180 d).
with /*BASE*/,
fo as (select order_id, count(distinct pkey) n_products, count(distinct range_) n_ranges, bool_or(is_set) has_set,
         bool_or(range_='Appareils & SPA') has_device from bp where seq=1 and not legacy group by 1),
c as (select b.id, b.cid, b.ts t0, b.net_ht first_net, b.has_promo, b.has_code,
        (select min(ts) from bo x where x.cid=b.cid and x.seq=2) t2,
        (select coalesce(sum(net_ht),0) from bo x where x.cid=b.cid and x.ts < b.ts + interval '180 days') v180
      from bo b where seq=1 and not legacy and b.ts < timestamptz '2026-05-05 00:00 Europe/Paris')
select dim, val, count(*) customers, round(avg(first_net),2) first_aov_ht,
  round(100.0*avg(case when t2 < t0 + interval '180 days' then 1 else 0 end),1) pct_2nd_180d, round(avg(v180),2) value_180d,
  round(avg(v180 - first_net),2) subsequent_value_180d
from (
  select c.*, 'n_products' dim, case when n_products>=3 then '3+' else n_products::text end val from c join fo on fo.order_id=c.id
  union all select c.*, 'n_ranges', case when n_ranges>=3 then '3+' else n_ranges::text end from c join fo on fo.order_id=c.id
  union all select c.*, 'has_set', has_set::text from c join fo on fo.order_id=c.id
  union all select c.*, 'has_device', has_device::text from c join fo on fo.order_id=c.id
  union all select c.*, 'first_aov_band', case when first_net<35 then 'a <35' when first_net<50 then 'b 35-50' when first_net<70 then 'c 50-70'
    when first_net<100 then 'd 70-100' else 'e 100+' end from c
  union all select c.*, 'first_promo', case when has_code then 'code' when has_promo then 'automatic offer' else 'full price' end from c
) x group by 1,2 order by 1,2

-- name: q06_replenishment
-- Exact-product reorder behaviour. Buyers whose first purchase of the product was >= 180 d before as-of (matured).
with /*BASE*/,
pb as (select pkey, cid, min(title) title, min(range_) range_, min(ts) first_buy, count(distinct order_id) n_orders, sum(qty) units,
         avg(qty) avg_qty from bp group by 1,2),
nx as (select distinct on (a.pkey, a.cid) a.pkey, a.cid, extract(epoch from b.ts - a.first_buy)/86400 d
       from pb a join bp b on b.pkey=a.pkey and b.cid=a.cid and b.ts > a.first_buy + interval '1 day' order by a.pkey, a.cid, b.ts),
anyn as (select a.pkey, a.cid,
           bool_or(o.ts > a.first_buy + interval '1 day') any_later,
           bool_or(o.ts > a.first_buy + interval '1 day' and l.range_ = a.range_ and l.pkey <> a.pkey) same_range_other
         from pb a join bo o on o.cid=a.cid left join bp l on l.order_id=o.id group by 1,2)
select min(pb.title) product, min(pb.range_) range_, count(*) buyers,
  count(*) filter (where first_buy < timestamptz '2026-05-05 00:00 Europe/Paris') matured_buyers,
  round(avg(avg_qty),2) avg_qty_per_order,
  round(100.0*avg(case when nx.d < 180 then 1 else 0 end) filter (where first_buy < timestamptz '2026-05-05 00:00 Europe/Paris'),1) pct_same_product_180d,
  round(100.0*avg(case when nx.d is not null then 1 else 0 end),1) pct_same_product_ever,
  round(100.0*avg(case when anyn.any_later then 1 else 0 end) filter (where first_buy < timestamptz '2026-05-05 00:00 Europe/Paris'),1) pct_any_later_order_matured,
  round(100.0*avg(case when anyn.same_range_other then 1 else 0 end),1) pct_switch_same_range,
  count(nx.d) reorder_events,
  round((percentile_cont(0.25) within group (order by nx.d))::numeric) p25_days,
  round((percentile_cont(0.5) within group (order by nx.d))::numeric) median_days,
  round((percentile_cont(0.75) within group (order by nx.d))::numeric) p75_days
from pb left join nx using (pkey, cid) left join anyn using (pkey, cid)
group by pb.pkey having count(*) >= 40 order by pct_same_product_ever desc

-- name: q06_range_reorder
-- Same-range (family) reorder: buyer of a range who later buys the same range again, and the interval.
with /*BASE*/,
rb as (select range_, cid, min(ts) first_buy from bp group by 1,2),
nx as (select distinct on (a.range_, a.cid) a.range_, a.cid, extract(epoch from b.ts - a.first_buy)/86400 d
       from rb a join bp b on b.range_=a.range_ and b.cid=a.cid and b.ts > a.first_buy + interval '1 day' order by a.range_, a.cid, b.ts)
select rb.range_, count(*) buyers,
  round(100.0*avg(case when nx.d < 180 then 1 else 0 end) filter (where first_buy < timestamptz '2026-05-05 00:00 Europe/Paris'),1) pct_same_range_180d_matured,
  round(100.0*avg(case when nx.d is not null then 1 else 0 end),1) pct_same_range_ever,
  round((percentile_cont(0.25) within group (order by nx.d))::numeric) p25_days,
  round((percentile_cont(0.5) within group (order by nx.d))::numeric) median_days,
  round((percentile_cont(0.75) within group (order by nx.d))::numeric) p75_days
from rb left join nx using (range_, cid) group by 1 order by 2 desc

-- name: q06_product_monthly
-- Monthly net revenue per range (chart-ready, seasonality input).
with /*BASE*/
select m, range_, round(sum(net_ht)) net_ht, count(distinct order_id) orders from bp group by 1,2 order by 1,2
