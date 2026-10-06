import assert from 'node:assert/strict';
import test from 'node:test';
import contract from '../../../storefront-app/extensions/storefront-advisor/assets/advisor-cart.js';
import { evaluatePromotionsForCart, getActivePromotions, getCartContext, getStockContext, normalizeSnapshot } from './shopping-evaluator.mjs';
import { createShoppingReader } from './shopping-repository.mjs';
import { createShoppingTurn } from './shopping-tools.mjs';
import { parseChatRequest } from './request-schema.mjs';
import { createLlmAgent } from './llm-agent.mjs';
import { SHOPPING_CASES, fixture, addSecond, NOW, P1, V1, V2 } from './shopping-cases.mjs';

for (const c of SHOPPING_CASES) test(`French cart case ${c.id}: ${c.question}`, () => {
  const f = fixture(); c.change?.(f);
  const result = evaluatePromotionsForCart(f.cart, f.source, c.code ? { code: c.code } : c.id === 'expired' ? { code: 'WELCOME20' } : {}, { now: NOW });
  if (c.expectedRoot) return assert.equal(result.status, c.expectedRoot);
  const p = result.promotions[0];
  assert.equal(p.status, c.expected.status);
  if (c.expected.reason) assert.equal(p.reason, c.expected.reason);
  if (c.expected.gap) assert.equal(p.requirements_remaining[0].amount, c.expected.gap);
});

test('Ajax cart whitelist strips token, notes, properties, customer details and arbitrary context', () => {
  const raw = { currency: 'EUR', token: 'secret', note: 'personal', customer: { email: 'dummy@example.invalid' }, original_total_price: 4000, items_subtotal_price: 3200, total_price: 3000, cart_level_discount_applications: [{ title: 'ORDER', type: 'discount_code', total_allocated_amount: 200 }], items: [{ product_id: 1, variant_id: 11, quantity: 1, original_price: 4000, original_line_price: 4000, final_line_price: 3200, properties: { personal: 'dummy' }, line_level_discount_allocations: [{ amount: 800, discount_application: { title: 'Auto', type: 'automatic' } }] }] };
  const cart = contract.fromAjaxCart(raw);
  assert.equal(cart.lines[0].productId, P1);
  assert.equal(cart.discounts.length, 2);
  for (const text of ['secret', 'personal', 'email', 'properties']) assert.ok(!JSON.stringify(cart).includes(text));
  const parsed = parseChatRequest({ message: 'Mon panier', cart: { ...cart, token: 'secret' }, context: { loggedIn: true, currency: 'EUR', market: 'gid://shopify/Market/1', customerId: 'dummy' } });
  assert.equal(parsed.cart.lines.length, 1);
  assert.ok(!JSON.stringify(parsed).includes('customerId'));
});

test('Malformed or oversized cart is unavailable, never partially evaluated', () => {
  const { cart } = fixture();
  assert.equal(normalizeSnapshot({ ...cart, total: -1 }), null);
  assert.equal(normalizeSnapshot({ ...cart, originalSubtotal: 1 }), null);
  assert.equal(normalizeSnapshot({ ...cart, lines: Array(41).fill(cart.lines[0]) }), null);
  assert.equal(normalizeSnapshot({ ...cart, lines: [{ ...cart.lines[0], quantity: '1' }] }), null);
});

test('Browser cart reads are avoided for general offers, payment and product-page stock', () => {
  assert.equal(contract.needsCartSnapshot('Quelles offres sont disponibles en ce moment ?', null, {}), false);
  assert.equal(contract.needsCartSnapshot('Quelles offres ?', 'offers', {}), false);
  assert.equal(contract.needsCartSnapshot('Puis-je payer en plusieurs fois ?', null, {}), false);
  assert.equal(contract.needsCartSnapshot('Ce produit est-il disponible ?', null, { productHandle: 'creme' }), false);
  assert.equal(contract.needsCartSnapshot('Est-ce que tout est en stock ?', null, { productHandle: 'creme' }), true);
  assert.equal(contract.needsCartSnapshot('Le code WELCOME20 marche-t-il ?', null, {}), true);
});

