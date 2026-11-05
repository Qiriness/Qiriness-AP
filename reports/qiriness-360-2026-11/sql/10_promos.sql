-- name: q10_offers
-- Each offer (discount application name, codes upper-cased), excluding the always-on free-shipping rule.
-- new_cust_2nd_180d: of NEW customers whose FIRST order used this offer and is >=180 d old, share with a 2nd order within 180 d.
with /*BASE*/,
o as (select b.*, upper(trim(coalesce(nullif(d->>'name',''), d->>'kind'))) offer, d->>'kind' kind
      from bo b cross join lateral jsonb_array_elements(coalesce((select discount_applications from orders x where x.id=b.id and x.shop_id=:shop),'[]')) d
      where coalesce(d->>'name','') not ilike '%frais de port%'),
r as (select o.*, (select min(ts) from bo x where x.cid=o.cid and x.seq=2) t2 from o)
select offer, min(kind) kind, count(distinct id) orders, round(sum(net_ht)) net_ht, round(avg(net_ht),2) aov_ht,
  round(100.0*sum(disc_ttc)/nullif(sum(sub_ttc+disc_ttc),0),1) discount_rate_pct,
  to_char(min(ts),'YYYY-MM-DD') first_used, to_char(max(ts),'YYYY-MM-DD') last_used,
  count(*) filter (where seq=1 and not legacy) new_customer_first_orders,
  round(100.0*count(*) filter (where seq=1 and not legacy)/count(*),1) pct_new_first,
  count(*) filter (where seq=1 and not legacy and ts < timestamptz '2026-05-05 00:00 Europe/Paris') new_matured,
  round(100.0*avg(case when t2 < ts + interval '180 days' then 1 else 0 end) filter (where seq=1 and not legacy and ts < timestamptz '2026-05-05 00:00 Europe/Paris'),1) new_cust_2nd_180d
from r group by 1 having count(distinct id) >= 15 order by 3 desc

-- name: q10_depth_vs_basket
-- Order-level realised discount depth vs basket.
with /*BASE*/,
l as (select order_id, sum(qty) filter (where not is_sample and net_ht>0.01) units from bl group by 1)
select case when disc_ttc=0 then 'a 0%' when disc_ttc/(sub_ttc+disc_ttc) < 0.10 then 'b <10%' when disc_ttc/(sub_ttc+disc_ttc) < 0.20 then 'c 10-20%'
  when disc_ttc/(sub_ttc+disc_ttc) < 0.30 then 'd 20-30%' else 'e 30%+' end depth,
  count(*) orders, round(avg(net_ht),2) aov_ht, round(avg((sub_ttc+disc_ttc)/1.2),2) gross_basket_ht, round(avg(units),2) units,
  round(sum(disc_ttc)/1.2) discount_cost_ht, round(100.0*count(*) filter (where seq=1 and not legacy)/count(*),1) pct_new_first
from bo join l on l.order_id=bo.id group by 1 order by 1

-- name: q10_first_promo_retention_matched
-- New customers: 180-d repurchase by first-order promo type WITHIN each cohort quarter (controls for season/cohort).
with /*BASE*/,
c as (select b.cid, to_char(b.ts,'YYYY-"Q"Q') q, b.ts,
        case when b.has_code then 'code' when b.has_promo then 'automatic' else 'full price' end ptype,
        (select min(ts) from bo x where x.cid=b.cid and x.seq=2) t2,
        (select bool_or(has_promo) from bo x where x.cid=b.cid and x.seq=2) second_on_promo,
        b.net_ht first_net
      from bo b where seq=1 and not legacy and b.ts < timestamptz '2026-05-05 00:00 Europe/Paris')
select q, ptype, count(*) customers, round(avg(first_net),2) first_aov_ht,
  round(100.0*avg(case when t2 < ts + interval '180 days' then 1 else 0 end),1) pct_2nd_180d,
  round(100.0*avg(case when second_on_promo then 1 else 0 end) filter (where t2 is not null),1) pct_second_on_promo
from c group by 1,2 order by 1,2

-- name: q10_waiting_for_discounts
-- Share of repeat (2nd+) orders that carry a promotion, by quarter; and by whether the customer's first order was on promo.
with /*BASE*/,
f as (select cid, has_promo first_promo from bo where seq=1)
select to_char(b.ts,'YYYY-"Q"Q') q,
  count(*) filter (where seq>1) repeat_orders,
  round(100.0*avg(case when has_promo then 1 else 0 end) filter (where seq>1),1) pct_repeat_on_promo,
  round(100.0*avg(case when has_promo then 1 else 0 end) filter (where seq>1 and not f.first_promo),1) pct_repeat_on_promo_fullprice_starters,
  round(100.0*avg(case when has_promo then 1 else 0 end) filter (where seq>1 and f.first_promo),1) pct_repeat_on_promo_promo_starters,
  round(100.0*avg(case when has_promo then 1 else 0 end) filter (where seq=1),1) pct_first_on_promo
from bo b join f using (cid) group by 1 order by 1

-- name: q10_weekly
-- Weekly own-site orders with promo share and the most-used offer (for event lift / pull-forward reading).
with /*BASE*/,
w as (select date_trunc('week', ts)::date wk, id, has_promo, net_ht, seq, legacy from bo),
top as (select distinct on (wk) wk, offer, n from (
          select date_trunc('week', b.ts)::date wk, coalesce(nullif(d->>'name',''), d->>'kind') offer, count(*) n
          from bo b cross join lateral jsonb_array_elements(coalesce((select discount_applications from orders x where x.id=b.id and x.shop_id=:shop),'[]')) d
          where coalesce(d->>'name','') not ilike '%frais de port%' group by 1,2) z order by wk, n desc)
select w.wk, count(*) orders, round(sum(net_ht)) net_ht, round(100.0*avg(case when has_promo then 1 else 0 end),1) pct_promo,
  count(*) filter (where seq=1 and not legacy) new_customers, top.offer top_offer, top.n top_offer_orders
from w left join top using (wk) group by w.wk, top.offer, top.n order by 1

-- name: q10_product_promo_dependency
-- Share of each product's paid units sold in promo orders, and realised discount on the product line itself.
with /*BASE*/
select min(title) product, min(range_) range_, sum(qty) units,
  round(100.0*sum(qty) filter (where has_promo)/sum(qty),1) pct_units_promo_orders,
  round(100.0*(1 - sum(net_ht)/nullif(sum(gross_ttc/1.2),0)),1) realised_discount_pct, round(sum(net_ht)) net_ht
from bp group by pkey having sum(qty) >= 60 order by 5 desc
