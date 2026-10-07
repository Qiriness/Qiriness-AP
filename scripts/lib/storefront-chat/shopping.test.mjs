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
  assert.equal(getActivePromotions(source, { topic: 'non_shipping' }, NOW).promotions.length, 0);
  assert.equal(getActivePromotions(source, {}, NOW).promotions.length, 1, 'free delivery is listed by default');
  assert.equal(getActivePromotions(source, {}, NOW).promotions[0].delivery_cost, 'not_calculated');
  assert.notEqual(evaluatePromotionsForCart(cart, source, { code: 'WELCOME20' }, { now: NOW }).promotions[0].reason, 'shipping_out_of_scope');
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
  // Six reads: shop, products, public codes, automatic offers, collections, and
  // the shop's active codes used ONLY to recognise a code applied in the cart.
  await reader('test.myshopify.com'); assert.equal(calls.length, 6);
  assert.ok(source.cartCodeRows.some((p) => p.id === 'secret'), 'a private code can be recognised in a cart');
  assert.ok(!source.promotions.some((p) => p.id === 'secret'), '…but never reaches the offers');
  assert.ok(!getActivePromotions(source, {}, NOW).promotions.some((p) => p.promotion_id === 'secret'), '…nor the listing');
  assert.doesNotMatch(calls.find((c) => c.filters.status === 'ACTIVE' && c.filters.method === 'code').columns, /rule_snapshot|usage/);
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

test('free delivery is evaluated against the cart: the minimum, the gap, the destination — never a cost', () => {
  const { source, promotion } = fixture();
  promotion.method = 'automatic';
  promotion.codes = [];
  promotion.describable_in_replies = true;
  promotion.discount_type = 'DiscountAutomaticFreeShipping';
  promotion.discount_classes = ['SHIPPING'];
  promotion.rule_snapshot = {
    discount_type: 'DiscountAutomaticFreeShipping',
    destination: { scope: 'countries', countries: ['FR'], include_rest_of_world: false },
    minimum_requirement: { type: 'subtotal', amount: '70.0', currency: 'EUR' },
    customer_selection: null
  };
  const variant = source.products[0].variants[0];
  const productId = source.products[0].shopify_product_id;
  const line = (unit, quantity = 1) => ({ productId, variantId: variant.id, productName: 'x', variantTitle: null, quantity, unitPrice: unit, originalTotal: unit * quantity, finalTotal: unit * quantity, controlledPricing: false });
  const cartOf = (lines, total) => {
    const sum = lines.reduce((n, l) => n + l.originalTotal, 0);
    return { lines, currency: 'EUR', originalSubtotal: sum, subtotal: sum, total: total ?? sum, codes: [], discounts: [] };
  };

  const short = evaluatePromotionsForCart(cartOf([line(1183)]), source, { promotion_ids: [promotion.id] }, { now: NOW }).promotions[0];
  assert.equal(short.status, 'not_eligible');
  assert.equal(short.reason, 'below_subtotal');
  assert.deepEqual(short.requirements_remaining, [{ type: 'spend', amount: 58.17, currency: 'EUR' }]);

  const met = evaluatePromotionsForCart(cartOf([line(6895), line(1183)]), source, { promotion_ids: [promotion.id] }, { now: NOW }).promotions[0];
  assert.equal(met.status, 'eligible');
  assert.equal(met.reason, 'threshold_met_destination_required');
  assert.deepEqual(met.destination.countries, ['FR']);
  assert.equal(met.delivery_cost, 'not_calculated');

  // An order discount between total and subtotal decides it: unknown, not guessed.
  const between = cartOf([line(7500)], 6500);
  between.discounts = [];
  const decided = evaluatePromotionsForCart(between, source, { promotion_ids: [promotion.id] }, { now: NOW }).promotions[0];
  assert.equal(decided.status, 'unknown');

  promotion.rule_snapshot.minimum_requirement.currency = 'GBP';
  assert.equal(evaluatePromotionsForCart(cartOf([line(9000)]), source, { promotion_ids: [promotion.id] }, { now: NOW }).promotions[0].reason, 'threshold_currency_unknown_or_different');
});

