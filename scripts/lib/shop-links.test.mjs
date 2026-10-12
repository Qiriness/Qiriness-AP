import test from 'node:test';
import assert from 'node:assert/strict';

import { markCurrentShop, parseShopLinks } from './shop-links.mjs';

test('parses name|url pairs and keeps only the origin', () => {
  assert.deepEqual(parseShopLinks('Alpha|https://alpha.example/path?x=1, Beta | http://beta.example:3000/'), [
    { name: 'Alpha', url: 'https://alpha.example' },
    { name: 'Beta', url: 'http://beta.example:3000' }
  ]);
});

test('unset or blank gives no switcher', () => {
  assert.deepEqual(parseShopLinks(undefined), []);
  assert.deepEqual(parseShopLinks(''), []);
  assert.deepEqual(parseShopLinks('   '), []);
});

test('skips malformed entries without dropping the good ones', () => {
  assert.deepEqual(
    parseShopLinks('nourl,|https://noname.example,Bad|not a url,Js|javascript:alert(1),Ok|https://ok.example'),
    [{ name: 'Ok', url: 'https://ok.example' }]
  );
});

test('a repeated address is listed once', () => {
  assert.deepEqual(parseShopLinks('A|https://x.example,B|https://x.example/other'), [{ name: 'A', url: 'https://x.example' }]);
});

test('marks the shop being served by host, case-insensitively', () => {
  const links = parseShopLinks('A|https://a.example,B|https://b.example');
  assert.deepEqual(
    markCurrentShop(links, 'B.example').map((l) => l.current),
    [false, true]
  );
});

test('a host that matches nothing marks nothing', () => {
  const links = parseShopLinks('A|https://a.example');
  assert.deepEqual(markCurrentShop(links, 'preview.vercel.app').map((l) => l.current), [false]);
  assert.deepEqual(markCurrentShop(links, null).map((l) => l.current), [false]);
});