test('Cart results never expose a private code or its campaign title', () => {
  const { source, cart, promotion } = fixture();
  promotion.offerable_in_replies = false; promotion.title = 'SECRET_PARTNER'; promotion.codes = [{ code: 'SECRET50' }];
  cart.codes = ['SECRET50']; cart.discounts = [{ title: 'SECRET50', type: 'code', amount: 1000 }]; cart.total = 3000;
  const result = getCartContext(cart, source);
  assert.equal(result.discount_total, 10);
  assert.equal(result.lines[0].product_id, 'p1');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.deepEqual(getActivePromotions(source, {}, NOW).promotions, []);
  assert.ok(!JSON.stringify(evaluatePromotionsForCart(cart, source, { code: 'SECRET50' }, { now: NOW })).includes('SECRET'));
});

test('Stock checks aggregate repeated variants, quantities, unknown and stale records', () => {
  const { cart, source } = fixture();
  assert.equal(getStockContext(cart, source, {}, NOW).status, 'available');
  addSecond(cart, 2);
  assert.equal(getStockContext(cart, source, {}, NOW).status, 'insufficient');
  assert.equal(getStockContext(cart, source, {}, NOW).items.find((i) => i.variant_id === V2).requested_quantity, 2);
  cart.lines = [cart.lines[0], { ...cart.lines[0], quantity: 3, originalTotal: 12000, finalTotal: 12000 }]; cart.originalSubtotal = cart.subtotal = cart.total = 16000;
  assert.equal(getStockContext(cart, source, {}, NOW).items[0].requested_quantity, 4);
  assert.equal(getStockContext(cart, source, {}, NOW).status, 'insufficient');
  source.products[0].variants[0].inventory_quantity = null;
  assert.equal(getStockContext(cart, source, {}, NOW).status, 'unknown');
  source.products[0].synced_at = '2020-01-01';
  assert.equal(getStockContext(cart, source, {}, NOW).items[0].reason, 'stock_snapshot_stale');
});

test('A specific product needs its selected variant; aggregate product stock is never substituted', () => {
  const { source } = fixture();
  source.products[0].variants.push({ id: 'gid://shopify/ProductVariant/12', inventory_quantity: 99 });
  assert.equal(getStockContext(null, source, { productIds: ['p1'], cartScope: false }, NOW).status, 'unknown');
  assert.equal(getStockContext(null, source, { productIds: ['p1'], variantId: V1, quantity: 2, cartScope: false }, NOW).status, 'available');
});

test('Multiple simultaneous offers report pairwise stacking without assuming application', () => {
  const { source, cart, promotion } = fixture();
  const second = structuredClone(promotion); second.id = 'second'; second.codes = [{ code: 'SECOND10' }]; second.combines_with.product_discounts = false;
  source.promotions.push(second);
  const result = evaluatePromotionsForCart(cart, source, {}, { now: NOW });
  assert.equal(result.promotions.length, 2);
  assert.ok(result.promotions.every((p) => p.status === 'eligible'));
  assert.equal(result.combinations[0].status, 'not_combinable');
  delete second.combines_with.product_discounts;
  assert.equal(evaluatePromotionsForCart(cart, source, {}, { now: NOW }).combinations[0].status, 'unknown');
});

test('Shipping and unsupported item conditions are withheld', () => {
  const { source, cart, promotion } = fixture();
  promotion.rule_snapshot.customer_gets.items.excluded_products = [P1];
  assert.equal(evaluatePromotionsForCart(cart, source, {}, { now: NOW }).promotions[0].status, 'unknown');
  promotion.discount_type = 'DiscountCodeFreeShipping';
  assert.equal(getActivePromotions(source, {}, NOW).promotions.length, 0);
  assert.equal(evaluatePromotionsForCart(cart, source, { code: 'WELCOME20' }, { now: NOW }).promotions[0].reason, 'shipping_out_of_scope');
});

