/**
 * WHICH OFFERS SHOPIFY WILL APPLY TO A CART, predicted.
 *
 * Shopify does not apply offers one by one: among the combinations its rules
 * allow, it keeps the one with the largest total saving for the customer
 * (docs/shopify-discount-rules.md § 3). Evaluating each offer on its own — the
 * evaluator's job — cannot say « with the Eau Qi in the cart, TEST02 wins and
 * September Rose no longer applies to the cream ». This module can: carts are
 * small and offers few, so it enumerates every allowed set and prices each one
 * in Shopify's order.
 *
 * Rules modelled (non-Plus unless `shopifyPlus`):
 *   - combining is mutual, by class; at most one shipping discount;
 *   - one product discount per line; a Buy X Get Y claims its « buys » and
 *     « gets » lines first (on Plus only its « buys » lines stay exclusive —
 *     not modelled further: the « gets » lines stay claimed, and that is said);
 *   - product discounts, then order discounts on the subtotal after them (each
 *     on that same subtotal, no compounding), then shipping;
 *   - minimums by class, as the evaluator measures them.
 *
 * Reached: public automatic offers, and codes ALREADY ENTERED in the cart. A
 * public code nobody entered is not applied by Shopify, so it is left out and
 * named in `excluded`. A private code the shopper entered keeps the amount the
 * cart shows (its rules are not loaded). App discounts and customer-specific
 * offers are never predicted.
 *
 * The cart remains the authority: on a real cart, what Shopify applied is
 * what applies. A prediction that differs is flagged, never preferred.
 */
import cartContract from '../../../storefront-app/extensions/storefront-advisor/assets/advisor-cart.js';
import { promotionMechanic } from '../promotion-mechanic.mjs';
import { combinable } from '../../../agent/src/retrieval/promotion-outcome.mjs';
import { qualifyingIds, running } from './shopping-evaluator.mjs';
import { isPublicPromotion } from './shopping-repository.mjs';

const MAX_OFFERS = 10;
const MAX_ADDITIONS = 4;
const major = (minor) => minor / 100;
const norm = (value) => String(value ?? '').trim().toUpperCase();
const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const codesOf = (row) => (row.codes ?? []).map((c) => norm(c.code)).filter(Boolean);
const classOf = (row) => (row.discount_classes ?? [])[0] ?? null;
const live = (p) => p?.status?.toLowerCase() === 'active' && p.published_at && !p.deleted_at;

