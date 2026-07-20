-- Consolidated Supabase schema for Qiriness Shopify support operations.
-- Shopify remains the source of truth; this database stores operational snapshots
-- for sync, dashboard, and AI context.

create extension if not exists pgcrypto;
create extension if not exists vector;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.is_valid_product_faqs(value jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when jsonb_typeof(value) <> 'array' then false
    else not exists (
      select 1
      from jsonb_array_elements(value) as faq(item)
      where jsonb_typeof(faq.item) <> 'object'
        or not (faq.item ? 'faq_id')
        or not (faq.item ? 'question')
        or not (faq.item ? 'answer')
        or not (faq.item ? 'source')
        or not (faq.item ? 'content_hash')
        or not (faq.item ? 'updated_at')
        or not (faq.item ? 'published')
        or jsonb_typeof(faq.item -> 'source') <> 'object'
        or jsonb_typeof(faq.item -> 'published') <> 'boolean'
    )
  end;
$$;

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  shopify_shop_id text,
  shop_domain text not null,
  shop_name text,
  environment text not null default 'development',
  installed_at timestamptz,
  uninstalled_at timestamptz,
  access_scopes text[] not null default '{}',
  sync_cursors jsonb not null default '{}'::jsonb,
  app_settings jsonb not null default '{}'::jsonb,
  raw_shopify_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shops_shop_domain_unique unique (shop_domain),
  constraint shops_environment_check check (
    environment in ('development', 'staging', 'production')
  ),
  constraint shops_sync_cursors_object_check check (
    jsonb_typeof(sync_cursors) = 'object'
  ),
  constraint shops_app_settings_object_check check (
    jsonb_typeof(app_settings) = 'object'
  ),
  constraint shops_raw_payload_object_check check (
    jsonb_typeof(raw_shopify_payload) = 'object'
  )
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shopify_customer_id text not null,
  legacy_resource_id text,
  display_name text,
  first_name text,
  last_name text,
  email text,
  phone text,
  locale text,
  state text,
  verified_email boolean,
  valid_email_address boolean,
  tags text[] not null default '{}',
  email_marketing_state text,
  email_marketing_opt_in_level text,
  email_marketing_consent_updated_at timestamptz,
  on_email_marketing_list boolean generated always as (
    coalesce(email_marketing_state = 'SUBSCRIBED', false)
  ) stored,
  default_address_city text,
  default_address_province text,
  default_address_country text,
  default_address_country_code text,
  default_address_formatted_area text,
  number_of_orders integer not null default 0,
  amount_spent numeric(12, 2) not null default 0,
  amount_spent_currency text,
  last_order_id text,
  last_order_name text,
  last_order_at timestamptz,
  last_order_total numeric(12, 2),
  last_order_currency text,
  rfm_group text,
  synced_at timestamptz not null default now(),
  shopify_created_at timestamptz,
  shopify_updated_at timestamptz,
  raw_shopify_payload jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customers_shopify_customer_unique unique (shop_id, shopify_customer_id),
  constraint customers_state_check check (
    state is null or state in ('DECLINED', 'DISABLED', 'ENABLED', 'INVITED')
  ),
  constraint customers_email_marketing_state_check check (
    email_marketing_state is null
      or email_marketing_state in ('INVALID', 'NOT_SUBSCRIBED', 'PENDING', 'REDACTED', 'SUBSCRIBED', 'UNSUBSCRIBED')
  ),
  constraint customers_number_of_orders_check check (number_of_orders >= 0),
  constraint customers_amount_spent_check check (amount_spent >= 0),
  constraint customers_last_order_total_check check (
    last_order_total is null or last_order_total >= 0
  ),
  constraint customers_rfm_group_check check (
    rfm_group is null
      or rfm_group in (
        'ACTIVE',
        'ALMOST_LOST',
        'AT_RISK',
        'CHAMPIONS',
        'DORMANT',
        'LOYAL',
        'NEEDS_ATTENTION',
        'NEW',
        'PREVIOUSLY_LOYAL',
        'PROMISING',
        'PROSPECTS'
      )
  ),
  constraint customers_raw_payload_object_check check (
    jsonb_typeof(raw_shopify_payload) = 'object'
  )
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  shopify_order_id text not null,
  shopify_customer_id text,
  legacy_resource_id text,
  name text not null,
  order_number integer,
  source_name text,
  sales_channel text,
  sales_channel_handle text,
  financial_status text,
  fulfillment_status text,
  return_status text,
  order_status text,
  cancel_reason text,
  currency_code text,
  presentment_currency_code text,
  subtotal_price numeric(12, 2),
  total_discounts numeric(12, 2),
  total_shipping_price numeric(12, 2),
  total_tax numeric(12, 2),
  total_price numeric(12, 2),
  total_refunded numeric(12, 2),
  total_outstanding numeric(12, 2),
  total_weight_grams integer,
  tags text[] not null default '{}',
  customer_email_hash text,
  customer_phone_hash text,
  shipping_destination jsonb not null default '{}'::jsonb,
  line_items jsonb not null default '[]'::jsonb,
  fulfillments jsonb not null default '[]'::jsonb,
  returns jsonb not null default '[]'::jsonb,
  refunds jsonb not null default '[]'::jsonb,
  delivered_at timestamptz,
  return_refund_opened_at timestamptz,
  return_refund_completed_at timestamptz,
  retention_rule text,
  retention_delete_after timestamptz,
  processed_at timestamptz,
  cancelled_at timestamptz,
  closed_at timestamptz,
  shopify_created_at timestamptz,
  shopify_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  raw_shopify_payload jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint orders_shopify_order_unique unique (shop_id, shopify_order_id),
  constraint orders_order_number_check check (
    order_number is null or order_number >= 0
  ),
  constraint orders_subtotal_price_check check (
    subtotal_price is null or subtotal_price >= 0
  ),
  constraint orders_total_discounts_check check (
    total_discounts is null or total_discounts >= 0
  ),
  constraint orders_total_shipping_price_check check (
    total_shipping_price is null or total_shipping_price >= 0
  ),
  constraint orders_total_tax_check check (
    total_tax is null or total_tax >= 0
  ),
  constraint orders_total_price_check check (
    total_price is null or total_price >= 0
  ),
  constraint orders_total_refunded_check check (
    total_refunded is null or total_refunded >= 0
  ),
  constraint orders_total_weight_grams_check check (
    total_weight_grams is null or total_weight_grams >= 0
  ),
  constraint orders_order_status_check check (
    order_status is null
      or order_status in (
        'cancelled',
        'return_refund_in_progress',
        'return_refund_completed',
        'delivered',
        'in_transit',
        'fulfilled',
        'partially_fulfilled',
        'unfulfilled',
        'closed',
        'open'
      )
  ),
  constraint orders_retention_rule_check check (
    retention_rule is null
      or retention_rule in (
        'delivered_plus_3_months',
        'undelivered_plus_6_months',
        'return_refund_completed_plus_3_months',
        'return_refund_open_plus_6_months'
      )
  ),
  constraint orders_shipping_destination_object_check check (
    jsonb_typeof(shipping_destination) = 'object'
  ),
  constraint orders_line_items_array_check check (
    jsonb_typeof(line_items) = 'array'
  ),
  constraint orders_fulfillments_array_check check (
    jsonb_typeof(fulfillments) = 'array'
  ),
  constraint orders_returns_array_check check (
    jsonb_typeof(returns) = 'array'
  ),
  constraint orders_refunds_array_check check (
    jsonb_typeof(refunds) = 'array'
  ),
  constraint orders_raw_payload_object_check check (
    jsonb_typeof(raw_shopify_payload) = 'object'
  )
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shopify_product_id text not null,
  handle text,
  title text not null,
  status text,
  vendor text,
  product_type text,
  tags text[] not null default '{}',
  description text,
  short_description text,
  usage_instructions text,
  usage_advice text,
  active_ingredients text,
  ingredients_popup text,
  product_ingredients jsonb not null default '[]'::jsonb,
  product_ingredient_metaobject_ids text[] not null default '{}',
  product_faqs jsonb not null default '[]'::jsonb,
  product_faq_metaobject_ids text[] not null default '{}',
  available_stock integer,
  structured_facts jsonb not null default '{}'::jsonb,
  variants jsonb not null default '[]'::jsonb,
  published_at timestamptz,
  shopify_created_at timestamptz,
  shopify_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  raw_shopify_payload jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint products_shopify_product_unique unique (shop_id, shopify_product_id),
  constraint products_status_check check (
    status is null or lower(status) in ('active', 'archived', 'draft', 'unlisted')
  ),
  constraint products_product_ingredients_array_check check (
    jsonb_typeof(product_ingredients) = 'array'
  ),
  constraint products_product_faqs_shape_check check (
    public.is_valid_product_faqs(product_faqs)
  ),
  constraint products_structured_facts_object_check check (
    jsonb_typeof(structured_facts) = 'object'
  ),
  constraint products_variants_array_check check (
    jsonb_typeof(variants) = 'array'
  ),
  constraint products_raw_payload_object_check check (
    jsonb_typeof(raw_shopify_payload) = 'object'
  )
);

