-- ============================================================================
-- 39 — KLAVIYO: THE PRIVATE KEY, AND WHAT EACH FLOW AND CAMPAIGN EARNED
--
-- WHAT THIS ADDS.
--   `klaviyo_connections` — one row per shop: which Vault secret holds the
--     Klaviyo private key, its last four characters (the only part ever shown
--     again), the "Placed Order" metric revenue is counted on, and how the
--     last sync went.
--   `klaviyo_flow_days` — one row per shop, flow and day (Klaviyo's account
--     clock): recipients, delivered, unique opens, unique clicks, unique
--     conversions and conversion value, summed over the flow's messages and
--     channels. A flow sends every day, so its figures are kept per day and
--     any Insights range sums them.
--   `klaviyo_campaigns` — one row per shop and campaign: its send time and the
--     same counts, as Klaviyo reports them for the campaign as a whole. A
--     campaign is sent once, so a range selects it by send time.
--   Four functions: `klaviyo_save_key`, `klaviyo_read_key`, `klaviyo_clear_key`
--   (the only way to touch the key) and `insights_klaviyo_messages` (the
--   Marketing card's read).
--
-- THE KEY IS IN SUPABASE VAULT, NOT IN A COLUMN. It is typed on /settings and
-- read by the nightly sync on GitHub Actions, so it has to live in the
-- database — but encrypted at rest, and out of reach of anything but the
-- service role. The three key functions are SECURITY DEFINER with a fixed
-- search_path, executable by service_role only; the table stores the secret's
-- id, never its value.
--
-- COUNTS ONLY, BECAUSE ONLY THOSE ADD UP. Click rate, conversion rate and
-- revenue per recipient are rebuilt from the counts at read time, the way
-- storefront_session_months stores sessions and not conversion.
--
-- IDEMPOTENT: `if not exists` and `create or replace`. No data is written.
--
-- Requires: 01_foundation.sql (shops).
-- ============================================================================

create table if not exists public.klaviyo_connections (
  shop_id uuid primary key references public.shops(id) on delete cascade,
  secret_id uuid not null,
  key_hint text not null,
  conversion_metric_id text,
  saved_at timestamptz not null default now(),
  saved_by uuid,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  constraint klaviyo_connections_hint_check check (char_length(key_hint) <= 8),
  constraint klaviyo_connections_status_check check (last_sync_status is null or last_sync_status in ('ok', 'failed'))
);

alter table public.klaviyo_connections enable row level security;
revoke all on public.klaviyo_connections from anon, authenticated;

comment on table public.klaviyo_connections is
  'One row per shop connected to Klaviyo. The private key itself is in vault.secrets (secret_id); key_hint is its last four characters, the only part ever shown again.';

create table if not exists public.klaviyo_flow_days (
  shop_id uuid not null references public.shops(id) on delete cascade,
  flow_id text not null,
  day date not null,
  flow_name text,
  recipients bigint not null default 0,
  delivered bigint not null default 0,
  opens_unique bigint not null default 0,
  clicks_unique bigint not null default 0,
  conversions bigint not null default 0,
  conversion_value numeric(14, 2) not null default 0,
  fetched_at timestamptz not null default now(),
  primary key (shop_id, flow_id, day)
);

alter table public.klaviyo_flow_days enable row level security;
revoke all on public.klaviyo_flow_days from anon, authenticated;

comment on table public.klaviyo_flow_days is
  'Klaviyo flow performance per day (Klaviyo account clock), summed over the flow''s messages and channels. The last 60 days are rewritten nightly, because conversions keep arriving after a send.';

create table if not exists public.klaviyo_campaigns (
  shop_id uuid not null references public.shops(id) on delete cascade,
  campaign_id text not null,
  name text,
  channel text,
  send_time timestamptz,
  recipients bigint not null default 0,
  delivered bigint not null default 0,
  opens_unique bigint not null default 0,
  clicks_unique bigint not null default 0,
  conversions bigint not null default 0,
  conversion_value numeric(14, 2) not null default 0,
  fetched_at timestamptz not null default now(),
  primary key (shop_id, campaign_id)
);

create index if not exists klaviyo_campaigns_send_time_idx on public.klaviyo_campaigns (shop_id, send_time);

alter table public.klaviyo_campaigns enable row level security;
revoke all on public.klaviyo_campaigns from anon, authenticated;

comment on table public.klaviyo_campaigns is
  'Klaviyo campaign performance, one row per campaign, as Klaviyo reports it for the campaign as a whole. Campaigns sent in the last year are rewritten nightly.';

-- --- the key -------------------------------------------------------------------

create or replace function public.klaviyo_save_key(
  p_shop uuid,
  p_key text,
  p_hint text,
  p_metric_id text,
  p_saved_by uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  select c.secret_id into v_secret from public.klaviyo_connections c where c.shop_id = p_shop;
  if v_secret is not null and exists (select 1 from vault.secrets s where s.id = v_secret) then
    perform vault.update_secret(v_secret, p_key);
  else
    v_secret := vault.create_secret(p_key, 'klaviyo_private_key:' || p_shop::text || ':' || gen_random_uuid()::text, 'Klaviyo private API key');
  end if;

  insert into public.klaviyo_connections as c (shop_id, secret_id, key_hint, conversion_metric_id, saved_at, saved_by)
  values (p_shop, v_secret, p_hint, p_metric_id, now(), p_saved_by)
  on conflict (shop_id) do update
    set secret_id = excluded.secret_id,
        key_hint = excluded.key_hint,
        conversion_metric_id = excluded.conversion_metric_id,
        saved_at = excluded.saved_at,
        saved_by = excluded.saved_by,
        last_sync_error = null;
end;
$$;

create or replace function public.klaviyo_read_key(p_shop uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select d.decrypted_secret
  from public.klaviyo_connections c
  join vault.decrypted_secrets d on d.id = c.secret_id
  where c.shop_id = p_shop;
$$;

create or replace function public.klaviyo_clear_key(p_shop uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  delete from public.klaviyo_connections c where c.shop_id = p_shop returning c.secret_id into v_secret;
  if v_secret is not null then
    delete from vault.secrets s where s.id = v_secret;
  end if;
end;
$$;

revoke all on function public.klaviyo_save_key(uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.klaviyo_read_key(uuid) from public, anon, authenticated;
revoke all on function public.klaviyo_clear_key(uuid) from public, anon, authenticated;
grant execute on function public.klaviyo_save_key(uuid, text, text, text, uuid) to service_role;
grant execute on function public.klaviyo_read_key(uuid) to service_role;
grant execute on function public.klaviyo_clear_key(uuid) to service_role;

comment on function public.klaviyo_save_key(uuid, text, text, text, uuid) is
  'Stores (or replaces) the shop''s Klaviyo private key in Vault and records the connection. Service role only.';
comment on function public.klaviyo_read_key(uuid) is
  'The shop''s decrypted Klaviyo private key, for the sync. Service role only; never returned to a browser.';
comment on function public.klaviyo_clear_key(uuid) is
  'Deletes the shop''s Klaviyo key from Vault and the connection row. Synced figures are kept.';

-- --- the read ------------------------------------------------------------------

-- One row per flow and per campaign with anything in the range. Flows sum
-- their days; a campaign is in the range when it was SENT in it. Same range
-- convention as every insights_* function: wall-clock timestamps, half-open,
-- in p_tz. A flow day is a whole day, so a 24-hour range reads the days it
-- touches.
create or replace function public.insights_klaviyo_messages(
  p_shop uuid,
  p_from timestamp,
  p_to timestamp,
  p_tz text
)
returns table (
  kind text,
  id text,
  name text,
  sent_at timestamptz,
  recipients bigint,
  delivered bigint,
  opens_unique bigint,
  clicks_unique bigint,
  conversions bigint,
  conversion_value numeric
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    'flow'::text,
    f.flow_id,
    (array_agg(f.flow_name order by f.day desc) filter (where f.flow_name is not null))[1],
    null::timestamptz,
    sum(f.recipients)::bigint,
    sum(f.delivered)::bigint,
    sum(f.opens_unique)::bigint,
    sum(f.clicks_unique)::bigint,
    sum(f.conversions)::bigint,
    sum(f.conversion_value)
  from public.klaviyo_flow_days f
  where f.shop_id = p_shop
    and f.day >= p_from::date
    and f.day::timestamp < p_to
  group by f.flow_id
  union all
  select
    'campaign'::text,
    c.campaign_id,
    c.name,
    c.send_time,
    c.recipients,
    c.delivered,
    c.opens_unique,
    c.clicks_unique,
    c.conversions,
    c.conversion_value
  from public.klaviyo_campaigns c
  where c.shop_id = p_shop
    and c.send_time >= (p_from at time zone p_tz)
    and c.send_time < (p_to at time zone p_tz);
$$;

revoke all on function public.insights_klaviyo_messages(uuid, timestamp, timestamp, text) from public, anon, authenticated;
grant execute on function public.insights_klaviyo_messages(uuid, timestamp, timestamp, text) to service_role;

comment on function public.insights_klaviyo_messages(uuid, timestamp, timestamp, text) is
  'Klaviyo flows (summed over their days) and campaigns (by send time) in a range: counts only, rates are computed by the reader.';
