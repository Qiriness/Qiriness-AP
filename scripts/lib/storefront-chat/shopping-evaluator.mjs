import cartContract from '../../../storefront-app/extensions/storefront-advisor/assets/advisor-cart.js';
import { promotionMechanic } from '../promotion-mechanic.mjs';
import { combinable, evaluateOutcome } from '../../../agent/src/retrieval/promotion-outcome.mjs';
import { isPublicPromotion } from './shopping-repository.mjs';

export const { normalizeSnapshot, needsShoppingContext } = cartContract;
const norm = (value) => String(value ?? '').trim().toUpperCase();
const amount = (minor) => minor / 100; // Shopify Ajax monetary integers use hundredths, including JPY.
const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const publicRows = (source) => (source?.promotions ?? []).filter(isPublicPromotion);
const codesOf = (row) => (row.codes ?? []).map((c) => cartContract.code(c.code)).filter(Boolean);
const liveProduct = (p) => p?.status?.toLowerCase() === 'active' && p.published_at && !p.deleted_at;
const missing = (reason) => ({ status: 'unknown', reason });

export function running(p, now = Date.now()) {
  if (p.ends_at && (!Number.isFinite(Date.parse(p.ends_at)) || now >= Date.parse(p.ends_at))) return 'expired';
  if (p.starts_at && (!Number.isFinite(Date.parse(p.starts_at)) || now < Date.parse(p.starts_at))) return 'not_started';
  return p.status === 'ACTIVE' ? null : 'inactive';
}

function matchedDiscount(discount, rows) {
  const matches = rows.filter((p) => p.method === discount.type && (discount.type === 'code' ? codesOf(p).includes(norm(discount.title)) : norm(p.title) === norm(discount.title)));
  return matches.length === 1 ? matches[0] : null;
}

/** Raw client labels/codes NEVER reach the model. Only public DB matches can be named. */
export function getCartContext(raw, source, context = {}) {
  const cart = normalizeSnapshot(raw);
  if (!cart) return { status: 'unavailable', reason: 'cart_snapshot_missing_or_invalid' };
  const rows = publicRows(source);
  return {
    status: 'ok', source: 'shopify_ajax_snapshot', verified: false, money_unit: 'major',
    country: context.country ?? null, market: context.market ?? null, logged_in_observed: typeof context.loggedIn === 'boolean' ? context.loggedIn : null, currency: cart.currency,
    subtotal: amount(cart.subtotal), original_subtotal: amount(cart.originalSubtotal), total: amount(cart.total), discount_total: amount(cart.originalSubtotal - cart.total),
    lines: cart.lines.map((l) => {
      const product = source?.products?.find((p) => p.shopify_product_id === l.productId);
      const variant = product?.variants?.find((v) => v.id === l.variantId);
      return { product_id: product?.id ?? null, shopify_product_id: l.productId, variant_id: l.variantId, name: product?.title ?? l.productName ?? null, name_source: product?.title ? 'synced_product' : l.productName ? 'cart_observation' : null, variant_title: variant?.title ?? l.variantTitle ?? null, variant_known: Boolean(variant), quantity: l.quantity, unit_price: amount(l.unitPrice), original_total: amount(l.originalTotal), final_total: amount(l.finalTotal) };
    }),
    discounts: cart.discounts.map((d) => {
      const p = matchedDiscount(d, rows);
      return { promotion_id: p?.id ?? null, name: p?.title ?? 'Réduction appliquée', type: d.type, amount: amount(d.amount), code: p && d.type === 'code' ? norm(d.title) : null };
    }),
    applied_codes: cart.codes.filter((c) => rows.some((p) => codesOf(p).includes(c))),
    entered_codes_available: cart.enteredCodesAvailable, data_status: source?.status ?? 'unavailable'
  };
}

