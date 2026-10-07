/** French scenarios: deterministic expectations are declared before running any model. Dummy data only. */
export const NOW = Date.parse('2026-10-06T12:00:00Z');
export const P1 = 'gid://shopify/Product/1';
export const P2 = 'gid://shopify/Product/2';
export const V1 = 'gid://shopify/ProductVariant/11';
export const V2 = 'gid://shopify/ProductVariant/22';
export const C1 = 'gid://shopify/Collection/3';
export function fixture() {
  const promotion = { id: 'public', title: 'Offre publique test', method: 'code', codes: [{ code: 'WELCOME20', usage_count: 0 }], status: 'ACTIVE', discount_type: 'DiscountCodeBasic', discount_classes: ['PRODUCT'], offerable_in_replies: true, starts_at: '2020-01-01T00:00:00Z', ends_at: null, applies_once_per_customer: false, usage_limit: null, discount_usage_count: 0, combines_with: { order_discounts: true, product_discounts: true, shipping_discounts: true }, rule_snapshot: { customer_selection: { scope: 'all' }, customer_gets: { percentage: 0.2, items: { scope: 'all' } }, minimum_requirement: null } };
  const source = { status: 'ok', shopDomain: 'test.myshopify.com', loadedAt: NOW, products: [
    { id: 'p1', shopify_product_id: P1, title: 'Crème test', status: 'active', published_at: '2020-01-01', synced_at: new Date(NOW).toISOString(), variants: [{ id: V1, inventory_quantity: 3 }] },
    { id: 'p2', shopify_product_id: P2, title: 'Sérum test', status: 'active', published_at: '2020-01-01', synced_at: new Date(NOW).toISOString(), variants: [{ id: V2, inventory_quantity: 1 }] }
  ], promotions: [promotion], members: new Map([[C1, new Set([P1])]]) };
  const cart = { currency: 'EUR', originalSubtotal: 4000, subtotal: 4000, total: 4000, lines: [{ productId: P1, variantId: V1, quantity: 1, unitPrice: 4000, originalTotal: 4000, finalTotal: 4000 }], discounts: [], codes: [], enteredCodesAvailable: false };
  return { source, cart, promotion };
}
export function addSecond(cart, quantity = 1) {
  cart.lines.push({ productId: P2, variantId: V2, quantity, unitPrice: 1000, originalTotal: 1000 * quantity, finalTotal: 1000 * quantity });
  cart.originalSubtotal += 1000 * quantity; cart.subtotal += 1000 * quantity; cart.total += 1000 * quantity;
}
export const SHOPPING_CASES = [
  { id: 'empty', question: 'Mon panier est vide, ai-je une remise ?', expected: { status: 'not_eligible', reason: 'empty_cart' }, change({ cart }) { cart.lines = []; cart.originalSubtotal = cart.subtotal = cart.total = 0; } },
  { id: 'code', question: 'Est-ce que le code WELCOME20 marche avec mon panier ?', expected: { status: 'eligible', reason: 'known_conditions_met_code_required' } },
  { id: 'multiple', question: "Cette offre s'applique-t-elle à ces deux produits ?", expected: { status: 'eligible' }, change({ cart }) { addSecond(cart); } },
  { id: 'invalid', question: 'Pourquoi le code INCONNU99 ne fonctionne pas ?', code: 'INCONNU99', expectedRoot: 'not_found' },
  { id: 'expired', question: 'Mon code WELCOME20 est-il expiré ?', expected: { status: 'not_eligible', reason: 'expired' }, change({ promotion }) { promotion.ends_at = '2026-10-05T00:00:00Z'; } },
  { id: 'minimum', question: 'Combien me manque-t-il pour cette promotion ?', expected: { status: 'not_eligible', reason: 'below_threshold', gap: 10 }, change({ promotion }) { promotion.rule_snapshot.minimum_requirement = { type: 'subtotal', amount: '50', currency: 'EUR' }; } },
  { id: 'excluded', question: "Ce produit est-il exclu de l'offre ?", expected: { status: 'not_eligible', reason: 'items_not_qualifying' }, change({ promotion }) { promotion.rule_snapshot.customer_gets.items = { scope: 'products', products: [{ id: P2 }] }; } },
  { id: 'collection', question: 'Ma crème de cette collection bénéficie-t-elle du code ?', expected: { status: 'eligible' }, change({ promotion }) { promotion.rule_snapshot.customer_gets.items = { scope: 'collections', collections: [{ id: C1 }] }; } },
  { id: 'collection-unknown', question: 'Cette collection est-elle éligible ?', expected: { status: 'unknown', reason: 'collection_or_item_scope_unknown' }, change({ source, promotion }) { source.members.clear(); promotion.rule_snapshot.customer_gets.items = { scope: 'collections', collections: [{ id: C1 }] }; } },
  { id: 'automatic', question: "Est-ce que j'ai déjà une réduction automatique ?", expected: { status: 'applied' }, change({ cart, promotion }) { promotion.method = 'automatic'; promotion.codes = []; promotion.describable_in_replies = true; promotion.discount_type = 'DiscountAutomaticBasic'; cart.discounts = [{ title: promotion.title, type: 'automatic', amount: 800 }]; cart.total = 3200; } },
  { id: 'already-code', question: 'Le code est-il déjà appliqué ?', expected: { status: 'applied' }, change({ cart }) { cart.discounts = [{ title: 'WELCOME20', type: 'code', amount: 800 }]; cart.codes = ['WELCOME20']; cart.total = 3200; } },
  { id: 'non-stack', question: 'Puis-je cumuler cette remise avec mon code ?', expected: { status: 'not_eligible', reason: 'not_combinable' }, change({ cart, source, promotion }) { promotion.combines_with.product_discounts = false; source.promotions.push({ ...structuredClone(promotion), id: 'auto', title: 'Automatique test', method: 'automatic', codes: [], describable_in_replies: true, discount_type: 'DiscountAutomaticBasic' }); cart.discounts = [{ title: 'Automatique test', type: 'automatic', amount: 400 }]; cart.total = 3600; } },
  { id: 'private', question: 'Quelles offres sont disponibles en ce moment ?', expectedRoot: 'not_found', change({ promotion }) { promotion.offerable_in_replies = false; } },
  { id: 'customer', question: 'Ai-je droit à ce code réservé ?', expected: { status: 'unknown', reason: 'customer_eligibility_requires_checkout' }, change({ promotion }) { promotion.rule_snapshot.customer_selection = { scope: 'segments' }; } },
  { id: 'once', question: 'Puis-je réutiliser ce code ?', expected: { status: 'unknown', reason: 'customer_eligibility_requires_checkout' }, change({ promotion }) { promotion.applies_once_per_customer = true; } },
  { id: 'currency', question: 'Puis-je utiliser ce code sur mon panier en dollars ?', expected: { status: 'unknown', reason: 'threshold_currency_unknown_or_different' }, change({ cart, promotion }) { cart.currency = 'USD'; promotion.rule_snapshot.minimum_requirement = { type: 'subtotal', amount: '50', currency: 'EUR' }; } },
  { id: 'quantity', question: 'Combien de produits me manque-t-il ?', expected: { status: 'not_eligible', reason: 'below_quantity' }, change({ promotion }) { promotion.rule_snapshot.minimum_requirement = { type: 'quantity', quantity: 3 }; } },
  { id: 'app', question: 'Cette promotion externe fonctionne-t-elle ?', expected: { status: 'unknown', reason: 'unsupported_rules' }, change({ promotion }) { promotion.discount_type = 'DiscountCodeApp'; } },
  { id: 'threshold-straddle', question: 'Ma réduction change-t-elle le montant minimum ?', note: 'order minimum: met before AND after product discounts (Shopify)', expected: { status: 'not_eligible', reason: 'below_threshold', gap: 5 }, change({ cart, promotion }) { promotion.rule_snapshot.minimum_requirement = { type: 'subtotal', amount: '35', currency: 'EUR' }; cart.lines[0].finalTotal = 3000; cart.subtotal = cart.total = 3000; cart.discounts = [{ title: 'Autre réduction', type: 'unknown', amount: 1000 }]; } }
];
