import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const migration = readFileSync(
  new URL('./005_fix_core_topic_check_constraint.sql', import.meta.url),
  'utf8'
);

test('core_topic constraint fix recreates the check with the combined delivery_returns slot', () => {
  assert.match(migration, /drop constraint knowledge_documents_core_topic_check/i);

  const addClause = migration.match(
    /add constraint knowledge_documents_core_topic_check check \(([\s\S]*?)\);/i
  );
  assert.ok(addClause, 'expected to find the re-added core_topic check constraint');
  assert.match(addClause[1], /'delivery_returns'/);
  assert.doesNotMatch(addClause[1], /'returns_exchanges'/);
  assert.doesNotMatch(addClause[1], /'delivery'\s*,/);
});
