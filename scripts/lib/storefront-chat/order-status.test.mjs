import assert from 'node:assert/strict';
import test from 'node:test';

import { orderStatus, parseOrderNumber, workingDaysBetween } from './order-status.mjs';
import { createOrderStatusReader } from './order-status-repository.mjs';
import { MAX_ORDER_LOOKUPS, runOrderTool } from './order-tools.mjs';
import { buildKnowledge } from './knowledge-repository.mjs';
import { createLlmAgent } from './llm-agent.mjs';

// One order's status by its number (owner, 2026-10-13). Invented orders only.
const TIMINGS = { dispatchDays: 2, homeDeliveryDays: 3, abroadDeliveryDays: 5, homeCountry: 'FR' };
const WED = new Date('2026-10-07T15:00:00Z');
const order = (over = {}) => ({ name: '#1234', processed_at: '2026-10-05T09:00:00Z', fulfillment_status: 'UNFULFILLED', cancelled_at: null, delivered_at: null, country: 'FR', fulfillments: [], ...over });
const shipped = (createdAt, over = {}) => order({ fulfillment_status: 'FULFILLED', fulfillments: [{ created_at: createdAt, status: 'SUCCESS' }], ...over });

test('working days skip the weekend', () => {
  assert.equal(workingDaysBetween(new Date('2026-10-05'), WED), 2); // Mon → Wed
  assert.equal(workingDaysBetween(new Date('2026-10-02'), new Date('2026-10-05')), 1); // Fri → Mon
  assert.equal(workingDaysBetween(WED, WED), 0);
});

test('not shipped: being prepared within the dispatch time, delayed past it', () => {
  assert.equal(orderStatus(order(), TIMINGS, WED).status, 'preparing');
  assert.equal(orderStatus(order(), TIMINGS, new Date('2026-10-08T10:00:00Z')).status, 'dispatch_delayed');
  // Partly shipped is judged on what is still to ship.
  assert.equal(orderStatus(shipped('2026-10-06T10:00:00Z', { fulfillment_status: 'PARTIALLY_FULFILLED' }), TIMINGS, new Date('2026-10-12T10:00:00Z')).status, 'dispatch_delayed');
});

test('shipped: on its way within the delivery time, late past it; home and abroad differ', () => {
  const thu = shipped('2026-10-01T10:00:00Z'); // Fri, Mon, Tue, Wed = 4 working days
  assert.deepEqual(orderStatus(thu, TIMINGS, WED), { order: '#1234', ordered_on: '2026-10-05', status: 'delivery_late', shipped_on: '2026-10-01', working_days_since: 4, usual_working_days: 3 });
  assert.equal(orderStatus({ ...thu, country: 'BE' }, TIMINGS, WED).status, 'on_the_way');
  assert.equal(orderStatus(shipped('2026-10-06T10:00:00Z'), TIMINGS, WED).status, 'on_the_way');
});

test('delivered, cancelled, and a timing the shop has not set', () => {
  assert.equal(orderStatus(shipped('2026-10-01T10:00:00Z', { delivered_at: '2026-10-03T10:00:00Z' }), TIMINGS, WED).status, 'delivered');
  assert.equal(orderStatus(order({ cancelled_at: '2026-10-05T10:00:00Z' }), TIMINGS, WED).status, 'cancelled');
  assert.equal(orderStatus(order(), { ...TIMINGS, dispatchDays: null }, WED).status, 'timing_unknown');
  assert.equal(orderStatus(shipped('2026-10-01T10:00:00Z'), { ...TIMINGS, homeDeliveryDays: null }, WED).status, 'timing_unknown');
});

test('order numbers as customers write them', () => {
  for (const v of ['#1234', '1234', 'n°1234', 'commande 1234', 'Order 1234', ' #1234 ']) assert.equal(parseOrderNumber(v), 1234, v);
  for (const v of ['', 'abc', '12-34', 'jane@example.com', '#']) assert.equal(parseOrderNumber(v), null, v);
});

// THE READER, on a fake database.
function fakeDb({ rows = [order({ id: 'o1', sales_channel_handle: 'web' })], channels = [{ handles: ['amazon'] }], logFails = false } = {}) {
  const queries = [];
  const logged = [];
  return {
    queries, logged,
    async select(table, filters, columns) {
      queries.push({ table, filters, columns });
      if (table === 'shops') return [{ id: 'shop-1' }];
      if (table === 'sales_channels') return channels;
      if (table === 'orders') return rows.map((r) => ({ ...r, email: 'jane@example.com', shipping_destination: { city: 'Paris' } }));
      throw new Error(`unexpected table ${table}`);
    },
    async logAccess(row) { if (logFails) throw new Error('audit down'); logged.push(row); },
  };
}

test('the reader: by number on the shop, named columns, nothing personal out, every lookup logged', async () => {
  const db = fakeDb({ rows: [shipped('2026-10-01T10:00:00Z', { sales_channel_handle: 'web', fulfillments: [{ created_at: '2026-10-01T10:00:00Z', status: 'SUCCESS', tracking_info: [{ number: 'TRK1' }] }] })] });
  const row = await createOrderStatusReader(db)({ shopDomain: 'shop.myshopify.com', orderNumber: 1234 });
  const orders = db.queries.find((q) => q.table === 'orders');
  assert.equal(orders.filters.order_number, 1234);
  assert.equal(orders.filters.shop_id, 'shop-1');
  assert.doesNotMatch(orders.columns, /email|phone|address|total|line_items|tracking|customer/);
  assert.doesNotMatch(JSON.stringify(row), /jane|Paris|TRK1/);
  assert.equal(db.logged.length, 1);
  assert.equal(db.logged[0].action, 'order_status_read');
  assert.match(db.logged[0].resource_id_hash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(db.logged), /1234/);
});

