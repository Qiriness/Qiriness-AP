import assert from 'node:assert/strict';
import test from 'node:test';

import { getOrderedSections } from './template-traversal.mjs';
import { faqPageTemplateFixture } from './template-extractors/__fixtures__/faq-page-template.fixture.mjs';

test('excludes disabled sections by default and preserves order-array positions', () => {
  const sections = getOrderedSections(faqPageTemplateFixture);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].sectionId, 'faq_XnTkzc');
  assert.equal(sections[0].type, 'faq');
  assert.equal(sections[0].position, 2);
});

test('includeDisabled:true returns every section including placeholders', () => {
  const sections = getOrderedSections(faqPageTemplateFixture, { includeDisabled: true });
  assert.equal(sections.length, 3);
  assert.deepEqual(sections.map((section) => section.position), [0, 1, 2]);
});

test('blocks follow block_order and drop disabled blocks', () => {
  const template = {
    order: ['section-a'],
    sections: {
      'section-a': {
        type: 'faq',
        block_order: ['b1', 'b2', 'b3'],
        blocks: {
          b1: { type: 'question', settings: { title: 'Q1', text: 'A1' } },
          b2: { type: 'question', disabled: true, settings: { title: 'Q2', text: 'A2' } },
          b3: { type: 'question', settings: { title: 'Q3', text: 'A3' } }
        }
      }
    }
  };

  const [section] = getOrderedSections(template);
  assert.deepEqual(section.blocks.map((block) => block.blockId), ['b1', 'b3']);
  assert.deepEqual(section.blocks.map((block) => block.position), [0, 2]);
});

test('falls back to Object.keys order when template.order is missing', () => {
  const template = {
    sections: {
      only: { type: 'rich-text', settings: {}, blocks: {} }
    }
  };

  const sections = getOrderedSections(template);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].sectionId, 'only');
});

test('is deterministic across repeated calls', () => {
  const first = getOrderedSections(faqPageTemplateFixture, { includeDisabled: true });
  const second = getOrderedSections(faqPageTemplateFixture, { includeDisabled: true });
  assert.deepEqual(first, second);
});
