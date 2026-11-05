-- name: q02_monthly
-- Monthly own-site performance. new = first order of a non-legacy customer; legacy_first = first Shopify
-- order of an imported (pre-2025-04) customer; returning = 2nd+ order.
with /*BASE*/,
lines as (select order_id, sum(qty) filter (where not is_sample and net_ht > 0.01) units from bl group by 1),
mm as (
  select b.m,
    count(*) orders, count(distinct b.cid) buyers,
    count(*) filter (where seq=1 and not legacy) new_customers,
    count(*) filter (where seq=1 and legacy) legacy_first,
    count(distinct cid) filter (where seq>1) returning_buyers,
    round(sum(net_ht),0) net_ht,
    round(sum(net_ht) filter (where seq=1 and not legacy),0) net_ht_new,
    round(sum(net_ht) filter (where seq=1 and legacy),0) net_ht_legacy_first,
    round(sum(net_ht) filter (where seq>1),0) net_ht_returning,
    round(sum(sub_ttc + disc_ttc)/1.2,0) gross_ht,
    round(sum(disc_ttc)/1.2,0) discounts_ht,
    round(sum(ref_ttc)/1.2,0) refunds_ht,
    round(avg(net_ttc),2) aov_ttc,
    round(avg(net_ht),2) aov_ht,
    round(avg(l.units),2) units_per_order,
    round(100.0*avg(case when has_promo then 1 else 0 end),1) pct_orders_promo,
    round(100.0*avg(case when has_code then 1 else 0 end),1) pct_orders_code,
    round(100.0*sum(disc_ttc)/nullif(sum(sub_ttc+disc_ttc),0),1) discount_rate_pct
  from bo b left join lines l on l.order_id=b.id group by 1)
select mm.*, s.sessions, s.converted_sessions,
  round(100.0*s.converted_sessions/nullif(s.sessions,0),2) conv_rate_pct,
  round(mm.net_ht/nullif(s.sessions,0),2) rev_per_session_ht
from mm left join storefront_session_months s on s.shop_id=:shop and s.month=mm.m
order by m

-- name: q02_periods
-- Headline KPIs per analysis window (completed months only).
with /*BASE*/,
win as (select * from (values
  ('a full Mar25-Oct26', date '2025-03-01', date '2026-11-01'),
  ('b T12 Nov25-Oct26', date '2025-11-01', date '2026-11-01'),
  ('c T6 May26-Oct26', date '2026-05-01', date '2026-11-01'),
  ('d T3 Aug26-Oct26', date '2026-08-01', date '2026-11-01'),
  ('e Mar-Oct 2025', date '2025-03-01', date '2025-11-01'),
  ('f Mar-Oct 2026', date '2026-03-01', date '2026-11-01')) v(w, f, t))
select w, count(*) orders, count(distinct cid) buyers,
  count(*) filter (where seq=1 and not legacy) new_customers,
  count(*) filter (where seq=1 and legacy) legacy_first,
  count(*) filter (where seq>1) repeat_orders,
  round(sum(net_ht)) net_ht, round(avg(net_ht),2) aov_ht,
  round(count(*)::numeric/count(distinct cid),3) orders_per_buyer,
  round(100.0*sum(net_ht) filter (where seq>1)/sum(net_ht),1) pct_rev_repeat,
  round(100.0*sum(disc_ttc)/sum(sub_ttc+disc_ttc),1) discount_rate_pct,
  round(100.0*avg(case when has_promo then 1 else 0 end),1) pct_orders_promo
from bo join win on bo.m >= win.f and bo.m < win.t group by w order by w

-- name: q02_yoy
-- Same calendar months (Mar-Oct), 2025 vs 2026.
with /*BASE*/
select extract(month from m)::int mon,
  sum(case when m < '2026-01-01' then net_ht end)::int net_2025, sum(case when m >= '2026-01-01' then net_ht end)::int net_2026,
  count(distinct cid) filter (where m < '2026-01-01') buyers_2025, count(distinct cid) filter (where m >= '2026-01-01') buyers_2026,
  count(*) filter (where m < '2026-01-01') orders_2025, count(*) filter (where m >= '2026-01-01') orders_2026,
  round(avg(net_ht) filter (where m < '2026-01-01'),2) aov_2025, round(avg(net_ht) filter (where m >= '2026-01-01'),2) aov_2026,
  count(*) filter (where m < '2026-01-01' and seq=1 and not legacy) new_2025,
  count(*) filter (where m >= '2026-01-01' and seq=1 and not legacy) new_2026,
  count(*) filter (where m < '2026-01-01' and seq>1) rep_2025,
  count(*) filter (where m >= '2026-01-01' and seq>1) rep_2026
from bo where extract(month from m) between 3 and 10 group by 1 order by 1

-- name: q02_marketplace_context
-- Context only (not in the DTC population): marketplace orders and revenue per month.
select date_trunc('month', processed_at)::date m, sales_channel, count(*) orders, round(sum(subtotal_price)/1.2) sub_ht
from orders where shop_id=:shop and sales_channel in ('Amazon','Mirakl Connect') and cancelled_at is null
group by 1,2 order by 1,2
