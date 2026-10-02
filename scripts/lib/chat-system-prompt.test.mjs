import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSystemPrompt } from './chat-system-prompt.mjs';
import { buildMarketplaces } from './marketplaces.mjs';

// Example marketplaces, as a `sales_channels` read returns them.
const MARKETPLACES = buildMarketplaces([
  { platform_key: 'market_a', label: 'Market A', handles: ['market-a'] },
  { platform_key: 'market_b', label: 'Market B', handles: ['connect-b'] }
]);
const prompt = buildSystemPrompt({
  schemaText: 'chat.orders — One row per order.',
  today: '2026-09-14',
  timezone: 'Europe/Paris',
  companyName: 'Boutique Exemple',
  marketplaces: MARKETPLACES
});

test('the prompt forbids invented figures and asks for a plain "cannot answer"', () => {
  assert.match(prompt, /Every figure in your answer must come from a query result/);
  assert.match(prompt, /If the data cannot answer the question reliably, say so plainly/);
});

test('the marketplaces are the shop’s, by name and handle, as the Insights filter reads them', () => {
  for (const handle of MARKETPLACES.handles) assert.ok(prompt.includes(`'${handle}'`), handle);
  assert.match(prompt, /Boutique Exemple sells on its own Shopify store and on marketplaces: Market A \(channel market-a\); Market B/);
  // A shop with none says so, and names no company it does not have.
  const none = buildSystemPrompt({ schemaText: '', today: '2026-09-14' });
  assert.match(none, /the company sells on its own Shopify store\. /);
  assert.doesNotMatch(none, /Qiriness|Amazon|Yves Rocher/);
});

test('the known limits of the data are stated', () => {
  assert.match(prompt, /snapshot of each customer now/);
  assert.match(prompt, /Delivery time cannot be measured/);
  assert.match(prompt, /min\(first_message_at\)/);
});

test('the timezone, the date and the schema are filled in', () => {
  assert.match(prompt, /at time zone 'Europe\/Paris'/);
  assert.match(prompt, /Today is 2026-09-14\./);
  assert.ok(prompt.endsWith('chat.orders — One row per order.'));
  assert.match(buildSystemPrompt({ schemaText: '', today: '2026-09-14' }), /timezone is UTC/);
});
