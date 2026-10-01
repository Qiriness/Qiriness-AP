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
    category: 'product',
    sections: [{ heading: 'Livraison offerte', text, order: 0, unit_type: 'feature_item' }]
  };

  const chunks = buildKnowledgeChunks(documentRow);
  assert.equal(chunks.length, 1);
});

test('an FAQ section under the ceiling stays one chunk, past the old 450-token packing size', () => {
  // ~830 tokens: one question, its rewordings and a long answer.
  const text = longText();
  const documentRow = {
    id: 'doc-3',
    title: 'Commandes',
    category: 'order',
    sections: [{ heading: 'Où en est ma commande ?', text, order: 0 }]
  };

  const chunks = buildKnowledgeChunks(documentRow);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].chunk_text, text);
});

test('a section past the FAQ ceiling is not FAQ-shaped and is token-packed', () => {
  const text = `${longText()} ${longText()}`;
  const documentRow = {
    id: 'doc-3b',
    title: 'Conditions générales',
    category: 'legal_privacy',
    sections: [{ heading: 'Section', text, order: 0 }]
  };

  const chunks = buildKnowledgeChunks(documentRow);
  assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
});

test('a brand story is not an FAQ and keeps token-packed splitting', () => {
  const documentRow = {
    id: 'doc-3c',
    title: 'La Marque',
    category: 'brand_story',
    sections: [{ heading: 'Section', text: longText(), order: 0 }]
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
