import assert from 'node:assert/strict';
import test from 'node:test';

import { KNOWLEDGE_CATEGORIES } from '../../scripts/lib/support-taxonomy.mjs';
import { checkClause, codeOnly, literalsIn, read } from './_shared.test.mjs';

const SQL = read('58_faq_articles');
const KNOWLEDGE = read('03_knowledge');

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const CATEGORY = 'knowledge_documents_category_check';

test('58 carries the baseline check, not a retyped one', () => {
  assert.ok(checkClause(SQL, CATEGORY));
  assert.equal(squash(checkClause(SQL, CATEGORY)), squash(checkClause(KNOWLEDGE, CATEGORY)));
});

test('the check is the article vocabulary, and other is not in it', () => {
  assert.deepEqual(literalsIn(checkClause(SQL, CATEGORY)), [...KNOWLEDGE_CATEGORIES].sort());
  assert.ok(!literalsIn(checkClause(SQL, CATEGORY)).includes('other'));
});

test('articles and chunks under other move to faq before the check narrows', () => {
  const code = codeOnly(SQL);
  const narrow = code.search(new RegExp(`add constraint ${CATEGORY}`));
  for (const table of ['knowledge_documents', 'knowledge_chunks']) {
    const move = code.search(
      new RegExp(`update public\.${table} set category = 'faq' where category = 'other'`)
    );
    assert.ok(move >= 0 && narrow > move, table);
  }
  const writes = code.split('\n').filter((line) => /^\s*(insert|update|delete)\s+/i.test(line));
  assert.equal(writes.length, 2);
});

test('the column comment matches the baseline', () => {
  const comment = (sql) => sql.match(/comment on column public\.knowledge_documents\.category is\s+'([\s\S]*?)';/)?.[1];
  assert.ok(comment(SQL));
  assert.equal(comment(SQL), comment(KNOWLEDGE));
});
