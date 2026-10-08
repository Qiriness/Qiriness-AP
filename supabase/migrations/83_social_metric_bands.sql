-- ============================================================================
-- 83 — SOCIAL METRIC BANDS: LOW / MEDIUM / HIGH PER PLATFORM AND METRIC
--
-- WHAT THIS ADDS.
--   `social_metric_bands` — one row per shop, platform kind and post metric:
--     how a number is measured (`mode`) and the two limits that cut it into
--     low (below `low`), medium, and high (`high` and above):
--       off        no colour for this metric
--       absolute   the metric itself (a count; a % for the engagement rate)
--       followers  the metric as a % of the account's followers
--       median     the metric as a % of the median of that platform's posts
--                  in the period
--     A metric with no row uses the app's suggested rule (social-bands.mjs).
--     Deleting a platform's rows restores the suggestions.
--
-- IDEMPOTENT: `if not exists`. No data is written.
--
-- Requires: 01_foundation (shops).
-- ============================================================================

create table if not exists public.social_metric_bands (
  shop_id uuid not null references public.shops(id) on delete cascade,
  kind text not null,
  metric text not null,
  mode text not null,
  low numeric,
  high numeric,
  updated_at timestamptz not null default now(),
  primary key (shop_id, kind, metric),
  constraint social_metric_bands_kind_check check (kind in ('instagram', 'facebook')),
  constraint social_metric_bands_metric_check check (metric in ('views', 'reach', 'engagement', 'engagementRate', 'likes', 'comments', 'shares', 'follows')),
  constraint social_metric_bands_mode_check check (mode in ('off', 'absolute', 'followers', 'median')),
  constraint social_metric_bands_limits_check check (
    mode = 'off' or (low is not null and high is not null and low >= 0 and low <= high)
  )
);

alter table public.social_metric_bands enable row level security;
revoke all on public.social_metric_bands from anon, authenticated;

comment on table public.social_metric_bands is
  'The team''s low / medium / high limits for a post metric, per platform: below low is low, high and above is high. mode says what the limits are relative to: nothing (off), the number itself, the account''s followers, or the median post.';