test('Lazy repository scopes every read to signed shop and excludes private rows before tools', async () => {
  const calls = []; const f = fixture();
  const reader = createShoppingReader({ async selectAll(table, filters, columns) {
    calls.push({ table, filters, columns });
    if (table === 'shops') return filters.shop_domain === 'test.myshopify.com' ? [{ id: 'shop1' }] : [];
    if (table === 'products') return f.source.products;
    if (table === 'advice_collections') return [];
    return filters.method === 'code' ? [f.promotion, { ...f.promotion, offerable_in_replies: false, id: 'secret' }] : [];
  } }, { now: () => NOW });
  const source = await reader('test.myshopify.com');
  assert.equal(source.promotions.length, 1);
  await reader('test.myshopify.com'); assert.equal(calls.length, 5);
  assert.ok(calls.slice(1).every((c) => c.filters.shop_id === 'shop1'));
  assert.equal(calls.find((c) => c.filters.method === 'code').filters.offerable_in_replies, true);
  assert.equal((await reader('another.myshopify.com')).reason, 'shop_not_synced');
  assert.ok(calls.every((c) => !/customer|order|raw_shopify_payload/.test(c.table + ',' + c.columns.replace(/applies_once_per_customer/g, ''))));
});

test('French deterministic opening routes are narrow; payment FAQ does no shopping read', async () => {
  const f = fixture(); let reads = 0;
  const turn = (message) => createShoppingTurn({ message, shopDomain: f.source.shopDomain, cart: f.cart, readShopping: async () => { reads++; return f.source; } });
  assert.equal(await turn('Puis-je payer en plusieurs fois ?').opening(), null);
  assert.equal(reads, 0);
  assert.deepEqual((await turn('Quelles offres sont disponibles en ce moment ?').opening()).results.map((r) => r.tool), ['get_active_promotions']);
  assert.deepEqual((await turn('Est-ce que tout mon panier est en stock ?').opening()).results.map((r) => r.tool), ['get_cart_context', 'get_stock_context']);
  const result = await turn('Le code WELCOME20 marche avec mon panier ?').opening();
  assert.equal(result.results.find((r) => r.tool === 'evaluate_promotions_for_cart').result.promotions[0].status, 'eligible');
  assert.equal((await turn('Bonjour').run('evaluate_promotions_for_cart', { code: 'WELCOME20' })).reason, 'code_not_supplied_by_customer');
  assert.equal((await turn('Bonjour').run('get_stock_context', { product_ids: ['arbitrary'] })).reason, 'product_not_resolved');
});

test('Agent receives opening shopping results in one model call, never private cart codes', async () => {
  const { source, cart } = fixture();
  cart.codes = ['SECRET50']; cart.discounts = [{ title: 'SECRET50', type: 'code', amount: 1000 }]; cart.total = 3000;
  let calls = 0;
  const agent = createLlmAgent({ readShopping: async (domain) => { assert.equal(domain, source.shopDomain); return source; }, client: { async completeWithTools(input) {
    calls++; assert.ok(input.system.includes('SHOPPING RETRIEVED')); assert.ok(!input.system.includes('SECRET50'));
    assert.ok(input.tools.some((t) => t.function.name === 'get_cart_context'));
    return { content: JSON.stringify({ reply: 'Une réduction de 10 euros apparaît dans votre panier.', products: [] }), toolCalls: [] };
  } } });
  const reply = await agent.respond({ message: "Est-ce que j'ai déjà une réduction dans mon panier ?", cart, shopDomain: source.shopDomain });
  assert.equal(calls, 1); assert.equal(reply.trace.shopping.route, 'shopping_context');
  assert.ok(!JSON.stringify(reply.trace).includes('SECRET50'));
});

test('Explicit resolved product stock overrides passive cart products', async () => {
  const f = fixture(); f.source.products.forEach((p) => { p.synced_at = new Date().toISOString(); });
  const turn = createShoppingTurn({ message: "Si j'en prends deux, est-ce disponible ?", cart: f.cart, context: { productHandle: 'other-page', variantId: V1 }, readShopping: async () => f.source, shopDomain: f.source.shopDomain, resolvedProducts: [{ id: 'p2', shopifyId: f.source.products[1].shopify_product_id, handle: 'serum' }] });
  const stock = (await turn.opening()).results[0].result;
  assert.equal(stock.status, 'insufficient'); assert.equal(stock.items[0].requested_quantity, 2); assert.equal(stock.items[0].product_id, 'p2');
});

