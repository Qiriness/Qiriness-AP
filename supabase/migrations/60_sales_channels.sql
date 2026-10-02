-- ============================================================================
-- 60 — THE MARKETPLACES BECOME DATA
--
-- `sales_channels`: one row per marketplace the shop sells on, a name and the
-- Shopify sales channel handles behind it. Every handle not listed is the
-- shop's own store.
--
-- WHY. The list was this shop's, written into code (`MARKETPLACE_CHANNELS`),
-- into SQL (`array['amazon', 'connect-dev-1']` below, in 21) and into a dozen
-- UI sentences. Deployed for another shop it would have described the wrong
-- marketplaces. Edited in Setup -> Sales channels.
--
-- ALSO HERE: `chat.vip_customer_rows()` reads the handles from the table rather
-- than from a literal, and the three chat schema comments that named Amazon
-- and Yves Rocher no longer do (the chat model reads them; its instructions
-- now list the shop's marketplaces).
--
-- NO DATA IS WRITTEN. A shop with no rows has no marketplaces: every order is
-- its own store's. COPIED FROM 02_shopify.sql (60_sales_channels.test.mjs
-- asserts they agree). IDEMPOTENT.
--
-- Requires: 02_shopify.sql, 17_management_chat.sql, 21_chat_vip.sql.
-- ============================================================================

create table if not exists public.sales_channels (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- The platform's id in URLs and filters (`?platform=amazon`). Never changes.
  platform_key text not null,
  -- What the dashboard and the agents call it.
  label text not null,
  -- The Shopify sales channel handles that make up this marketplace.
  handles text[] not null default '{}',
  -- The names Shopify Analytics (ShopifyQL `sales_channel`) gives the same
  -- marketplace, lower case: « marketplace connect », « mirakl connect ».
  analytics_names text[] not null default '{}',
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_channels_key_shape_check check (
    platform_key ~ '^[a-z][a-z0-9_]{1,40}$' and platform_key not in ('all', 'shopify')
  )
);

create unique index if not exists sales_channels_shop_key_unique
  on public.sales_channels (shop_id, platform_key);

drop trigger if exists sales_channels_set_updated_at on public.sales_channels;
create trigger sales_channels_set_updated_at
before update on public.sales_channels
for each row
execute function public.set_updated_at();

alter table public.sales_channels enable row level security;

comment on table public.sales_channels is
  'The marketplaces this shop sells on: a name and the Shopify sales channel handles behind it. Every handle not listed is the shop''s own store. Marketplaces mint one customer per order, so their buyers are left out of every per-person figure. Edited in Setup -> Sales channels.';

-- The VIP rule excludes the shop's marketplaces, read from the table. Same
-- signature, grants and security as 21; only the handles' source changed.
create or replace function chat.vip_customer_rows()
returns table (
  customer_id uuid,
  orders_in_window bigint,
  net_spend_in_window numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select v.customer_id, v.orders, v.spend
  from public.shops s
  cross join lateral public.vip_customers(
    s.id,
    s.vip_min_spend,
    s.vip_min_orders,
    s.vip_window_months,
    coalesce(
      (select array_agg(h) from public.sales_channels c cross join lateral unnest(c.handles) h where c.shop_id = s.id),
      '{}'::text[]
    )
  ) v
  where s.vip_min_spend is not null
    and s.vip_min_orders is not null
    and s.vip_window_months is not null;
$$;

revoke all on function chat.vip_customer_rows() from public, anon, authenticated;
grant execute on function chat.vip_customer_rows() to mgmt_chat_ro;

comment on column chat.orders.channel is
  'Stable sales channel handle: web = Online Store, shopify-draft-orders = Draft Orders, shop-72 = Shop app; the marketplace handles are listed in your instructions.';
comment on column chat.orders.tags is
  'Merchant tags. Marketplace orders may carry the marketplace''s own tag.';
comment on view chat.customers is
  'One row per Shopify customer, as they are NOW (a snapshot, not a history: past states cannot be reconstructed). Marketplace orders (the handles listed in your instructions) create one synthetic customer per order, so exclude customers whose orders are all on those channels from any per-person metric.';
comment on view chat.vip_customers is
  'One row per customer who is a VIP RIGHT NOW under the shop''s VIP rule (see chat.shop: net spend strictly above vip_min_spend AND strictly more than vip_min_orders orders, both inside the last vip_window_months; uncancelled orders; marketplace orders do not count). Empty when no rule is set. Join chat.customers on customer_id for country, lifetime spend or RFM group, and chat.orders / chat.tickets on customer_id. Current status only: who was a VIP in the past cannot be reconstructed.';