test('an offers question that came with a cart also evaluates the cart', async () => {
  const f = fixture();
  const withCart = await createShoppingTurn({ message: 'Quelle offre puis-je avoir ?', shopDomain: f.source.shopDomain, cart: f.cart, readShopping: async () => f.source }).opening();
  assert.deepEqual(withCart.results.map((r) => r.tool), ['get_active_promotions', 'evaluate_promotions_for_cart', 'simulate_offers']);
  const noCart = await createShoppingTurn({ message: 'Quelle offre puis-je avoir ?', shopDomain: f.source.shopDomain, cart: null, readShopping: async () => f.source }).opening();
  assert.deepEqual(noCart.results.map((r) => r.tool), ['get_active_promotions'], 'no cart: listing only');
});

test('a gift nobody can add is unavailable, not « add it to your cart »', () => {
  const BUY = 'gid://shopify/Product/901', GIFT = 'gid://shopify/Product/902';
  const product = (gid, extra = {}) => ({ id: gid, shopify_product_id: gid, title: gid, status: 'active', published_at: '2026-01-01', deleted_at: null, synced_at: new Date(NOW).toISOString(), variants: [{ id: gid.replace('Product/', 'ProductVariant/') + '1', price: '20', inventory_quantity: 5 }], ...extra });
  const offer = {
    id: 'gift', title: 'Cadeau', method: 'automatic', status: 'ACTIVE', describable_in_replies: true, discount_type: 'DiscountAutomaticBxgy', discount_classes: ['PRODUCT'],
    combines_with: { order_discounts: false, product_discounts: false, shipping_discounts: false },
    rule_snapshot: { discount_type: 'DiscountAutomaticBxgy', customer_buys: { items: { scope: 'products', products: [{ id: BUY }] }, quantity: '1' }, customer_gets: { items: { scope: 'products', products: [{ id: GIFT }] }, quantity: 1, percentage: 1 }, minimum_requirement: null, customer_selection: null }
  };
  const line = { productId: BUY, variantId: 'gid://shopify/ProductVariant/9011', productName: 'x', variantTitle: null, quantity: 1, unitPrice: 2000, originalTotal: 2000, finalTotal: 2000, controlledPricing: false };
  const cart = { lines: [line], currency: 'EUR', originalSubtotal: 2000, subtotal: 2000, total: 2000, codes: [], discounts: [] };
  const source = (gift) => ({ status: 'ok', shopDomain: 's.myshopify.com', products: [product(BUY), gift], promotions: [offer], members: new Map(), loadedAt: NOW });

  const live = evaluatePromotionsForCart(cart, source(product(GIFT)), {}, { now: NOW }).promotions[0];
  assert.equal(live.reason, 'reward_not_in_basket', 'a live gift: add it');
  const draft = evaluatePromotionsForCart(cart, source(product(GIFT, { status: 'draft', published_at: null })), {}, { now: NOW }).promotions[0];
  assert.equal(draft.status, 'not_eligible');
  assert.equal(draft.reason, 'reward_unavailable');
  const soldOut = evaluatePromotionsForCart(cart, source(product(GIFT, { variants: [{ id: 'gid://shopify/ProductVariant/9021', price: '20', inventory_quantity: 0 }] })), {}, { now: NOW }).promotions[0];
  assert.equal(soldOut.status, 'unknown');
  assert.equal(soldOut.reason, 'reward_out_of_stock');

  // A negative count is Shopify selling past zero: sellable, so « add it ».
  const oversold = evaluatePromotionsForCart(cart, source(product(GIFT, { variants: [{ id: 'gid://shopify/ProductVariant/9021', price: '20', inventory_quantity: -1 }] })), {}, { now: NOW }).promotions[0];
  assert.equal(oversold.reason, 'reward_not_in_basket');

  // The reward already in the cart: its synced count no longer matters.
  const giftLine = { productId: GIFT, variantId: 'gid://shopify/ProductVariant/9021', productName: 'g', variantTitle: null, quantity: 1, unitPrice: 2000, originalTotal: 2000, finalTotal: 2000, controlledPricing: false };
  const both = { ...cart, lines: [line, giftLine], originalSubtotal: 4000, subtotal: 4000, total: 4000 };
  const inCart = evaluatePromotionsForCart(both, source(product(GIFT, { variants: [{ id: 'gid://shopify/ProductVariant/9021', price: '20', inventory_quantity: 0 }] })), {}, { now: NOW }).promotions[0];
  assert.notEqual(inCart.reason, 'reward_out_of_stock');
});

