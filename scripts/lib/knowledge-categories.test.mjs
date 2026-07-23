import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { KNOWLEDGE_CATEGORIES } from './knowledge-categories.mjs';

const typesSource = readFileSync(new URL('../../web/lib/types.ts', import.meta.url), 'utf8');

test('web/lib/types.ts KNOWLEDGE_CATEGORIES stays in sync with scripts/lib/knowledge-categories.mjs', () => {
  const match = typesSource.match(
    /export const KNOWLEDGE_CATEGORIES: KnowledgeCategory\[\] = \[([\s\S]*?)\];/
  );
  assert.ok(match, 'expected to find a KNOWLEDGE_CATEGORIES array in web/lib/types.ts');

  const uiCategories = match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

  assert.deepEqual(
    uiCategories,
    KNOWLEDGE_CATEGORIES,
    'web/lib/types.ts KNOWLEDGE_CATEGORIES has drifted from scripts/lib/knowledge-categories.mjs — keep both lists in sync'
  );
});
