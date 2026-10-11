-- ============================================================================
-- 87 — TIKTOK: LIFETIME VIDEO COUNTERS BY PUBLICATION BUCKET
--
-- WHAT THIS ADDS. `insights_tiktok_post_series` — the TikTok Display API gives
--   no daily account rows, so views / interactions are the lifetime counters of
--   the videos PUBLISHED in each bucket (the business timezone), and growth is
--   the difference between stored follower snapshots. A bucket with no video or
--   no snapshot pair is absent, never zero. The period end is exclusive. Every
--   enabled TikTok video counts, independently of the posts table's row limit.
--
-- IDEMPOTENT: `create or replace`. No data is written.
--
-- Requires: 70_social.sql, 85_tiktok.sql.
-- ============================================================================

create or replace function public.insights_tiktok_post_series(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_grain text
)
returns table (
  kind text,
  account_id uuid,
  bucket timestamp,
  views bigint,
  engagement bigint,
  posts bigint,
  growth bigint
)
language sql
stable
set search_path = ''
as $$
  with videos as (
    select
      a.kind,
      a.id as account_id,
      pg_catalog.date_trunc(case when p_grain in ('day', 'week', 'month', 'hour') then p_grain else 'day' end, p.published_at at time zone p_tz) as bucket,
      sum(p.views)::bigint as views,
      sum(p.engagement)::bigint as engagement,
      count(*)::bigint as posts
    from public.social_posts p
    join public.social_accounts a on a.id = p.account_id and a.shop_id = p.shop_id and a.enabled
    where p.shop_id = p_shop
      and a.kind = 'tiktok'
      and p.published_at >= (p_from at time zone p_tz)
      and p.published_at < (p_to at time zone p_tz)
    group by a.kind, a.id, 3
  ),
  -- Snapshots before the range are read so the first bucket's change has a
  -- predecessor. A first-ever snapshot establishes no growth (lag is null).
  snapshots as (
    select
      a.id as account_id,
      d.day,
      d.followers - lag(d.followers) over (partition by a.id order by d.day) as growth
    from public.social_account_days d
    join public.social_accounts a on a.id = d.account_id and a.shop_id = d.shop_id and a.enabled
    where d.shop_id = p_shop
      and a.kind = 'tiktok'
      and d.followers is not null
      and d.day < p_to::date
  ),
  follower_changes as (
    select
      s.account_id,
      pg_catalog.date_trunc(case when p_grain in ('day', 'week', 'month', 'hour') then p_grain else 'day' end, s.day::timestamp) as bucket,
      sum(s.growth)::bigint as growth
    from snapshots s
    where s.day >= p_from::date
    group by s.account_id, 2
  )
  select 'tiktok'::text, coalesce(v.account_id, f.account_id), coalesce(v.bucket, f.bucket), v.views, v.engagement, v.posts, f.growth
  from videos v
  full join follower_changes f on f.account_id = v.account_id and f.bucket = v.bucket;
$$;

revoke all on function public.insights_tiktok_post_series(uuid, timestamp, timestamp, text, text) from public, anon, authenticated;
grant execute on function public.insights_tiktok_post_series(uuid, timestamp, timestamp, text, text) to service_role;

comment on function public.insights_tiktok_post_series(uuid, timestamp, timestamp, text, text) is
  'TikTok lifetime views / interactions of the videos published in each bucket, plus follower-snapshot differences. Not daily account activity: TikTok supplies none.';
