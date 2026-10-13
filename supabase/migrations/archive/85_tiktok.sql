-- 85: TikTok organic accounts and rotating OAuth bundles in Vault.
-- Incremental; existing connections, tracking choices and history are retained.
begin;
alter table public.social_connections drop constraint if exists social_connections_provider_check;
alter table public.social_connections add constraint social_connections_provider_check check (provider in ('meta', 'google', 'tiktok'));
alter table public.social_accounts drop constraint if exists social_accounts_provider_check;
alter table public.social_accounts add constraint social_accounts_provider_check check (provider in ('meta', 'google', 'tiktok'));
alter table public.social_accounts drop constraint if exists social_accounts_kind_check;
alter table public.social_accounts add constraint social_accounts_kind_check check (kind in ('instagram', 'facebook', 'meta_ads', 'google_ads', 'tiktok'));
alter table public.social_metric_bands drop constraint if exists social_metric_bands_kind_check;
alter table public.social_metric_bands add constraint social_metric_bands_kind_check check (kind in ('instagram', 'facebook', 'tiktok'));

create or replace function public.social_refresh_token(p_shop uuid, p_provider text, p_token text, p_expires_at timestamptz)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_secret uuid;
begin
  select c.secret_id into v_secret from public.social_connections c
    where c.shop_id = p_shop and c.provider = p_provider for update;
  if v_secret is null then raise exception 'Connection unavailable'; end if;
  perform vault.update_secret(v_secret, p_token);
  update public.social_connections set token_expires_at = p_expires_at
    where shop_id = p_shop and provider = p_provider;
end;
$$;
revoke all on function public.social_refresh_token(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.social_refresh_token(uuid, text, text, timestamptz) to service_role;
comment on function public.social_refresh_token(uuid, text, text, timestamptz) is
  'Rotates a shop OAuth bundle in Vault without changing the connecting user or connection date. Service role only.';

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
    and a.kind in ('instagram', 'facebook', 'tiktok');
$$;
commit;
