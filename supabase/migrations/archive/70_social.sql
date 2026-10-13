-- ============================================================================
-- 70 — SOCIAL AND PAID MEDIA: META (INSTAGRAM, FACEBOOK, META ADS) AND GOOGLE ADS
--
-- WHAT THIS ADDS.
--   `social_connections` — one row per shop and provider (meta | google): which
--     Vault secret holds the OAuth token, when it expires, and how the last
--     sync went. The token itself is never a column.
--   `social_accounts` — what that token can see, found when it connects: an
--     Instagram account, a Facebook Page, a Meta ad account, a Google Ads
--     customer. `enabled` is the team's choice of what to track; everything is
--     tracked until someone says otherwise.
--   `social_account_days` — per organic account and day (the platform's
--     clock): views, engagement, profile visits, link taps, follows gained and
--     lost, posts published, and the follower count that day. COUNTS THAT ADD
--     UP ACROSS DAYS ONLY. Reach and accounts engaged are unique people and do
--     not add up, so they are not stored per day: the panel reads them live
--     for ranges the platform can answer, and shows a dash beyond.
--   `social_posts` — per post: when, what type, a caption excerpt, and its
--     lifetime counts (views, reach, likes, comments, shares, saves, follows,
--     engagement). Post reach IS stored: it is one post's lifetime figure.
--   `social_audience` — aggregated follower demographics (gender, age,
--     country, city), one snapshot per account and day it was read.
--   `ad_days` — per ad account, day and publisher: spend, impressions, clicks,
--     conversions and conversion value, in the account's currency.
--   Three key functions (`social_save_token`, `_read_token`, `_clear_token`,
--   service role only) and five reads.
--
-- A NULL IS "NOT MEASURED", NEVER ZERO. A metric the platform did not answer
-- for an account stays null, sums of nulls stay null, and the panel draws a
-- dash with its reason. Same rule as the delivery tiles.
--
-- COUNTS ONLY. Engagement rate, CTR, CPC, CPA and ROAS are rebuilt from the
-- counts at read time, like Klaviyo's rates.
--
-- PLUS ONE WIDENED CHECK: `mail_jobs.kind` accepts `sync_social`, the job the
-- dashboard queues when a provider is connected or « Sync now » is pressed.
-- The clause is copied from 04_support.sql and 46_mail_jobs.sql, which declare
-- it too (70_social.test.mjs asserts the three agree).
--
-- IDEMPOTENT: `if not exists`, `create or replace`, and the check is dropped and
-- re-added under its own name. No data is written.
--
-- Requires: 01_foundation.sql (shops, set_updated_at), 46_mail_jobs.sql.
-- ============================================================================

create table if not exists public.social_connections (
  shop_id uuid not null references public.shops(id) on delete cascade,
  provider text not null,
  secret_id uuid not null,
  -- Meta's long-lived user token lasts about 60 days; Google's refresh token
  -- has no expiry. Null when the provider gives none.
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  -- Meta only: the action type counted as a conversion. Null reads as Meta's
  -- own « Purchases » column (social-sync.mjs DEFAULT_META_CONVERSION_ACTION).
  conversion_action text,
  connected_at timestamptz not null default now(),
  connected_by uuid,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  primary key (shop_id, provider),
  constraint social_connections_provider_check check (provider in ('meta', 'google')),
  constraint social_connections_status_check check (last_sync_status is null or last_sync_status in ('ok', 'failed', 'needs_reconnect'))
);

alter table public.social_connections enable row level security;
revoke all on public.social_connections from anon, authenticated;

comment on table public.social_connections is
  'One row per shop and provider (meta | google) connected through OAuth. The token is in vault.secrets (secret_id), never in a column. last_sync_status needs_reconnect means the provider refused the token.';

create table if not exists public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  provider text not null,
  kind text not null,
  external_id text not null,
  name text,
  handle text,
  currency text,
  -- Google Ads: the manager account the customer is reached through, sent as
  -- login-customer-id. Null when the customer is reached directly.
  login_customer_id text,
  enabled boolean not null default true,
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_accounts_provider_check check (provider in ('meta', 'google')),
  constraint social_accounts_kind_check check (kind in ('instagram', 'facebook', 'meta_ads', 'google_ads')),
  constraint social_accounts_external_unique unique (shop_id, kind, external_id)
);

drop trigger if exists social_accounts_set_updated_at on public.social_accounts;
create trigger social_accounts_set_updated_at
before update on public.social_accounts
for each row
execute function public.set_updated_at();

alter table public.social_accounts enable row level security;
revoke all on public.social_accounts from anon, authenticated;

comment on table public.social_accounts is
  'The accounts a social connection can see, found when it connects: instagram, facebook (a Page), meta_ads, google_ads. enabled is the team''s choice of what to track; every read skips a disabled account.';