test('a marketplace order is not found; a lookup that cannot be logged is not used', async () => {
  const market = fakeDb({ rows: [order({ sales_channel_handle: 'amazon' })] });
  assert.equal(await createOrderStatusReader(market)({ shopDomain: 's', orderNumber: 1234 }), null);
  assert.deepEqual(market.logged[0].metadata, { found: false });
  await assert.rejects(createOrderStatusReader(fakeDb({ logFails: true }))({ shopDomain: 's', orderNumber: 1234 }), /audit down/);
});

// THE TOOL, with the shop's policy.
const KNOWLEDGE = buildKnowledge({
  parameters: [['dispatch_days', '2'], ['france_delivery_days', '3'], ['abroad_delivery_days', '5']].map(([parameter_key, value]) => ({ parameter_key, value })),
  policies: [
    { policy_key: 'dispatch_time_policy', active: true, version: 1, content: 'La préparation prend {dispatch_days} jours ouvrés.' },
    { policy_key: 'delivery_time_policy', active: true, version: 1, content: 'Livraison : France {france_delivery_days} jours ouvrés, étranger {abroad_delivery_days} jours ouvrés, à compter de l’expédition.' },
    { policy_key: 'shipping_cost_policy', active: true, version: 1, content: 'Frais de port : voir le panier.' },
  ],
});

test('the tool: the status with its policy passages; not found; invalid; at most three lookups', async () => {
  const readOrder = async ({ orderNumber }) => (orderNumber === 1234 ? shipped('2026-10-01T10:00:00Z') : null);
  const ctx = { readOrder, shopDomain: 's', knowledge: KNOWLEDGE, lookupsSoFar: 0, now: WED };
  const late = await runOrderTool({ order_number: '#1234' }, ctx);
  assert.equal(late.status, 'delivery_late');
  assert.match(late.instruction, /apologise that it is late/);
  assert.ok(late.policy.passages.some((p) => /France 3 jours ouvrés/.test(p)));
  assert.ok(!late.policy.passages.some((p) => /Frais de port/.test(p)));
  assert.equal((await runOrderTool({ order_number: '9999' }, ctx)).status, 'not_found');
  assert.equal((await runOrderTool({ order_number: 'jane@example.com' }, ctx)).status, 'invalid_order_number');
  assert.equal((await runOrderTool({ order_number: '1234' }, { ...ctx, lookupsSoFar: MAX_ORDER_LOOKUPS })).status, 'lookup_limit');
});

// THROUGH THE AGENT.
const toolCall = (name, args) => ({ content: null, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, toolCalls: [{ id: 'c1', name, args, argsError: null }], usage: {} });
const answer = (reply, contactLink = false) => ({ content: JSON.stringify({ reply, reply_language: 'fr', products: [], contact_link: contactLink }), toolCalls: [], usage: {} });
function scripted(...responses) {
  const calls = [];
  return { calls, async completeWithTools(args) { calls.push(structuredClone(args)); return responses.shift(); } };
}
const toolOutput = (client, round = 1) => JSON.parse(client.calls[round].messages.find((m) => m.role === 'tool').content);
const agentWith = (client, readOrder) => createLlmAgent({ client, company: { name: 'Lumen', contactFormPath: '/pages/contact' }, knowledge: KNOWLEDGE, readOrder, catalogueShopDomain: 's' });

test('« où est ma commande #1234 ? »: the tool, the answer, the contact form; the number is never traced', async () => {
  const client = scripted(toolCall('get_order_status', { order_number: '#1234' }), answer('Votre commande #1234 est en cours de préparation.'));
  const reply = await agentWith(client, async () => order({ processed_at: new Date().toISOString() })).respond({ message: 'Où est ma commande #1234 ?', context: { locale: 'fr' } });
  assert.ok(client.calls[0].tools.some((t) => t.function.name === 'get_order_status'));
  assert.match(client.calls[0].system, /ask for its order number only/);
  assert.equal(toolOutput(client).status, 'preparing');
  assert.deepEqual(reply.contact, { url: '/pages/contact' });
  assert.equal(reply.orderLookups, 1);
  assert.doesNotMatch(JSON.stringify(reply.trace), /1234/);
});

test('any « contact us » carries the contact form, in French and English, whatever the model set', async () => {
  const fr = await agentWith(scripted(answer('Notre service client vous répondra.')), null).respond({ message: 'Mon produit me pique', context: { locale: 'fr' } });
  assert.deepEqual(fr.contact, { url: '/pages/contact' });
  const en = await agentWith(scripted(answer('Please contact us for a refund.')), null).respond({ message: 'I want a refund', context: { locale: 'en' } });
  assert.deepEqual(en.contact, { url: '/pages/contact' });
  const none = await agentWith(scripted(answer('Bonjour !')), null).respond({ message: 'Bonjour', context: { locale: 'fr' } });
  assert.equal(none.contact, undefined);
});

test('the conversation\'s lookups are counted across turns: the fourth is refused', async () => {
  const history = [{ role: 'assistant', content: '…', context: { order_lookups: 3 } }];
  const client = scripted(toolCall('get_order_status', { order_number: '1235' }), answer('Je ne peux plus vérifier de commande ici.'));
  const reply = await agentWith(client, async () => order()).respond({ message: 'Et la commande 1235 ?', context: { locale: 'fr' }, history });
  assert.equal(toolOutput(client).status, 'lookup_limit');
  assert.equal(reply.orderLookups, undefined);
  assert.deepEqual(reply.contact, { url: '/pages/contact' });
});
