-- ============================================================================
-- 02 — SHOPIFY SNAPSHOTS
-- Operational mirrors of the Shopify store: customers, orders, products,
-- metaobjects, promotions, and the page/policy catalog.
--
-- SHOPIFY REMAINS THE SOURCE OF TRUTH. Nothing here is authoritative — every
-- table is a snapshot maintained by an idempotent sync keyed on the Shopify id,
-- and every row carries `synced_at` plus a raw payload for traceability.
--
-- PERSONAL DATA IS MINIMISED ON THE WAY IN, not filtered on the way out:
-- `orders` stores hashes rather than the customer's email and phone, and a
-- coarse city/country rather than a shipping address. `customers` carries no
-- street address and no notes. What is not stored cannot leak.
--
-- Requires: 01_foundation.sql (shops, set_updated_at).
-- ============================================================================

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

-- ---------------------------------------------------------------- customers

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

create index customers_shop_email_idx on public.customers (shop_id, email);

create index customers_shop_email_marketing_idx on public.customers (shop_id, on_email_marketing_list);

create index customers_shop_location_idx on public.customers (shop_id, default_address_country_code, default_address_city);

create index customers_shop_orders_idx on public.customers (shop_id, number_of_orders);

create index customers_shop_amount_spent_idx on public.customers (shop_id, amount_spent);

create index customers_shop_rfm_group_idx on public.customers (shop_id, rfm_group);

create index customers_shop_last_order_at_idx on public.customers (shop_id, last_order_at);

create index customers_shop_deleted_at_idx on public.customers (shop_id, deleted_at);

create index customers_tags_gin_idx on public.customers using gin (tags);

create trigger customers_set_updated_at
before update on public.customers
for each row
execute function public.set_updated_at();

alter table public.customers enable row level security;

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

-- ---------------------------------------------------------------- orders

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
  -- The same address as the hash above, reduced to what a person can RECOGNISE:
  -- `j***l@orange.fr`. Not a second copy of the identifier — the local part is
  -- destroyed at map time and never stored, so this cannot be reversed or used
  -- to contact anyone.
  --
  -- It exists for one question the hash cannot answer. `orders:resolve` refuses
  -- an order whose requester hash does not match, and 15 tickets sit in that
  -- state; deciding whether each is a gift, a partner or the same customer's
  -- second mailbox needs a human to LOOK at the address. A hash cannot be looked
  -- at. The domain is kept whole because it is the discriminating half.
  customer_email_masked text,
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

create trigger orders_set_updated_at
before update on public.orders
for each row
execute function public.set_updated_at();

alter table public.orders enable row level security;

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

comment on column public.orders.customer_email_masked is
  'The order contact address reduced to a recognisable form (j***l@orange.fr), derived beside customer_email_hash from the same input so the two can never describe different addresses. NOT a raw address: the local part is destroyed at map time. It answers the question a hash cannot -- which address is this? -- for a human reviewing an ownership mismatch. Never sent to a model: the tool layer withholds it, and only the dashboard renders it.';

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

-- ---------------------------------------------------------------- products

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

create index products_shop_handle_idx on public.products (shop_id, handle);

create index products_shop_status_idx on public.products (shop_id, status);

create index products_shop_deleted_at_idx on public.products (shop_id, deleted_at);

create index products_product_ingredients_gin_idx on public.products using gin (product_ingredients);

create index products_product_ingredient_metaobject_ids_gin_idx on public.products using gin (product_ingredient_metaobject_ids);

create index products_product_faqs_gin_idx on public.products using gin (product_faqs);

create index products_product_faq_metaobject_ids_gin_idx on public.products using gin (product_faq_metaobject_ids);

create index products_structured_facts_gin_idx on public.products using gin (structured_facts);

create index products_variants_gin_idx on public.products using gin (variants);

create trigger products_set_updated_at
before update on public.products
for each row
execute function public.set_updated_at();

alter table public.products enable row level security;

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

-- ---------------------------------------------------------------- shopify_metaobjects

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

create index shopify_metaobjects_shop_type_idx on public.shopify_metaobjects (shop_id, metaobject_type);

create index shopify_metaobjects_shop_handle_idx on public.shopify_metaobjects (shop_id, handle);

create index shopify_metaobjects_shop_deleted_at_idx on public.shopify_metaobjects (shop_id, deleted_at);

create index shopify_metaobjects_fields_gin_idx on public.shopify_metaobjects using gin (fields);

create trigger shopify_metaobjects_set_updated_at
before update on public.shopify_metaobjects
for each row
execute function public.set_updated_at();

alter table public.shopify_metaobjects enable row level security;

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

-- ---------------------------------------------------------------- promotions