export function getActivePromotions(source, { limit = 8, topic = 'non_shipping' } = {}, now = Date.now()) {
  if (source?.status !== 'ok') return { status: 'unavailable', reason: source?.reason ?? 'source_unavailable', promotions: [] };
  const candidates = publicRows(source).filter((p) => !running(p, now) && (topic === 'free_shipping' ? promotionMechanic(p) === 'free_shipping' : promotionMechanic(p) !== 'free_shipping'));
  const cap = Number.isInteger(limit) ? Math.min(12, Math.max(1, limit)) : 8;
  return { status: 'ok', promotions: candidates.slice(0, cap).map((p) => {
    const offer = publicOffer(p);
    if (topic !== 'free_shipping') return offer;
    const destination = p.rule_snapshot?.destination;
    return { ...offer, destination: destination ? { scope: destination.scope, countries: (destination.countries ?? []).filter((c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c)).slice(0, 250), include_rest_of_world: destination.include_rest_of_world === true } : null, cart_eligibility: 'not_evaluated', delivery_cost: 'not_calculated' };
  }), has_more: candidates.length > cap, scope: topic === 'free_shipping' ? 'public_shipping_offer_terms' : 'public_non_shipping_offers', loaded_at: new Date(source.loadedAt).toISOString() };
}

function publicOffer(p, requestedCode = null) {
  const r = p.rule_snapshot ?? {};
  const min = r.minimum_requirement;
  const minimum = !min ? null : min.type === 'subtotal' ? { type: 'subtotal', amount: finite(min.amount) ? Number(min.amount) : null, currency: min.currency ?? null } : min.type === 'quantity' ? { type: 'quantity', quantity: finite(min.quantity) ? Number(min.quantity) : null } : { type: 'unknown' };
  return { promotion_id: p.id, name: p.title, type: p.method, mechanic: promotionMechanic(p), code: p.method === 'code' ? requestedCode ?? codesOf(p)[0] ?? null : null, starts_at: p.starts_at ?? null, ends_at: p.ends_at ?? null, reward: { percentage: finite(r.customer_gets?.percentage) ? Number(r.customer_gets.percentage) * 100 : null, amount: finite(r.customer_gets?.amount) ? Number(r.customer_gets.amount) : null, currency: r.customer_gets?.currency ?? null, quantity: r.customer_gets?.quantity ?? null }, minimum, synced_at: p.synced_at ?? null };
}

/** Variant quantities, including duplicate cart lines. Synced inventory is not a live reservation. */
export function getStockContext(raw, source, { productIds = [], variantId = null, quantity = null, cartScope = true } = {}, now = Date.now()) {
  if (source?.status !== 'ok') return { status: 'unavailable', reason: source?.reason ?? 'source_unavailable', items: [] };
  const cart = normalizeSnapshot(raw);
  const requests = new Map();
  if (cartScope && !cart) return { status: 'unavailable', reason: 'cart_snapshot_missing_or_invalid', items: [] };
  if (cartScope) for (const l of cart.lines) requests.set(l.variantId, { productId: l.productId, variantId: l.variantId, quantity: (requests.get(l.variantId)?.quantity ?? 0) + l.quantity });
  else for (const id of productIds.slice(0, 8)) {
    const p = source.products.find((p) => p.id === id || p.shopify_product_id === id);
    if (!p) { requests.set(id, { productId: id, variantId: null, quantity: quantity ?? 1 }); continue; }
    const inCart = cart?.lines.filter((l) => l.productId === p.shopify_product_id) ?? [];
    const selected = variantId ? p.variants?.find((v) => v.id === variantId) : inCart.length === 1 ? p.variants?.find((v) => v.id === inCart[0].variantId) : p.variants?.length === 1 ? p.variants[0] : null;
    requests.set(selected?.id ?? id, { productId: p.shopify_product_id, variantId: selected?.id ?? null, quantity: quantity ?? (inCart.reduce((n, l) => n + l.quantity, 0) || 1) });
  }
  const items = [...requests.values()].map((request) => {
    const p = source.products.find((p) => p.shopify_product_id === request.productId);
    const v = p?.variants?.find((v) => v.id === request.variantId);
    const age = now - Date.parse(p?.synced_at);
    let result = !p ? missing('product_unknown') : !liveProduct(p) ? { status: 'unavailable', reason: 'product_not_published' } : !v ? missing('variant_required_or_unknown') : !Number.isFinite(age) || age < 0 || age > 36 * 60 * 60 * 1000 ? missing('stock_snapshot_stale') : !Number.isInteger(v.inventory_quantity) ? missing('inventory_quantity_unknown') : { status: v.inventory_quantity >= request.quantity ? 'available' : 'insufficient', reason: 'synced_inventory_quantity', available_quantity: Math.max(0, v.inventory_quantity) };
    return { product_id: p?.id ?? null, variant_id: request.variantId, name: p?.title ?? null, requested_quantity: request.quantity, as_of: p?.synced_at ?? null, ...result };
  });
  return { status: !items.length ? 'empty' : items.some((i) => i.status === 'insufficient' || i.status === 'unavailable') ? 'insufficient' : items.some((i) => i.status === 'unknown') ? 'unknown' : 'available', source: 'synced_variant_inventory', live_checkout_verified: false, items };
}

