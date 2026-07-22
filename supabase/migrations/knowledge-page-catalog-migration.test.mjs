import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const migration = readFileSync(new URL('./003_knowledge_page_catalog.sql', import.meta.url), 'utf8');

test('knowledge page catalog migration creates a unified, minimal content source catalog', () => {
  assert.match(migration, /create table public\.shopify_content_sources/i);
  assert.match(migration, /source_type text not null/i);
  assert.match(migration, /shopify_source_id text not null/i);
  assert.match(
    migration,
    /constraint shopify_content_sources_shop_source_unique unique \(shop_id, source_type, shopify_source_id\)/i
  );
  assert.match(
    migration,
    /constraint shopify_content_sources_source_type_check check \(source_type in \('shopify_page', 'shopify_policy'\)\)/i
  );
});

test('knowledge page catalog migration keeps the catalog free of page/policy body content', () => {
  const tableDefinition = migration.match(/create table public\.shopify_content_sources \(([\s\S]*?)\n\);/i)?.[1] || '';
  assert.doesNotMatch(tableDefinition, /^\s*body\s+\w+/im);
  assert.doesNotMatch(tableDefinition, /^\s*content\s+\w+/im);
  assert.doesNotMatch(tableDefinition, /^\s*sections\s+\w+/im);
});

test('knowledge page catalog migration enables lookup index and RLS', () => {
  assert.match(
    migration,
    /create index shopify_content_sources_shop_type_idx on public\.shopify_content_sources \(shop_id, source_type\)/i
  );
  assert.match(migration, /alter table public\.shopify_content_sources enable row level security/i);
});

test('knowledge page catalog migration adds the agent-workflow columns to knowledge_documents', () => {
  assert.match(migration, /add column content_html text/i);
  assert.match(migration, /add column approval_status text not null default 'draft'/i);
  assert.match(migration, /add column core_topic text/i);
});

test('knowledge page catalog migration does not add a separate locally-modified flag', () => {
  // The manual-edit lock is a knowledge_documents.source_type transition to
  // 'manual', not a boolean column — assert the old design didn't creep back in.
  assert.doesNotMatch(migration, /is_locally_modified/i);
});

test('knowledge page catalog migration restricts approval_status to the four agent workflow states', () => {
  assert.match(
    migration,
    /approval_status in \(\s*'draft', 'in_review', 'approved', 'needs_optimization'\s*\)/i
  );
});

test('knowledge page catalog migration restricts core_topic to the six required slugs', () => {
  const coreTopics = [
    'order_policies',
    'brand',
    'confidentiality',
    'delivery_returns',
    'locations',
    'faqs'
  ];

  for (const topic of coreTopics) {
    assert.match(migration, new RegExp(`'${topic}'`));
  }
});

test('knowledge page catalog migration enforces one active article per core topic per shop', () => {
  assert.match(
    migration,
    /create unique index knowledge_documents_shop_core_topic_unique\s+on public\.knowledge_documents \(shop_id, core_topic\)\s+where core_topic is not null/i
  );
});