-- Promotion metadata needed for support lookup and manual filtering. Customer
-- targeting details, customer IDs, emails and phone numbers are never stored.
create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shopify_discount_node_id text not null,
  promotion_key text not null,
  title text not null,
  -- ONE ROW PER DISCOUNT; the redeem codes live in here.
  --
  -- This was one row per CODE, which on a real store meant the same discount
  -- duplicated up to 600 times: 324 discounts became 7,512 rows and a 22 MB
  -- table, of which 4.4 MB was the identical rule_snapshot copied over and over.
  --
  -- jsonb rather than a delimited string because per-code USAGE has to survive.
  -- 7,206 of the store's codes are single-use and 69 are already spent, and
  -- "you have already used this code" is the promotion tool's most actionable
  -- answer — a list of bare codes cannot carry it. A delimited string is also
  -- unindexable for the lookup that matters (leading-wildcard LIKE) and matches
  -- substrings: real collisions exist on this store, where "BIENVENUE" appears
  -- inside "BIENVENUEQIRINESS" and "WRAP" inside "WRAP-V".
  --
  -- Shape: [{ code, usage_count, redeem_code_id }]. Empty for automatic
  -- discounts, which have no code at all.
  codes jsonb not null default '[]'::jsonb,
  method text not null,
  discount_type text not null,
  status text,
  summary text,
  short_summary text,
  starts_at timestamptz,
  ends_at timestamptz,
  usage_limit integer,
  discount_usage_count integer,
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
  constraint promotions_codes_array_check check (
    jsonb_typeof(codes) = 'array'
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

-- GIN over the codes array: "which discount owns the code the customer typed?"
-- is the promotion tool's entry point, and a btree cannot answer it once the
-- codes live inside a jsonb array. Containment (`codes @> '[{"code":"X"}]'`)
-- matches the WHOLE value, so it cannot return "BIENVENUEQIRINESS" for a
-- customer who typed "BIENVENUE" — which a substring search over a delimited
-- string would have done on this very store.
create index promotions_shop_codes_gin_idx on public.promotions using gin (codes jsonb_path_ops);

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
  'Stable local unique key. One row per DISCOUNT, so this is the discount node ID.';

comment on column public.promotions.codes is
  'Redeem codes for this discount: [{ code, usage_count, redeem_code_id }]. Empty for automatic discounts. One row per discount rather than per code — a bulk-generated discount carries up to 600 codes, and duplicating the whole snapshot per code cost 7,512 rows and 22 MB where 324 rows do. usage_count is per CODE and is load-bearing: most codes here are single-use, so "this code has already been used" is the answer to the commonest promotions question, and a bare list of codes could not carry it.';

comment on column public.promotions.applies_once_per_customer is
  'Shopify appliesOncePerCustomer flag for manual filtering of customer-specific or one-use promotions.';

comment on column public.promotions.rule_snapshot is
  'Sanitized promotion rule metadata such as discount classes, combines-with flags, context type, and requirement types. Do not store customer targeting details.';

comment on column public.promotions.source_metadata is
  'Small source metadata snapshot such as code count and creator app name. Do not store customer IDs, emails, phone numbers, or customer selection payloads.';

comment on column public.promotions.raw_shopify_payload is
  'Sanitized raw Shopify discount payload for traceability. Exclude customer targeting details and personal data.';

-- ---------------------------------------------------------------- shopify_content_sources

-- ============================================================================
-- Knowledge library
--
-- Nothing auto-syncs into knowledge_documents: a row is only ever created by an
-- explicit import or a manually written article. Editing an imported article
-- converts source_type to 'manual', which is what stops it from resyncing --
-- there is no separate "locally modified" flag.
-- ============================================================================

-- Identity-only index of live Shopify pages and policies, used to populate the
-- Agent Setup source dropdown. Content is resolved on demand at import time.
create table public.shopify_content_sources (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  source_type text not null,
  shopify_source_id text not null,
  handle text not null,
  title text not null,
  status text not null default 'unpublished',
  shopify_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shopify_content_sources_shop_source_unique unique (shop_id, source_type, shopify_source_id),
  constraint shopify_content_sources_source_type_check check (source_type in ('shopify_page', 'shopify_policy')),
  constraint shopify_content_sources_status_check check (status in ('published', 'unpublished'))
);

create index shopify_content_sources_shop_type_idx on public.shopify_content_sources (shop_id, source_type);

create trigger shopify_content_sources_set_updated_at
before update on public.shopify_content_sources
for each row
execute function public.set_updated_at();

alter table public.shopify_content_sources enable row level security;

comment on table public.shopify_content_sources is
  'Lightweight index of live Shopify Online Store pages and shop policies (refund, privacy, shipping, terms of service, etc.), used to populate the Agent Setup source dropdown. Holds identity only; content is resolved on demand at import/resync time and is not stored here.';

comment on column public.shopify_content_sources.source_type is
  'shopify_page or shopify_policy. Distinguishes which Shopify resource this row indexes, since pages and policies are fetched and resolved through different Shopify Admin API calls.';

comment on column public.shopify_content_sources.status is
  'Shopify publish state: published or unpublished. Policies are always published (Shopify has no draft state for a filled-in policy); pages derive this from publishedAt presence.';
