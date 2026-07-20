import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const migration = readFileSync(new URL('./002_promotions.sql', import.meta.url), 'utf8');

test('promotions migration creates promotion table and unique key', () => {
  assert.match(migration, /create table public\.promotions/i);
  assert.match(migration, /shopify_discount_node_id text not null/i);
  assert.match(migration, /promotion_key text not null/i);
  assert.match(migration, /constraint promotions_promotion_key_unique unique \(shop_id, promotion_key\)/i);
});

test('promotions migration supports manual filtering by applies once per customer', () => {
  assert.match(migration, /applies_once_per_customer boolean/i);
  assert.match(migration, /create index promotions_shop_applies_once_idx/i);
});

test('promotions migration enables lookup indexes and RLS', () => {
  assert.match(migration, /create index promotions_shop_status_idx/i);
  assert.match(migration, /create index promotions_shop_code_idx/i);
  assert.match(migration, /create index promotions_shop_source_app_name_idx/i);
  assert.match(migration, /alter table public\.promotions enable row level security/i);
});

test('promotions migration avoids customer personal data columns', () => {
  const tableDefinition = migration.match(/create table public\.promotions \(([\s\S]*?)\n\);/i)?.[1] || '';
  assert.doesNotMatch(tableDefinition, /^\s*customer_id\s+\w+/im);
  assert.doesNotMatch(tableDefinition, /^\s*email\s+\w+/im);
  assert.doesNotMatch(tableDefinition, /^\s*phone\s+\w+/im);
});
