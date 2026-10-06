import assert from 'node:assert/strict';
import test from 'node:test';

import { QUICK_ACTIONS } from './request-schema.mjs';
import { STOREFRONT_AGENT_NAME, createMockAgent, replyLanguage } from './agent.mjs';

test('there is one agent, and it has the name the docs use', () => {
  assert.equal(createMockAgent().name, STOREFRONT_AGENT_NAME);
  assert.equal(STOREFRONT_AGENT_NAME, 'storefront_sales_agent');
});

test('every quick action has its own mock reply, in both languages', async () => {
  const agent = createMockAgent();
  const fallback = (await agent.respond({ context: { locale: 'fr' } })).text;
  for (const action of QUICK_ACTIONS) {
    for (const locale of ['fr', 'en']) {
      const reply = await agent.respond({ action, context: { locale } });
      assert.ok(reply.text, `${action} ${locale}`);
      if (locale === 'fr') assert.notEqual(reply.text, fallback, action);
    }
  }
});

test('only « find my product » carries a card, and its link stays on the store', async () => {
  const agent = createMockAgent();
  const { products } = await agent.respond({ action: 'find_product', context: {} });
  assert.equal(products.length, 1);
  assert.match(products[0].url, /^\/[^/]/);
  assert.deepEqual((await agent.respond({ action: 'offers', context: {} })).products, []);
});

test('the mock reports no model and no spend', async () => {
  const reply = await createMockAgent().respond({ context: {} });
  assert.equal(reply.model, null);
  assert.equal(reply.usage, null);
});

test('French unless the storefront says English', () => {
  assert.equal(replyLanguage('en-GB'), 'en');
  assert.equal(replyLanguage('fr'), 'fr');
  assert.equal(replyLanguage('de'), 'fr');
  assert.equal(replyLanguage(null), 'fr');
});