test('cart.js discounts are read in both shapes, and an untyped one is matched by its title', () => {
  const item = (extra) => ({ product_id: 901, variant_id: 9011, product_title: 'Baume', variant_title: null, quantity: 1, original_price: 2095, original_line_price: 2095, final_line_price: 1467, ...extra });
  const base = { currency: 'EUR', original_total_price: 2095, items_subtotal_price: 1467, total_price: 1467, cart_level_discount_applications: [] };
  const modern = contract.fromAjaxCart({ ...base, items: [item({ line_level_discount_allocations: [{ amount: 628, discount_application: { type: 'automatic', title: 'September Rose' } }] })] });
  const legacy = contract.fromAjaxCart({ ...base, items: [item({ line_level_discount_allocations: [], discounts: [{ amount: 628, title: 'September Rose' }] })] });
  assert.deepEqual(modern.discounts, [{ title: 'September Rose', type: 'automatic', amount: 628 }]);
  assert.deepEqual(legacy.discounts, [{ title: 'September Rose', type: 'unknown', amount: 628 }]);

  const offer = { id: 'sept', title: 'September Rose', method: 'automatic', status: 'ACTIVE', describable_in_replies: true, discount_type: 'DiscountAutomaticBasic', discount_classes: ['PRODUCT'], combines_with: {}, codes: [], rule_snapshot: {} };
  const source = { status: 'ok', products: [], promotions: [offer], members: new Map(), loadedAt: NOW };
  assert.equal(getCartContext(legacy, source).discounts[0].promotion_id, 'sept', 'the untyped discount is September Rose');
  assert.equal(getCartContext(legacy, source).discounts[0].name, 'September Rose');
});

test('a private code the shopper applied is named back to them and used for stacking — and only then', () => {
  const f = fixture();
  const secret = { ...structuredClone(f.promotion), id: 'secret', title: 'Code bienvenue', offerable_in_replies: false, codes: [{ code: 'BIENVENUE20' }], combines_with: { order_discounts: false, product_discounts: false, shipping_discounts: false } };
  const source = { ...f.source, cartCodeRows: [secret] };
  const cart = { ...f.cart, codes: ['BIENVENUE20'], discounts: [{ title: 'BIENVENUE20', type: 'code', amount: 500 }], total: f.cart.subtotal - 500 };

  const ctx = getCartContext(cart, source);
  assert.equal(ctx.discounts[0].name, 'Code bienvenue');
  assert.equal(ctx.discounts[0].code, 'BIENVENUE20');
  assert.equal(ctx.discounts[0].entered_by_customer, true);
  assert.deepEqual(ctx.applied_codes, ['BIENVENUE20']);

  // Not in this cart: never named, never listed.
  assert.equal(getCartContext({ ...f.cart, codes: [], discounts: [] }, source).applied_codes.length, 0);
  assert.ok(!getActivePromotions(source, {}, NOW).promotions.some((p) => p.promotion_id === 'secret'));

  // « Does BIENVENUE20 work? » while it is applied here: applied.
  const asked = evaluatePromotionsForCart(cart, source, { code: 'BIENVENUE20' }, { now: NOW });
  assert.equal(asked.promotions[0].status, 'applied');
  // And a public offer is judged against it: it combines with nothing.
  const pub = evaluatePromotionsForCart(cart, source, {}, { now: NOW }).promotions.find((p) => p.promotion_id === f.promotion.id);
  assert.equal(pub.reason, 'not_combinable');
});

