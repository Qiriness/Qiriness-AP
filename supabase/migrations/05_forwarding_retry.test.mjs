import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_FORWARD_ATTEMPTS } from '../../agent/src/routing/forwarding-store.mjs';

const migration = readFileSync(new URL('./05_forwarding_retry.sql', import.meta.url), 'utf8');

test('it adds the attempts counter retry depends on', () => {
  assert.match(migration, /add column attempts integer not null default 1/);
});

test('it only alters, never migrates data', () => {
  // The 42 failed rows from the first run are retried by the new selection
  // rule, not deleted — so there is nothing for this migration to clean up.
  for (const line of migration.split('\n').filter((l) => !l.trim().startsWith('--'))) {
    assert.doesNotMatch(line, /^\s*(update|insert|delete)\s+/i, line);
  }
});

test('the retry cap is a real number the store enforces', () => {
  assert.ok(Number.isInteger(MAX_FORWARD_ATTEMPTS) && MAX_FORWARD_ATTEMPTS > 1);
});
