-- Association rules on paid lines (samples and 100%-gifted lines excluded, so gift-with-purchase does not create fake pairs).

-- name: q08_product_pairs
-- Same-order product pairs. support = pair orders / all orders; confidence A->B = pair / orders with A; lift = conf / P(B).
with /*BASE*/,
op as (select distinct order_id, pkey, title from bp),
n as (select count(distinct order_id) n from op),
pc as (select pkey, min(title) title, count(*) c from op group by 1),
pr as (select a.pkey a, b.pkey b, count(*) ab from op a join op b on a.order_id=b.order_id and a.pkey < b.pkey group by 1,2 having count(*) >= 12)
select pa.title product_a, pb.title product_b, ab pair_orders, pa.c orders_a, pb.c orders_b,
  round(100.0*ab/(select n from n),2) support_pct,
  round(100.0*ab/pa.c,1) conf_a_to_b, round(100.0*ab/pb.c,1) conf_b_to_a,
  round((ab::numeric/(select n from n)) / ((pa.c::numeric/(select n from n))*(pb.c::numeric/(select n from n))),2) lift
from pr join pc pa on pa.pkey=pr.a join pc pb on pb.pkey=pr.b order by lift desc, ab desc

-- name: q08_range_pairs
with /*BASE*/,
op as (select distinct order_id, range_ from bp),
n as (select count(distinct order_id) n from op),
pc as (select range_, count(*) c from op group by 1),
pr as (select a.range_ a, b.range_ b, count(*) ab from op a join op b on a.order_id=b.order_id and a.range_ < b.range_ group by 1,2 having count(*) >= 15)
select a range_a, b range_b, ab pair_orders, pa.c orders_a, pb.c orders_b,
  round(100.0*ab/pa.c,1) conf_a_to_b, round(100.0*ab/pb.c,1) conf_b_to_a,
  round((ab::numeric*(select n from n)) / (pa.c::numeric*pb.c),2) lift
from pr join pc pa on pa.range_=pr.a join pc pb on pb.range_=pr.b order by lift desc

-- name: q08_next_order_ranges
-- Sequential: ranges in order k -> ranges in order k+1 (same customer). Share of next orders containing each range.
with /*BASE*/,
o as (select distinct order_id, cid, seq, range_ from bp),
nx as (select a.range_ from_range, b.range_ to_range, a.cid, a.seq
       from o a join o b on b.cid=a.cid and b.seq=a.seq+1),
fr as (select from_range, count(distinct (cid, seq)) n_next_orders from nx group by 1)
select nx.from_range, nx.to_range, count(distinct (cid, seq)) next_orders, fr.n_next_orders,
  round(100.0*count(distinct (cid, seq))/fr.n_next_orders,1) pct_of_next_orders,
  (nx.from_range = nx.to_range) same_range
from nx join fr using (from_range) group by 1,2,fr.n_next_orders having count(distinct (cid, seq)) >= 8 order by 1, 3 desc

-- name: q08_basket_size
-- Orders by number of distinct paid products, and AOV.
with /*BASE*/,
o as (select order_id, count(distinct pkey) np, count(distinct range_) nr from bp group by 1)
select case when np>=4 then '4+' else np::text end products_in_order, count(*) orders, round(100.0*count(*)/sum(count(*)) over (),1) pct,
  round(avg(b.net_ht),2) aov_ht, round(avg(nr),2) avg_ranges
from o join bo b on b.id=o.order_id group by 1 order by 1

-- name: q08_threshold_effect
-- Basket distribution around the 65/70 EUR (incl. VAT) gift and free-shipping thresholds.
with /*BASE*/
select width_bucket(sub_ttc, 0, 150, 30) bucket, min(round(sub_ttc)) from_ttc, max(round(sub_ttc)) to_ttc, count(*) orders
from bo group by 1 order by 1
