import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const migration = readFileSync(new URL('./001_initial_schema.sql', import.meta.url), 'utf8');

test('orders migration creates the orders table and Shopify identity constraint', () => {
  assert.match(migration, /create table public\.orders/i);
  assert.match(migration, /shopify_order_id text not null/i);
  assert.match(migration, /constraint orders_shopify_order_unique unique \(shop_id, shopify_order_id\)/i);
});

test('orders migration keeps customer-adjacent fields lean', () => {
  assert.match(migration, /customer_email_hash text/i);
  assert.match(migration, /customer_phone_hash text/i);
  assert.match(migration, /shipping_destination jsonb not null default '\{\}'::jsonb/i);
  assert.match(migration, /returns jsonb not null default '\[\]'::jsonb/i);
  assert.doesNotMatch(migration, /shipping_address_line/i);
  assert.doesNotMatch(migration, /billing_address_line/i);
});

test('orders migration stores merchant-facing sales channel separately from raw source name', () => {
  assert.match(migration, /source_name text/i);
  assert.match(migration, /sales_channel text/i);
  assert.match(migration, /sales_channel_handle text/i);
  assert.match(migration, /create index orders_sales_channel_idx/i);
  assert.match(migration, /create index orders_sales_channel_handle_idx/i);
});

test('orders migration includes a dashboard-facing order status', () => {
  assert.match(migration, /order_status text/i);
  assert.match(migration, /constraint orders_order_status_check check/i);
  assert.match(migration, /'return_refund_in_progress'/i);
  assert.match(migration, /'delivered'/i);
  assert.match(migration, /create index orders_order_status_idx/i);
});

test('orders migration includes retention anchors for delivered and stale undelivered orders', () => {
  assert.match(migration, /delivered_at timestamptz/i);
  assert.match(migration, /return_refund_opened_at timestamptz/i);
  assert.match(migration, /return_refund_completed_at timestamptz/i);
  assert.match(migration, /retention_rule text/i);
  assert.match(migration, /retention_delete_after timestamptz/i);
  assert.match(migration, /'delivered_plus_3_months'/i);
  assert.match(migration, /'undelivered_plus_6_months'/i);
  assert.match(migration, /'return_refund_completed_plus_3_months'/i);
  assert.match(migration, /'return_refund_open_plus_6_months'/i);
  assert.match(migration, /create index orders_retention_delete_after_idx/i);
});

test('orders migration adds support lookup indexes and RLS', () => {
  assert.match(migration, /create index orders_shop_name_idx/i);
  assert.match(migration, /create index orders_shopify_customer_id_idx/i);
  assert.match(migration, /create index orders_fulfillment_status_idx/i);
  assert.match(migration, /alter table public\.orders enable row level security/i);
});
