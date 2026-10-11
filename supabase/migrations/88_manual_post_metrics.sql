-- ============================================================================
-- 88 — SOCIAL POSTS: MANUAL VALUES FOR ANY MISSING POST METRIC
--
-- WHAT THIS ADDS. `social_post_manual_metrics` — a value a person typed for a
--   post metric the platform did not give, keyed shop / account / post / metric.
--   The sync writes social_posts only, so an annotation survives every sync;
--   a provider value shown later takes precedence without deleting it.
--   An engagement rate carries the denominator (`basis`) it was entered against.
--
--   Replaces `social_posts.non_followers_pct` (84) as the store: existing values
--   are copied across, the column is left in place.
--
-- IDEMPOTENT. Requires: 70_social.sql, 84_post_non_followers.sql.
-- ============================================================================

-- The annotation references a post by (shop, account, external id); the post's
-- own key is (account, external id), so the shop-scoped key is added beside it.
create unique index if not exists social_posts_shop_account_external_key
  on public.social_posts (shop_id, account_id, external_id);

create table if not exists public.social_post_manual_metrics (
  shop_id uuid not null references public.shops(id) on delete cascade,
  account_id uuid not null,
  post_id text not null,
  metric text not null check (metric in ('views', 'reach', 'engagementRate', 'likes', 'comments', 'shares', 'follows', 'engagement', 'nonFollowersPct')),
  value numeric not null check (value >= 0 and value <= 9007199254740991),
  basis text check (basis in ('views', 'reach', 'followers')),
  updated_at timestamptz not null default now(),
  primary key (shop_id, account_id, post_id, metric),
  foreign key (shop_id, account_id, post_id) references public.social_posts (shop_id, account_id, external_id) on delete cascade,
  check ((metric = 'engagementRate' and basis is not null) or (metric <> 'engagementRate' and basis is null)),
  check (metric <> 'nonFollowersPct' or value <= 100),
  check (metric in ('engagementRate', 'nonFollowersPct') or value = trunc(value))
);

alter table public.social_post_manual_metrics enable row level security;
revoke all on public.social_post_manual_metrics from anon, authenticated;

insert into public.social_post_manual_metrics (shop_id, account_id, post_id, metric, value)
select shop_id, account_id, external_id, 'nonFollowersPct', non_followers_pct
from public.social_posts
where non_followers_pct is not null
on conflict do nothing;

comment on table public.social_post_manual_metrics is
  'Values a person typed for post metrics the platform did not give. Provider counters and sync stay separate in social_posts; a rate is specific to the denominator it was entered against.';
