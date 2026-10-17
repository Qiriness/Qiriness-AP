import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * "The newest `updated_at`" is asked for as plain `updated_at.desc`.
 *
 * WHY. `updated_at` is NOT NULL on every table, so `desc.nullslast` returns the
 * same row, but it is the reverse of the (shop_id, updated_at) btree and
 * Postgres reads and sorts every row of the shop instead of one index entry.
 * The change gate and the customer index stamp did this every poll: the two
 * largest statements by blocks, and 1.6 s a call on customers (2026-10-17).
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('no updated_at read orders by desc.nullslast', () => {
  const files = execSync('git ls-files agent scripts web storefront-app', { cwd: ROOT }).toString().trim().split('\n')
    .filter((f) => /\.(mjs|js|ts|tsx)$/.test(f) && !/\.test\./.test(f));
  const offenders = files.filter((f) => /updated_at\.desc\.nullslast/.test(readFileSync(`${ROOT}${f}`, 'utf8')));
  assert.deepEqual(offenders, []);
});