test('a follow-up with a cart, after a shopping reply, is evaluated again — without a shopping word', async () => {
  const f = fixture();
  const history = [
    { role: 'user', content: 'What is in my basket?' },
    { role: 'assistant', content: 'Your basket contains…', context: { trace: { shopping: { route: 'shopping_context' } } } }
  ];
  const turn = (cart, h) => createShoppingTurn({ message: 'why did that not apply?', shopDomain: f.source.shopDomain, cart, history: h, readShopping: async () => f.source });
  assert.deepEqual((await turn(f.cart, history).opening()).results.map((r) => r.tool), ['get_cart_context', 'evaluate_promotions_for_cart', 'simulate_offers']);
  assert.equal(await turn(null, history).opening(), null, 'no cart: nothing to evaluate');
  assert.equal(await turn(f.cart, []).opening(), null, 'no shopping reply before: not a follow-up');
  assert.equal(contract.needsShoppingContext('why did the 30 percent off not apply?'), true);
  assert.equal(contract.needsShoppingContext('pourquoi les 30 % ne sont pas déduits ?'), true);
  assert.equal(contract.needsShoppingContext('comment appliquer ce sérum ?'), false, 'applying a cream is not a discount');
});

test('one product discount per line: an offer whose lines are all discounted already cannot apply', () => {
  const f = fixture();
  const other = { ...structuredClone(f.promotion), id: 'two-for-one', title: 'Deux pour un', method: 'automatic', codes: [], describable_in_replies: true, discount_classes: ['PRODUCT'] };
  const source = { ...f.source, promotions: [...f.source.promotions, other] };
  const discounted = (titles) => ({ ...f.cart, lines: f.cart.lines.map((l) => ({ ...l, discountTitles: titles })) });
  const target = (cart) => evaluatePromotionsForCart(cart, source, { promotion_ids: [f.promotion.id] }, { now: NOW }).promotions[0];

  const blocked = target(discounted(['Deux pour un']));
  assert.equal(blocked.status, 'not_eligible');
  assert.equal(blocked.reason, 'line_already_discounted');
  assert.deepEqual(blocked.blocked_by, ['Deux pour un']);
  assert.notEqual(target(discounted([])).reason, 'line_already_discounted', 'free lines: it can apply');

  const fromAjax = contract.fromAjaxCart({ currency: 'EUR', original_total_price: 2000, items_subtotal_price: 1000, total_price: 1000, cart_level_discount_applications: [],
    items: [{ product_id: 901, variant_id: 9011, product_title: 'x', variant_title: null, quantity: 1, original_price: 2000, original_line_price: 2000, final_line_price: 1000,
      line_level_discount_allocations: [{ amount: 1000, discount_application: { type: 'automatic', title: 'Deux pour un' } }] }] });
  assert.deepEqual(fromAjax.lines[0].discountTitles, ['Deux pour un'], 'the widget records which discounts sit on each line');
});

test('an amount names the offer: « why did the 30 % not apply? » evaluates that offer, marked', async () => {
  const f = fixture();
  const pct = Math.round(getActivePromotions(f.source, {}, NOW).promotions[0].reward.percentage ?? 0);
  const turn = createShoppingTurn({ message: `why did the ${pct} percent off not apply?`, shopDomain: f.source.shopDomain, cart: f.cart, readShopping: async () => f.source });
  const opening = await turn.opening();
  assert.deepEqual(opening.results.map((r) => r.tool), ['get_cart_context', 'evaluate_promotions_for_cart', 'simulate_offers']);
  const evaluation = opening.results[1].result;
  assert.equal(evaluation.mentioned_by_customer, true);
  assert.deepEqual(evaluation.promotions.map((p) => p.promotion_id), [f.promotion.id]);
});

