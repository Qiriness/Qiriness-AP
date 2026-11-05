-- As-of date for maturity and censoring: 2026-11-01 00:00 Europe/Paris (orders observed through 2026-10-31).

-- name: q04_cohorts
-- Monthly first-purchase cohorts. Fixed-window rates are null unless the whole cohort has had the full window.
with /*BASE*/,
asof as (select timestamptz '2026-11-01 00:00 Europe/Paris' t),
c as (
  select b.cid, b.legacy, b.m cohort, b.ts t0, b.net_ht first_net,
    (select min(ts) from bo x where x.cid=b.cid and x.seq=2) t2,
    (select min(ts) from bo x where x.cid=b.cid and x.seq=3) t3
  from bo b where seq=1),
v as (
  select c.*,
    (select coalesce(sum(net_ht),0) from bo x where x.cid=c.cid and x.ts < c.t0 + interval '90 days') v90,
    (select coalesce(sum(net_ht),0) from bo x where x.cid=c.cid and x.ts < c.t0 + interval '180 days') v180,
    (select coalesce(sum(net_ht),0) from bo x where x.cid=c.cid and x.ts < c.t0 + interval '365 days') v365,
    (select coalesce(sum(net_ht),0) from bo x where x.cid=c.cid) v_to_date
  from c)
select cohort, case when legacy then 'legacy' else 'new' end ctype, count(*) customers,
  round(avg(first_net),2) first_aov_ht,
  round(100.0*avg(case when t2 is not null then 1 else 0 end),1) pct_2nd_to_date,
  round(100.0*avg(case when t3 is not null then 1 else 0 end),1) pct_3rd_to_date,
  case when max(t0) + interval '30 days' <= (select t from asof) then round(100.0*avg(case when t2 < t0 + interval '30 days' then 1 else 0 end),1) end r30,
  case when max(t0) + interval '60 days' <= (select t from asof) then round(100.0*avg(case when t2 < t0 + interval '60 days' then 1 else 0 end),1) end r60,
  case when max(t0) + interval '90 days' <= (select t from asof) then round(100.0*avg(case when t2 < t0 + interval '90 days' then 1 else 0 end),1) end r90,
  case when max(t0) + interval '180 days' <= (select t from asof) then round(100.0*avg(case when t2 < t0 + interval '180 days' then 1 else 0 end),1) end r180,
  case when max(t0) + interval '365 days' <= (select t from asof) then round(100.0*avg(case when t2 < t0 + interval '365 days' then 1 else 0 end),1) end r365,
  round((percentile_cont(0.5) within group (order by extract(epoch from t2 - t0)/86400))::numeric, 0) median_days_to_2nd,
  case when max(t0) + interval '90 days' <= (select t from asof) then round(avg(v90),2) end cv90,
  case when max(t0) + interval '180 days' <= (select t from asof) then round(avg(v180),2) end cv180,
  case when max(t0) + interval '365 days' <= (select t from asof) then round(avg(v365),2) end cv365,
  round(avg(v_to_date),2) value_to_date
from v group by 1,2 order by 2,1

-- name: q04_pooled_windows
-- Pooled repurchase rates over every customer who has had the full window (new customers vs legacy).
with /*BASE*/,
asof as (select timestamptz '2026-11-01 00:00 Europe/Paris' t),
c as (select b.cid, b.legacy, b.ts t0, (select min(ts) from bo x where x.cid=b.cid and x.seq=2) t2,
             (select min(ts) from bo x where x.cid=b.cid and x.seq=3) t3 from bo b where seq=1),
w as (select * from (values (30),(60),(90),(180),(270),(365),(450)) v(d))
select case when legacy then 'legacy' else 'new' end ctype, d window_days,
  count(*) eligible, count(*) filter (where t2 < t0 + make_interval(days => d)) repurchased,
  round(100.0*count(*) filter (where t2 < t0 + make_interval(days => d))/count(*),1) pct_2nd,
  round(100.0*count(*) filter (where t3 < t0 + make_interval(days => d))/count(*),1) pct_3rd
from c cross join w where t0 + make_interval(days => d) <= (select t from asof)
group by 1,2 order by 1,2

-- name: q04_km_second
-- Kaplan-Meier: share still WITHOUT a 2nd order after t days (censored at the as-of date). 1 - S(t) = cumulative repurchase.
with /*BASE*/,
asof as (select timestamptz '2026-11-01 00:00 Europe/Paris' t),
c as (select b.cid, b.legacy, b.ts t0, (select min(ts) from bo x where x.cid=b.cid and x.seq=2) t2 from bo b where seq=1),
e as (select legacy, greatest(1, ceil(extract(epoch from coalesce(t2, (select t from asof)) - t0)/86400))::int dd,
             (t2 is not null)::int ev from c),
