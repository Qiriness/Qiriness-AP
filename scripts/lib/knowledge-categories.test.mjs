import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { KNOWLEDGE_CATEGORIES, FALLBACK_CATEGORY, inferKnowledgeCategory } from './knowledge-categories.mjs';
import { isKnowledgeCategory } from './support-taxonomy.mjs';

const typesSource = readFileSync(new URL('../../web/lib/types.ts', import.meta.url), 'utf8');
const serviceSource = readFileSync(
  new URL('../../web/lib/server/knowledge-service.ts', import.meta.url),
  'utf8'
);
const mapperSource = readFileSync(new URL('../../web/lib/knowledge-mapper.ts', import.meta.url), 'utf8');

function uiList(name, source) {
  const match = source.match(
    new RegExp(`export const ${name}: KnowledgeCategory\\[\\] = \\[([\\s\\S]*?)\\];`)
  );
  assert.ok(match, `expected to find a ${name} array`);
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

test('web/lib/types.ts KNOWLEDGE_CATEGORIES stays in sync with the shared taxonomy', () => {
  assert.deepEqual(
    uiList('KNOWLEDGE_CATEGORIES', typesSource),
    KNOWLEDGE_CATEGORIES,
    'web/lib/types.ts KNOWLEDGE_CATEGORIES has drifted from scripts/lib/support-taxonomy.mjs — keep both lists in sync'
  );
});

test('every category has a UI label', () => {
  const labels = typesSource.match(
    /export const CATEGORY_LABELS: Record<KnowledgeCategory, string> = \{([\s\S]*?)\};/
  )?.[1];
  assert.ok(labels, 'expected a CATEGORY_LABELS record');
  for (const category of KNOWLEDGE_CATEGORIES) {
    assert.match(labels, new RegExp(`\\b${category}:`), `CATEGORY_LABELS is missing ${category}`);
  }
});

test('core-topic default categories are all valid categories', () => {
  const defaults = typesSource.match(
    /export const CORE_TOPIC_DEFAULT_CATEGORY: Record<CoreTopic, KnowledgeCategory> = \{([\s\S]*?)\};/
  )?.[1];
  assert.ok(defaults, 'expected a CORE_TOPIC_DEFAULT_CATEGORY record');
  const values = [...defaults.matchAll(/:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(values.length >= 6, 'expected a default per core topic');
  for (const value of values) {
    assert.ok(isKnowledgeCategory(value), `CORE_TOPIC_DEFAULT_CATEGORY has invalid category "${value}"`);
  }
});

// These two write/read the category against a database that now has a check
// constraint (03_categorisation.sql), so an out-of-vocabulary literal here is a
// runtime failure.
test('server-side and client-side category fallbacks are valid categories', () => {
  const serverFallback = serviceSource.match(/category: input\.category \|\| "([a-z_]+)"/)?.[1];
  assert.ok(serverFallback, 'expected a category fallback in knowledge-service.ts');
  assert.ok(
    isKnowledgeCategory(serverFallback),
    `knowledge-service.ts falls back to "${serverFallback}", which is not a valid category`
  );

  const mapperFallback = mapperSource.match(/\?\s*\(raw\.category as KnowledgeCategory\)\s*:\s*"([a-z_]+)"/)?.[1];
  assert.ok(mapperFallback, 'expected a category fallback in knowledge-mapper.ts');
  assert.ok(
    isKnowledgeCategory(mapperFallback),
    `knowledge-mapper.ts falls back to "${mapperFallback}", which is not a valid category`
  );
});

test('inference only ever returns a valid category', () => {
  const samples = [
    ['Livraison et expédition', 'livraison', 'Nos délais de livraison'],
    ['Retours et échanges', 'retours', 'Politique de retour'],
    ['Ingrédients', 'ingredients', 'Composition et actifs'],
    ['Recrutement', 'nous-rejoindre', 'Envoyez votre candidature'],
    ['Effet indésirable', 'cosmetovigilance', 'Réaction allergique'],
    ['Rupture de stock', 'stock', 'Produit épuisé'],
    ['Mentions légales', 'cgv', 'Conditions générales de vente'],
    ['Quelque chose sans rapport', 'xyz', 'aucun terme connu']
  ];
  for (const sample of samples) {
    const category = inferKnowledgeCategory(...sample);
    assert.ok(isKnowledgeCategory(category), `inferred invalid category "${category}" for ${sample[0]}`);
  }
});

test('inference maps representative pages to the expected category', () => {
  assert.equal(inferKnowledgeCategory('Livraison', 'livraison', ''), 'delivery');
  assert.equal(inferKnowledgeCategory('Retours et échanges', 'retours', ''), 'return_exchange');
  assert.equal(inferKnowledgeCategory('Ingrédients', 'ingredients', ''), 'product');
  assert.equal(inferKnowledgeCategory('Nous rejoindre', 'nous-rejoindre', ''), 'careers');
  assert.equal(inferKnowledgeCategory('Cosmétovigilance', 'cosmetovigilance', ''), 'cosmetovigilance');
  assert.equal(inferKnowledgeCategory('La Marque', 'la-marque', ''), 'brand_story');
  assert.equal(inferKnowledgeCategory('FAQ', 'faq', ''), 'faq');
});

test('the fallback is the taxonomy catch-all', () => {
  assert.equal(FALLBACK_CATEGORY, 'other');
  assert.ok(isKnowledgeCategory(FALLBACK_CATEGORY));
  assert.equal(inferKnowledgeCategory('', '', ''), 'other');
});
