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

/**
 * « Already on sale »: the synced compare-at price above the price the cart
 * charges. Promotions are calculated on the cart's price (the sale price, e.g.
 * after an Alpha sale), never on the crossed-out one.
 */
function saleOf(variant, line) {
  const was = Number(variant?.compare_at_price);
  const now = line.unitPrice / 100;
  return Number.isFinite(was) && was > now ? { on_sale: true, price_before_sale: was, sale_percentage: Math.round((1 - now / was) * 100) } : {};
}

export function running(p, now = Date.now()) {
  if (p.ends_at && (!Number.isFinite(Date.parse(p.ends_at)) || now >= Date.parse(p.ends_at))) return 'expired';
  if (p.starts_at && (!Number.isFinite(Date.parse(p.starts_at)) || now < Date.parse(p.starts_at))) return 'not_started';
  return p.status === 'ACTIVE' ? null : 'inactive';
}

function matchedDiscount(discount, rows) {
  // An `unknown` type (the older cart.js shape carries none) is matched by its
  // title alone — still only to a public row, and only when exactly one fits.
  const sameKind = (p) => discount.type === 'unknown' || p.method === discount.type;
  const named = (p) => discount.type === 'code' ? codesOf(p).includes(norm(discount.title)) : norm(p.title) === norm(discount.title) || (discount.type === 'unknown' && codesOf(p).includes(norm(discount.title)));
  const matches = rows.filter((p) => sameKind(p) && named(p));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * A discount in the cart → the offer it is. Public offers first; then, for a
 * code, the shop's other active codes (`cartCodeRows`): a code the shopper
 * entered may be named back to them and used for stacking, but such a row is
 * never listed or offered (`entered` marks it).
 */
function appliedOffer(discount, source) {
  const pub = matchedDiscount(discount, publicRows(source));
  if (pub) return { row: pub, entered: false };
  if (!['code', 'unknown'].includes(discount.type)) return null;
  const rows = (source?.cartCodeRows ?? []).filter((p) => codesOf(p).includes(norm(discount.title)));
  return rows.length === 1 ? { row: rows[0], entered: true } : null;
}

/**
 * WHY A CODE WE CANNOT SEE MAY NOT APPLY, from the cart alone. « J'arrive pas
 * à appliquer QIRINESS10 » with BIENVENUE20 already applied was answered « je
 * ne peux pas confirmer » (dev store, 2026-10-07), when the cart itself holds
 * the likely reason: an applied offer that refuses to combine with order (or
 * product) discounts blocks any new one of that class. Nothing about the typed
 * code is read, so nothing about it — not even that it exists — is disclosed.
 */
function cartReasoning(cart, source) {
  const applied = cart.discounts.filter((d) => d.amount > 0).map((d) => appliedOffer(d, source)).filter(Boolean);
  const label = ({ row, entered }) => entered ? codesOf(row).find((c) => cart.codes.includes(c) || cart.discounts.some((d) => norm(d.title) === c)) ?? row.title : row.title;
  const refusing = (key) => applied.filter(({ row }) => row.combines_with?.[key] === false).map(label);
  const codesInCart = new Set([...cart.codes, ...cart.discounts.filter((d) => d.type === 'code').map((d) => norm(d.title))]).size;
  return {
    applied_offers: applied.map(label),
    unmatched_discounts: cart.discounts.filter((d) => d.amount > 0 && !appliedOffer(d, source)).length,
    blocks_new_order_codes: refusing('order_discounts'),
    blocks_new_product_codes: refusing('product_discounts'),
    blocks_new_shipping_codes: refusing('shipping_discounts'),
    code_limit_reached: codesInCart >= 5,
    // Conditions a code can carry that the cart cannot show.
    other_possible_reasons: ['minimum_spend_or_quantity', 'eligible_products', 'customer_or_market_restriction', 'dates_or_usage_limit', 'code_typed_differently']
  };
}

/** For the trace only: what the cart said, and whether it matched a public offer. */
export function cartDiscountTrace(raw, source) {
  const cart = normalizeSnapshot(raw);
  if (!cart) return null;
  const rows = publicRows(source);
  return cart.discounts.map((d) => ({ type: d.type, title: d.type === 'code' ? null : d.title.slice(0, 80), amount: amount(d.amount), matched: appliedOffer(d, source)?.row.id ?? null, entered_code: appliedOffer(d, source)?.entered === true }));
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
      return { product_id: product?.id ?? null, shopify_product_id: l.productId, variant_id: l.variantId, name: product?.title ?? l.productName ?? null, name_source: product?.title ? 'synced_product' : l.productName ? 'cart_observation' : null, variant_title: variant?.title ?? l.variantTitle ?? null, variant_known: Boolean(variant), quantity: l.quantity, unit_price: amount(l.unitPrice), original_total: amount(l.originalTotal), final_total: amount(l.finalTotal), ...saleOf(variant, l) };
    }),
    discounts: cart.discounts.map((d) => {
      const match = appliedOffer(d, source);
      const p = match?.row;
      const isCode = p && (d.type === 'code' || codesOf(p).includes(norm(d.title)));
      return { promotion_id: p?.id ?? null, name: p?.title ?? 'Réduction appliquée', type: isCode ? 'code' : d.type, amount: amount(d.amount), code: isCode ? norm(d.title) : null, entered_by_customer: match?.entered === true };
    }),
    // Codes the shopper applied that match an offer: public ones, and the shop's own private ones they entered.
    applied_codes: [...new Set([...cart.codes, ...cart.discounts.filter((d) => d.type === 'unknown').map((d) => norm(d.title))])].filter((c) => rows.some((p) => codesOf(p).includes(c)) || (source?.cartCodeRows ?? []).some((p) => codesOf(p).includes(c))),
    entered_codes_available: cart.enteredCodesAvailable, data_status: source?.status ?? 'unavailable'
  };
}

