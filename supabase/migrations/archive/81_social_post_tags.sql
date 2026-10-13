-- ============================================================================
-- 81 — SOCIAL POSTS: WHEN INSIGHTS WERE LAST READ, AND THE TEAM'S OWN TAGS
--
-- WHAT THIS ADDS.
--   `social_posts.insights_at` — when Meta last answered a post's insights.
--     Null means never: the sync reads those posts once whatever their age, a
--     capped number per sync. Until now only posts of the last 30 days (90 on
--     the first sync) were read, so a shop whose posts were all older than that
--     on connecting had no views, reach or engagement on any post.
--   `social_post_tags` — a shop's own labels for posts (« launch », « UGC »,
--     « promo »…), created by a person in the Posts table.
--   `social_post_tag_links` — which post carries which tag. A post can carry
--     several; removing a tag removes it from every post.
--
-- IDEMPOTENT: `if not exists`. No data is written.
--
-- Requires: 70_social.sql (social_posts).
-- ============================================================================

alter table public.social_posts add column if not exists insights_at timestamptz;

comment on column public.social_posts.insights_at is
  'When Meta last answered this post''s insights; null = never read. The sync reads never-read posts once, whatever their age.';

create table if not exists public.social_post_tags (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  constraint social_post_tags_name_check check (char_length(btrim(name)) between 1 and 40 and name = btrim(name))
);

create unique index if not exists social_post_tags_shop_name_idx on public.social_post_tags (shop_id, lower(name));

alter table public.social_post_tags enable row level security;
revoke all on public.social_post_tags from anon, authenticated;

comment on table public.social_post_tags is
  'A shop''s own labels for social posts, created by a person in Insights → Social media → Posts. Names are unique per shop, ignoring case.';

create table if not exists public.social_post_tag_links (
  tag_id uuid not null references public.social_post_tags(id) on delete cascade,
  account_id uuid not null,
  external_id text not null,
  shop_id uuid not null references public.shops(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (tag_id, account_id, external_id),
  foreign key (account_id, external_id) references public.social_posts(account_id, external_id) on delete cascade
);

create index if not exists social_post_tag_links_post_idx on public.social_post_tag_links (account_id, external_id);
create index if not exists social_post_tag_links_shop_idx on public.social_post_tag_links (shop_id);

alter table public.social_post_tag_links enable row level security;
revoke all on public.social_post_tag_links from anon, authenticated;

comment on table public.social_post_tag_links is
  'Which social post carries which of the shop''s tags. Deleting a tag or a post deletes its links.';