export function simulateOffers(raw, source, { add = [] } = {}, { now = Date.now(), baseCurrency = null, shopifyPlus = source?.shopifyPlus === true } = {}) {
  if (source?.status !== 'ok') return { status: 'unavailable', reason: source?.reason ?? 'source_unavailable' };
  const cart = cartContract.normalizeSnapshot(raw) ?? (add.length ? { currency: baseCurrency, lines: [], discounts: [], codes: [] } : null);
  if (!cart || !cart.currency) return { status: 'unavailable', reason: 'cart_snapshot_missing_or_invalid' };

  // THE CART TO PRICE: its lines at the price Shopify charges (a sale price
  // included), plus any hypothetical additions at their synced price.
  const lines = cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, total: l.originalTotal, added: false }));
  const additions = [];
  for (const a of add.slice(0, MAX_ADDITIONS)) {
    const product = source.products.find((p) => p.id === a.product_id || p.shopify_product_id === a.product_id);
    const quantity = Number.isInteger(a.quantity) && a.quantity > 0 && a.quantity <= 99 ? a.quantity : 1;
    if (!product || !live(product)) return { status: 'unknown', reason: 'product_unknown_or_unavailable', product_id: a.product_id ?? null };
    const variants = product.variants ?? [];
    const variant = variants.length === 1 ? variants[0] : variants.find((v) => v.id === a.variant_id);
    if (!variant || !finite(variant.price)) return { status: 'unknown', reason: 'variant_required_or_price_unknown', product_id: product.id };
    const unitPrice = Math.round(Number(variant.price) * 100);
    lines.push({ productId: product.shopify_product_id, quantity, unitPrice, total: unitPrice * quantity, added: true });
    additions.push({ product_id: product.id, name: product.title, quantity, unit_price: major(unitPrice) });
  }
  if (!lines.length) return { status: 'ok', reason: 'empty_cart', best: null, additions, caveats: [], checkout_verified: false };

  const caveats = new Set();
  const excluded = [];
  const offers = [];
  const enteredCodes = new Set([...(cart.codes ?? []).map(norm), ...cart.discounts.filter((d) => d.type !== 'automatic').map((d) => norm(d.title))]);
  for (const row of (source.promotions ?? []).filter(isPublicPromotion)) {
    if (running(row, now)) continue;
    if (row.method === 'code' && !codesOf(row).some((c) => enteredCodes.has(c))) { excluded.push({ promotion_id: row.id, name: row.title, reason: 'code_not_entered' }); continue; }
    const model = modelOf(row, { source, cart, baseCurrency });
    if (model.excluded) { excluded.push({ promotion_id: row.id, name: row.title, reason: model.excluded }); if (model.excluded === 'app_rules_not_predicted') caveats.add('app_discount_not_predicted'); continue; }
    offers.push(model);
  }
  // A private code the shopper entered: kept at the amount the cart shows.
  for (const d of cart.discounts.filter((d) => d.amount > 0 && d.type !== 'automatic')) {
    const row = (source.cartCodeRows ?? []).find((p) => codesOf(p).includes(norm(d.title)));
    if (!row || offers.some((o) => o.row.id === row.id) || running(row, now)) continue;
    offers.push({ row, kind: 'observed', cls: classOf(row), amount: d.amount, code: norm(d.title) });
    caveats.add('entered_code_amount_from_current_cart');
  }
  if (offers.length > MAX_OFFERS) { caveats.add('too_many_offers_partial_search'); offers.length = MAX_OFFERS; }

  const results = [];
  for (let mask = 0; mask < 1 << offers.length; mask++) {
    const set = offers.filter((_, i) => mask & (1 << i));
    const priced = priceSet(set, lines);
    if (priced) results.push(priced);
  }
  results.sort((a, b) => b.saving - a.saving || Number(b.shipping) - Number(a.shipping) || a.offers.length - b.offers.length);
  const [best, ...rest] = results;
  if (shopifyPlus && offers.some((o) => o.kind === 'bxgy')) caveats.add('plus_gets_line_stacking_not_modelled');
  if (best.offers.some((o) => o.kind === 'bxgy')) caveats.add('buy_x_get_y_counted_once');
  if (results.some((r) => r.uncertain && r.saving >= best.saving)) caveats.add('combination_flags_incomplete');
  if (best.offers.some((o) => o.kind === 'shipping')) caveats.add('delivery_cost_not_calculated');
  // On the current cart, Shopify's own result is the authority.
  const observed = additions.length ? null : new Set(cart.discounts.filter((d) => d.amount > 0).map((d) => d.title).map((t) => (source.promotions ?? []).concat(source.cartCodeRows ?? []).find((p) => norm(p.title) === norm(t) || codesOf(p).includes(norm(t)))?.id).filter(Boolean));
  // Shipping discounts appear at checkout, never in cart.js: not compared.
  const predicted = new Set(best.offers.filter((o) => o.class !== 'SHIPPING').map((o) => o.promotion_id));
  const matches = observed ? observed.size === predicted.size && [...observed].every((id) => predicted.has(id)) : null;
  if (matches === false) caveats.add('prediction_differs_from_cart_cart_is_authoritative');
  // FREE DELIVERY MISSED BECAUSE OF THE DISCOUNTS: its minimum is measured on
  // the discounted total, so the best saving can drop the cart below it (dev
  // store: TEST02 leaves 68,95 € against a 70 € minimum, where September Rose
  // kept 74,72 €). Shopify still applies the best saving; the shopper is told.
  const freeDeliveryMissed = offers
    .filter((o) => o.kind === 'shipping' && !best.offers.some((b) => b.promotion_id === o.row.id) && o.minimum?.spend !== undefined && best.total < o.minimum.spend)
    .filter((o) => offers.every((x) => x === o || !best.offers.some((b) => b.promotion_id === x.row.id) || combinable(o.row, x.row)))
    .map((o) => ({ promotion_id: o.row.id, name: o.row.title, missing: major(o.minimum.spend - best.total), before_discounts: lines.reduce((n, l) => n + l.total, 0) >= o.minimum.spend }));
  const describe = (r) => ({ offers: r.offers.map(({ kind, ...o }) => o), saving_total: major(r.saving), total_after: major(r.total) });
  return {
    status: 'ok', currency: cart.currency, cart_priced: additions.length ? 'current_cart_with_additions' : 'current_cart',
    additions, subtotal_before: major(lines.reduce((n, l) => n + l.total, 0)),
    best: describe(best),
    alternatives: rest.filter((r) => r.offers.length && r.saving > 0).slice(0, 3).map(describe),
    free_delivery_missed: freeDeliveryMissed,
    // FOR EACH OFFER LEFT OUT OF THE BEST SET, the best set that includes it:
    // « TEST02 would save 111,09 € with September Rose on the rest; September
    // Rose alone on everything saves 116,66 € » is the answer to « why not? ».
    not_chosen: offers.filter((o) => o.kind !== 'observed' && !best.offers.some((b) => b.promotion_id === o.row.id)).map((o) => {
      const withIt = results.find((r) => r.offers.some((x) => x.promotion_id === o.row.id));
      return { promotion_id: o.row.id, name: o.row.title, ...(withIt ? { possible: true, saving_with_it: major(withIt.saving), set_with_it: withIt.offers.filter((x) => x.class !== 'SHIPPING').map((x) => x.name), saving_chosen: major(best.saving) } : { possible: false }) };
    }),
    excluded, matches_current_cart: matches, caveats: [...caveats], checkout_verified: false
  };
}