test('an applied Buy X Get Y locks its « buys » line too, though cart.js allocates nothing to it', () => {
  const f = fixture();
  const P2 = f.source.products[1].shopify_product_id;
  const bxgy = { ...structuredClone(f.promotion), id: 'test02', title: 'TEST02', method: 'automatic', codes: [], discount_type: 'DiscountAutomaticBxgy', describable_in_replies: true,
    rule_snapshot: { customer_selection: { scope: 'all' }, customer_buys: { quantity: 1, items: { scope: 'products', products: [{ id: P1 }] } }, customer_gets: { quantity: 1, percentage: 1, items: { scope: 'products', products: [{ id: P2 }] } }, minimum_requirement: null } };
  const source = { ...f.source, promotions: [...f.source.promotions, bxgy] };
  addSecond(f.cart);
  f.cart.lines[1].finalTotal = 0; f.cart.lines[1].discountTitles = ['TEST02']; f.cart.subtotal -= 1000; f.cart.total -= 1000;
  f.cart.discounts = [{ title: 'TEST02', type: 'automatic', amount: 1000 }];
  const target = (opts) => evaluatePromotionsForCart(f.cart, source, { promotion_ids: [f.promotion.id] }, { now: NOW, ...opts }).promotions[0];
  const locked = target();
  assert.equal(locked.reason, 'line_already_discounted');
  assert.deepEqual(locked.blocked_by, ['TEST02']);
  assert.notEqual(target({ shopifyPlus: true }).reason, 'line_already_discounted', 'Plus: only the buys item stays exclusive, the gets line may stack');
});

test('minimums by class: product discounts see prices after other product discounts; order discounts both sides', () => {
  const product = fixture();
  product.promotion.rule_snapshot.minimum_requirement = { type: 'subtotal', amount: '35', currency: 'EUR' };
  product.cart.lines[0].finalTotal = 3000; product.cart.subtotal = product.cart.total = 3000;
  const p = evaluatePromotionsForCart(product.cart, product.source, {}, { now: NOW }).promotions[0];
  assert.equal(p.reason, 'below_threshold'); assert.equal(p.measured_on, 'after_other_product_discounts');

  const order = fixture();
  order.promotion.discount_classes = ['ORDER'];
  order.promotion.rule_snapshot.minimum_requirement = { type: 'subtotal', amount: '35', currency: 'EUR' };
  const met = evaluatePromotionsForCart(order.cart, order.source, {}, { now: NOW }).promotions[0];
  assert.equal(met.status, 'eligible', 'met before and after');
  order.cart.lines[0].finalTotal = 3000; order.cart.subtotal = order.cart.total = 3000;
  const straddle = evaluatePromotionsForCart(order.cart, order.source, {}, { now: NOW }).promotions[0];
  assert.equal(straddle.reason, 'below_threshold'); assert.equal(straddle.measured_on, 'order_minimum_before_and_after_product_discounts');
  assert.equal(straddle.requirements_remaining[0].amount, 5);
});

test('a public automatic offer named like a code is that offer, and its name is never masked', async () => {
  const f = fixture();
  const auto = { ...structuredClone(f.promotion), id: 'test02', title: 'TEST02', method: 'automatic', codes: [], describable_in_replies: true, discount_type: 'DiscountAutomaticBasic' };
  const source = { ...f.source, promotions: [...f.source.promotions, auto] };
  const turn = createShoppingTurn({ readShopping: async () => source, shopDomain: source.shopDomain, cart: f.cart, message: 'pourquoi TEST02 ne s’active pas ?' });
  const r = await turn.run('evaluate_promotions_for_cart', { code: 'TEST02' });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.promotions.map((p) => p.promotion_id), ['test02']);
  const fresh = createShoppingTurn({ readShopping: async () => source, shopDomain: source.shopDomain, cart: f.cart, message: 'et TEST02 ?' });
  const text = 'L’offre TEST02 est éligible.';
  await fresh.beforeSanitize(text);
  assert.equal(fresh.sanitizeReply(text), text, 'loaded before the backstop, even when no shopping tool ran');
  assert.ok(!fresh.sanitizeReply('Utilisez SECRET99.').includes('SECRET99'), 'real unreturned codes are still masked');
});

test('a shopping question with a cart that names no known word still evaluates the cart, with the best combination', async () => {
  const f = fixture();
  const turn = createShoppingTurn({ readShopping: async () => f.source, shopDomain: f.source.shopDomain, cart: f.cart, message: 'Why did it apply to my checkout and not the free one?', baseCurrency: 'EUR' });
  const opening = await turn.opening();
  assert.deepEqual(opening.results.map((r) => r.tool), ['get_cart_context', 'evaluate_promotions_for_cart', 'simulate_offers']);
});

