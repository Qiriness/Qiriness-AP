import assert from 'node:assert/strict';
import test from 'node:test';

import { extractGenericSection } from './generic-fallback.mjs';

test('extracts only allowlisted keys, ignoring presentation values', () => {
  const section = {
    sectionId: 's1',
    type: 'unknown-section',
    position: 0,
    settings: {
      title: 'Vrai titre',
      align_text: 'left',
      heading_position: 'center',
      custom_css: ['.foo {}']
    },
    blocks: []
  };

  const units = extractGenericSection(section);
  assert.equal(units.length, 1);
  assert.equal(units[0].confidence, 'low');
  assert.equal(units[0].text, 'Vrai titre');
  assert.ok(!units[0].text.includes('left'));
  assert.ok(!units[0].text.includes('center'));
});

test('extracts prose from liquid-type block code at low confidence', () => {
  const section = {
    sectionId: 's1',
    type: 'advanced-content',
    position: 0,
    settings: {},
    blocks: [
      {
        blockId: 'b1',
        type: 'liquid',
        position: 0,
        settings: { code: "<p>Depuis 21 ans, Qiriness puise dans l'energie vitale.</p>" }
      }
    ]
  };

  const units = extractGenericSection(section);
  assert.equal(units.length, 1);
  assert.equal(units[0].confidence, 'low');
  assert.equal(units[0].text, "Depuis 21 ans, Qiriness puise dans l'energie vitale.");
});

test('strips an inline base64 image embedded alongside liquid block prose', () => {
  const section = {
    sectionId: 's1',
    type: 'advanced-content',
    position: 0,
    settings: {},
    blocks: [
      {
        blockId: 'b1',
        type: 'liquid',
        position: 0,
        settings: {
          code:
            '<p style="text-align:center"><img src="data:image/svg+xml;base64,QUJDREVGRw==" width="212" height="150"></p>' +
            "<p>Depuis 21 ans, Qiriness puise dans l'energie vitale du Qi.</p>"
        }
      }
    ]
  };

  const [unit] = extractGenericSection(section);
  assert.ok(!unit.text.includes('base64'));
  assert.ok(!unit.text.includes('QUJDREVGRw'));
  assert.match(unit.text, /Qiriness puise dans l'energie vitale/);
});

test('a liquid block with no recoverable prose (pure markup/CSS) yields nothing', () => {
  const section = {
    sectionId: 's1',
    type: 'advanced-content',
    position: 0,
    settings: {},
    blocks: [
      {
        blockId: 'b1',
        type: 'liquid',
        position: 0,
        settings: { code: '<style>.foo { color: red; }</style><img src="data:image/svg+xml;base64,QUJD" />' }
      }
    ]
  };

  assert.deepEqual(extractGenericSection(section), []);
});

test('returns no unit when nothing recognized is present', () => {
  const section = { sectionId: 's1', type: 'gallery', position: 0, settings: { image_crop: 'landscape' }, blocks: [] };
  assert.deepEqual(extractGenericSection(section), []);
});

test('"Example title" placeholder is excluded even under a recognized key', () => {
  const section = {
    sectionId: 's1',
    type: 'unknown-section',
    position: 0,
    settings: { title: 'Example title' },
    blocks: []
  };

  assert.deepEqual(extractGenericSection(section), []);
});
