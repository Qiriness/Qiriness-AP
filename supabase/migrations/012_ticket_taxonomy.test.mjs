import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { SUBJECTS, REQUEST_KINDS, KNOWLEDGE_CATEGORIES } from '../../scripts/lib/support-taxonomy.mjs';

const knowledgeMigration = readFileSync(
  new URL('./011_support_taxonomy_knowledge.sql', import.meta.url),
  'utf8'
);
const ticketMigration = readFileSync(new URL('./012_ticket_taxonomy.sql', import.meta.url), 'utf8');

// The migrations spell the vocabulary out in SQL (a check constraint cannot import
// a JS module), so these tests are what stop the two drifting apart.

test('011 constrains knowledge_documents.category to every taxonomy value', () => {
  const constraint = knowledgeMigration.match(
    /add constraint knowledge_documents_category_check check \(([\s\S]*?)\n {2}\);/i
  )?.[1];
  assert.ok(constraint, 'expected a category check constraint in 011');
  for (const category of KNOWLEDGE_CATEGORIES) {
    assert.ok(constraint.includes(`'${category}'`), `011 is missing '${category}'`);
  }
  assert.match(constraint, /category is null or/i, 'an uncategorised article must stay valid');
});

test('011 renames every old knowledge category', () => {
  const renames = [
    ['shipping_delivery', 'delivery'],
    ['returns_refunds', 'return_exchange'],
    ['product_information', 'product'],
    ['payments', 'payment'],
    ['stock', 'product_stock'],
    ['b2b_partnerships', 'b2b'],
    ['general', 'other']
  ];
  for (const [from, to] of renames) {
    assert.match(
      knowledgeMigration,
      new RegExp(`set category = '${to}' where category = '${from}'`, 'i'),
      `011 should rename ${from} -> ${to} on documents`
    );
  }
  // privacy and legal merge into one value.
  assert.match(
    knowledgeMigration,
    /set category = 'legal_privacy' where category in \('privacy', 'legal'\)/i
  );
});

test('011 renames chunk categories too, since category is denormalised there', () => {
  const chunkUpdates = knowledgeMigration.match(/update public\.knowledge_chunks[^;]*;/gi) || [];
  assert.ok(chunkUpdates.length >= 7, 'expected the chunk renames to mirror the document renames');
});

test('011 leaves NULL categories alone', () => {
  assert.doesNotMatch(
    knowledgeMigration,
    /update public\.knowledge_documents set category = '[a-z_]+' where category is null/i,
    'a NULL category is a real state and must not be back-filled'
  );
});

test('012 adds both request_kind columns', () => {
  assert.match(ticketMigration, /add column request_kind text/i);
  assert.match(ticketMigration, /add column secondary_request_kind text/i);
});

test('012 constrains both subject columns to the 14 ticket subjects only', () => {
  for (const constraintName of ['tickets_category_check', 'tickets_secondary_category_check']) {
    const constraint = ticketMigration.match(
      new RegExp(`add constraint ${constraintName} check \\(([\\s\\S]*?)\\n {2}\\)`, 'i')
    )?.[1];
    assert.ok(constraint, `expected ${constraintName}`);
    for (const subject of SUBJECTS) {
      assert.ok(constraint.includes(`'${subject}'`), `${constraintName} is missing '${subject}'`);
    }
    // Knowledge-only shapes must NOT be valid ticket subjects.
    assert.ok(!constraint.includes("'faq'"), `${constraintName} should not allow faq`);
    assert.ok(!constraint.includes("'brand_story'"), `${constraintName} should not allow brand_story`);
  }
});

test('012 constrains both kind columns to the four kinds', () => {
  for (const constraintName of ['tickets_request_kind_check', 'tickets_secondary_request_kind_check']) {
    const constraint = ticketMigration.match(
      new RegExp(`add constraint ${constraintName} check \\(([\\s\\S]*?)\\n {2}\\)`, 'i')
    )?.[1];
    assert.ok(constraint, `expected ${constraintName}`);
    for (const kind of REQUEST_KINDS) {
      assert.ok(constraint.includes(`'${kind}'`), `${constraintName} is missing '${kind}'`);
    }
  }
});

test('012 forbids a secondary kind without a secondary subject', () => {
  assert.match(
    ticketMigration,
    /add constraint tickets_secondary_pair_check check \(\s*secondary_request_kind is null or secondary_category is not null\s*\)/i
  );
});

test('012 indexes the queue filter on subject + kind', () => {
  assert.match(
    ticketMigration,
    /create index tickets_shop_category_kind_idx\s+on public\.tickets \(shop_id, category, request_kind\)/i
  );
});
