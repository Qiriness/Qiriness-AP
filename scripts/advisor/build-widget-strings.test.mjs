import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { OUTPUT, buildWidgetStrings } from './build-widget-strings.mjs';

// The widget's words for a page whose language is not Shopify's (Weglot, owner 2026-11-02).
function load({ weglot = null, path = '/', htmlLang = 'fr' } = {}) {
  const window = { Weglot: weglot, location: { pathname: path } };
  vm.runInNewContext(fs.readFileSync(OUTPUT, 'utf8'), { window, document: { documentElement: { lang: htmlLang } }, setTimeout });
  return window.StorefrontAdvisorStrings;
}
const config = (custom = {}) => ({
  shopName: 'Maison Test',
  custom,
  context: { locale: 'fr' },
  strings: { greeting: 'Bonjour !', title: 'Conseiller Beauté Maison Test', routine: { total: 'Routine' } },
  banner: { text: 'Une routine ?', button: 'Construire', close: 'Fermer' },
  quickActions: [{ id: 'find_product', label: 'Trouver mon soin' }, { id: 'build_routine', label: 'Construire ma routine' }]
});

test('advisor-strings.js is up to date with the embed and the locale files (npm run advisor:widget-strings)', () => {
  // Line endings aside: Git may check the file out with CRLF on Windows.
  assert.equal(fs.readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n'), buildWidgetStrings());
});

test('the language comes from Weglot, else the URL, else the page; only one the widget has', () => {
  assert.equal(load({ weglot: { getCurrentLang: () => 'de' } }).detect(), 'de');
  assert.equal(load({ path: '/nl/products/x' }).detect(), 'nl');
  assert.equal(load({ htmlLang: 'it-IT' }).detect(), 'it');
  assert.equal(load({ htmlLang: 'pt' }).detect(), '');
});

test('German words replace the French ones, with the shop name; a greeting the merchant wrote stays theirs', () => {
  const words = load();
  const c = config();
  assert.equal(words.apply(c, 'de'), true);
  assert.match(c.strings.greeting, /^Guten Tag! .*Maison Test/);
  assert.equal(c.strings.title, 'Beauty-Beraterin');
  assert.equal(c.quickActions[0].label, 'Meine Pflege finden');
  assert.notEqual(c.strings.routine.total, 'Routine');
  assert.equal(c.context.locale, 'de', 'the chat is asked in German too');
  const own = config({ greeting: true, bannerText: true });
  words.apply(own, 'de');
  assert.equal(own.strings.greeting, 'Bonjour !');
  assert.equal(own.banner.text, 'Une routine ?');
  assert.notEqual(own.banner.button, 'Construire');
});
