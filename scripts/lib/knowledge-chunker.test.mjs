import assert from 'node:assert/strict';
import test from 'node:test';

import { buildKnowledgeChunks } from './knowledge-chunker.mjs';

function longText() {
  return Array.from({ length: 80 }, (_, i) => `Phrase numero ${i} qui rallonge artificiellement la reponse fournie.`).join(' ');
}

test('faq_item sections produce exactly one chunk regardless of length', () => {
  const text = longText();
  const documentRow = {
    id: 'doc-1',
    title: 'FAQ',
    category: 'faq',
    sections: [{ heading: 'Une question avec une longue reponse ?', text, order: 0, unit_type: 'faq_item' }]
  };

  const chunks = buildKnowledgeChunks(documentRow);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].chunk_text, text);
  assert.equal(chunks[0].section_heading, 'Une question avec une longue reponse ?');
});

test('feature_item sections also produce exactly one chunk', () => {
  const text = longText();
  const documentRow = {
    id: 'doc-2',
    title: 'Features',
    category: 'product_information',
    sections: [{ heading: 'Livraison offerte', text, order: 0, unit_type: 'feature_item' }]
  };

  const chunks = buildKnowledgeChunks(documentRow);
  assert.equal(chunks.length, 1);
});

test('legacy sections with no unit_type keep token-packed splitting behavior', () => {
  const text = longText();
  const documentRow = {
    id: 'doc-3',
    title: 'Policy',
    category: 'privacy',
    sections: [{ heading: 'Section', text, order: 0 }]
  };

  const chunks = buildKnowledgeChunks(documentRow);
  assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
});

test('an empty faq_item section text produces no chunks', () => {
  const documentRow = {
    id: 'doc-4',
    title: 'FAQ',
    category: 'faq',
    sections: [{ heading: 'Question vide', text: '', order: 0, unit_type: 'faq_item' }]
  };

  assert.deepEqual(buildKnowledgeChunks(documentRow), []);
});
