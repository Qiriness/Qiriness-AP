-- ============================================================================
-- 90 — SOCIAL BANDS: NON-FOLLOWERS AS A BANDED POST METRIC
--
-- WHAT THIS ADDS. `nonFollowersPct` joins the metrics a colour rule can be set
--   on. Modes: off, absolute (percentage points, 0-100) or median (relative to
--   the platform's posts). "% of followers" is refused: the metric is already a
--   percentage. Existing rules are kept.
--
-- IDEMPOTENT. Requires: 83_social_metric_bands.sql.
-- ============================================================================

alter table public.social_metric_bands drop constraint if exists social_metric_bands_metric_check;
alter table public.social_metric_bands
  add constraint social_metric_bands_metric_check check (
    metric in ('views', 'reach', 'engagement', 'engagementRate', 'likes', 'comments', 'shares', 'follows', 'nonFollowersPct')
  );

alter table public.social_metric_bands drop constraint if exists social_metric_bands_non_followers_check;
alter table public.social_metric_bands
  add constraint social_metric_bands_non_followers_check check (
    metric <> 'nonFollowersPct' or (mode <> 'followers' and (mode <> 'absolute' or high <= 100))
  );
