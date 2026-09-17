import assert from 'node:assert/strict';
import test from 'node:test';

import { checkClause, definitionOf, literalsIn, read, tablesIn } from './_shared.test.mjs';

const sql = read('02_shopify');

test('creates exactly the seven tables it documents', () => {
  // Six snapshots, plus `advice_collections` — which is a snapshot of Shopify's
  // collections AND the team's decisions about them, so it lives here with the
  // rest of the Shopify mirror rather than in the analytics file.
  assert.deepEqual(tablesIn(sql).sort(), [
    'advice_collections',
    'customers',
    'orders',
    'products',
    'promotions',
    'shopify_content_sources',
    'shopify_metaobjects'
  ]);
});

test('advice_collections keeps three columns out of the reach of the sync', () => {
  // The whole mechanism: the mapper returns a fixed column set and the upsert
  // merges duplicates, so a column absent from the payload is left alone. These
  // three are the ones a sync must never carry — asserted again on the mapper
  // itself, the way `recommended_for_concerns` already is.
  const body = definitionOf(sql, 'advice_collections');
  for (const column of ['is_active boolean not null default false', 'axis text', 'note text']) {
    assert.ok(body.includes(column), `advice_collections is missing ${column}`);
  }
  assert.match(sql, /comment on column public\.advice_collections\.is_active is\s+'Local, never written by the sync/);
});

test('an axis is one of two things, or undecided', () => {
  // « un sérum pour mes rides » is one requirement of each kind, and a tool that
  // could not tell them apart could not relax the right one.
  const clause = checkClause(sql, 'advice_collections_axis_check');
  assert.ok(clause, 'no axis constraint');
  assert.deepEqual(literalsIn(clause), ['category', 'concern']);
});

test('every snapshot is keyed to Shopify identity and scoped to a shop', () => {
  for (const [table, key] of [
    ['customers', 'shopify_customer_id'],
    ['orders', 'shopify_order_id'],
    ['products', 'shopify_product_id']
  ]) {
    assert.match(sql, new RegExp(`constraint ${table}_shopify_\\w+_unique unique \\(shop_id, ${key}\\)`, 'i'));
  }
});

test('orders keep customer-adjacent fields lean', () => {
  // Contact details are hashes, so an order can be matched to a ticket's
  // requester without either side holding the raw address.
  assert.match(sql, /customer_email_hash text/i);
  assert.match(sql, /customer_phone_hash text/i);
  assert.doesNotMatch(sql, /^\s*customer_email text/im);
  assert.doesNotMatch(sql, /^\s*customer_phone text/im);
});

test('the shipping destination is coarse, never a street address', () => {
  assert.match(sql, /shipping_destination jsonb not null default '\{\}'::jsonb/i);
  for (const forbidden of ['address1', 'address2', 'street', 'zip', 'postcode']) {
    assert.doesNotMatch(sql, new RegExp(`^\\s*${forbidden}\\b`, 'im'), forbidden);
  }
});

test('orders store the merchant-facing sales channel separately from the raw source name', () => {
  assert.match(sql, /source_name text/i);
  assert.match(sql, /sales_channel text/i);
  assert.match(sql, /sales_channel_handle text/i);
});

test('orders carry a dashboard-facing status and the retention anchors', () => {
  // order_status is derived by the sync mapper; web/lib/types.ts mirrors this
  // list, so a value added here without the UI is a blank cell in the panel.
  for (const status of [
    'cancelled', 'return_refund_in_progress', 'return_refund_completed',
    'delivered', 'in_transit', 'fulfilled', 'partially_fulfilled',
    'unfulfilled', 'closed', 'open'
  ]) {
    assert.match(sql, new RegExp(`'${status}'`), status);
  }
  assert.match(sql, /retention_rule text/i);
  assert.match(sql, /retention_delete_after timestamptz/i);
  assert.match(sql, /create index orders_retention_delete_after_idx/i);
});

test('the RFM group is constrained, since VIP status is derived from it', () => {
  // scripts/lib/customer-segments.mjs reads this column. A value it has never
  // seen is simply not VIP, but a value the DATABASE rejects breaks the sync.
  assert.match(sql, /constraint customers_rfm_group_check/i);
  for (const group of ['CHAMPIONS', 'LOYAL', 'ACTIVE', 'PROSPECTS', 'DORMANT']) {
    assert.match(sql, new RegExp(`'${group}'`), group);
  }
});

test('the marketing-list flag is generated, not synced', () => {
  // Derived in the database so it cannot disagree with email_marketing_state.
  assert.match(sql, /on_email_marketing_list boolean generated always as/i);
  assert.match(sql, /email_marketing_state = 'SUBSCRIBED'/i);
});

test('promotions are keyed per shop and hold no customer personal data', () => {
  assert.match(sql, /create table public\.promotions/i);
  assert.match(sql, /rule_snapshot/i);
  assert.doesNotMatch(sql, /^\s*customer_email\b/im);
});

test('the product FAQ shape is validated by the shared function', () => {
  assert.match(sql, /create or replace function public\.is_valid_product_faqs/i);
  assert.match(sql, /constraint products_product_faqs_shape_check check \(\s*public\.is_valid_product_faqs\(product_faqs\)\s*\)/i);
});

test('only active products can be matched, so status is constrained', () => {
  assert.match(
    sql,
    /constraint products_status_check check \(\s*status is null or lower\(status\) in \('active', 'archived', 'draft', 'unlisted'\)\s*\)/i
  );
});

test('the content catalog indexes identity only, never page bodies', () => {
  assert.match(sql, /create table public\.shopify_content_sources/i);
  for (const forbidden of ['content_html', 'content_text', 'body']) {
    assert.doesNotMatch(
      sql.split('create table public.shopify_content_sources')[1].split('\n);')[0],
      new RegExp(`^\\s*${forbidden}\\b`, 'im'),
      forbidden
    );
  }
});
