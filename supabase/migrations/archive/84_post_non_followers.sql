-- ============================================================================
-- 84 — SOCIAL POSTS: THE SHARE OF NON-FOLLOWERS REACHED, ENTERED BY HAND
--
-- WHAT THIS ADDS.
--   `social_posts.non_followers_pct` — the percentage (0–100) of the people a
--     post reached who do not follow the account. Null = not entered.
--
-- WHY BY HAND. Meta refuses the follower breakdown for every post metric
-- (« Incompatible breakdowns (follow_type) », tried on reels and feed posts,
-- API v21–v25), but Instagram's app shows the figure per post. A person copies
-- it from there. The sync never writes this column: its post upserts name their
-- columns, so a sync cannot overwrite an entry.
--
-- IDEMPOTENT. No data is written.
--
-- Requires: 70_social.sql.
-- ============================================================================

alter table public.social_posts add column if not exists non_followers_pct numeric;

alter table public.social_posts drop constraint if exists social_posts_non_followers_pct_check;
alter table public.social_posts
  add constraint social_posts_non_followers_pct_check check (non_followers_pct is null or (non_followers_pct >= 0 and non_followers_pct <= 100));

comment on column public.social_posts.non_followers_pct is
  'Percent (0-100) of the people the post reached who do not follow the account, typed in by the team from the platform''s own app: the API does not give it per post. Never written by a sync.';