/**
 * Current public offers. `all` (the default) lists every one, free delivery
 * included: « quelles sont les offres du moment ? » on a store whose only public
 * offer is free delivery used to answer « aucune offre » (measured on the dev
 * store, 2026-10-06). A shipping offer always carries its published terms —
 * minimum, destinations — and never a delivery cost.
 */
export function getActivePromotions(source, { limit = 8, topic = 'all' } = {}, now = Date.now()) {
  if (source?.status !== 'ok') return { status: 'unavailable', reason: source?.reason ?? 'source_unavailable', promotions: [] };
  const wanted = (p) => topic === 'free_shipping' ? promotionMechanic(p) === 'free_shipping' : topic === 'non_shipping' ? promotionMechanic(p) !== 'free_shipping' : true;
  const candidates = publicRows(source).filter((p) => !running(p, now) && wanted(p));
  const cap = Number.isInteger(limit) ? Math.min(12, Math.max(1, limit)) : 8;
  return { status: 'ok', promotions: candidates.slice(0, cap).map((p) => {
    const offer = publicOffer(p);
    if (promotionMechanic(p) !== 'free_shipping') return offer;
    return { ...offer, destination: destinationOf(p.rule_snapshot), cart_eligibility: 'not_evaluated', delivery_cost: 'not_calculated' };
  }), stacking_rules: stackingRules(source), has_more: candidates.length > cap, scope: topic === 'free_shipping' ? 'public_shipping_offer_terms' : topic === 'non_shipping' ? 'public_non_shipping_offers' : 'public_offers', loaded_at: new Date(source.loadedAt).toISOString() };
}

function destinationOf(r) {
  const destination = r?.destination;
  return destination ? { scope: destination.scope, countries: (destination.countries ?? []).filter((c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c)).slice(0, 250), include_rest_of_world: destination.include_rest_of_world === true } : null;
}

/** Item names a rule targets (Shopify's own titles, synced with it), or 'all'. */
function itemNames(items) {
  if (!items) return null;
  if (items.scope === 'all') return 'all';
  const list = items.scope === 'products' ? items.products : items.scope === 'collections' ? items.collections : null;
  return Array.isArray(list) ? list.map((x) => x.title).filter((t) => typeof t === 'string' && t).slice(0, 8) : null;
}

