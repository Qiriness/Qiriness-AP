-- Audience sizing for the opportunity register (as of 2026-11-01).

-- name: q13_replenishment_due
-- For replenishable products (measured median reorder 100-180 d), customers whose LAST purchase of the product
-- is 60-240 d old and who have placed no order since; email-subscribed share. "due_now" = within p25..p75 of the product's interval.
with /*BASE*/,
prod as (select * from (values
  ('Duo Jour & Nuit Temps Sublime', 81, 215), ('Élixir Source d''Eau', 65, 163), ('Bonne Mine Homme', 74, 196),
  ('Caresse Source d''Eau', 96, 215), ('Caresse d''Exception', 53, 164), ('Crème Hydratante Niacinamide', 64, 166),
  ('Sérum Booster Anti-âge Vitamine C', 47, 185), ('Mousse Divine', 106, 201), ('Caresse Regard Sublime', 87, 241),
  ('CC Crème - Soin Bonne Mine', 76, 218), ('Lotion Exquise', 27, 188), ('Crème Anti-Âge - Acide Hyaluronique - Caresse Active Énergie Lift', 76, 204)
  ) v(pat, p25, p75)),
lastbuy as (select p.pat, p.p25, p.p75, b.cid, max(b.ts) last_ts from bp b join prod p on b.title ilike '%' || p.pat || '%' group by 1,2,3,4),
cu as (select cid, max(ts) last_order, max(mstate) mstate from bo group by 1)
select pat product, count(*) buyers_ever,
  count(*) filter (where l.last_ts = c.last_order and now_d between p25 and p75) due_now,
  count(*) filter (where l.last_ts = c.last_order and now_d between p25 and p75 and c.mstate='SUBSCRIBED') due_now_subscribed,
  count(*) filter (where l.last_ts = c.last_order and now_d > p75 and now_d <= 365) overdue_to_365d,
  count(*) filter (where l.last_ts = c.last_order and now_d > p75 and now_d <= 365 and c.mstate='SUBSCRIBED') overdue_subscribed,
  p25, p75
from (select l.*, extract(epoch from timestamptz '2026-11-01 00:00 Europe/Paris' - l.last_ts)/86400 now_d from lastbuy l) l
join cu c using (cid) group by pat, p25, p75 order by due_now desc

-- name: q13_routine_gaps
-- Routine completion: customers who bought A (any time) but never B. Subscribed share = reachable by email.
with /*BASE*/,
r as (select * from (values
  ('Exception: crème -> sérum', '%Caresse d''Exception%', '%Élixir d''Exception%'),
  ('Exception: crème -> yeux', '%Caresse d''Exception%', '%Regard d’Exception%'),
  ('Active Énergie: crème Lift -> sérum Lift', '%Caresse Active Énergie Lift%', '%Élixir Active Énergie Lift%'),
  ('Éclat Parfait: crème -> élixir', '%Caresse Éclat Parfait%', '%Élixir Éclat Parfait%'),
  ('Temps Sublime: crème(s) -> sérum', '%Caresse Temps Sublime%', '%Élixir Temps Sublime%'),
  ('Temps Sublime: soin -> yeux Regard Sublime', '%Temps Sublime%', '%Regard Sublime%'),
  ('Source d''Eau: crème -> élixir', '%Caresse Source d''Eau%', '%Élixir Source d''Eau%'),
  ('Homme: CC crème -> nettoyant', '%Bonne Mine Homme%', '%Nettoyant Visage Purifiant Homme%'),
  ('Purifiant: Ginger gel -> lotion Kéfir', '%Ginger Gel%', '%Kéfir%'),
  ('Masque LED -> masques/wraps', '%Masque LED%', '%Wrap%')) v(routine, a, b)),
cu as (select cid, max(mstate) mstate, extract(epoch from timestamptz '2026-11-01 00:00 Europe/Paris' - max(ts))/86400 rec from bo group by 1),
x as (select r.routine, c.cid, c.mstate, c.rec,
        bool_or(p.title ilike r.a) has_a, bool_or(p.title ilike r.b) has_b
      from r cross join cu c join bp p on p.cid=c.cid group by 1,2,3,4)
select routine, count(*) filter (where has_a) buyers_a, count(*) filter (where has_a and has_b) bought_both,
  round(100.0*count(*) filter (where has_a and has_b)/nullif(count(*) filter (where has_a),0),1) pct_completed,
  count(*) filter (where has_a and not has_b) gap_customers,
  count(*) filter (where has_a and not has_b and mstate='SUBSCRIBED') gap_subscribed,
  count(*) filter (where has_a and not has_b and mstate='SUBSCRIBED' and rec <= 365) gap_subscribed_active_12m
from x group by 1 order by gap_subscribed_active_12m desc

-- name: q13_bf_pull_forward
-- Weekly orders Sep 2025 - Mar 2026 vs the same weeks' repeat share: dips before/after Black Friday and Christmas.
with /*BASE*/
select date_trunc('week', ts)::date wk, count(*) orders, count(*) filter (where seq>1) repeat_orders,
  count(*) filter (where seq=1 and not legacy) new_customers, round(sum(net_ht)) net_ht,
  round(100.0*avg(case when has_promo then 1 else 0 end),1) pct_promo
from bo where ts >= timestamptz '2025-09-01 00:00 Europe/Paris' and ts < timestamptz '2026-03-01 00:00 Europe/Paris'
group by 1 order by 1

-- name: q13_value_ladder
-- Average subsequent value (after the first order) of customers who made a 2nd order, and first-order AOV — for sizing 1->2.
with /*BASE*/,
cu as (select cid, count(*) n, sum(net_ht) v, sum(net_ht) filter (where seq=1) v1, sum(net_ht) filter (where seq=2) v2,
         min(ts) filter (where seq=1) t0 from bo group by 1)
select count(*) filter (where n>=2) repeaters, round(avg(v - v1) filter (where n>=2),2) avg_value_after_first_to_date,
  round(avg(v2) filter (where n>=2),2) avg_second_order,
  round(avg(v - v1) filter (where n>=2 and t0 < timestamptz '2025-11-01 00:00 Europe/Paris'),2) avg_value_after_first_mature_cohorts,
  count(*) filter (where n=1 and not exists (select 1 from bo x where x.cid=cu.cid and x.legacy)) one_timers_new
from cu

-- name: q13_t12_shapes
with /*BASE*/,
o as (select order_id, count(distinct pkey) np from bp group by 1)
select count(*) orders_t12, count(*) filter (where np=1) single_product_orders,
  round(avg(b.net_ht) filter (where np=1),2) aov_single, round(avg(b.net_ht) filter (where np=2),2) aov_two,
  count(*) filter (where b.sub_ttc >= 50 and b.sub_ttc < 70) orders_50_70_ttc,
  count(*) filter (where b.seq=1 and not b.legacy) new_t12
from bo b join o on o.order_id=b.id where b.m >= '2025-11-01'