test('Multi-buy separate product scopes require both purchase and reward quantities', () => {
  const f = fixture(); const r = f.promotion.rule_snapshot;
  f.promotion.discount_type = 'DiscountCodeBxgy';
  r.customer_buys = { quantity: 1, items: { scope: 'products', products: [{ id: P1 }] } };
  r.customer_gets = { quantity: 1, percentage: 1, items: { scope: 'products', products: [{ id: f.source.products[1].shopify_product_id }] } };
  assert.equal(evaluatePromotionsForCart(f.cart, f.source, {}, { now: NOW }).promotions[0].reason, 'reward_not_in_basket');
  addSecond(f.cart);
  assert.equal(evaluatePromotionsForCart(f.cart, f.source, {}, { now: NOW }).promotions[0].status, 'eligible');
  r.customer_gets.items = { scope: 'all' };
  f.cart.lines = [f.cart.lines[0]]; f.cart.originalSubtotal = f.cart.subtotal = f.cart.total = 4000;
  assert.equal(evaluatePromotionsForCart(f.cart, f.source, {}, { now: NOW }).promotions[0].reason, 'reward_not_in_basket');
});

test('Gift threshold excludes the reward and requires the actual gift quantity', () => {
  const f = fixture(); const r = f.promotion.rule_snapshot;
  f.promotion.discount_type = 'DiscountCodeBxgy';
  r.customer_buys = { amount: '45', items: { scope: 'all' } };
  r.customer_gets = { quantity: 1, percentage: 1, items: { scope: 'products', products: [{ id: f.source.products[1].shopify_product_id }] } };
  addSecond(f.cart);
  const first = evaluatePromotionsForCart(f.cart, f.source, {}, { now: NOW, baseCurrency: 'EUR' }).promotions[0];
  assert.equal(first.reason, 'below_threshold'); assert.equal(first.requirements_remaining[0].amount, 5);
  r.customer_buys.amount = '40';
  assert.equal(evaluatePromotionsForCart(f.cart, f.source, {}, { now: NOW, baseCurrency: 'EUR' }).promotions[0].status, 'eligible');
});

test('Reply backstop removes unreturned codes, including cart, history and invented codes', async () => {
  const f = fixture(); const turn = createShoppingTurn({ readShopping: async () => f.source, shopDomain: f.source.shopDomain, cart: { ...f.cart, codes: ['PARTNER_SECRET'] }, message: 'Le code WELCOME20 fonctionne ?', history: [{ content: 'code PRIVATEWORD' }] });
  await turn.run('evaluate_promotions_for_cart', { code: 'WELCOME20' });
  const result = turn.sanitizeReply('Le code WELCOME20 est disponible. Utilisez PARTNER_SECRET ou PRIVATEWORD ou INVENTED99.');
  assert.ok(result.includes('WELCOME20'));
  for (const code of ['PARTNER_SECRET', 'PRIVATEWORD', 'INVENTED99']) assert.ok(!result.includes(code));
});

test('Failed shopping reads do not poison the cache and expired snapshots reload', async () => {
  let clock = NOW; let fail = true; let reads = 0;
  const read = createShoppingReader({ async selectAll(table) { reads++; if (fail) throw new Error('dummy'); return table === 'shops' ? [{ id: 'test' }] : []; } }, { now: () => clock, ttlMs: 30 });
  await assert.rejects(read('test.myshopify.com'));
  fail = false;
  assert.equal((await read('test.myshopify.com')).status, 'ok');
  const at = reads; await read('test.myshopify.com'); assert.equal(reads, at);
  clock += 31; await read('test.myshopify.com'); assert.ok(reads > at);
});

test('Narrow tools run after model request with no cart mutation or private values in trace', async () => {
  const f = fixture(); let calls = 0;
  const agent = createLlmAgent({ readShopping: async () => f.source, client: { async completeWithTools(input) {
    if (!calls++) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'cart', type: 'function', function: { name: 'get_cart_context', arguments: '{}' } }] }, toolCalls: [{ id: 'cart', name: 'get_cart_context', args: {} }] };
    const result = JSON.parse(input.messages.find((m) => m.role === 'tool').content);
    assert.equal(result.subtotal, 40);
    return { content: JSON.stringify({ reply: 'Le sous-total est de 40 euros.', products: [] }), toolCalls: [] };
  } } });
  const before = JSON.stringify(f.cart);
  const result = await agent.respond({ message: 'Que contient mon achat ?', cart: f.cart, shopDomain: f.source.shopDomain });
  assert.equal(calls, 2); assert.equal(JSON.stringify(f.cart), before); assert.equal(result.trace.tools[0].name, 'get_cart_context');
});
