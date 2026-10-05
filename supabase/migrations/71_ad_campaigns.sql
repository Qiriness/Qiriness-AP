-- ============================================================================
-- 71 — AD CAMPAIGNS: WHAT EACH META ADS / GOOGLE ADS CAMPAIGN SPENT AND EARNED
--
-- WHAT THIS ADDS.
--   `ad_campaigns` — one row per ad account and campaign: its name, status and
--     objective (Meta) / channel type (Google), as last read. Names change, so
--     they live here once rather than on every day.
--   `ad_campaign_days` — per ad account, campaign and day (the ad account's
--     clock): spend, impressions, clicks, conversions and conversion value, in
--     the account's currency. Same counts as `ad_days`, cut by campaign instead
--     of by publisher; the two are read side by side, never joined.
--   `insights_paid_campaigns` — the Paid view's campaign table: every campaign
--     with delivery in the range, summed, with what a link to it needs.
--
-- COUNTS ONLY, as in 70: CTR, CPC, CPA and ROAS are rebuilt by the reader.
--
-- IDEMPOTENT: `if not exists`, `create or replace`. No data is written.
--
-- Requires: 70_social.sql (social_accounts).
-- ============================================================================

create table if not exists public.ad_campaigns (
  account_id uuid not null references public.social_accounts(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  external_id text not null,
  name text,
  status text,
  objective text,
  fetched_at timestamptz not null default now(),
  primary key (account_id, external_id)
);

alter table public.ad_campaigns enable row level security;
revoke all on public.ad_campaigns from anon, authenticated;

comment on table public.ad_campaigns is
  'One row per ad account and campaign (Meta Ads, Google Ads): name, status, objective or channel type, as last read by the sync.';

create table if not exists public.ad_campaign_days (
  account_id uuid not null references public.social_accounts(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  campaign_id text not null,
  day date not null,
  currency text not null,
  spend numeric(14, 2) not null default 0,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  conversions numeric(14, 2) not null default 0,
  conversion_value numeric(14, 2) not null default 0,
  fetched_at timestamptz not null default now(),
  primary key (account_id, campaign_id, day)
);

create index if not exists ad_campaign_days_shop_day_idx on public.ad_campaign_days (shop_id, day);

alter table public.ad_campaign_days enable row level security;
revoke all on public.ad_campaign_days from anon, authenticated;

comment on table public.ad_campaign_days is
  'Paid media per ad account, campaign and day, in the account''s currency. Conversions are the platform''s own attribution. The last 28 days are rewritten each sync, like ad_days.';

-- Every campaign with a day in the range, summed, biggest spend first. Carries
-- the account's kind, platform id and manager id: what the campaign link needs.
create or replace function public.insights_paid_campaigns(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_limit integer default 200
)
returns table (
  kind text,
  account_id uuid,
  account_external_id text,
  account_name text,
  login_customer_id text,
  campaign_id text,
  name text,
  status text,
  objective text,
  currency text,
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
    a.external_id,
    a.name,
    a.login_customer_id,
    d.campaign_id,
    c.name,
    c.status,
    c.objective,
    d.currency,
    sum(d.spend),
    sum(d.impressions)::bigint,
    sum(d.clicks)::bigint,
    sum(d.conversions),
    sum(d.conversion_value)
  from public.ad_campaign_days d
  join public.social_accounts a on a.id = d.account_id and a.enabled
  left join public.ad_campaigns c on c.account_id = d.account_id and c.external_id = d.campaign_id
  where d.shop_id = p_shop
    and d.day >= p_from::date
    and d.day::timestamp < p_to
  group by a.kind, a.id, a.external_id, a.name, a.login_customer_id, d.campaign_id, c.name, c.status, c.objective, d.currency
  order by sum(d.spend) desc, sum(d.impressions) desc
  limit greatest(coalesce(p_limit, 200), 1);
$$;

revoke all on function public.insights_paid_campaigns(uuid, timestamp, timestamp, integer) from public, anon, authenticated;
grant execute on function public.insights_paid_campaigns(uuid, timestamp, timestamp, integer) to service_role;

comment on function public.insights_paid_campaigns(uuid, timestamp, timestamp, integer) is
  'Campaigns of enabled ad accounts with delivery in a range, summed per campaign and currency, biggest spend first, capped at p_limit.';
