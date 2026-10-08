-- ============================================================================
-- 82 — ENGAGEMENT RATE: WHICH DENOMINATOR EACH PLATFORM USES
--
-- WHAT THIS ADDS.
--   `social_accounts.engagement_basis` — `followers`, `reach` or `views`: what
--     interactions are divided by for this account's engagement rate. The team
--     picks one per platform on the Social media screen. Default `reach`, the
--     only rate the panel computed before this existed.
--   `insights_social_post_totals` gains three sums, so a rate by views and a
--     rate by followers can be pooled across posts as the rate by reach is:
--       engaged_posts          posts with a measured engagement
--       rated_views_engagement engagement of the posts carrying views > 0
--       rated_views            those posts' views
--     The function's result type changes, so it is dropped and recreated (same
--     arguments, same grants), and the existing columns keep their meaning.
--
-- IDEMPOTENT. No data is written.
--
-- Requires: 70_social.sql.
-- ============================================================================

alter table public.social_accounts add column if not exists engagement_basis text not null default 'reach';

alter table public.social_accounts drop constraint if exists social_accounts_engagement_basis_check;
alter table public.social_accounts
  add constraint social_accounts_engagement_basis_check check (engagement_basis in ('followers', 'reach', 'views'));

comment on column public.social_accounts.engagement_basis is
  'What interactions are divided by for this account''s engagement rate: followers, reach (default) or views. One per platform, chosen by the team.';

drop function if exists public.insights_social_post_totals(uuid, timestamp, timestamp, text);

create or replace function public.insights_social_post_totals(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text
)
returns table (
  kind text,
  account_id uuid,
  posts bigint,
  views bigint,
  engagement bigint,
  rated_engagement bigint,
  rated_reach bigint,
  engaged_posts bigint,
  rated_views_engagement bigint,
  rated_views bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    a.kind,
    a.id,
    count(*)::bigint,
    sum(p.views)::bigint,
    sum(p.engagement)::bigint,
    sum(p.engagement) filter (where p.reach > 0 and p.engagement is not null)::bigint,
    sum(p.reach) filter (where p.reach > 0 and p.engagement is not null)::bigint,
    (count(*) filter (where p.engagement is not null))::bigint,
    sum(p.engagement) filter (where p.views > 0 and p.engagement is not null)::bigint,
    sum(p.views) filter (where p.views > 0 and p.engagement is not null)::bigint
  from public.social_posts p
  join public.social_accounts a on a.id = p.account_id and a.enabled
  where p.shop_id = p_shop
    and p.published_at >= (p_from at time zone p_tz)
    and p.published_at < (p_to at time zone p_tz)
  group by a.kind, a.id;
$$;

revoke all on function public.insights_social_post_totals(uuid, timestamp, timestamp, text) from public, anon, authenticated;
grant execute on function public.insights_social_post_totals(uuid, timestamp, timestamp, text) to service_role;

comment on function public.insights_social_post_totals(uuid, timestamp, timestamp, text) is
  'Per account, every post published in a range: count, views, engagement, and the numerator and denominator of each engagement rate (by reach, by views; by followers needs only engaged_posts).';
