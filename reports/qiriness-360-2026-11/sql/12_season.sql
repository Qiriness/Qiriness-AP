-- name: q12_need_share_by_month
-- Each need's share of the month's paid-line revenue (normalises for overall growth). Calendar month pooled over 2025-03..2026-10.
with /*BASE*/,
t as (select extract(month from m)::int mon, need, sum(net_ht) v from bp group by 1,2),
tm as (select mon, sum(v) tot from t group by 1)
select t.mon, t.need, round(t.v) net_ht, round(100.0*t.v/tm.tot,1) pct_of_month
from t join tm using (mon) order by 1,2

-- name: q12_range_share_by_month
with /*BASE*/,
t as (select extract(month from m)::int mon, range_, sum(net_ht) v from bp group by 1,2),
tm as (select mon, sum(v) tot from t group by 1)
select t.mon, t.range_, round(t.v) net_ht, round(100.0*t.v/tm.tot,1) pct_of_month
from t join tm using (mon) order by 1,2

-- name: q12_gifting
-- Gifting signals by month: sets/coffrets share of revenue, orders with 2+ units of the same set, orders shipped to non-default... (n/a)
with /*BASE*/,
s as (select m, order_id, bool_or(is_set) has_set, max(case when is_set then qty end) max_set_qty, sum(net_ht) filter (where is_set) set_net, sum(net_ht) net from bp group by 1,2)
select m, count(*) orders, round(100.0*avg(case when has_set then 1 else 0 end),1) pct_orders_with_set,
  round(100.0*sum(set_net)/sum(net),1) pct_rev_sets, count(*) filter (where max_set_qty >= 2) orders_2plus_same_set
from s group by 1 order by 1

-- name: q12_dow_hour
-- Day of week / hour of own-site orders (Paris time), for send-time choices.
with /*BASE*/
select extract(isodow from ts)::int dow, count(*) orders, round(avg(net_ht),2) aov_ht,
  round(100.0*count(*) filter (where extract(hour from ts) between 18 and 23)/count(*),1) pct_evening
from bo group by 1 order by 1

-- name: q12_repeat_demand_by_month
-- Repeat orders per month vs the number of customers "due" (last order 60-180 d earlier) — replenishment demand proxy.
with /*BASE*/,
mons as (select generate_series(date '2025-06-01', date '2026-10-01', interval '1 month')::date m),
due as (select mons.m, count(distinct b.cid) due_customers from mons join bo b
          on b.ts >= mons.m - interval '180 days' and b.ts < mons.m - interval '60 days'
          and not exists (select 1 from bo x where x.cid=b.cid and x.ts > b.ts and x.ts < mons.m) group by 1),
rep as (select m, count(*) repeat_orders from bo where seq>1 group by 1)
select due.m, due_customers, coalesce(repeat_orders,0) repeat_orders, round(100.0*coalesce(repeat_orders,0)/due_customers,1) repeat_per_100_due
from due left join rep using (m) order by 1
