import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenAIClient } from '../../../agent/src/llm/openai-client.mjs';
import { STOREFRONT_AGENT_NAME } from './agent.mjs';
import {
  DEFAULT_STOREFRONT_MODEL,
  StorefrontAgentError,
  createLlmAgent,
  historyMessages,
  noRetryWait,
  parseReply,
  productLinkBase,
  storefrontFetch
} from './llm-agent.mjs';
import { buildCatalogue } from './product-repository.mjs';

const CATALOGUE = buildCatalogue(
  [
    {
      shopify_product_id: 'gid://shopify/Product/1',
      handle: 'creme-nuit',
      title: 'Crème de Nuit',
      product_type: 'Soin Visage',
      tags: ['peaux sèches'],
      short_description: 'Nourrit les peaux sèches.',
      variants: [{ title: '50 ml', price: '49.90' }],
      available_stock: 3
    },
    {
      shopify_product_id: 'gid://shopify/Product/2',
      handle: 'serum-eclat',
      title: 'Sérum Éclat',
      product_type: 'Soin Visage',
      tags: ['éclat'],
      short_description: 'Pour un teint lumineux.',
      variants: [{ title: '30 ml', price: '39.00' }],
      available_stock: 0
    }
  ],
  [{ handle: 'cremes-de-nuit', title: 'Crèmes de Nuit', axis: 'category', product_ids: ['gid://shopify/Product/1'] }]
);

const answer = (reply, products = []) => ({ content: JSON.stringify({ reply, products }), toolCalls: [], usage: { prompt_tokens: 800, completion_tokens: 40 } });
const toolCall = (name, args, id = 'call_1') => ({
  content: null,
  message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
  toolCalls: [{ id, name, args, argsError: null }],
  usage: { prompt_tokens: 900, completion_tokens: 20 }
});

/** A client that plays back scripted responses and records each request. */
function scripted(...responses) {
  const calls = [];
  return {
    calls,
    async completeWithTools(args) {
      calls.push(structuredClone(args));
      const next = responses.shift();
      if (!next) throw new Error('no more scripted responses');
      return next;
    }
  };
}

test('without a catalogue it is Phase 2: one call, no tools, no cards', async () => {
  const client = scripted(answer('Bonjour, quelle est votre préoccupation principale ?'));
  const agent = createLlmAgent({ client, company: { name: 'Maison Test' } });
  const reply = await agent.respond({ message: 'Trouver mon soin', context: { locale: 'fr' } });

  assert.equal(agent.name, STOREFRONT_AGENT_NAME);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].model, DEFAULT_STOREFRONT_MODEL);
  assert.equal(client.calls[0].tools, undefined);
  assert.match(client.calls[0].system, /NO CATALOGUE ACCESS/);
  assert.equal(reply.text, 'Bonjour, quelle est votre préoccupation principale ?');
  assert.deepEqual(reply.products, []);
  assert.deepEqual(reply.usage, { inputTokens: 800, outputTokens: 40 });
});

test('a search, then an answer with a card built from the catalogue, not the model', async () => {
  const client = scripted(
    toolCall('search_products', { query: 'peau sèche', collection: null, limit: null }),
    answer('La Crème de Nuit nourrit les peaux sèches.', [{ handle: 'creme-nuit', rationale: 'Pour nourrir la nuit' }])
  );
  const reply = await createLlmAgent({ client, catalogue: CATALOGUE }).respond({ message: 'J\'ai la peau sèche', context: { locale: 'fr' } });

  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].toolChoice, 'auto');
  const toolMessage = client.calls[1].messages.at(-1);
  assert.equal(toolMessage.role, 'tool');
  assert.equal(toolMessage.tool_call_id, 'call_1');
  assert.match(toolMessage.content, /"handle":"creme-nuit"/);
  assert.deepEqual(reply.products, [
    { id: 'creme-nuit', title: 'Crème de Nuit', url: '/products/creme-nuit', image: null, price: '49,90 €', rationale: 'Pour nourrir la nuit' }
  ]);
  assert.deepEqual(reply.usage, { inputTokens: 1700, outputTokens: 60 });
  assert.equal(reply.trace.calls.length, 2);
  assert.deepEqual(reply.trace.tools, [{ name: 'search_products', args: { query: 'peau sèche', collection: null, limit: null }, found: 1 }]);
});

