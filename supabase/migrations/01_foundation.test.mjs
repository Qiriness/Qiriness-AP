import assert from 'node:assert/strict';
import test from 'node:test';

import { read, tablesIn } from './_shared.test.mjs';

const sql = read('01_foundation');

test('creates exactly the four tables it documents', () => {
  assert.deepEqual(tablesIn(sql).sort(), [
    'data_access_events',
    'integration_events',
    'privacy_requests',
    'shops'
  ]);
});

test('the extensions everything else depends on are created first', () => {
  // pgcrypto for gen_random_uuid(), vector for the two embedding columns in
  // 03 and 04. Both must precede the first table that uses them.
  const pgcrypto = sql.indexOf('create extension if not exists pgcrypto');
  const vector = sql.indexOf('create extension if not exists vector');
  const firstTable = sql.indexOf('create table public.');
  assert.ok(pgcrypto >= 0 && vector >= 0);
  assert.ok(pgcrypto < firstTable && vector < firstTable);
});

test('the shared updated_at trigger function is defined here, once', () => {
  // Every other file's triggers call it, so it belongs in the first file and
  // nowhere else.
  assert.match(sql, /create or replace function public\.set_updated_at/i);
  assert.equal(sql.match(/create or replace function public\.set_updated_at/gi).length, 1);
});

test('a shop is unique on its domain and carries the sync cursors', () => {
  assert.match(sql, /constraint shops_shop_domain_unique unique \(shop_domain\)/i);
  // The mail delta link lives in here, which is why ingestion can resume.
  assert.match(sql, /sync_cursors jsonb not null default '\{\}'::jsonb/i);
  assert.match(sql, /constraint shops_sync_cursors_object_check/i);
});

test('environment is constrained, so dev and production cannot blur', () => {
  assert.match(
    sql,
    /constraint shops_environment_check check \(\s*environment in \('development', 'staging', 'production'\)\s*\)/i
  );
});

test('the compliance metadata tables exist with idempotency keys', () => {
  // integration_events dedupes on event_key so a replayed webhook is a no-op.
  assert.match(sql, /create table public\.integration_events/i);
  assert.match(sql, /event_key text not null/i);
  assert.match(sql, /create table public\.privacy_requests/i);
});

test('the personal-data access trail is a first-class table', () => {
  // Sync paths and the agent's customer lookup both write here, and a future
  // dashboard user view must too.
  assert.match(sql, /create table public\.data_access_events/i);
  assert.match(sql, /create index data_access_events_shop_action_idx/i);
  assert.match(sql, /create index data_access_events_occurred_at_idx/i);
});

test('it holds no Shopify snapshot and no support table', () => {
  // Those are 02 and 04. This file is the part every other file depends on,
  // and it stays small enough to read in one go.
  for (const table of ['customers', 'orders', 'products', 'tickets', 'knowledge_documents']) {
    assert.doesNotMatch(sql, new RegExp(`create table public\\.${table}\\b`, 'i'));
  }
});
