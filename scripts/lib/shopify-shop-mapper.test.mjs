import assert from 'node:assert/strict';
import test from 'node:test';

import { mapShop } from './shopify-shop-mapper.mjs';

const CONFIG = { shopDomain: 'qiriness.myshopify.com', appEnv: 'production' };
const SHOP = {
  id: 'gid://shopify/Shop/1',
  name: 'Qiriness',
  myshopifyDomain: 'qiriness.myshopify.com',
  primaryDomain: { url: 'https://qiriness.com' },
  ianaTimezone: 'Europe/Paris'
};

test('the mapped shop never carries the columns that are ours', () => {
  // THE BUG THIS PINS. `sync_cursors: {}` in the payload made every Shopify
  // sync overwrite the mail delta link, so the next mail poll re-read the whole
  // mailbox. Omitted keys are left alone by the upsert; `{}` is not omitted.
  const row = mapShop(SHOP, CONFIG);
  assert.equal('sync_cursors' in row, false);
  assert.equal('app_settings' in row, false);
});

test('the shop timezone is recorded, and absent means null rather than a guess', () => {
  assert.equal(mapShop(SHOP, CONFIG).iana_timezone, 'Europe/Paris');
  assert.equal(mapShop({ ...SHOP, ianaTimezone: undefined }, CONFIG).iana_timezone, null);
});
