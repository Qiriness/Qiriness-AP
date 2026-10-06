import assert from 'node:assert/strict';
import test from 'node:test';
import contract from '../../../storefront-app/extensions/storefront-advisor/assets/advisor-cart.js';
import { parseChatRequest } from './request-schema.mjs';
import { createLlmAgent } from './llm-agent.mjs';
import { getCartContext, getStockContext, evaluatePromotionsForCart } from './shopping-evaluator.mjs';

const rawCart = {
  currency: 'EUR', original_total_price: 5000, items_subtotal_price: 5000, total_price: 5000,
  items: [
    { product_id: 901, variant_id: 911, product_title: 'Crème hydratante test', variant_title: '50 ml', handle: 'creme-test', quantity: 1, original_price: 3000, original_line_price: 3000, final_line_price: 3000 },
    { product_id: 902, variant_id: 912, product_title: 'Sérum éclat test', variant_title: '30 ml', handle: 'serum-test', quantity: 1, original_price: 2000, original_line_price: 2000, final_line_price: 2000 }
  ]
};

for (const message of ["I've added some itmes to my cart, I wanted to know if they are adapted", 'Im on the cart page, can you see it now', 'Are they adapted to my skin?']) {
  test(`unsynced dev cart names survive browser, request and opening prompt: ${message}`, async () => {
    assert.equal(contract.needsCartSnapshot(message, null, { pageType: 'cart' }), true);
    const parsed = parseChatRequest({ message, context: { pageType: 'cart', locale: 'en' }, cart: contract.fromAjaxCart(rawCart) });
    let seen;
    const agent = createLlmAgent({ readShopping: async () => ({ status: 'unavailable', reason: 'shop_not_synced' }), client: { async completeWithTools(input) {
      seen = input.system;
      assert.ok(seen.includes('Crème hydratante test'), 'first observed cart product name must reach the model');
      assert.ok(seen.includes('Sérum éclat test'), 'second observed cart product name must reach the model');
      assert.ok(seen.includes('50 ml'), 'selected variant label must reach the model');
      assert.ok(seen.includes('gid://shopify/Product/901'));
      assert.ok(!seen.includes('product description invented'));
      return { content: JSON.stringify({ reply: 'I can see your cream and serum. What is your skin type?', products: [] }), toolCalls: [] };
    } } });
    await agent.respond({ ...parsed, shopDomain: 'dev-test.myshopify.com' });
    assert.ok(seen);
  });
}

test('Observed labels do not manufacture synced identity, stock, eligibility or product facts', () => {
  const cart = contract.fromAjaxCart(rawCart);
  const unavailable = { status: 'unavailable', reason: 'shop_not_synced' };
  const result = getCartContext(cart, unavailable);
  assert.equal(result.lines[0].name, 'Crème hydratante test');
  assert.equal(result.lines[0].name_source, 'cart_observation');
  assert.equal(result.lines[0].product_id, null);
  assert.equal(result.lines[0].variant_known, false);
  assert.equal(getStockContext(cart, unavailable).status, 'unavailable');
  assert.equal(evaluatePromotionsForCart(cart, unavailable).status, 'unavailable');
  assert.ok(!JSON.stringify(result).includes('properties'));
});

test('Cart labels are bounded, stripped of markup/control characters, and subordinate to same-shop synced titles', () => {
  const cart = contract.fromAjaxCart(rawCart);
  const clean = contract.normalizeSnapshot({ ...cart, lines: [{ ...cart.lines[0], productName: '<b>Crème</b>\u0000 test', variantTitle: 'x'.repeat(101) }, cart.lines[1]] });
  assert.equal(clean.lines[0].productName, 'Crème test');
  assert.equal(clean.lines[0].variantTitle, null);
  const result = getCartContext(clean, { status: 'ok', products: [{ id: 'real', shopify_product_id: clean.lines[0].productId, title: 'Authoritative title', variants: [] }], promotions: [] });
  assert.equal(result.lines[0].name, 'Authoritative title');
  assert.equal(result.lines[0].name_source, 'synced_product');
  assert.equal(contract.needsCartSnapshot('Can I pay in installments?', null, { pageType: 'cart' }), false);
});
