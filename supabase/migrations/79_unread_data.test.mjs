import assert from 'node:assert/strict';
import test from 'node:test';

import { read } from './_shared.test.mjs';

const SQL = read('79_unread_data');
const BASELINE = read('02_shopify') + read('04_support') + read('05_exemplars');

const DROPPED = [
  'ticket_messages_embedding_hnsw_idx',
  'support_exemplar_phrasings_embedding_hnsw_idx',
  'orders_line_items_gin_idx',
  'orders_fulfillments_gin_idx',
  'customers_shop_amount_spent_idx',
  'products_structured_facts_gin_idx',
  'promotions_rule_snapshot_gin_idx',
  'shopify_metaobjects_fields_gin_idx'
];

test('each unused index is dropped here and gone from the baseline', () => {
  for (const name of DROPPED) {
    assert.match(SQL, new RegExp(`drop index if exists public\.${name};`), name);
    assert.doesNotMatch(BASELINE, new RegExp(`create index ${name}\b`), `the baseline still creates ${name}`);
  }
});

test('the vectors stay: only their indexes go', () => {
  assert.doesNotMatch(SQL, /drop column|alter table/i);
  assert.match(read('04_support'), /embedding vector\(1536\)/);
});

test('the raw payloads are emptied to {}, which the column check accepts', () => {
  for (const table of ['customers', 'orders']) {
    assert.match(SQL, new RegExp(`update public\.${table} set raw_shopify_payload = '\{\}'::jsonb where raw_shopify_payload <> '\{\}'::jsonb;`));
  }
});

test('the per-page sync rows become one row per run, in one statement', () => {
  const statement = SQL.slice(SQL.indexOf('with pages as ('));
  assert.match(statement, /insert into public\.data_access_events/);
  assert.match(statement, /replace\(action, '_sync_page', '_sync_run'\)/);
  assert.match(statement, /delete from public\.data_access_events\nwhere action in \('shopify_customers_sync_page', 'shopify_orders_sync_page', 'shopify_promotions_sync_page'\);/);
});

test('the column comments say the payload is no longer written, here and in the baseline', () => {
  for (const table of ['customers', 'orders']) {
    const comment = new RegExp(`comment on column public\.${table}\.raw_shopify_payload is\n  'Not written since 2026-10-06`);
    assert.match(SQL, comment);
    assert.match(read('02_shopify'), comment);
  }
});