/** All business-rule reasoning happens here, never in the prompt. */
export function evaluatePromotionsForCart(raw, source, { code = null, promotion_ids = [] } = {}, { now = Date.now(), baseCurrency = null } = {}) {
  if (source?.status !== 'ok') return { status: 'unavailable', reason: source?.reason ?? 'source_unavailable', promotions: [] };
  const rows = publicRows(source);
  const requested = cartContract.code(code);
  const selected = requested ? rows.filter((p) => codesOf(p).includes(requested)) : promotion_ids.length ? rows.filter((p) => promotion_ids.includes(p.id)) : rows.filter((p) => !running(p, now) && promotionMechanic(p) !== 'free_shipping');
  if (!selected.length) return { status: 'not_found', reason: 'no_public_promotion_match', promotions: [] };
  const cart = normalizeSnapshot(raw);
  const applied = cart ? cart.discounts.filter((d) => d.amount > 0).map((d) => matchedDiscount(d, rows)).filter(Boolean) : [];
  const unknownDiscount = cart && (cart.discounts.some((d) => d.amount > 0 && !matchedDiscount(d, rows)) || cart.originalSubtotal > cart.total && !cart.discounts.length);
  const cap = 12;
  const promotions = selected.slice(0, cap).map((p) => {
    const result = (status, reason, extra = {}) => ({ ...publicOffer(p, requested), status, reason, requirements_remaining: [], ...extra });
    if (!cart) return result('unknown', 'cart_snapshot_missing_or_invalid');
    if (applied.some((a) => a.id === p.id)) return result('applied', 'observed_in_cart');
    const window = running(p, now);
    if (window) return result('not_eligible', window);
    if (!cart.lines.length) return result('not_eligible', 'empty_cart');
    const mechanic = promotionMechanic(p);
    if (mechanic === 'free_shipping') return result('unknown', 'shipping_out_of_scope');
    if (['app', 'unknown'].includes(mechanic)) return result('unknown', 'unsupported_rules');
    const r = p.rule_snapshot;
    if (!r || !r.customer_gets?.items || r.minimum_requirement?.type === 'unknown') return result('unknown', 'rules_incomplete');
    if (r.minimum_requirement?.type === 'subtotal' && (!finite(r.minimum_requirement.amount) || Number(r.minimum_requirement.amount) < 0) || r.customer_buys?.amount !== undefined && (!finite(r.customer_buys.amount) || Number(r.customer_buys.amount) < 0)) return result('unknown', 'rules_incomplete');
    if (['gift', 'multi_buy'].includes(mechanic) && (!r.customer_buys?.items || !Number.isInteger(Number(r.customer_gets.quantity)) || Number(r.customer_gets.quantity) < 1)) return result('unknown', 'rules_incomplete');
    if (cart.lines.some((l) => l.controlledPricing)) return result('unknown', 'selling_plan_or_bundle_rules_unknown');
    if (cart.lines.some((l) => !source.products.some((pr) => pr.shopify_product_id === l.productId && pr.variants?.some((v) => v.id === l.variantId)))) return result('unknown', 'cart_product_or_variant_unknown');
    if (p.usage_limit !== null && p.usage_limit !== undefined) {
      const uses = requested ? p.codes?.find((c) => norm(c.code) === requested)?.usage_count : p.discount_usage_count;
      if (!finite(uses)) return result('unknown', 'usage_count_unknown');
      if (Number(uses) >= Number(p.usage_limit) || finite(p.discount_usage_count) && Number(p.discount_usage_count) >= Number(p.usage_limit)) return result('not_eligible', 'usage_limit_reached');
    }
    const others = applied.filter((a) => a.id !== p.id);
    if (others.some((a) => !combinable(p, a))) return result('not_eligible', 'not_combinable');
    const basket = { source: 'cart', at: new Date(now).toISOString(), countryCode: null, applied: [], lines: cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, price: amount(l.originalTotal), paid: amount(l.finalTotal) })) };
    // Allocation of order discounts to qualifying lines is not provided by Ajax.
    if (cart.total < cart.subtotal) for (const l of basket.lines) l.paid = null;
    const scope = r.customer_buys?.items ?? (mechanic === 'product_discount' ? r.customer_gets.items : null);
    const scopeIds = qualifyingIds(scope, source.members);
    if (scopeIds === null) return result('unknown', 'collection_or_item_scope_unknown');
    const qualifying = basket.lines.filter((l) => scopeIds === true || scopeIds.has(l.productId));
    if (!qualifying.length) return result('not_eligible', 'items_not_qualifying');
    // Unsupported additions are not silently ignored (e.g. future exclusions/variant rules).
    if ([r.customer_buys?.items, r.customer_gets.items].some((s) => s && Object.keys(s).some((k) => !['scope', 'products', 'collections'].includes(k)))) return result('unknown', 'unsupported_item_conditions');
    const threshold = r.minimum_requirement;
    const thresholdCurrency = threshold?.type === 'subtotal' ? threshold.currency : r.customer_buys?.amount !== undefined ? baseCurrency : null;
    if ((threshold?.type === 'subtotal' || r.customer_buys?.amount !== undefined) && (!thresholdCurrency || thresholdCurrency !== cart.currency)) return result('unknown', 'threshold_currency_unknown_or_different');
    if (threshold?.type === 'quantity') {
      if (!finite(threshold.quantity)) return result('unknown', 'rules_incomplete');
      const gap = Math.max(0, Number(threshold.quantity) - qualifying.reduce((n, l) => n + l.quantity, 0));
      if (gap) return result('not_eligible', 'below_quantity', { requirements_remaining: [{ type: 'quantity', quantity: gap }] });
    }
    const rewardScope = qualifyingIds(r.customer_gets.items, source.members);
    if (rewardScope === null) return result('unknown', 'collection_or_item_scope_unknown');
    const rewardLines = basket.lines.filter((l) => rewardScope === true || rewardScope.has(l.productId));
    if (mechanic === 'gift' && qualifying.some((l) => rewardLines.includes(l)) && rewardLines.reduce((n, l) => n + l.quantity, 0) > Number(r.customer_gets.quantity)) return result('unknown', 'buy_reward_allocation_unknown');
    if (mechanic === 'multi_buy') {
      const buyQty = Number(r.customer_buys.quantity), getQty = Number(r.customer_gets.quantity);
      if (!Number.isInteger(buyQty) || buyQty < 1) return result('unknown', 'rules_incomplete');
      const units = qualifying.reduce((n, l) => n + l.quantity, 0);
      if (units < buyQty) return result('not_eligible', 'below_quantity', { requirements_remaining: [{ type: 'quantity', quantity: buyQty - units }] });
      const rewardUnits = rewardLines.reduce((n, l) => n + l.quantity, 0);
      const unionUnits = [...new Set([...qualifying, ...rewardLines])].reduce((n, l) => n + l.quantity, 0);
      if (rewardUnits < getQty || unionUnits < buyQty + getQty) return result('not_eligible', 'reward_not_in_basket', { requirements_remaining: [{ type: 'reward_quantity', quantity: Math.max(getQty - rewardUnits, buyQty + getQty - unionUnits) }] });
    }
    // Support's multi-buy path assumes buy and reward scopes overlap. Handle the
    // two quantities above, then reuse only its shared window/scope/threshold checks.
    const outcomePromotion = mechanic === 'multi_buy' ? { ...p, discount_type: p.method === 'code' ? 'DiscountCodeBasic' : 'DiscountAutomaticBasic', discount_classes: ['PRODUCT'] } : p;
    const outcome = evaluateOutcome({ promotion: outcomePromotion, basket, others, members: source.members });
    const failed = outcome.checks.find((c) => c.status === 'fail');
    if (failed) return result('not_eligible', outcome.outcome, { requirements_remaining: finite(failed.gap) ? [{ type: 'spend', amount: Number(failed.gap), currency: cart.currency }] : [], checks: outcome.checks.map(({ id, status, reason }) => ({ id, status, reason })) });
    if (outcome.outcome === 'undetermined') return result('unknown', 'threshold_or_reward_unknown');
    if (mechanic === 'gift' && rewardLines.reduce((n, l) => n + l.quantity, 0) < Number(r.customer_gets.quantity)) return result('not_eligible', 'reward_not_in_basket');
    if (p.method === 'code' && r.customer_selection?.scope !== 'all' || p.applies_once_per_customer === true) return result('unknown', 'customer_eligibility_requires_checkout');
    if (unknownDiscount || others.some((a) => !stackingKnown(p, a))) return result('unknown', 'current_discount_combination_unknown');
    if (r.destination || r.app_discount_type || r.customer_gets.items?.scope === 'unknown') return result('unknown', 'unsupported_rules');
    const reward = r.customer_gets;
    if (!finite(reward.percentage) && !finite(reward.amount)) return result('unknown', 'reward_value_unknown');
    return result('eligible', p.method === 'code' ? 'known_conditions_met_code_required' : 'known_conditions_met', { scope_result: cart.lines.map((l) => ({ product_id: source.products.find((p) => p.shopify_product_id === l.productId)?.id ?? null, qualifies: scopeIds === true || scopeIds.has(l.productId) })) });
  });
  const combinations = [];
  for (let i = 0; i < Math.min(selected.length, cap); i++) for (let j = i + 1; j < Math.min(selected.length, cap); j++) combinations.push({ promotion_ids: [selected[i].id, selected[j].id], status: !combinable(selected[i], selected[j]) ? 'not_combinable' : stackingKnown(selected[i], selected[j]) ? 'allowed_by_rules' : 'unknown' });
  return { status: 'ok', promotions, combinations, has_more: selected.length > cap, checkout_verified: false };
}

function qualifyingIds(scope, members = new Map()) {
  if (!scope || scope.scope === 'all') return true;
  if (scope.scope === 'products' && Array.isArray(scope.products)) return new Set(scope.products.map((p) => p.id));
  if (scope.scope === 'collections' && Array.isArray(scope.collections)) {
    const sets = scope.collections.map((c) => members.get(c.id));
    if (sets.some((s) => !s)) return null;
    return new Set(sets.flatMap((s) => [...s]));
  }
  return null;
}
function stackingKnown(a, b) {
  const key = { ORDER: 'order_discounts', PRODUCT: 'product_discounts', SHIPPING: 'shipping_discounts' };
  return [a, b].every((p) => Array.isArray(p.discount_classes) && p.discount_classes.length && p.discount_classes.every((c) => key[c])) && [[a, b], [b, a]].every(([x, y]) => y.discount_classes.every((c) => x.combines_with?.[key[c]] === true));
}