create table public.shopify_metaobjects (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shopify_metaobject_id text not null,
  metaobject_type text not null,
  definition_name text,
  definition_fields jsonb not null default '[]'::jsonb,
  handle text,
  display_name text,
  status text,
  fields jsonb not null default '{}'::jsonb,
  content_hash text,
  synced_at timestamptz not null default now(),
  raw_shopify_payload jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shopify_metaobjects_unique unique (shop_id, shopify_metaobject_id),
  constraint shopify_metaobjects_definition_fields_array_check check (
    jsonb_typeof(definition_fields) = 'array'
  ),
  constraint shopify_metaobjects_fields_object_check check (
    jsonb_typeof(fields) = 'object'
  ),
  constraint shopify_metaobjects_raw_payload_object_check check (
    jsonb_typeof(raw_shopify_payload) = 'object'
  )
);

create table public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  source_type text not null,
  shopify_source_id text,
  handle text,
  title text not null,
  url_path text,
  navigation_area text,
  category text,
  locale text not null default 'fr',
  status text,
  content_text text not null,
  sections jsonb not null default '[]'::jsonb,
  content_hash text not null,
  synced_at timestamptz not null default now(),
  shopify_updated_at timestamptz,
  source_metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint knowledge_documents_navigation_area_check check (
    navigation_area is null or navigation_area in ('header', 'footer', 'manual')
  ),
  constraint knowledge_documents_sections_array_check check (
    jsonb_typeof(sections) = 'array'
  ),
  constraint knowledge_documents_source_metadata_object_check check (
    jsonb_typeof(source_metadata) = 'object'
  )
);

