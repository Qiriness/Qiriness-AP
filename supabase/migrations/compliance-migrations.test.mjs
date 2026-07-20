import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const migration = readFileSync(new URL('./001_initial_schema.sql', import.meta.url), 'utf8');

test('compliance migration creates required metadata tables', () => {
  assert.match(migration, /create table public\.privacy_requests/i);
  assert.match(migration, /create table public\.integration_events/i);
  assert.match(migration, /create table public\.data_access_events/i);
});

test('compliance migration enables RLS on metadata tables', () => {
  assert.match(migration, /alter table public\.privacy_requests enable row level security/i);
  assert.match(migration, /alter table public\.integration_events enable row level security/i);
  assert.match(migration, /alter table public\.data_access_events enable row level security/i);
});

test('compliance migration adds lookup and idempotency support', () => {
  assert.match(migration, /constraint integration_events_event_key_unique unique \(event_key\)/i);
  assert.match(migration, /constraint privacy_requests_request_key_unique unique \(request_key\)/i);
  assert.match(migration, /create index privacy_requests_status_idx/i);
  assert.match(migration, /create index data_access_events_resource_idx/i);
});
