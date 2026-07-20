-- Shopify promotion and discount snapshots for support workflows.
-- Shopify remains the source of truth. Store promotion metadata needed for
-- support lookup and manual filtering, but do not store customer targeting
-- details, customer IDs, emails, or phone numbers.

create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shopify_discount_node_id text not null,
  shopify_redeem_code_id text,
  promotion_key text not null,
  title text not null,
  code text,
  method text not null,
  discount_type text not null,
  status text,
  summary text,
  short_summary text,
  starts_at timestamptz,
  ends_at timestamptz,
  usage_limit integer,
  discount_usage_count integer,
  code_usage_count integer,
  applies_once_per_customer boolean,
  discount_classes text[] not null default '{}',
  combines_with jsonb not null default '{}'::jsonb,
  source_app_name text,
  rule_snapshot jsonb not null default '{}'::jsonb,
  source_metadata jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  shopify_created_at timestamptz,
  shopify_updated_at timestamptz,
  raw_shopify_payload jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint promotions_promotion_key_unique unique (shop_id, promotion_key),
  constraint promotions_method_check check (
    method in ('code', 'automatic')
  ),
  constraint promotions_usage_limit_check check (
    usage_limit is null or usage_limit >= 0
  ),
  constraint promotions_discount_usage_count_check check (
    discount_usage_count is null or discount_usage_count >= 0
  ),
  constraint promotions_code_usage_count_check check (
    code_usage_count is null or code_usage_count >= 0
  ),
  constraint promotions_combines_with_object_check check (
    jsonb_typeof(combines_with) = 'object'
  ),
  constraint promotions_rule_snapshot_object_check check (
    jsonb_typeof(rule_snapshot) = 'object'
  ),
  constraint promotions_source_metadata_object_check check (
    jsonb_typeof(source_metadata) = 'object'
  ),
  constraint promotions_raw_payload_object_check check (
    jsonb_typeof(raw_shopify_payload) = 'object'
  )
);

create index promotions_shop_status_idx on public.promotions (shop_id, status);
create index promotions_shop_code_idx on public.promotions (shop_id, code);
create index promotions_shop_method_idx on public.promotions (shop_id, method);
create index promotions_shop_discount_type_idx on public.promotions (shop_id, discount_type);
create index promotions_shop_applies_once_idx on public.promotions (shop_id, applies_once_per_customer);
create index promotions_shop_source_app_name_idx on public.promotions (shop_id, source_app_name);
create index promotions_shop_synced_at_idx on public.promotions (shop_id, synced_at);
create index promotions_shop_deleted_at_idx on public.promotions (shop_id, deleted_at);
create index promotions_discount_classes_gin_idx on public.promotions using gin (discount_classes);
create index promotions_combines_with_gin_idx on public.promotions using gin (combines_with);
create index promotions_rule_snapshot_gin_idx on public.promotions using gin (rule_snapshot);

create trigger promotions_set_updated_at
before update on public.promotions
for each row
execute function public.set_updated_at();

alter table public.promotions enable row level security;

comment on table public.promotions is
  'Shopify discount and promotion snapshots for support workflows. Shopify remains the source of truth.';

comment on column public.promotions.promotion_key is
  'Stable local unique key: redeem-code ID for code discounts, or discount node ID for automatic discounts.';

comment on column public.promotions.code is
  'Customer-entered promotion code when method = code. Automatic discounts store null.';

comment on column public.promotions.applies_once_per_customer is
  'Shopify appliesOncePerCustomer flag for manual filtering of customer-specific or one-use promotions.';

comment on column public.promotions.rule_snapshot is
  'Sanitized promotion rule metadata such as discount classes, combines-with flags, context type, and requirement types. Do not store customer targeting details.';

comment on column public.promotions.source_metadata is
  'Small source metadata snapshot such as code count and creator app name. Do not store customer IDs, emails, phone numbers, or customer selection payloads.';

comment on column public.promotions.raw_shopify_payload is
  'Sanitized raw Shopify discount payload for traceability. Exclude customer targeting details and personal data.';