create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  knowledge_document_id uuid not null references public.knowledge_documents(id) on delete cascade,
  chunk_index integer not null,
  section_index integer,
  section_heading text,
  category text,
  chunk_text text not null,
  token_count integer,
  content_hash text not null,
  embedding vector,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint knowledge_chunks_document_chunk_unique unique (knowledge_document_id, chunk_index),
  constraint knowledge_chunks_chunk_index_check check (chunk_index >= 0),
  constraint knowledge_chunks_section_index_check check (
    section_index is null or section_index >= 0
  ),
  constraint knowledge_chunks_token_count_check check (
    token_count is null or token_count >= 0
  )
);

create table public.integration_events (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops(id) on delete set null,
  event_key text not null,
  source text not null,
  event_type text not null,
  status text not null default 'received',
  idempotency_key text,
  topic text,
  actor_type text not null default 'system',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  counts jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint integration_events_event_key_unique unique (event_key),
  constraint integration_events_status_check check (
    status in ('received', 'processing', 'completed', 'failed', 'skipped')
  ),
  constraint integration_events_counts_object_check check (
    jsonb_typeof(counts) = 'object'
  ),
  constraint integration_events_metadata_object_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create table public.privacy_requests (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops(id) on delete set null,
  integration_event_id uuid references public.integration_events(id) on delete set null,
  request_key text not null,
  topic text not null,
  shopify_shop_id text,
  shop_domain text,
  shopify_customer_id text,
  customer_email_hash text,
  customer_phone_hash text,
  status text not null default 'received',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  deleted_customer_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint privacy_requests_request_key_unique unique (request_key),
  constraint privacy_requests_topic_check check (
    topic in ('customers/data_request', 'customers/redact', 'shop/redact')
  ),
  constraint privacy_requests_status_check check (
    status in ('received', 'processing', 'pending_merchant_response', 'completed', 'failed', 'skipped')
  ),
  constraint privacy_requests_deleted_customer_count_check check (
    deleted_customer_count >= 0
  ),
  constraint privacy_requests_metadata_object_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create table public.data_access_events (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops(id) on delete set null,
  integration_event_id uuid references public.integration_events(id) on delete set null,
  actor_type text not null,
  actor_id text not null,
  action text not null,
  resource_type text not null,
  resource_id_hash text,
  purpose text not null,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint data_access_events_actor_type_check check (
    actor_type in ('system', 'service', 'user')
  ),
  constraint data_access_events_metadata_object_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create index shops_shopify_shop_id_idx on public.shops (shopify_shop_id);

create index customers_shop_email_idx on public.customers (shop_id, email);
create index customers_shop_email_marketing_idx on public.customers (shop_id, on_email_marketing_list);
create index customers_shop_location_idx on public.customers (shop_id, default_address_country_code, default_address_city);
create index customers_shop_orders_idx on public.customers (shop_id, number_of_orders);
create index customers_shop_amount_spent_idx on public.customers (shop_id, amount_spent);
create index customers_shop_rfm_group_idx on public.customers (shop_id, rfm_group);
create index customers_shop_last_order_at_idx on public.customers (shop_id, last_order_at);
create index customers_shop_deleted_at_idx on public.customers (shop_id, deleted_at);
create index customers_tags_gin_idx on public.customers using gin (tags);

create index orders_shop_name_idx on public.orders (shop_id, name);
create index orders_shop_order_number_idx on public.orders (shop_id, order_number);
create index orders_sales_channel_idx on public.orders (shop_id, sales_channel);
create index orders_sales_channel_handle_idx on public.orders (shop_id, sales_channel_handle);
create index orders_customer_id_idx on public.orders (customer_id);
create index orders_shopify_customer_id_idx on public.orders (shop_id, shopify_customer_id);
create index orders_financial_status_idx on public.orders (shop_id, financial_status);
create index orders_fulfillment_status_idx on public.orders (shop_id, fulfillment_status);
create index orders_return_status_idx on public.orders (shop_id, return_status);
create index orders_order_status_idx on public.orders (shop_id, order_status);
create index orders_delivered_at_idx on public.orders (shop_id, delivered_at);
create index orders_return_refund_opened_at_idx on public.orders (shop_id, return_refund_opened_at);
create index orders_return_refund_completed_at_idx on public.orders (shop_id, return_refund_completed_at);
create index orders_retention_delete_after_idx on public.orders (shop_id, retention_delete_after);
create index orders_processed_at_idx on public.orders (shop_id, processed_at);
create index orders_deleted_at_idx on public.orders (shop_id, deleted_at);
create index orders_tags_gin_idx on public.orders using gin (tags);
create index orders_line_items_gin_idx on public.orders using gin (line_items);
create index orders_fulfillments_gin_idx on public.orders using gin (fulfillments);
create index orders_returns_gin_idx on public.orders using gin (returns);
create index orders_refunds_gin_idx on public.orders using gin (refunds);

create index products_shop_handle_idx on public.products (shop_id, handle);
create index products_shop_status_idx on public.products (shop_id, status);
create index products_shop_deleted_at_idx on public.products (shop_id, deleted_at);
create index products_product_ingredients_gin_idx on public.products using gin (product_ingredients);
create index products_product_ingredient_metaobject_ids_gin_idx on public.products using gin (product_ingredient_metaobject_ids);
create index products_product_faqs_gin_idx on public.products using gin (product_faqs);
create index products_product_faq_metaobject_ids_gin_idx on public.products using gin (product_faq_metaobject_ids);
create index products_structured_facts_gin_idx on public.products using gin (structured_facts);
create index products_variants_gin_idx on public.products using gin (variants);

create index shopify_metaobjects_shop_type_idx on public.shopify_metaobjects (shop_id, metaobject_type);
create index shopify_metaobjects_shop_handle_idx on public.shopify_metaobjects (shop_id, handle);
create index shopify_metaobjects_shop_deleted_at_idx on public.shopify_metaobjects (shop_id, deleted_at);
create index shopify_metaobjects_fields_gin_idx on public.shopify_metaobjects using gin (fields);

create unique index knowledge_documents_shop_source_id_unique
  on public.knowledge_documents (shop_id, source_type, shopify_source_id)
  where shopify_source_id is not null;

create unique index knowledge_documents_shop_source_handle_unique
  on public.knowledge_documents (shop_id, source_type, handle)
  where shopify_source_id is null and handle is not null;

create index knowledge_documents_shop_category_idx on public.knowledge_documents (shop_id, category);
create index knowledge_documents_shop_navigation_area_idx on public.knowledge_documents (shop_id, navigation_area);
create index knowledge_documents_shop_deleted_at_idx on public.knowledge_documents (shop_id, deleted_at);
create index knowledge_documents_sections_gin_idx on public.knowledge_documents using gin (sections);

create index knowledge_chunks_document_id_idx on public.knowledge_chunks (knowledge_document_id);
create index knowledge_chunks_category_idx on public.knowledge_chunks (category);

create index integration_events_shop_status_idx on public.integration_events (shop_id, status);
create index integration_events_source_type_idx on public.integration_events (source, event_type);
create index integration_events_topic_idx on public.integration_events (topic);
create index integration_events_started_at_idx on public.integration_events (started_at);

create index privacy_requests_shop_topic_idx on public.privacy_requests (shop_id, topic);
create index privacy_requests_status_idx on public.privacy_requests (status);
create index privacy_requests_shopify_customer_id_idx on public.privacy_requests (shopify_customer_id);
create index privacy_requests_received_at_idx on public.privacy_requests (received_at);

create index data_access_events_shop_action_idx on public.data_access_events (shop_id, action);
create index data_access_events_resource_idx on public.data_access_events (resource_type, resource_id_hash);
create index data_access_events_occurred_at_idx on public.data_access_events (occurred_at);

create trigger shops_set_updated_at
before update on public.shops
for each row
execute function public.set_updated_at();

create trigger customers_set_updated_at
before update on public.customers
for each row
execute function public.set_updated_at();

create trigger orders_set_updated_at
before update on public.orders
for each row
execute function public.set_updated_at();

create trigger products_set_updated_at
before update on public.products
for each row
execute function public.set_updated_at();

create trigger shopify_metaobjects_set_updated_at
before update on public.shopify_metaobjects
for each row
execute function public.set_updated_at();

create trigger knowledge_documents_set_updated_at
before update on public.knowledge_documents
for each row
execute function public.set_updated_at();

create trigger knowledge_chunks_set_updated_at
before update on public.knowledge_chunks
for each row
execute function public.set_updated_at();

create trigger integration_events_set_updated_at
before update on public.integration_events
for each row
execute function public.set_updated_at();

create trigger privacy_requests_set_updated_at
before update on public.privacy_requests
for each row
execute function public.set_updated_at();

alter table public.shops enable row level security;
alter table public.customers enable row level security;
alter table public.orders enable row level security;
alter table public.products enable row level security;
alter table public.shopify_metaobjects enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.integration_events enable row level security;
alter table public.privacy_requests enable row level security;
alter table public.data_access_events enable row level security;

comment on table public.shops is
  'Shopify shop records and app-level sync state. Shopify remains the source of truth.';

comment on column public.shops.sync_cursors is
  'Per-resource sync cursors for Shopify imports, webhooks, and reconciliation jobs.';

comment on table public.customers is
  'Lean Shopify customer snapshots for support dashboards and segmentation. Access through service-role sync paths only until dashboard roles and policies are implemented.';

comment on column public.customers.email is
  'Customer email for support lookup. Do not include this field in AI prompts unless strictly required.';

comment on column public.customers.phone is
  'Customer phone for support lookup. Do not include this field in AI prompts unless strictly required.';

comment on column public.customers.on_email_marketing_list is
  'Generated from Shopify defaultEmailAddress.marketingState = SUBSCRIBED.';

comment on column public.customers.default_address_formatted_area is
  'Coarse customer location from the default address. Street address and postcode are intentionally not stored here.';

comment on column public.customers.number_of_orders is
  'Lifetime Shopify order count from Customer.numberOfOrders.';

comment on column public.customers.amount_spent is
  'Lifetime Shopify amount spent from Customer.amountSpent.';

comment on column public.customers.rfm_group is
  'Shopify-computed Customer.statistics.rfmGroup category used by Shopify customer segmentation as rfm_group.';

comment on column public.customers.raw_shopify_payload is
  'Small sanitized customer payload for traceability. Avoid full addresses, notes, and unnecessary personal data.';

comment on table public.orders is
  'Lean Shopify order snapshots for support workflows. Shopify remains the source of truth.';

comment on column public.orders.customer_id is
  'Optional link to the local customer snapshot. Guest orders or unsynced customers may only have shopify_customer_id or hashed contact fields.';

comment on column public.orders.source_name is
  'Raw Shopify order source name, such as web, pos, mobile_app, or a third-party source identifier. This is not always the merchant-facing sales channel label.';

comment on column public.orders.sales_channel is
  'Merchant-facing sales channel label shown in Shopify Admin order lists, such as Online Store, POS, Amazon, or another marketplace.';

comment on column public.orders.sales_channel_handle is
  'Stable Shopify sales channel or order attribution handle when available, useful for filtering and matching channel-specific workflows.';

comment on column public.orders.order_status is
  'Dashboard-facing order lifecycle stage derived from cancellation, return/refund, delivery, and fulfillment state.';

comment on column public.orders.customer_email_hash is
  'Hash of the order contact email for support lookup without duplicating raw email on the order row.';

comment on column public.orders.customer_phone_hash is
  'Hash of the order contact phone for support lookup without duplicating raw phone on the order row.';

comment on column public.orders.shipping_destination is
  'Coarse shipping destination only, such as city, province, country, and country code. Do not store street address or postcode here.';

comment on column public.orders.line_items is
  'Sanitized Shopify line item snapshots for support workflows, excluding customer personal data.';

comment on column public.orders.fulfillments is
  'Sanitized fulfillment and tracking summaries needed for order tracking support.';

comment on column public.orders.returns is
  'Sanitized return summaries needed for support workflows and order retention decisions.';

comment on column public.orders.refunds is
  'Sanitized refund summaries needed for support workflows.';

comment on column public.orders.delivered_at is
  'Timestamp when the order was confirmed delivered from Shopify fulfillment/tracking data. Used as the retention anchor for completed delivered orders.';

comment on column public.orders.return_refund_opened_at is
  'Timestamp when a return or refund process was first detected. Used as the retention anchor for unresolved return/refund cases.';

comment on column public.orders.return_refund_completed_at is
  'Timestamp when a return or refund process was completed. Used as the retention anchor before deleting completed return/refund cases.';

comment on column public.orders.retention_rule is
  'Order retention rule selected by sync: delivered_plus_3_months, undelivered_plus_6_months, return_refund_completed_plus_3_months, or return_refund_open_plus_6_months.';

comment on column public.orders.retention_delete_after is
  'Timestamp after which the local operational order snapshot can be deleted: delivered_at plus 3 months, return/refund completion plus 3 months, order creation/processing plus 6 months if not delivered, or return/refund opening plus 6 months if unresolved.';

comment on column public.orders.raw_shopify_payload is
  'Sanitized raw Shopify order payload for traceability. Exclude street addresses, raw contact values, payment details, and other unnecessary personal data.';

comment on table public.products is
  'Operational Shopify product snapshots for dashboard and AI context. Product images are intentionally not imported.';

comment on column public.products.short_description is
  'Shopify product metafield: Short description.';

comment on column public.products.usage_instructions is
  'Shopify product metafield: Usage Instructions.';

comment on column public.products.usage_advice is
  'Shopify product metafield: Conseils d''utilisation.';

comment on column public.products.active_ingredients is
  'Shopify product metafield: Actifs & ingredients.';

comment on column public.products.ingredients_popup is
  'Shopify product metafield: ingredients popup.';

comment on column public.products.product_ingredients is
  'Optional denormalized product ingredient snapshot for AI/search. Canonical linked ingredient metaobjects are referenced by product_ingredient_metaobject_ids.';

comment on column public.products.product_ingredient_metaobject_ids is
  'Shopify metaobject IDs linked from the Product Ingredients metafield. Canonical ingredient content lives in shopify_metaobjects.';

comment on column public.products.product_faqs is
  'Optional denormalized product FAQ snapshot for AI/search. Canonical linked FAQ metaobjects are referenced by product_faq_metaobject_ids.';

comment on column public.products.product_faq_metaobject_ids is
  'Shopify metaobject IDs linked from the product FAQ list metafield. Canonical FAQ content lives in shopify_metaobjects.';

comment on column public.products.available_stock is
  'Product-level available stock summary, currently synced as the sum of Shopify variant inventory quantities when available.';

comment on column public.products.structured_facts is
  'AI-safe structured product facts extracted from Shopify fields, metafields, or metaobjects.';

comment on column public.products.variants is
  'Structured Shopify variant snapshots as JSONB. Keep query-critical fields duplicated here before adding more tables.';

comment on column public.products.raw_shopify_payload is
  'Sanitized raw Shopify product payload for traceability. Do not include image binaries or unnecessary personal data.';

comment on table public.shopify_metaobjects is
  'Shopify metaobject snapshots shared across products, such as predefined product FAQs and ingredients.';

comment on column public.shopify_metaobjects.shopify_metaobject_id is
  'Stable Shopify metaobject ID/GID used by products to reference this shared content.';

comment on column public.shopify_metaobjects.metaobject_type is
  'Shopify metaobject type, for example product FAQ or ingredient.';

comment on column public.shopify_metaobjects.definition_name is
  'Human-readable Shopify metaobject definition name, for example Product FAQ or Ingredients List.';

comment on column public.shopify_metaobjects.definition_fields is
  'Shopify metaobject definition field schema snapshot for interpreting fields JSONB.';

comment on column public.shopify_metaobjects.fields is
  'Structured metaobject field values synced from Shopify.';

comment on column public.shopify_metaobjects.raw_shopify_payload is
  'Sanitized raw Shopify metaobject payload for traceability. Do not store image binaries or unnecessary personal data.';

comment on table public.knowledge_documents is
  'Cleaned Shopify header/footer page and policy content used as source material for AI support context.';

comment on column public.knowledge_documents.source_type is
  'Source content type, such as shopify_page, shopify_policy, or shopify_menu_page.';

comment on column public.knowledge_documents.navigation_area is
  'Where the page is exposed in the storefront navigation: header, footer, or manual.';

comment on column public.knowledge_documents.category is
  'Loose knowledge category for routing and retrieval. This is intentionally unrestricted until the support taxonomy is finalized.';

comment on column public.knowledge_documents.content_text is
  'Cleaned canonical plain text used for AI context.';

comment on column public.knowledge_documents.sections is
  'Ordered section objects parsed from the page content, usually containing heading, text, order, and anchor.';

comment on column public.knowledge_documents.source_metadata is
  'Small sanitized source metadata snapshot. Do not store full page HTML or unnecessary raw payloads here.';

comment on table public.knowledge_chunks is
  'AI retrieval chunks generated from knowledge_documents sections.';

comment on column public.knowledge_chunks.category is
  'Chunk category copied from the source document for direct filtering during retrieval.';

comment on column public.knowledge_chunks.token_count is
  'Approximate token count used to tune chunking and prompt budgets.';

comment on column public.knowledge_chunks.embedding is
  'Optional pgvector embedding for semantic retrieval. Stored without fixed dimensions until the embedding model is finalized.';

comment on table public.integration_events is
  'Metadata-only log of Shopify sync, webhook, and reconciliation events. Do not store raw payloads or personal data here.';

comment on table public.privacy_requests is
  'Lifecycle records for Shopify compliance webhooks. Customer contact values are hashed, not stored verbatim.';

comment on table public.data_access_events is
  'Audit trail for service-level personal-data access. Future dashboard human views must write here as user events.';

comment on column public.data_access_events.resource_id_hash is
  'Stable hash of the accessed resource identifier. Avoid storing direct customer email, phone, or address values.';
