import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { SUBJECTS, REQUEST_KINDS, defaultLevel } from '../../scripts/lib/support-taxonomy.mjs';

const migration = readFileSync(new URL('./013_ticket_level_semantics.sql', import.meta.url), 'utf8');

// 013 exists to realign the database's own documentation with the level rule in
// support-taxonomy.mjs. These tests are what stop the two drifting apart again.

test('013 documents level 4 as a severity judgement, not a subject', () => {
  assert.match(migration, /comment on column public\.tickets\.level/i);
  assert.match(migration, /severity judgement/i);
  assert.match(migration, /threat of legal action/i);
  assert.match(migration, /hospitalisation/i);
  assert.match(migration, /grave injury/i);
});

test('the comments it writes do not re-state the removed always-4 rule', () => {
  // 012's exact wording, which this migration corrects. The file header quotes it
  // deliberately as history, so only the statements actually written to the
  // database are checked.
  assert.doesNotMatch(sqlWithoutComments(migration), /cosmetovigilance is always/i);
});

test('the documented rule matches the code: no subject derives level 4', () => {
  for (const subject of SUBJECTS) {
    for (const kind of REQUEST_KINDS) {
      assert.notEqual(defaultLevel(subject, kind), 4, `${subject}/${kind}`);
    }
  }
});

test('013 changes documentation only — no schema or constraint change', () => {
  for (const line of sqlWithoutComments(migration).split('\n')) {
    assert.doesNotMatch(line, /^\s*(alter|create|drop|update|insert|delete)\b/i, line);
  }
});

/** The statements actually sent to the database, without the `--` rationale. */
function sqlWithoutComments(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}
