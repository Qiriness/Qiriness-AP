import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSystemPrompt } from './chat-system-prompt.mjs';
import { ALL_MARKETPLACE_HANDLES } from './insights-range.mjs';

const prompt = buildSystemPrompt({ schemaText: 'chat.orders — One row per order.', today: '2026-09-14', timezone: 'Europe/Paris' });

test('the prompt forbids invented figures and asks for a plain "cannot answer"', () => {
  assert.match(prompt, /Every figure in your answer must come from a query result/);
  assert.match(prompt, /If the data cannot answer the question reliably, say so plainly/);
});

test('the marketplace handles come from the same constant the Insights filter uses', () => {
  for (const handle of ALL_MARKETPLACE_HANDLES) assert.ok(prompt.includes(`'${handle}'`), handle);
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
