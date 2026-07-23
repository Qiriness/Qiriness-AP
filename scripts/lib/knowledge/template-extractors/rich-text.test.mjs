import assert from 'node:assert/strict';
import test from 'node:test';

import { extractRichTextSection } from './rich-text.mjs';

function block(blockId, type, settings, position = 0) {
  return { blockId, type, position, settings };
}

test('builds one prose unit from heading/text blocks', () => {
  const section = {
    sectionId: 's1',
    type: 'rich-text',
    position: 0,
    settings: {},
    blocks: [
      block('h', 'heading', { title: '<em>Les</em> 4 Piliers' }, 0),
      block('t', 'text', { text: '<p>Un vrai paragraphe sur la marque.</p>' }, 1)
    ]
  };

  const units = extractRichTextSection(section);
  assert.equal(units.length, 1);
  assert.equal(units[0].type, 'prose');
  assert.equal(units[0].heading, 'Les 4 Piliers');
  assert.equal(units[0].text, 'Un vrai paragraphe sur la marque.');
});

test('starter-theme placeholder heading/text blocks are excluded entirely', () => {
  const section = {
    sectionId: 's1',
    type: 'rich-text',
    position: 0,
    settings: {},
    blocks: [
      block('h', 'heading', { title: '<em>Rich</em> text' }, 0),
      block(
        't',
        'text',
        {
          text: '<p>Use this text to share information about your brand with your customers. Describe a product, share announcements, or welcome customers to your store.</p>'
        },
        1
      )
    ]
  };

  assert.deepEqual(extractRichTextSection(section), []);
});

test('falls back to flat section.settings when there are no content blocks', () => {
  const section = {
    sectionId: 's2',
    type: 'background-image-text',
    position: 1,
    settings: {
      title: "L'Art du Rituel",
      subtitle: 'Rendre à la peau son équilibre',
      text: '<p></p>',
      heading_size: 'h1',
      layout: 'left'
    },
    blocks: []
  };

  const units = extractRichTextSection(section);
  assert.equal(units.length, 1);
  assert.equal(units[0].heading, "L'Art du Rituel");
  assert.equal(units[0].text, 'Rendre à la peau son équilibre');
});

test('produces no unit when a section has neither content blocks nor recognized settings', () => {
  const section = { sectionId: 's3', type: 'rich-text', position: 0, settings: { align_text: 'center' }, blocks: [] };
  assert.deepEqual(extractRichTextSection(section), []);
});
