-- Lifecycle segmentation as of 2026-11-01. Thresholds come from the observed gap distribution (q04_gaps):
--   first->second gap: median 105 d, p75 180 d, p90 261 d;  repeat gaps: median 69-84 d, p75 116-145 d, p90 164-213 d.
--   So: a one-time buyer is "in the natural window" to 180 d, "at risk" 181-365 d, "lost" after 365 d;
--   a repeat buyer is "active" to 150 d, "at risk" 151-270 d, "lapsed" after 270 d.

-- name: q05_segments
with /*BASE*/,
lines as (select cid, range_, sum(net_ht) v from bp group by 1,2),
fav as (select distinct on (cid) cid, range_ fav_range from lines order by cid, v desc),
cu as (
  select cid, bool_or(legacy) legacy, count(*) n, sum(net_ht) v, avg(net_ht) aov,
    max(ts) last_ts, min(ts) first_ts, avg(case when has_promo then 1.0 else 0 end) promo_share,
    sum(disc_ttc)/nullif(sum(sub_ttc+disc_ttc),0) disc_rate, max(mstate) mstate,
    extract(epoch from timestamptz '2026-11-01 00:00 Europe/Paris' - max(ts))/86400 rec
  from bo group by 1),
p90 as (select percentile_cont(0.9) within group (order by aov) a from cu),
s as (
  select cu.*, f.fav_range,
    case
      when n=1 and rec<=60 then '01 Nouveaux (1 achat, <=60 j)'
      when n=1 and rec<=180 then '02 1 achat, fenêtre naturelle (61-180 j)'
      when n=1 and rec<=365 then '03 1 achat, à risque (181-365 j)'
      when n=1 then '04 1 achat, perdus (>365 j)'
      when n>=4 and rec<=150 then '05 Champions (4+ achats, actifs <=150 j)'
      when rec<=150 then '06 Réachat actifs (2-3 achats, <=150 j)'
      when rec<=270 then '07 Réachat à risque (151-270 j)'
      else '08 Réachat inactifs (>270 j)' end seg,
    (n>=2 and promo_share>=0.99) all_orders_on_promo,
    (aov >= (select a from p90)) high_basket
  from cu left join fav f using (cid))
select seg, count(*) customers, round(100.0*count(*)/sum(count(*)) over (),1) pct_customers,
  round(sum(v)) net_ht, round(100.0*sum(v)/sum(sum(v)) over (),1) pct_revenue,
  round(avg(aov),2) aov_ht, round(avg(n),2) avg_orders, round(avg(v),2) avg_value,
  round(avg(rec)) avg_recency_days, round(100.0*avg(promo_share),1) pct_orders_promo,
  round(100.0*avg(disc_rate),1) avg_discount_rate,
  count(*) filter (where mstate='SUBSCRIBED') email_subscribed,
  round(100.0*count(*) filter (where mstate='SUBSCRIBED')/count(*),1) pct_subscribed,
  count(*) filter (where legacy) legacy, count(*) filter (where high_basket) high_basket,
  count(*) filter (where all_orders_on_promo) all_orders_on_promo
from s group by 1 order by 1

-- name: q05_segment_fav_range
with /*BASE*/,
lines as (select cid, range_, sum(net_ht) v from bp group by 1,2),
fav as (select distinct on (cid) cid, range_ fav_range from lines order by cid, v desc),
cu as (select cid, count(*) n, extract(epoch from timestamptz '2026-11-01 00:00 Europe/Paris' - max(ts))/86400 rec, max(mstate) mstate, sum(net_ht) v from bo group by 1)
select fav_range,
  count(*) filter (where n=1 and rec between 181 and 365) one_time_at_risk,
  count(*) filter (where n>=2 and rec > 150) repeat_at_risk_or_lapsed,
  count(*) filter (where n>=2 and rec > 150 and mstate='SUBSCRIBED') repeat_lapsing_subscribed,
  round(sum(v) filter (where n>=2 and rec > 150)) repeat_lapsing_hist_value,
  count(*) filter (where n>=2 and rec <= 150) repeat_active
from cu join fav using (cid) group by 1 order by 3 desc

-- name: q05_discount_sensitivity
-- Customers by share of their orders carrying a promotion (2+ order customers only), and their economics.
with /*BASE*/,
cu as (select cid, count(*) n, avg(case when has_promo then 1.0 else 0 end) ps, sum(net_ht) v, avg(net_ht) aov,
         sum(disc_ttc)/sum(sub_ttc+disc_ttc) dr from bo group by 1 having count(*)>=2)
select case when ps=0 then 'a never promo' when ps<0.5 then 'b <50% promo' when ps<1 then 'c 50-99% promo' else 'd always promo' end band,
  count(*) customers, round(avg(n),2) avg_orders, round(avg(v),2) avg_value, round(avg(aov),2) aov_ht, round(100*avg(dr),1) avg_discount_rate
from cu group by 1 order by 1

-- name: q05_rfm_crosscheck
-- Shopify's own rfm_group vs our segments (same customers).
with /*BASE*/,
cu as (select cid, count(*) n, extract(epoch from timestamptz '2026-11-01 00:00 Europe/Paris' - max(ts))/86400 rec from bo group by 1)
select c.rfm_group, count(*) customers, round(avg(n),2) avg_orders, round(avg(rec)) avg_recency
from cu join customers c on c.id=cu.cid and c.shop_id=:shop group by 1 order by 2 desc

-- name: q05_consent
-- Marketing consent across the whole Qiriness customer table and across DTC buyers.
with /*BASE*/,
b as (select distinct cid from bo)
select coalesce(c.email_marketing_state,'(null)') state,
  count(*) all_profiles,
  count(*) filter (where b.cid is not null) dtc_buyers,
  count(*) filter (where (c.shopify_created_at at time zone 'Europe/Paris')::date = date '2025-04-14') legacy_import_profiles,
  count(*) filter (where (c.shopify_created_at at time zone 'Europe/Paris')::date = date '2025-04-14' and b.cid is null) legacy_never_bought_on_shopify
from customers c left join b on b.cid=c.id where c.shop_id=:shop and c.deleted_at is null group by 1 order by 2 desc