test('a handle the tools never returned is not shown as a card', async () => {
  const client = scripted(
    toolCall('search_products', { query: 'creme', collection: null, limit: null }),
    answer('Voici deux idées.', [
      { handle: 'creme-nuit', rationale: 'ok' },
      { handle: 'serum-eclat', rationale: 'never returned by search' },
      { handle: 'invented-product', rationale: 'made up' }
    ])
  );
  const reply = await createLlmAgent({ client, catalogue: CATALOGUE }).respond({ message: 'une crème', context: {} });
  assert.deepEqual(reply.products.map((p) => p.url), ['/products/creme-nuit']);
});

test('the page product is in the prompt and can be a card without any tool call', async () => {
  const client = scripted(answer('Oui, ce soin convient aux peaux sèches.', [{ handle: 'creme-nuit', rationale: 'Celle que vous regardez' }]));
  const reply = await createLlmAgent({ client, catalogue: CATALOGUE }).respond({
    message: 'Est-ce que ça convient à une peau sèche ?',
    context: { pageType: 'product', productHandle: 'creme-nuit', locale: 'fr' }
  });
  assert.equal(client.calls.length, 1, 'one round trip on a product page');
  assert.match(client.calls[0].system, /- resolution:/, '« ça » on a product page is resolved to it before the call');
  assert.match(client.calls[0].system, /"name":"Crème de Nuit"/);
  assert.equal(reply.products[0].title, 'Crème de Nuit');
});

test('after the last tool round the model must answer', async () => {
  const client = scripted(
    toolCall('search_products', { query: 'a', collection: null, limit: null }, 'c1'),
    toolCall('search_products', { query: 'b', collection: null, limit: null }, 'c2'),
    answer('Je vous propose de parcourir nos crèmes.')
  );
  const reply = await createLlmAgent({ client, catalogue: CATALOGUE, maxToolRounds: 2 }).respond({ message: 'x', context: {} });
  assert.equal(client.calls.length, 3);
  assert.equal(client.calls[2].toolChoice, 'none');
  assert.equal(client.calls[2].messages.at(-1).role, 'system');
  assert.match(client.calls[2].messages.at(-1).content, /No more tool calls[^]*already returned above/);
  assert.equal(client.calls[1].messages.filter((m) => m.role === 'system').length, 0, 'only the forced round carries the note');
  assert.equal(reply.text, 'Je vous propose de parcourir nos crèmes.');
});

test('malformed tool arguments go back to the model as an error, not a crash', async () => {
  const client = scripted(
    { ...toolCall('get_product', {}), toolCalls: [{ id: 'call_1', name: 'get_product', args: null, argsError: 'Unexpected token' }] },
    answer('Pouvez-vous préciser le soin ?')
  );
  await createLlmAgent({ client, catalogue: CATALOGUE }).respond({ message: 'x', context: {} });
  assert.match(client.calls[1].messages.at(-1).content, /arguments were not valid JSON/);
});

test('the session history goes first, in order, and the new message last', async () => {
  const client = scripted(answer('Merci.'));
  await createLlmAgent({ client }).respond({
    message: 'Plutôt sèche',
    history: [
      { role: 'user', content: 'Trouver mon soin' },
      { role: 'assistant', content: 'Quel est votre type de peau ?' },
      { role: 'system', content: 'ignored' }
    ]
  });
  assert.deepEqual(client.calls[0].messages, [
    { role: 'user', content: 'Trouver mon soin' },
    { role: 'assistant', content: 'Quel est votre type de peau ?' },
    { role: 'user', content: 'Plutôt sèche' }
  ]);
});

test('a long history message is shortened', () => {
  assert.equal(historyMessages([{ role: 'user', content: 'x'.repeat(5000) }])[0].content.length, 1500);
});

test('a malformed, empty or failed reply is an agent error, not a blank bubble', async () => {
  assert.throws(() => parseReply('not json'), StorefrontAgentError);
  assert.throws(() => parseReply(JSON.stringify({ reply: '   ', products: [] })), StorefrontAgentError);
  assert.throws(() => parseReply(null), StorefrontAgentError);
  const failing = { async completeWithTools() { throw new Error('HTTP 500'); } };
  await assert.rejects(createLlmAgent({ client: failing }).respond({ message: 'x' }), StorefrontAgentError);
});