/** What an offer does, in the solver's terms, or why it is left out. */
function modelOf(row, { source, cart, baseCurrency }) {
  const mechanic = promotionMechanic(row);
  const r = row.rule_snapshot ?? {};
  if (['app', 'unknown'].includes(mechanic)) return { excluded: 'app_rules_not_predicted' };
  if (r.customer_selection?.scope && r.customer_selection.scope !== 'all' || row.applies_once_per_customer === true) return { excluded: 'customer_specific' };
  const min = r.minimum_requirement;
  if (min?.type === 'unknown' || min?.type === 'subtotal' && (!finite(min.amount) || min.currency !== cart.currency) || min?.type === 'quantity' && !finite(min.quantity)) return { excluded: 'threshold_unknown_or_other_currency' };
  const minimum = !min ? null : min.type === 'subtotal' ? { spend: Math.round(Number(min.amount) * 100) } : { units: Number(min.quantity) };
  const code = row.method === 'code' ? codesOf(row).find((c) => (cart.codes ?? []).map(norm).includes(c) || cart.discounts.some((d) => norm(d.title) === c)) ?? null : null;
  const base = { row, minimum, code };
  if (mechanic === 'free_shipping') return { ...base, kind: 'shipping', cls: 'SHIPPING', destination: Boolean(r.destination) };
  const gets = r.customer_gets;
  if (!gets?.items || !finite(gets.percentage) && !finite(gets.amount)) return { excluded: 'rules_incomplete' };
  const reward = { percentage: finite(gets.percentage) ? Number(gets.percentage) : null, amount: finite(gets.amount) ? Math.round(Number(gets.amount) * 100) : null, each: gets.applies_on_each_item === true };
  if (mechanic === 'order_discount') return { ...base, kind: 'order', cls: 'ORDER', reward };
  const getsIds = qualifyingIds(gets.items, source.members);
  if (getsIds === null) return { excluded: 'collection_or_item_scope_unknown' };
  if (mechanic === 'product_discount') return { ...base, kind: 'line', cls: 'PRODUCT', reward, scope: getsIds };
  const buysIds = qualifyingIds(r.customer_buys?.items, source.members);
  if (buysIds === null || !r.customer_buys) return { excluded: 'collection_or_item_scope_unknown' };
  const buysAmount = r.customer_buys.amount !== undefined ? Number(r.customer_buys.amount) : null;
  if (buysAmount !== null && (!Number.isFinite(buysAmount) || !baseCurrency || baseCurrency !== cart.currency)) return { excluded: 'threshold_unknown_or_other_currency' };
  const getQty = Number(gets.quantity);
  if (!Number.isInteger(getQty) || getQty < 1) return { excluded: 'rules_incomplete' };
  return { ...base, kind: 'bxgy', cls: 'PRODUCT', reward, buys: buysIds, gets: getsIds, buyQty: finite(r.customer_buys.quantity) ? Number(r.customer_buys.quantity) : null, buyAmount: buysAmount === null ? null : Math.round(buysAmount * 100), getQty };
}

const inScope = (scope, line) => scope === true || scope.has(line.productId);
const off = (reward, value, units = 1) => reward.percentage !== null ? Math.round(value * reward.percentage) : Math.min(value, reward.amount * (reward.each ? units : 1));

