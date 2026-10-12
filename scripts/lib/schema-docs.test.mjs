import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as tables from './tables.mjs';

/**
 * Every table and view the code names is in the schema map.
 *
 * WHY. `docs/schema/database.md` is where a session looks first. On 2026-10-12
 * `dropped_mail_clears` and `dropped_mail_list` appeared nowhere in it, and four
 * more had no row in their domain's table (only a mention in the migration
 * list), so a reader could not learn what they held without scanning SQL. The
 * names live in `tables.mjs` (every `*_T` map and `V`), so the check is cheap.
 * It catches an absent name; whether the row is in the right table is review.
 */
const DOC = readFileSync(new URL('../../docs/schema/database.md', import.meta.url), 'utf8');

const named = Object.entries(tables)
  .filter(([key, value]) => (key === 'V' || /(^|_)T$/.test(key)) && value && typeof value === 'object')
  .flatMap(([, map]) => Object.values(map))
  .filter((name) => typeof name === 'string');

test('the schema map documents every table and view tables.mjs names', () => {
  assert.ok(named.length > 50, `expected the table maps, found ${named.length} names`);
  const missing = [...new Set(named)].filter((name) => !DOC.includes(`\`${name}\``) && !DOC.includes(`\`${name}(`));
  assert.deepEqual(missing, []);
});