test('a Buy X Get Y whose « buys » items take another product discount is « taken », not « spend more »', () => {
  const f = fixture();
  const P2 = f.source.products[1].shopify_product_id;
  const rose = { ...structuredClone(f.promotion), id: 'rose', title: 'September Rose', method: 'automatic', codes: [], describable_in_replies: true, discount_type: 'DiscountAutomaticBasic' };
  const bxgy = { ...structuredClone(f.promotion), id: 'test02', title: 'TEST02', method: 'automatic', codes: [], describable_in_replies: true, discount_type: 'DiscountAutomaticBxgy',
    rule_snapshot: { customer_selection: { scope: 'all' }, customer_buys: { amount: '35', items: { scope: 'products', products: [{ id: P1 }] } }, customer_gets: { quantity: 1, percentage: 1, items: { scope: 'products', products: [{ id: P2 }] } }, minimum_requirement: null } };
  const source = { ...f.source, promotions: [rose, bxgy] };
  addSecond(f.cart);
  for (const l of f.cart.lines) { l.finalTotal = Math.round(l.originalTotal * 0.8); l.discountTitles = ['September Rose']; }
  f.cart.subtotal = f.cart.total = f.cart.lines.reduce((n, l) => n + l.finalTotal, 0);
  f.cart.discounts = [{ title: 'September Rose', type: 'automatic', amount: f.cart.originalSubtotal - f.cart.subtotal }];
  const r = evaluatePromotionsForCart(f.cart, source, { promotion_ids: ['test02'] }, { now: NOW, baseCurrency: 'EUR' }).promotions[0];
  assert.equal(r.reason, 'line_already_discounted');
  assert.deepEqual(r.blocked_by, ['September Rose']);
});

test('stacking rules for the plan travel with the offers: one product discount per item off Plus', () => {
  const f = fixture();
  const rules = getActivePromotions(f.source, {}, NOW).stacking_rules;
  assert.equal(rules.product_discounts_per_item, 1);
  assert.equal(rules.buy_x_get_y_items, 'both_items_exclusive');
  assert.equal(evaluatePromotionsForCart(f.cart, f.source, {}, { now: NOW }).stacking_rules.shopify_plus, false);
  assert.equal(getActivePromotions({ ...f.source, shopifyPlus: true }, {}, NOW).stacking_rules.product_discounts_per_item, 'several_if_tagged_to_combine');
});

test('a code we cannot see gets reasoning from the cart: an applied code that refuses order discounts blocks it', async () => {
  const f = fixture();
  const blocker = { id: 'bienvenue', title: 'BIENVENUE20', codes: [{ code: 'BIENVENUE20' }], method: 'code', discount_type: 'DiscountCodeBasic', discount_classes: ['ORDER'], combines_with: { order_discounts: false, product_discounts: true, shipping_discounts: true }, status: 'ACTIVE' };
  const source = { ...f.source, cartCodeRows: [blocker] };
  const cart = { ...f.cart, codes: ['BIENVENUE20'], discounts: [{ title: 'BIENVENUE20', type: 'code', amount: 800 }], total: 3200 };
  const r = evaluatePromotionsForCart(cart, source, { code: 'QIRINESS10' }, { now: NOW });
  assert.equal(r.status, 'not_found');
  assert.deepEqual(r.cart_reasoning.blocks_new_order_codes, ['BIENVENUE20']);
  assert.deepEqual(r.cart_reasoning.blocks_new_product_codes, []);
  assert.ok(!JSON.stringify(r).includes('QIRINESS10'), 'nothing about the typed code is returned');
  const turn = createShoppingTurn({ readShopping: async () => source, shopDomain: source.shopDomain, cart, message: "J'arrive pas appliquer mon code QIRINESS10" });
  await turn.run('get_cart_context');
  assert.equal(turn.sanitizeReply('Le code QIRINESS10 ne se cumule pas avec BIENVENUE20.'), 'Le code QIRINESS10 ne se cumule pas avec BIENVENUE20.', 'the customer typed it; BIENVENUE20 is in their cart');
  assert.ok(!turn.sanitizeReply('Essayez SECRET99.').includes('SECRET99'));
});
