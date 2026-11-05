-- Klaviyo aggregates synced to the DB (campaign totals; flow totals per day). Attributed revenue = Klaviyo's
-- "Placed Order" conversion value (Klaviyo attribution window, incl. VAT, all channels) — attribution, not incrementality.

-- name: q11_campaign_months
select date_trunc('month', send_time)::date m, count(*) campaigns, sum(recipients) recipients, round(avg(recipients)) avg_recipients,
  sum(delivered) delivered, sum(clicks_unique) clicks, sum(conversions) conversions, round(sum(conversion_value)) value_ttc,
  round(100.0*sum(clicks_unique)/nullif(sum(delivered),0),2) click_rate_pct,
  round(100.0*sum(conversions)/nullif(sum(delivered),0),3) conv_rate_pct,
  round(1000*sum(conversion_value)/nullif(sum(delivered),0),2) value_per_1000_delivered
from klaviyo_campaigns where shop_id=:shop and send_time < timestamptz '2026-11-01 00:00 Europe/Paris' group by 1 order by 1

-- name: q11_flows
select flow_name, min(day) first_day, max(day) last_day, sum(recipients) recipients, sum(delivered) delivered,
  sum(clicks_unique) clicks, sum(conversions) conversions, round(sum(conversion_value)) value_ttc,
  round(100.0*sum(clicks_unique)/nullif(sum(delivered),0),2) click_rate_pct,
  round(sum(conversion_value)/nullif(sum(delivered),0),2) value_per_delivered
from klaviyo_flow_days where shop_id=:shop group by 1 order by value_ttc desc

-- name: q11_campaign_top
-- Best and worst campaigns by value per 1,000 delivered (>= 2,000 delivered).
select to_char(send_time,'YYYY-MM-DD') sent, name, delivered, clicks_unique, conversions, round(conversion_value) value_ttc,
  round(100.0*clicks_unique/nullif(delivered,0),2) click_rate_pct, round(1000*conversion_value/nullif(delivered,0),2) value_per_1000
from klaviyo_campaigns where shop_id=:shop and delivered >= 2000 order by value_per_1000 desc

-- name: q11_campaign_size_bands
-- Audience size vs yield: are big blasts worse per recipient than targeted sends?
select case when delivered < 2000 then 'a <2k' when delivered < 5000 then 'b 2-5k' when delivered < 10000 then 'c 5-10k'
  when delivered < 20000 then 'd 10-20k' else 'e 20k+' end size_band,
  count(*) campaigns, sum(delivered) delivered, round(100.0*sum(clicks_unique)/nullif(sum(delivered),0),2) click_rate_pct,
  round(1000*sum(conversion_value)/nullif(sum(delivered),0),2) value_per_1000, round(sum(conversion_value)) value_ttc
from klaviyo_campaigns where shop_id=:shop group by 1 order by 1

-- name: q11_attribution_share
-- Klaviyo-attributed value (campaigns + flows) vs own-site DTC net merchandise incl. VAT, per month.
with /*BASE*/,
shop as (select m, sum(net_ttc) net_ttc, count(*) orders from bo group by 1),
camp as (select date_trunc('month', send_time)::date m, sum(conversion_value) v, sum(conversions) c from klaviyo_campaigns where shop_id=:shop group by 1),
fl as (select date_trunc('month', day)::date m, sum(conversion_value) v, sum(conversions) c from klaviyo_flow_days where shop_id=:shop group by 1)
select shop.m, round(shop.net_ttc) shop_net_ttc, shop.orders, round(camp.v) campaign_value, camp.c campaign_conv, round(fl.v) flow_value, fl.c flow_conv,
  round(100.0*(coalesce(camp.v,0)+coalesce(fl.v,0))/shop.net_ttc,1) pct_attributed
from shop left join camp using (m) left join fl using (m) where shop.m >= '2025-10-01' order by 1

-- name: q11_send_pressure
-- Emails per subscribed profile per month (campaign deliveries / subscribed profiles at sync time).
select date_trunc('month', send_time)::date m, sum(delivered) delivered,
  (select count(*) from customers where shop_id=:shop and email_marketing_state='SUBSCRIBED') subscribed_now,
  round(sum(delivered)::numeric / (select count(*) from customers where shop_id=:shop and email_marketing_state='SUBSCRIBED'),1) emails_per_subscriber
from klaviyo_campaigns where shop_id=:shop group by 1 order by 1

-- name: q11_social_ads
-- What social / ad data exists for Qiriness (coverage only).
select 'ad_days' src, count(*) n_rows, min(day)::text first_day, max(day)::text last_day from ad_days where shop_id=:shop
union all select 'ad_campaign_days', count(*), min(day)::text, max(day)::text from ad_campaign_days where shop_id=:shop
union all select 'social_account_days', count(*), min(day)::text, max(day)::text from social_account_days where shop_id=:shop
union all select 'social_posts', count(*), null, null from social_posts where shop_id=:shop
