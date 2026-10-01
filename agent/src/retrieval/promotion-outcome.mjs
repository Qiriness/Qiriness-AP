import { promotionMechanic } from '../../../scripts/lib/promotion-mechanic.mjs';

// WHY A PROMOTION DID OR DID NOT APPLY to one basket — an order, or the last
// abandoned checkout. Pure: rows and basket in, verdict out.
//
// The question the corpus asks is never "what are the rules of this offer"; it
// is « j'avais 72 € et on m'a compté la livraison », « le masque offert dès
// 65 € a été facturé », « j'ai commandé 3 masques et je n'en ai reçu que 3 ».
// Each has one cause that the stored rule and the basket settle between them,
// and the measured cases are what the reasons below are named after.
//
// NOTHING IS CONCLUDED FROM WHAT CANNOT BE SEEN. A threshold compared against a
// spend that sits on either side of it depending on whether discounts count is
// `unknown`; a collection whose membership was never synced is `unknown`; a
// basket with no destination cannot fail a destination check.

/**
 * The closed vocabulary, in the order a reply should lead with: the first
 * failing reason is THE reason. Expiry beats everything — no other condition
 * matters for an offer that was not running.
 */
export const OUTCOMES = Object.freeze([
  'applied',
  'expired',
  'outside_destination',
  'not_combinable',
  'items_not_qualifying',
  'below_threshold',
  'reward_not_in_basket',
  'conditions_met',
  'undetermined'
]);

const FAIL_ORDER = [
  'expired',
  'outside_destination',
  'not_combinable',
  'items_not_qualifying',
  'below_threshold',
  'reward_not_in_basket'
];

/**
 * An order bundle (resolution/order-context.mjs) as a basket.
 * `applied` names what Shopify recorded — the typed code or the offer's title.
 */
export function basketFromOrder(order) {
  if (!order) return null;
  return {
    source: 'order',
    at: order.placedAt || null,
    countryCode: order.shipTo?.countryCode || null,
    lines: (order.items || []).map((item) => ({
      productId: item.productId || null,
      title: item.title || null,
      quantity: Number(item.quantity) || 0,
      price: num(item.price),
      paid: num(item.paid)
    })),
    applied: (order.promotions?.applied || []).map((a) => a.name).filter(Boolean),
    codes: order.promotions?.codes || []
  };
}

/**
 * An abandoned checkout (retrieval/abandoned-checkout.mjs) as a basket.
 * Shopify does not report which AUTOMATIC offers a checkout carried, only the
 * codes, so `applied` is unknown here rather than empty.
 */
export function basketFromCheckout(checkout) {
  if (!checkout) return null;
  return {
    source: 'checkout',
    at: checkout.updatedAt || null,
    countryCode: null,
    lines: (checkout.lineItems || []).map((item) => ({
      productId: item.productId || null,
      title: item.productTitle || item.title || null,
      quantity: Number(item.quantity) || 0,
      price: num(item.originalTotal),
      paid: num(item.discountedTotal)
    })),
    applied: null,
    codes: checkout.discountCodes || []
  };
}

/**
 * @param promotion  a `promotions` row
 * @param basket     from basketFromOrder / basketFromCheckout, or null
 * @param others     rows of the OTHER promotions on the basket (for combination)
 * @param members    Map<collectionGid, Set<productGid>> for collection-scoped offers
 */