function publicOffer(p, requestedCode = null) {
  const r = p.rule_snapshot ?? {};
  const min = r.minimum_requirement;
  const minimum = !min ? null : min.type === 'subtotal' ? { type: 'subtotal', amount: finite(min.amount) ? Number(min.amount) : null, currency: min.currency ?? null } : min.type === 'quantity' ? { type: 'quantity', quantity: finite(min.quantity) ? Number(min.quantity) : null } : { type: 'unknown' };
  return { promotion_id: p.id, name: p.title, type: p.method, mechanic: promotionMechanic(p), code: p.method === 'code' ? requestedCode ?? codesOf(p)[0] ?? null : null, starts_at: p.starts_at ?? null, ends_at: p.ends_at ?? null, reward: { percentage: finite(r.customer_gets?.percentage) ? Number(r.customer_gets.percentage) * 100 : null, amount: finite(r.customer_gets?.amount) ? Number(r.customer_gets.amount) : null, currency: r.customer_gets?.currency ?? null, quantity: r.customer_gets?.quantity ?? null, items_scope: r.customer_gets?.items?.scope ?? null, items: itemNames(r.customer_gets?.items) },
    // WHAT A BUY X GET Y ASKS FOR: without it « l'offre qui donne une Eau Qi dès
    // 65 € » could not be recognised as TEST02 (dev store, 2026-10-06).
    requires: r.customer_buys ? { spend: finite(r.customer_buys.amount) ? Number(r.customer_buys.amount) : null, quantity: finite(r.customer_buys.quantity) ? Number(r.customer_buys.quantity) : null, items_scope: r.customer_buys.items?.scope ?? null, items: itemNames(r.customer_buys.items) } : null,
    minimum, synced_at: p.synced_at ?? null };
}

/**
 * SHOPIFY'S STACKING RULES FOR THIS SHOP'S PLAN, which no offer description
 * states. Verified 2026-10-07: qiriness.myshopify.com is on the « Shopify »
 * plan (`plan.shopifyPlus: false`). Off Plus, an item takes at most one product
 * discount, and every item of a Buy X Get Y takes no other; on Plus, product
 * discounts tagged for each other may share an item, and the « gets » item of
 * a Buy X Get Y may take more. `source.shopifyPlus` is the one switch.
 */