g as (select legacy, dd, sum(ev) d, count(*) n_at from e group by 1,2),
r as (select legacy, dd, d, sum(n_at) over (partition by legacy order by dd desc) at_risk from g),
s as (select legacy, dd, at_risk, exp(sum(ln(greatest(1e-9, 1 - d::numeric/at_risk))) over (partition by legacy order by dd)) surv from r)
select case when legacy then 'legacy' else 'new' end ctype, t, round(100*(1 - (select surv from s s2 where s2.legacy=x.legacy and s2.dd <= t order by dd desc limit 1)),1) cum_repurchase_pct,
  (select at_risk from s s2 where s2.legacy=x.legacy and s2.dd >= t order by dd limit 1) at_risk_at_t
from (select distinct legacy from s) x cross join (values (7),(14),(30),(45),(60),(90),(120),(180),(270),(365),(450),(540)) v(t)
order by 1,2

-- name: q04_transitions
-- Ladder: of customers who reached order k at least 180 days before the as-of date, share reaching k+1 within 180 days and ever.
with /*BASE*/,
asof as (select timestamptz '2026-11-01 00:00 Europe/Paris' t),
k as (select a.cid, a.legacy, a.seq k, a.ts tk, (select min(ts) from bo x where x.cid=a.cid and x.seq=a.seq+1) tnext from bo a)
select case when k>=5 then '5+' else k::text end from_order, count(*) eligible_180d,
  round(100.0*count(*) filter (where tnext < tk + interval '180 days')/count(*),1) pct_next_within_180d,
  round(100.0*count(*) filter (where tnext is not null)/count(*),1) pct_next_ever,
  round((percentile_cont(0.5) within group (order by extract(epoch from tnext-tk)/86400) filter (where tnext is not null))::numeric,0) median_gap_days
from k where tk + interval '180 days' <= (select t from asof) and not legacy
group by 1 order by 1

-- name: q04_gaps
-- Distribution of days between consecutive orders (all customers), by transition.
with /*BASE*/,
g as (select case when seq=2 then '1->2' when seq=3 then '2->3' else '3+->next' end tr, extract(epoch from ts - prev_ts)/86400 d
      from bo where seq >= 2)
select tr, count(*) n,
  round((percentile_cont(0.10) within group (order by d))::numeric,0) p10,
  round((percentile_cont(0.25) within group (order by d))::numeric,0) p25,
  round((percentile_cont(0.50) within group (order by d))::numeric,0) p50,
  round((percentile_cont(0.75) within group (order by d))::numeric,0) p75,
  round((percentile_cont(0.90) within group (order by d))::numeric,0) p90,
  round(100.0*count(*) filter (where d < 7)/count(*),1) pct_within_7d,
  round(100.0*count(*) filter (where d < 30)/count(*),1) pct_within_30d
from g group by 1 order by 1

-- name: q04_gap_histogram
with /*BASE*/
select case when d<7 then 'a <7d' when d<30 then 'b 7-29d' when d<60 then 'c 30-59d' when d<90 then 'd 60-89d'
  when d<120 then 'e 90-119d' when d<180 then 'f 120-179d' when d<270 then 'g 180-269d' when d<365 then 'h 270-364d' else 'i 365d+' end bucket,
  count(*) n
from (select extract(epoch from ts - prev_ts)/86400 d from bo where seq>=2) x group by 1 order by 1

-- name: q04_frequency
-- Buyers by lifetime (in-window) order count and their revenue.
with /*BASE*/,
cu as (select cid, bool_or(legacy) legacy, count(*) n, sum(net_ht) v from bo group by 1)
select case when n=1 then '1' when n=2 then '2' when n=3 then '3' when n<=5 then '4-5' else '6+' end orders_bucket,
  count(*) customers, round(100.0*count(*)/sum(count(*)) over (),1) pct_customers,
  round(sum(v)) net_ht, round(100.0*sum(v)/sum(sum(v)) over (),1) pct_revenue,
  round(avg(v),2) avg_value, round(sum(v)/sum(n),2) aov_ht,
  count(*) filter (where legacy) legacy_customers
from cu group by 1 order by 1

-- name: q04_frequency_trend
-- Comparable cohorts: orders per new customer within their first 180 and 365 days, by cohort quarter.
with /*BASE*/,
c as (select cid, ts t0, to_char(ts,'YYYY-"Q"Q') q from bo where seq=1 and not legacy)
select q, count(*) customers,
  case when max(t0) + interval '180 days' <= timestamptz '2026-11-01 00:00 Europe/Paris' then
    round(avg((select count(*) from bo x where x.cid=c.cid and x.ts < c.t0 + interval '180 days')),3) end orders_180d,
  case when max(t0) + interval '365 days' <= timestamptz '2026-11-01 00:00 Europe/Paris' then
    round(avg((select count(*) from bo x where x.cid=c.cid and x.ts < c.t0 + interval '365 days')),3) end orders_365d
from c group by 1 order by 1