export function evaluateOutcome({ promotion, basket, others = [], members = new Map() }) {
  const mechanic = promotionMechanic(promotion);
  const checks = [];
  const add = (id, status, extra = {}) => checks.push({ id, status, ...extra });

  if (!basket) {
    return { outcome: 'undetermined', mechanic, checks: [{ id: 'basket', status: 'unknown' }], basketSource: null };
  }

  // --- was it applied at all? -------------------------------------------
  const applied = basket.applied === null ? null : basket.applied.some((name) => sameName(name, promotion.title) || sameCodeIn(name, promotion));
  if (applied) {
    add('applied', 'pass');
    return { outcome: 'applied', mechanic, checks, basketSource: basket.source };
  }

  // --- running at the time of the basket --------------------------------
  const at = basket.at ? new Date(basket.at) : null;
  if (at && promotion.ends_at && at > new Date(promotion.ends_at)) add('window', 'fail', { reason: 'expired' });
  else if (at && promotion.starts_at && at < new Date(promotion.starts_at)) add('window', 'fail', { reason: 'expired' });
  else add('window', at ? 'pass' : 'unknown');

  const rules = promotion.rule_snapshot || {};

  // --- destination --------------------------------------------------------
  const destination = rules.destination;
  if (destination?.scope === 'countries' && !destination.include_rest_of_world) {
    if (!basket.countryCode) add('destination', 'unknown');
    else if (destination.countries.includes(basket.countryCode)) add('destination', 'pass');
    else add('destination', 'fail', { reason: 'outside_destination', country: basket.countryCode, allowed: destination.countries });
  }

  // --- which lines qualify ------------------------------------------------
  const buysItems = rules.customer_buys?.items ?? null;
  const getsItems = rules.customer_gets?.items ?? null;
  const qualifyingScope = buysItems ?? (mechanic === 'product_discount' ? getsItems : null);
  const inScope = scopeTest(qualifyingScope, members);
  const qualifying = inScope ? basket.lines.filter((line) => inScope(line)) : null;

  if (qualifyingScope && !inScope) add('items', 'unknown');
  else if (qualifying && qualifying.length === 0) add('items', 'fail', { reason: 'items_not_qualifying' });
  else if (qualifying) add('items', 'pass');

  // --- the threshold: a spend or a quantity --------------------------------
  // A gift never counts towards the spend that earns it: the Wrap d'Or at
  // 6,23 € in a basket is the reward, not part of the 65 €.
  const giftTest = mechanic === 'gift' ? scopeTest(getsItems, members) : null;
  const lines = (qualifying ?? basket.lines).filter((line) => !(giftTest && giftTest(line)));
  const spend = {
    before: sum(lines.map((l) => l.price)),
    after: sum(lines.map((l) => l.paid))
  };
  const required = thresholdRequired(rules);
  if (required?.type === 'amount' && (qualifying || !qualifyingScope)) {
    // BOTH SIDES OF THE DISCOUNT, because which one Shopify measures depends
    // on the offer and is not in the data. Agreeing is an answer; straddling
    // the threshold is `unknown`, never a coin toss.
    const reachedBefore = spend.before !== null && spend.before >= required.amount;
    const reachedAfter = spend.after !== null && spend.after >= required.amount;
    if (reachedBefore && reachedAfter) add('threshold', 'pass', { required: required.amount, spend: spend.after });
    else if (!reachedBefore && !reachedAfter && spend.before !== null) {
      add('threshold', 'fail', { reason: 'below_threshold', required: required.amount, spend: spend.before, gap: round(required.amount - spend.before) });
    } else add('threshold', 'unknown', { required: required.amount, spend: spend.after });
  }

  // --- the reward: a gift or the « +1 » must be in the basket -------------
  //
  // MEASURED: « WRAP PURIFIANT commandé 3 reçu 3 et non 4 » (1d5445ac) — the
  // 3+1 gives the fourth item free, it does not add it. The customer has to put
  // it in the basket, and a gift is added with « je le veux ». A reward that is
  // missing from the basket is the cause, not a failure of the offer.
  if (mechanic === 'multi_buy' && qualifying) {
    const buyQty = Number(rules.customer_buys?.quantity) || 0;
    const getQty = Number(rules.customer_gets?.quantity) || 1;
    const units = qualifying.reduce((n, l) => n + l.quantity, 0);
    if (units < buyQty) add('threshold', 'fail', { reason: 'below_threshold', required: buyQty, units });
    else if (units < buyQty + getQty) add('reward', 'fail', { reason: 'reward_not_in_basket', units, required: buyQty + getQty });
    else add('reward', 'pass', { units });
  }
  if (mechanic === 'gift') {
    const getsTest = scopeTest(getsItems, members);
    const giftLines = getsTest ? basket.lines.filter((line) => getsTest(line)) : null;
    if (!giftLines) add('reward', 'unknown');
    else if (giftLines.length === 0) add('reward', 'fail', { reason: 'reward_not_in_basket' });
    else add('reward', 'pass', { charged: giftLines.some((l) => (l.paid ?? 0) > 0) });
  }

  // --- combination with what else was applied ------------------------------
  for (const other of others) {
    if (!combinable(promotion, other)) {
      add('combination', 'fail', { reason: 'not_combinable', with: other.title });
    }
  }

  const failed = FAIL_ORDER.find((reason) => checks.some((c) => c.status === 'fail' && c.reason === reason));
  if (failed) return { outcome: failed, mechanic, checks, basketSource: basket.source };
  if (checks.some((c) => c.status === 'unknown')) return { outcome: 'undetermined', mechanic, checks, basketSource: basket.source };
  // Every condition held and Shopify did not apply it — or, on a checkout, it
  // would have. Either way a person looks: nothing here explains a refusal.
  return { outcome: 'conditions_met', mechanic, checks, basketSource: basket.source };
}

/**
 * Whether two promotions may apply together, both ways round — Shopify requires
 * each to allow the other's class. From `combines_with`, never inferred.
 */
export function combinable(a, b) {
  return allows(a, b) && allows(b, a);
}

const CLASS_KEY = { ORDER: 'order_discounts', PRODUCT: 'product_discounts', SHIPPING: 'shipping_discounts' };

function allows(a, b) {
  const combines = a?.combines_with || {};
  const classes = Array.isArray(b?.discount_classes) ? b.discount_classes : [];
  // A class we cannot read is not a refusal: the check only ever states what
  // the data says.
  return classes.every((cls) => !CLASS_KEY[cls] || combines[CLASS_KEY[cls]] !== false);
}

/** A predicate over basket lines, or null when membership cannot be known. */
function scopeTest(items, members) {
  if (!items) return null;
  if (items.scope === 'all') return () => true;
  if (items.scope === 'products') {
    const ids = new Set((items.products || []).map((p) => p.id));
    return (line) => ids.has(line.productId);
  }
  if (items.scope === 'collections') {
    const sets = (items.collections || []).map((c) => members.get(c.id));
    if (sets.some((s) => !s)) return null;
    return (line) => sets.some((s) => s.has(line.productId));
  }
  return null;
}

function thresholdRequired(rules) {
  if (rules.minimum_requirement?.type === 'subtotal' && rules.minimum_requirement.amount) {
    return { type: 'amount', amount: Number(rules.minimum_requirement.amount) };
  }
  if (rules.customer_buys?.amount !== undefined && rules.customer_buys?.amount !== null) {
    return { type: 'amount', amount: Number(rules.customer_buys.amount) };
  }
  return null;
}

function sameName(a, b) {
  const norm = (v) => String(v || '').trim().toLowerCase();
  return norm(a) !== '' && norm(a) === norm(b);
}

function sameCodeIn(name, promotion) {
  const codes = Array.isArray(promotion.codes) ? promotion.codes : [];
  return codes.some((c) => sameName(name, c?.code));
}

function sum(values) {
  if (values.some((v) => v === null)) return null;
  return round(values.reduce((a, b) => a + b, 0));
}

function num(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