export function stackingRules(source) {
  const plus = source?.shopifyPlus === true;
  return {
    shopify_plus: plus,
    product_discounts_per_item: plus ? 'several_if_tagged_to_combine' : 1,
    buy_x_get_y_items: plus ? 'buys_item_exclusive_gets_item_may_combine' : 'both_items_exclusive',
    order_discounts: 'combine_with_product_discounts_if_both_allow',
    shipping_discounts: 'one_per_order',
    when_offers_conflict: 'shopify_keeps_the_best_for_the_cart'
  };
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
export function evaluatePromotionsForCart(raw, source, { code = null, promotion_ids = [] } = {}, { now = Date.now(), baseCurrency = null, shopifyPlus = source?.shopifyPlus === true } = {}) {
  if (source?.status !== 'ok') return { status: 'unavailable', reason: source?.reason ?? 'source_unavailable', promotions: [] };
  const rows = publicRows(source);
  const requested = cartContract.code(code);
  const cart = normalizeSnapshot(raw);
  const selected = requested ? rows.filter((p) => codesOf(p).includes(requested)) : promotion_ids.length ? rows.filter((p) => promotion_ids.includes(p.id)) : rows.filter((p) => !running(p, now));
  if (!selected.length) {
    // « Does QIRINESS20 work? » about a private code ALREADY applied in this cart: it does.
    const enteredHere = requested && cart?.discounts.some((d) => d.amount > 0 && norm(d.title) === requested && appliedOffer(d, source)?.entered);
    if (enteredHere) {
      const row = appliedOffer(cart.discounts.find((d) => norm(d.title) === requested), source).row;
      return { status: 'ok', promotions: [{ promotion_id: row.id, name: row.title, type: 'code', code: requested, status: 'applied', reason: 'observed_in_cart', entered_by_customer: true, requirements_remaining: [] }], combinations: [], has_more: false, checkout_verified: false };
    }
    return { status: 'not_found', reason: 'no_public_promotion_match', promotions: [], ...(cart ? { cart_reasoning: cartReasoning(cart, source) } : {}) };
  }
  const applied = cart ? cart.discounts.filter((d) => d.amount > 0).map((d) => appliedOffer(d, source)?.row).filter(Boolean) : [];
  const unknownDiscount = cart && (cart.discounts.some((d) => d.amount > 0 && !appliedOffer(d, source)) || cart.originalSubtotal > cart.total && !cart.discounts.length);
  const cap = 12;
  const promotions = selected.slice(0, cap).map((p) => {
    const result = (status, reason, extra = {}) => ({ ...publicOffer(p, requested), status, reason, requirements_remaining: [], ...extra });
    if (!cart) return result('unknown', 'cart_snapshot_missing_or_invalid');
    if (applied.some((a) => a.id === p.id)) return result('applied', 'observed_in_cart');
    const window = running(p, now);
    if (window) return result('not_eligible', window);
    if (!cart.lines.length) return result('not_eligible', 'empty_cart');
    const mechanic = promotionMechanic(p);
    if (mechanic === 'free_shipping') return evaluateFreeShipping(p, cart, applied, result);
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
    // ONE PRODUCT DISCOUNT PER LINE (Shopify's default; tag stacking is Plus
    // only). A product discount whose every target line already carries another
    // product discount cannot apply, whatever the combination flags say: on the
    // dev store September Rose (30 %) was « eligible » while its two lines held
    // the 2-for-1 and the gift (2026-10-06).
    if ((p.discount_classes ?? []).includes('PRODUCT')) {
      const targets = mechanic === 'product_discount' ? qualifying : null;
      const blockers = targets && targets.length ? targets.map((l) => productDiscountsOn(cart.lines.find((c) => c.productId === l.productId), p, source, applied, shopifyPlus)) : [];
      if (blockers.length && blockers.every((names) => names.length)) {
        return result('not_eligible', 'line_already_discounted', { blocked_by: [...new Set(blockers.flat())] });
      }
    }
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
    // A MONEY THRESHOLD, MEASURED AS SHOPIFY MEASURES IT FOR THIS CLASS
    // (docs/shopify-discount-rules.md § 4) instead of « unknown » whenever the
    // cart straddles it before and after discounts.
    const spendRule = classThreshold(p, mechanic, r, cart, qualifying, source, applied, shopifyPlus);
    if (spendRule?.status === 'taken') return result('not_eligible', 'line_already_discounted', { blocked_by: spendRule.blocked_by, measured_on: spendRule.basis });
    if (spendRule?.status === 'fail') return result('not_eligible', 'below_threshold', { requirements_remaining: [{ type: 'spend', amount: spendRule.gap, currency: cart.currency }], measured_on: spendRule.basis });
    const rewardScope = qualifyingIds(r.customer_gets.items, source.members);
    if (rewardScope === null) return result('unknown', 'collection_or_item_scope_unknown');
    // A REWARD NOBODY CAN ADD IS NOT « ADD IT TO YOUR CART ». On the dev store the
    // « Masque Revitalisant offert » gift was a draft with no stock (2026-10-06):
    // reward_not_in_basket would have sent the shopper looking for it. Only
    // named reward products we hold are judged; an unknown one is left alone.
    const rewardProducts = r.customer_gets.items?.scope === 'products' && Array.isArray(r.customer_gets.items.products)
      ? r.customer_gets.items.products.map((x) => source.products.find((pr) => pr.shopify_product_id === x.id))
      : [];
    // Judged only while the reward is NOT yet in the cart: units already there
    // were sellable, whatever the synced count says.
    const rewardInCart = cart.lines.some((l) => rewardProducts.some((pr) => pr?.shopify_product_id === l.productId));
    if (rewardProducts.length && rewardProducts.every(Boolean) && !rewardInCart) {
      if (rewardProducts.every((pr) => !liveProduct(pr))) return result('not_eligible', 'reward_unavailable');
      // A NEGATIVE count means Shopify kept selling past zero (« continue selling
      // when out of stock », or an oversell): sellable. Zero is the unknown case.
      const sellable = (pr) => liveProduct(pr) && (pr.variants ?? []).some((v) => !Number.isInteger(v.inventory_quantity) || v.inventory_quantity !== 0);
      if (!rewardProducts.some(sellable)) return result('unknown', 'reward_out_of_stock');
    }
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
    // A threshold decided above by class overrides the shared check's both-sides view.
    const decided = (c) => !(spendRule && c.id === 'threshold');
    const failed = outcome.checks.find((c) => c.status === 'fail' && decided(c));
    if (failed) return result('not_eligible', failed.reason ?? outcome.outcome, { requirements_remaining: finite(failed.gap) ? [{ type: 'spend', amount: Number(failed.gap), currency: cart.currency }] : [], checks: outcome.checks.map(({ id, status, reason }) => ({ id, status, reason })) });
    if (outcome.checks.some((c) => c.status === 'unknown' && decided(c))) return result('unknown', 'threshold_or_reward_unknown');
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
  return { status: 'ok', promotions, combinations, stacking_rules: stackingRules(source), has_more: selected.length > cap, checkout_verified: false };
}

/**
 * Free delivery against the cart: the published minimum only. Never a delivery
 * cost, and never a promise about the destination — a rule limited to some
 * countries is « eligible if delivered to … », because the cart does not know
 * where it is going until checkout.
 *
 * THE THRESHOLD IS COMPARED WITH THE TOTAL AFTER DISCOUNTS, the lower of the two
 * figures: met there, it is met. Between the total and the subtotal, an order
 * discount decides it, and that is left unknown rather than guessed.
 */
function evaluateFreeShipping(p, cart, applied, result) {
  const r = p.rule_snapshot ?? {};
  const terms = { destination: destinationOf(r), delivery_cost: 'not_calculated' };
  if (finite(r.maximum_shipping_price)) terms.maximum_shipping_price = Number(r.maximum_shipping_price);
  if (r.customer_selection && r.customer_selection.scope && r.customer_selection.scope !== 'all') return result('unknown', 'customer_eligibility_requires_checkout', terms);
  if (applied.some((a) => a.id !== p.id && !combinable(p, a))) return result('not_eligible', 'not_combinable', terms);
  const min = r.minimum_requirement;
  if (min?.type === 'subtotal') {
    if (!finite(min.amount) || Number(min.amount) < 0 || !min.currency) return result('unknown', 'rules_incomplete', terms);
    if (min.currency !== cart.currency) return result('unknown', 'threshold_currency_unknown_or_different', terms);
    const need = Math.round(Number(min.amount) * 100);
    if (cart.total < need) {
      if (cart.subtotal >= need) return result('unknown', 'order_discount_decides_threshold', terms);
      return result('not_eligible', 'below_subtotal', { ...terms, requirements_remaining: [{ type: 'spend', amount: amount(need - cart.total), currency: cart.currency }] });
    }
  } else if (min?.type === 'quantity') {
    if (!finite(min.quantity)) return result('unknown', 'rules_incomplete', terms);
    const gap = Math.max(0, Number(min.quantity) - cart.lines.reduce((n, l) => n + l.quantity, 0));
    if (gap) return result('not_eligible', 'below_quantity', { ...terms, requirements_remaining: [{ type: 'quantity', quantity: gap }] });
  } else if (min && min.type) {
    return result('unknown', 'rules_incomplete', terms);
  }
  return result('eligible', terms.destination ? 'threshold_met_destination_required' : 'threshold_met', terms);
}

/**
 * What already holds a cart line against another product discount, by offer
 * name: a product discount allocated to it, and — Shopify's Buy X Get Y rule —
 * an APPLIED Buy X Get Y whose « buys » or « gets » items include it. The
 * « buys » line carries no allocation in cart.js (the reward is allocated to
 * the « gets » line), so the titles alone missed it.
 *
 * On Shopify Plus, product discounts may share a line through tags we do not
 * sync, and only the « buys » item of a Buy X Get Y stays exclusive.
 */
function productDiscountsOn(line, p, source, applied = [], shopifyPlus = false) {
  if (!line) return [];
  const allocated = shopifyPlus ? [] : (line.discountTitles ?? [])
    .map((title) => appliedOffer({ title, type: 'unknown', amount: 1 }, source)?.row)
    .filter((row) => row && row.id !== p.id && (row.discount_classes ?? []).includes('PRODUCT'));
  const bxgy = applied.filter((a) => a.id !== p.id && /Bxgy$/.test(a.discount_type ?? a.rule_snapshot?.discount_type ?? ''));
  const locking = bxgy.filter((a) => {
    const holds = (items) => { const ids = qualifyingIds(items, source.members); return ids === true || (ids instanceof Set && ids.has(line.productId)); };
    return holds(a.rule_snapshot?.customer_buys?.items) || (!shopifyPlus && holds(a.rule_snapshot?.customer_gets?.items));
  });
  return [...new Set([...allocated, ...locking].map((row) => row.title))];
}

/**
 * A money minimum, per Shopify's class rules:
 *   order discount        met BEFORE and AFTER product discounts (other order discounts don't count);
 *   product discount      measured after the other product discounts (order discounts excluded);
 *   Buy X Get Y (amount)  « buys » items at full price, excluding items holding another product discount.
 * Returns null when there is no money minimum, or { status, gap, basis }.
 */
function classThreshold(p, mechanic, r, cart, qualifying, source, applied, shopifyPlus) {
  const min = r.minimum_requirement?.type === 'subtotal' ? Number(r.minimum_requirement.amount) : r.customer_buys?.amount !== undefined ? Number(r.customer_buys.amount) : null;
  if (min === null || !Number.isFinite(min)) return null;
  const need = Math.round(min * 100);
  const cartLine = (l) => cart.lines.find((c) => c.productId === l.productId);
  const gap = (have) => ({ status: have >= need ? 'pass' : 'fail', gap: amount(Math.max(0, need - have)) });
  if ((p.discount_classes ?? []).includes('ORDER')) {
    const before = cart.originalSubtotal;
    const after = cart.subtotal;
    return { ...gap(Math.min(before, after)), basis: 'order_minimum_before_and_after_product_discounts' };
  }
  if (r.customer_buys?.amount !== undefined) {
    // The « gets » units never count towards the « buys » amount.
    const gets = qualifyingIds(r.customer_gets?.items, source.members);
    const value = (lines) => {
      let rewardUnits = Number(r.customer_gets?.quantity ?? 0) || 0;
      return lines.reduce((n, l) => {
        const inGets = gets === true || (gets instanceof Set && gets.has(l.productId));
        const held = inGets ? Math.min(rewardUnits, l.quantity) : 0;
        rewardUnits -= held;
        return n + l.originalTotal - held * l.unitPrice;
      }, 0);
    };
    const all = qualifying.map(cartLine).filter(Boolean);
    const held = all.map((l) => productDiscountsOn(l, p, source, applied, shopifyPlus));
    const free = all.filter((_, i) => held[i].length === 0);
    // Short even counting every item: the cart really is below the threshold.
    // Met only by counting items that take another product discount: those
    // items are taken by a better offer — Shopify chose it (simulate_offers says
    // by how much) — which is not « spend more ».
    if (value(all) < need) return { ...gap(value(all)), basis: 'buys_items_at_full_price' };
    if (value(free) < need) return { status: 'taken', blocked_by: [...new Set(held.flat())], basis: 'buys_items_hold_another_product_discount' };
    return { ...gap(value(free)), basis: 'buys_items_at_full_price_without_other_product_discounts' };
  }
  if (mechanic === 'product_discount') {
    const lines = qualifying.map(cartLine).filter(Boolean);
    return { ...gap(lines.reduce((n, l) => n + l.finalTotal, 0)), basis: 'after_other_product_discounts' };
  }
  return null;
}

export function qualifyingIds(scope, members = new Map()) {
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
