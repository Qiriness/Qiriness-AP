-- name: q09_ad_campaigns
-- Paid media synced for Qiriness (Meta / Google Ads connections). Platform-reported conversions are the platform's attribution.
select campaign_id, min(day) first_day, max(day) last_day, max(currency) currency, round(sum(spend),2) spend,
  sum(impressions) impressions, sum(clicks) clicks, round(sum(conversions)) platform_conversions, round(sum(conversion_value)) platform_value
from ad_campaign_days where shop_id = :shop group by 1 order by spend desc

-- name: q09_ad_months
select date_trunc('month', day)::date m, round(sum(spend),2) spend, sum(clicks) clicks, round(sum(conversions)) platform_conversions,
  round(sum(conversion_value)) platform_value
from ad_campaign_days where shop_id = :shop group by 1 order by 1
