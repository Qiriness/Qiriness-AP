import assert from 'node:assert/strict';
import test from 'node:test';

import { extractSemanticUnits } from './index.mjs';
import { faqPageTemplateFixture } from './__fixtures__/faq-page-template.fixture.mjs';

test('extracts only the real faq units from a template with disabled placeholder sections', () => {
  const units = extractSemanticUnits(faqPageTemplateFixture);
  assert.equal(units.length, 11);
  assert.ok(units.every((unit) => unit.type === 'faq_item'));
  assert.ok(!units.some((unit) => unit.question === 'Example title'));
  assert.ok(!units.some((unit) => unit.answer.includes('Example title')));
});

test('is deterministic', () => {
  const first = extractSemanticUnits(faqPageTemplateFixture);
  const second = extractSemanticUnits(faqPageTemplateFixture);
  assert.deepEqual(first, second);
});

test('unrecognized section types fall back to the generic low-confidence adapter', () => {
  const template = {
    order: ['s1'],
    sections: {
      s1: { type: 'slideshow', settings: { title: 'Titre du slide' }, blocks: {} }
    }
  };

  const units = extractSemanticUnits(template);
  assert.equal(units.length, 1);
  assert.equal(units[0].type, 'generic');
  assert.equal(units[0].confidence, 'low');
});