create table if not exists public.social_account_days (
  account_id uuid not null references public.social_accounts(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  day date not null,
  followers bigint,
  follows bigint,
  unfollows bigint,
  views bigint,
  engagement bigint,
  profile_visits bigint,
  link_taps bigint,
  posts bigint,
  fetched_at timestamptz not null default now(),
  primary key (account_id, day)
);

create index if not exists social_account_days_shop_day_idx on public.social_account_days (shop_id, day);

alter table public.social_account_days enable row level security;
revoke all on public.social_account_days from anon, authenticated;

comment on table public.social_account_days is
  'Organic account figures per day (the platform''s clock). Only counts that add up across days; null is not measured. followers is that day''s total. The trailing days are rewritten each sync.';

create table if not exists public.social_posts (
  account_id uuid not null references public.social_accounts(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  external_id text not null,
  published_at timestamptz not null,
  media_type text,
  caption_excerpt text,
  permalink text,
  thumbnail_url text,
  views bigint,
  reach bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  saves bigint,
  follows bigint,
  engagement bigint,
  fetched_at timestamptz not null default now(),
  primary key (account_id, external_id),
  constraint social_posts_caption_check check (caption_excerpt is null or char_length(caption_excerpt) <= 140)
);

create index if not exists social_posts_shop_published_idx on public.social_posts (shop_id, published_at);

alter table public.social_posts enable row level security;
revoke all on public.social_posts from anon, authenticated;

comment on table public.social_posts is
  'One row per published post with its lifetime counts. Posts of the last 90 days are re-read each sync, because their counts still grow. Counts only: no comment text and no commenter is ever fetched.';

create table if not exists public.social_audience (
  account_id uuid not null references public.social_accounts(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  captured_on date not null,
  dimension text not null,
  key text not null,
  value bigint not null,
  primary key (account_id, captured_on, dimension, key),
  constraint social_audience_dimension_check check (dimension in ('gender', 'age', 'country', 'city'))
);

alter table public.social_audience enable row level security;
revoke all on public.social_audience from anon, authenticated;

comment on table public.social_audience is
  'Aggregated follower demographics as the platform reports them (a count per bucket), one snapshot per account and day read. Never about an individual.';

create table if not exists public.ad_days (
  account_id uuid not null references public.social_accounts(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  day date not null,
  publisher text not null,
  currency text not null,
  spend numeric(14, 2) not null default 0,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  conversions numeric(14, 2) not null default 0,
  conversion_value numeric(14, 2) not null default 0,
  fetched_at timestamptz not null default now(),
  primary key (account_id, day, publisher),
  constraint ad_days_publisher_check check (publisher in (
    'facebook', 'instagram', 'audience_network', 'messenger', 'threads',
    'google_search', 'google_display', 'youtube', 'google_other', 'other'
  ))
);

create index if not exists ad_days_shop_day_idx on public.ad_days (shop_id, day);

alter table public.ad_days enable row level security;
revoke all on public.ad_days from anon, authenticated;

comment on table public.ad_days is
  'Paid media per ad account, day (the ad account''s clock) and publisher, in the account''s currency. Conversions and their value are the platform''s own attribution. The last 28 days are rewritten each sync, because attribution settles late.';

-- --- the token -------------------------------------------------------------------

create or replace function public.social_save_token(
  p_shop uuid,
  p_provider text,
  p_token text,
  p_expires_at timestamptz default null,
  p_scopes text[] default '{}',
  p_connected_by uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  select c.secret_id into v_secret from public.social_connections c where c.shop_id = p_shop and c.provider = p_provider;
  if v_secret is not null and exists (select 1 from vault.secrets s where s.id = v_secret) then
    perform vault.update_secret(v_secret, p_token);
  else
    v_secret := vault.create_secret(p_token, 'social_token:' || p_provider || ':' || p_shop::text || ':' || gen_random_uuid()::text, p_provider || ' OAuth token');
  end if;

  insert into public.social_connections as c (shop_id, provider, secret_id, token_expires_at, scopes, connected_at, connected_by)
  values (p_shop, p_provider, v_secret, p_expires_at, coalesce(p_scopes, '{}'), now(), p_connected_by)
  on conflict (shop_id, provider) do update
    set secret_id = excluded.secret_id,
        token_expires_at = excluded.token_expires_at,
        scopes = excluded.scopes,
        connected_at = excluded.connected_at,
        connected_by = excluded.connected_by,
        last_sync_status = case when c.last_sync_status = 'needs_reconnect' then null else c.last_sync_status end,
        last_sync_error = null;
end;
$$;

create or replace function public.social_read_token(p_shop uuid, p_provider text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select d.decrypted_secret
  from public.social_connections c
  join vault.decrypted_secrets d on d.id = c.secret_id
  where c.shop_id = p_shop and c.provider = p_provider;
$$;

create or replace function public.social_clear_token(p_shop uuid, p_provider text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  delete from public.social_connections c where c.shop_id = p_shop and c.provider = p_provider returning c.secret_id into v_secret;
  if v_secret is not null then
    delete from vault.secrets s where s.id = v_secret;
  end if;
end;
$$;

revoke all on function public.social_save_token(uuid, text, text, timestamptz, text[], uuid) from public, anon, authenticated;
revoke all on function public.social_read_token(uuid, text) from public, anon, authenticated;
revoke all on function public.social_clear_token(uuid, text) from public, anon, authenticated;
grant execute on function public.social_save_token(uuid, text, text, timestamptz, text[], uuid) to service_role;
grant execute on function public.social_read_token(uuid, text) to service_role;
grant execute on function public.social_clear_token(uuid, text) to service_role;

comment on function public.social_save_token(uuid, text, text, timestamptz, text[], uuid) is
  'Stores (or replaces) a provider''s OAuth token for the shop in Vault and records the connection. Service role only.';
comment on function public.social_read_token(uuid, text) is
  'The shop''s decrypted token for one provider, for the sync. Service role only; never returned to a browser.';
comment on function public.social_clear_token(uuid, text) is
  'Deletes a provider''s token from Vault and its connection row. Accounts and synced figures are kept.';

-- --- the reads ---------------------------------------------------------------------
--
-- Same range convention as every insights_* function: wall-clock timestamps,
-- half-open. A day row is a whole day on the platform's clock, so a range reads
-- the days it touches, like Klaviyo's flow days. Disabled accounts are skipped.

-- Organic figures per account and bucket. `sum` of nulls stays null: a metric
-- never measured in the bucket is missing, not zero. The grain is the panel's;
-- an hourly range buckets by day because nothing finer is stored.
create or replace function public.insights_social_series(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_grain text
)
returns table (
  kind text,
  account_id uuid,
  bucket timestamp,
  views bigint,
  engagement bigint,
  profile_visits bigint,
  link_taps bigint,
  follows bigint,
  unfollows bigint,
  posts bigint,
  days_measured bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    a.kind,
    a.id,
    date_trunc(case when p_grain = 'hour' then 'day' else p_grain end, d.day::timestamp),
    sum(d.views)::bigint,
    sum(d.engagement)::bigint,
    sum(d.profile_visits)::bigint,
    sum(d.link_taps)::bigint,
    sum(d.follows)::bigint,
    sum(d.unfollows)::bigint,
    sum(d.posts)::bigint,
    count(*)::bigint
  from public.social_account_days d
  join public.social_accounts a on a.id = d.account_id and a.enabled
  where d.shop_id = p_shop
    and d.day >= p_from::date
    and d.day::timestamp < p_to
  group by a.kind, a.id, 3;
$$;

-- The follower count at each end of a range: the last day measured inside it,
-- and the last day measured before it starts. Either may be null.
create or replace function public.insights_social_followers(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp
)
returns table (
  kind text,
  account_id uuid,
  followers_end bigint,
  end_day date,
  followers_start bigint,
  start_day date
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    a.kind,
    a.id,
    e.followers,
    e.day,
    s.followers,
    s.day
  from public.social_accounts a
  left join lateral (
    select d.followers, d.day
    from public.social_account_days d
    where d.account_id = a.id
      and d.followers is not null
      and d.day::timestamp < p_to
    order by d.day desc
    limit 1
  ) e on true
  left join lateral (
    select d.followers, d.day
    from public.social_account_days d
    where d.account_id = a.id
      and d.followers is not null
      and d.day < p_from::date
    order by d.day desc
    limit 1
  ) s on true
  where a.shop_id = p_shop
    and a.enabled
    and a.kind in ('instagram', 'facebook');
$$;

-- Posts published in the range, most viewed first, at most p_limit.
create or replace function public.insights_social_posts(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text,
  p_limit integer default 500
)
returns table (
  kind text,
  account_id uuid,
  external_id text,
  published_at timestamptz,
  media_type text,
  caption_excerpt text,
  permalink text,
  thumbnail_url text,
  views bigint,
  reach bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  saves bigint,
  follows bigint,
  engagement bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    a.kind,
    a.id,
    p.external_id,
    p.published_at,
    p.media_type,
    p.caption_excerpt,
    p.permalink,
    p.thumbnail_url,
    p.views,
    p.reach,
    p.likes,
    p.comments,
    p.shares,
    p.saves,
    p.follows,
    p.engagement
  from public.social_posts p
  join public.social_accounts a on a.id = p.account_id and a.enabled
  where p.shop_id = p_shop
    and p.published_at >= (p_from at time zone p_tz)
    and p.published_at < (p_to at time zone p_tz)
  order by p.views desc nulls last, p.published_at desc
  limit greatest(coalesce(p_limit, 500), 1);
$$;

-- Per account, over every post published in the range (not capped like the
-- list): how many, their views, and the engagement and reach of the posts that
-- carry BOTH — the engagement rate's numerator and denominator, so a post with
-- no reach figure cannot drag the rate.
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
  rated_reach bigint
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
    sum(p.reach) filter (where p.reach > 0 and p.engagement is not null)::bigint
  from public.social_posts p
  join public.social_accounts a on a.id = p.account_id and a.enabled
  where p.shop_id = p_shop
    and p.published_at >= (p_from at time zone p_tz)
    and p.published_at < (p_to at time zone p_tz)
  group by a.kind, a.id;
$$;

-- The newest demographics snapshot of each account. Not ranged: the platform
-- reports who follows now, not who followed in a period.
create or replace function public.insights_social_audience(p_shop uuid)
returns table (
  kind text,
  account_id uuid,
  captured_on date,
  dimension text,
  key text,
  value bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select a.kind, a.id, s.captured_on, s.dimension, s.key, s.value
  from public.social_accounts a
  join public.social_audience s on s.account_id = a.id
  where a.shop_id = p_shop
    and a.enabled
    and s.captured_on = (select max(x.captured_on) from public.social_audience x where x.account_id = a.id);
$$;

-- Paid media per account, publisher and bucket, in each account's currency.
-- Summing across currencies is the reader's decision, and it refuses to.
create or replace function public.insights_paid_series(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_grain text
)
returns table (
  kind text,
  account_id uuid,
  currency text,
  publisher text,
  bucket timestamp,
  spend numeric,
  impressions bigint,
  clicks bigint,
  conversions numeric,
  conversion_value numeric
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    a.kind,
    a.id,
    d.currency,
    d.publisher,
    date_trunc(case when p_grain = 'hour' then 'day' else p_grain end, d.day::timestamp),
    sum(d.spend),
    sum(d.impressions)::bigint,
    sum(d.clicks)::bigint,
    sum(d.conversions),
    sum(d.conversion_value)
  from public.ad_days d
  join public.social_accounts a on a.id = d.account_id and a.enabled
  where d.shop_id = p_shop
    and d.day >= p_from::date
    and d.day::timestamp < p_to
  group by a.kind, a.id, d.currency, d.publisher, 5;
$$;

revoke all on function public.insights_social_series(uuid, timestamp, timestamp, text) from public, anon, authenticated;
revoke all on function public.insights_social_followers(uuid, timestamp, timestamp) from public, anon, authenticated;
revoke all on function public.insights_social_posts(uuid, timestamp, timestamp, text, integer) from public, anon, authenticated;
revoke all on function public.insights_social_post_totals(uuid, timestamp, timestamp, text) from public, anon, authenticated;
revoke all on function public.insights_social_audience(uuid) from public, anon, authenticated;
revoke all on function public.insights_paid_series(uuid, timestamp, timestamp, text) from public, anon, authenticated;
grant execute on function public.insights_social_series(uuid, timestamp, timestamp, text) to service_role;
grant execute on function public.insights_social_followers(uuid, timestamp, timestamp) to service_role;
grant execute on function public.insights_social_posts(uuid, timestamp, timestamp, text, integer) to service_role;
grant execute on function public.insights_social_post_totals(uuid, timestamp, timestamp, text) to service_role;
grant execute on function public.insights_social_audience(uuid) to service_role;
grant execute on function public.insights_paid_series(uuid, timestamp, timestamp, text) to service_role;

comment on function public.insights_social_series(uuid, timestamp, timestamp, text) is
  'Organic counts per enabled account and bucket over a range. Null sums are not measured, never zero.';
comment on function public.insights_social_followers(uuid, timestamp, timestamp) is
  'Each organic account''s follower count on the last measured day inside the range and the last measured day before it.';
comment on function public.insights_social_posts(uuid, timestamp, timestamp, text, integer) is
  'Posts published in a range with their lifetime counts, most viewed first, capped at p_limit.';
comment on function public.insights_social_post_totals(uuid, timestamp, timestamp, text) is
  'Per account, every post published in a range: count, views, engagement, and engagement and reach over posts carrying both (the rate''s two halves).';
comment on function public.insights_social_audience(uuid) is
  'The newest follower-demographics snapshot of each enabled account.';
comment on function public.insights_paid_series(uuid, timestamp, timestamp, text) is
  'Paid media per enabled ad account, currency, publisher and bucket over a range. Never summed across currencies here.';

-- --- the job ----------------------------------------------------------------------

alter table public.mail_jobs
  drop constraint if exists mail_jobs_kind_check;

alter table public.mail_jobs
  add constraint mail_jobs_kind_check check (kind in ('sync_mailbox', 'send_outbound', 'sync_social'));
