import assert from 'node:assert/strict';
import test from 'node:test';

import { extractAccordionSection } from './accordion.mjs';

function block(blockId, type, settings, position = 0) {
  return { blockId, type, position, settings };
}

test('one feature_item per real block', () => {
  const section = {
    sectionId: 's1',
    type: 'advanced-accordion',
    position: 0,
    settings: {},
    blocks: [block('b1', 'text_block', { title: 'Livraison offerte', text: "<p>Dès 50€ d'achat.</p>" }, 0)]
  };

  const units = extractAccordionSection(section);
  assert.equal(units.length, 1);
  assert.equal(units[0].type, 'feature_item');
  assert.equal(units[0].heading, 'Livraison offerte');
});

test('starter-theme placeholder blocks are excluded even when the section is enabled', () => {
  const section = {
    sectionId: 's1',
    type: 'advanced-accordion',
    position: 0,
    settings: {},
    blocks: [
      block(
        'b1',
        'text_block',
        {
          title: 'Example title',
          text: 'Use this section to explain a set of product features, to link to a series of pages, or to answer common questions about your products. Add images for emphasis.'
        },
        0
      )
    ]
  };

  assert.deepEqual(extractAccordionSection(section), []);
});
