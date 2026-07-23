import assert from 'node:assert/strict';
import test from 'node:test';

import { getOrderedSections } from '../template-traversal.mjs';
import { extractFaqSection } from './faq.mjs';
import { faqPageTemplateFixture } from './__fixtures__/faq-page-template.fixture.mjs';

test('extracts exactly one faq_item per question, tagged with the preceding category', () => {
  const [faqSection] = getOrderedSections(faqPageTemplateFixture);
  const units = extractFaqSection(faqSection);

  assert.equal(units.length, 11);
  assert.ok(units.every((unit) => unit.type === 'faq_item'));

  assert.deepEqual(units.map((unit) => unit.category), [
    'Ma commande', 'Ma commande', 'Ma commande', 'Ma commande',
    'Livraison et retour', 'Livraison et retour',
    'Autres questions', 'Autres questions', 'Autres questions', 'Autres questions', 'Autres questions'
  ]);

  const questions = new Set(units.map((unit) => unit.question));
  assert.equal(questions.size, 11);
});

test('questions remain separate semantic units in deterministic block_order order', () => {
  const [faqSection] = getOrderedSections(faqPageTemplateFixture);
  const units = extractFaqSection(faqSection);
  const positions = units.map((unit) => unit.sourceRef.position);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.equal(new Set(positions).size, positions.length);
});