/** One set of offers, priced in Shopify's order; null when the set cannot all apply. */
function priceSet(set, cartLines) {
  if (set.filter((o) => o.cls === 'SHIPPING').length > 1) return null;
  let uncertain = false;
  for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) {
    if (!combinable(set[i].row, set[j].row)) return null;
    if (!stackingKnown(set[i].row, set[j].row)) uncertain = true;
  }
  const lines = cartLines.map((l) => ({ ...l, by: null }));
  const units = lines.reduce((n, l) => n + l.quantity, 0);
  const subtotal = lines.reduce((n, l) => n + l.total, 0);
  const priced = [];
  const name = (o) => ({ promotion_id: o.row.id, name: o.row.title, class: o.cls, kind: o.kind, ...(o.code ? { code: o.code } : {}) });

  // 1. BUY X GET Y CLAIMS ITS LINES FIRST: the cheapest « gets » units, then
  //    enough « buys » lines at full price (never the « gets » units).
  for (const o of set.filter((o) => o.kind === 'bxgy')) {
    const free = lines.filter((l) => !l.by);
    const getsLines = free.filter((l) => inScope(o.gets, l)).sort((a, b) => a.unitPrice - b.unitPrice);
    let need = o.getQty, saving = 0;
    const used = new Map();
    for (const l of getsLines) { const take = Math.min(need, l.quantity); if (!take) break; used.set(l, take); need -= take; saving += off(o.reward, take * l.unitPrice, take); }
    if (need > 0) return null;
    const buys = free.filter((l) => inScope(o.buys, l)).map((l) => ({ l, qty: l.quantity - (used.get(l) ?? 0) })).filter((x) => x.qty > 0).sort((a, b) => b.l.unitPrice - a.l.unitPrice);
    let qty = 0, value = 0;
    const buyLines = [];
    for (const x of buys) {
      if ((o.buyQty === null || qty >= o.buyQty) && (o.buyAmount === null || value >= o.buyAmount)) break;
      buyLines.push(x.l); qty += x.qty; value += x.qty * x.l.unitPrice;
    }
    if (o.buyQty !== null && qty < o.buyQty || o.buyAmount !== null && value < o.buyAmount) return null;
    for (const l of [...used.keys(), ...buyLines]) l.by = o;
    if (saving <= 0) return null;
    priced.push({ ...name(o), saving: major(saving), _minor: saving });
  }

  // 2. PRODUCT DISCOUNTS, one per line: each free line takes the best one.
  const lineOffers = set.filter((o) => o.kind === 'line');
  const got = new Map(lineOffers.map((o) => [o, []]));
  for (const l of lines.filter((l) => !l.by)) {
    const best = lineOffers.filter((o) => inScope(o.scope, l)).map((o) => ({ o, s: off(o.reward, l.total, l.quantity) })).sort((a, b) => b.s - a.s)[0];
    if (best && best.s > 0) { l.by = best.o; got.get(best.o).push(l); }
  }
  for (const o of lineOffers) {
    const mine = got.get(o);
    const value = mine.reduce((n, l) => n + l.total, 0);
    if (!mine.length || o.minimum?.spend !== undefined && value < o.minimum.spend || o.minimum?.units !== undefined && mine.reduce((n, l) => n + l.quantity, 0) < o.minimum.units) return null;
    const saving = o.reward.percentage !== null || o.reward.each ? mine.reduce((n, l) => n + off(o.reward, l.total, l.quantity), 0) : Math.min(o.reward.amount, value);
    priced.push({ ...name(o), saving: major(saving), _minor: saving });
  }
  for (const o of set.filter((o) => o.kind === 'observed' && o.cls === 'PRODUCT')) priced.push({ ...name(o), saving: major(o.amount), _minor: o.amount });
  const productSaving = priced.reduce((n, p) => n + p._minor, 0);
  const afterProducts = Math.max(0, subtotal - productSaving);

  // 3. ORDER DISCOUNTS, each on the subtotal after product discounts; a
  //    minimum must be met before AND after those product discounts.
  let orderSaving = 0;
  for (const o of set.filter((o) => o.kind === 'order')) {
    if (o.minimum?.spend !== undefined && Math.min(subtotal, afterProducts) < o.minimum.spend || o.minimum?.units !== undefined && units < o.minimum.units) return null;
    const saving = off(o.reward, afterProducts);
    if (saving <= 0) return null;
    orderSaving += saving;
    priced.push({ ...name(o), saving: major(saving), _minor: saving });
  }
  for (const o of set.filter((o) => o.kind === 'observed' && o.cls !== 'PRODUCT' && o.cls !== 'SHIPPING')) { orderSaving += o.amount; priced.push({ ...name(o), saving: major(o.amount), _minor: o.amount }); }
  const total = Math.max(0, afterProducts - orderSaving);

  // 4. SHIPPING, on the products at their discounted price.
  let shipping = false;
  for (const o of set.filter((o) => o.kind === 'shipping' || o.kind === 'observed' && o.cls === 'SHIPPING')) {
    if (o.minimum?.spend !== undefined && total < o.minimum.spend || o.minimum?.units !== undefined && units < o.minimum.units) return null;
    shipping = true;
    priced.push({ ...name(o), saving: null, delivery: 'free', ...(o.destination ? { destination_required: true } : {}) });
  }
  return { offers: priced.map(({ _minor, ...p }) => p), saving: productSaving + orderSaving, total, shipping, uncertain };
}

function stackingKnown(a, b) {
  const key = { ORDER: 'order_discounts', PRODUCT: 'product_discounts', SHIPPING: 'shipping_discounts' };
  return [a, b].every((p) => Array.isArray(p.discount_classes) && p.discount_classes.length && p.discount_classes.every((c) => key[c])) && [[a, b], [b, a]].every(([x, y]) => y.discount_classes.every((c) => x.combines_with?.[key[c]] === true));
}