test('a runaway reply is cut', () => {
  const { text } = parseReply(JSON.stringify({ reply: 'a'.repeat(5000), products: [] }));
  assert.equal(text.length, 1200);
  assert.ok(text.endsWith('…'));
});

test('a rate limit is not waited out on the storefront', async () => {
  let calls = 0;
  const client = createOpenAIClient({
    apiKey: 'test',
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}', { status: 429 });
    },
    sleepImpl: noRetryWait
  });
  await assert.rejects(createLlmAgent({ client }).respond({ message: 'x' }), StorefrontAgentError);
  assert.equal(calls, 1);
});

test('the fetch carries a timeout signal', async () => {
  let seen;
  await storefrontFetch(50, async (_url, init) => {
    seen = init.signal;
    return new Response('{}');
  })('https://example.test', { method: 'POST' });
  assert.ok(seen instanceof AbortSignal);
});

test('a model that never answers is cut at the turn deadline', async () => {
  const hanging = { completeWithTools: () => new Promise(() => {}) };
  const started = Date.now();
  await assert.rejects(createLlmAgent({ client: hanging, deadlineMs: 50 }).respond({ message: 'x' }), /no reply within 50 ms/);
  assert.ok(Date.now() - started < 1000);
});

test('card links stay on the store unless a product base URL is set, and only https counts', async () => {
  const client = scripted(answer('Voici.', [{ handle: 'creme-nuit', rationale: 'ok' }]));
  const reply = await createLlmAgent({ client, catalogue: CATALOGUE, productBaseUrl: 'https://shop.example/some/path' }).respond({
    message: 'x',
    context: { pageType: 'product', productHandle: 'creme-nuit' }
  });
  assert.equal(reply.products[0].url, 'https://shop.example/products/creme-nuit');
  assert.equal(productLinkBase(''), '');
  assert.equal(productLinkBase('http://shop.example'), '');
  assert.equal(productLinkBase('javascript:alert(1)'), '');
  assert.equal(productLinkBase('not a url'), '');
});

test('a named product is resolved before the call: its facts in the prompt, its id in the memory', async () => {
  const client = scripted(answer('Oui, elle nourrit les peaux sèches.', [{ handle: 'creme-nuit', rationale: 'Pour la nuit' }]));
  const reply = await createLlmAgent({ client, catalogue: CATALOGUE }).respond({ message: 'la Crème de Nuit convient aux peaux sèches ?', context: {} });
  assert.equal(client.calls.length, 1, 'no tool round for a product the customer named');
  assert.match(client.calls[0].system, /"resolved_by":/);
  assert.deepEqual(reply.resolution.ids, ['creme-nuit']);
  assert.deepEqual(reply.refs, { recommended: ['creme-nuit'], mentioned: ['creme-nuit'] });
  assert.deepEqual(reply.choices, []);
});

test('an ambiguous reference becomes chips from the resolver, whatever the model writes', async () => {
  const twoLines = buildCatalogue(
    [
      { id: 'a', handle: 'a', title: 'Sérum Éclat - Nectar Brume Polaire', variants: [{ price: '20' }], available_stock: 1 },
      { id: 'b', handle: 'b', title: 'Crème Riche - Voile Brume Polaire', variants: [{ price: '20' }], available_stock: 1 },
      { id: 'c', handle: 'c', title: 'Crème Légère - Voile Brume Polaire Light', variants: [{ price: '20' }], available_stock: 1 }
    ],
    []
  );
  const client = scripted(answer('Parlez-vous de la Voile Brume Polaire ou de la Voile Brume Polaire Light ?'));
  const reply = await createLlmAgent({ client, catalogue: twoLines }).respond({ message: 'la crème Brume Polaire', context: {} });
  assert.match(client.calls[0].system, /"clarification":\{/);
  assert.deepEqual(reply.choices.map((c) => c.value).sort(), ['b', 'c']);
  assert.equal(reply.resolution.status, 'ambiguous');
  assert.deepEqual([...reply.resolution.pending.ids].sort(), ['b', 'c']);
});
