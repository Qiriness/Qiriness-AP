import assert from 'node:assert/strict';
import test from 'node:test';

import { createThemeTemplateResolver } from './theme-template-resolver.mjs';
import { faqPageTemplateFixture } from '../template-extractors/__fixtures__/faq-page-template.fixture.mjs';

function buildThemeClient(assetKey, templateValue) {
  return {
    mainTheme: { id: 1, name: 'test-theme', role: 'main' },
    unavailableReason: null,
    assetCache: new Map([[assetKey, { value: JSON.stringify(templateValue) }]])
  };
}

test('resolves one section per FAQ question, correctly categorized, excluding placeholders', async () => {
  const themeClient = buildThemeClient('templates/page.faq.json', faqPageTemplateFixture);
  const resolver = createThemeTemplateResolver(themeClient);
  const source = { title: 'FAQ', handle: 'faq', page: { templateSuffix: 'faq' } };

  const result = await resolver.resolve(source);

  assert.equal(result.found, true);
  assert.equal(result.origin, 'theme_template');
  assert.equal(result.sections.length, 11);
  assert.ok(!result.text.includes('Example title'));

  assert.equal(result.sections[0].unit_type, 'faq_item');
  assert.equal(result.sections[0].metadata.category, 'Ma commande');
  assert.notEqual(result.sections[0].heading, 'Ma commande');

  const headings = result.sections.map((section) => section.heading);
  assert.equal(new Set(headings).size, 11);

  assert.deepEqual(
    result.sections.map((section) => section.order),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
});

test('returns found:false when the template asset is unavailable', async () => {
  const themeClient = {
    mainTheme: { id: 1, name: 'test-theme', role: 'main' },
    unavailableReason: null,
    assetCache: new Map([
      ['templates/page.faq.json', null],
      ['templates/page.faq.liquid', null],
      ['templates/page.json', null],
      ['templates/page.liquid', null]
    ])
  };
  const resolver = createThemeTemplateResolver(themeClient);
  const source = { title: 'FAQ', handle: 'faq', page: { templateSuffix: 'faq' } };

  const result = await resolver.resolve(source);
  assert.equal(result.found, false);
  assert.equal(result.reason, 'missing_theme_template_text');
});
