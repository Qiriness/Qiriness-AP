import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromotionLookup } from './promotion-lookup.mjs';

// `listActive` answers "quelles promos avez-vous ?", and it once answered it per
// REDEEM CODE. On the live shop that was 3619 entries and 259,874 characters in
// one tool result — seven times the model's whole per-minute token budget, which
// failed the investigation outright on a 284-character ticket.
//
// The tests below hold the two properties that fixed it: one entry per OFFER,
// and a bulk discount's per-customer codes never leaving the module.

/**
 * Stubs the transport, not the client — `supabaseSelectAll` builds a URL and
 * fetches it. The `Range` header must be honoured: it pages, and stops only on
 * an empty page, so a mock returning the same rows regardless loops forever.
 */
function stubFetch(getRows) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const from = Number(String(init?.headers?.Range || '0-999').split('-')[0]);
    const rows = from === 0 ? getRows() : [];
    return {
      ok: true,
      status: 200,
      async json() {
        return rows;
      },
      async text() {
        return JSON.stringify(rows);
      }
    };
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function bulkCodes(n, prefix = 'GEN') {
  return Array.from({ length: n }, (_, i) => ({ code: `${prefix}${i}`, usage_count: 0 }));
}

const ACTIVE = {
  id: 'p1',
  title: 'QIRINESS20',
  status: 'ACTIVE',
  summary: '20% off',
  codes: [{ code: 'QIRINESS20', usage_count: 3 }],
  // Listed only because an operator cleared it (offerable_in_replies).
  offerable_in_replies: true
};

const BULK = {
  id: 'p2',
  title: 'Welcome bulk',
  status: 'ACTIVE',
  summary: '10% off',
  codes: bulkCodes(600),
  offerable_in_replies: true
};

/** A lookup over a fixed set of rows, plus the teardown for its fetch stub. */
function lookupOver(rows) {
  const restore = stubFetch(() => rows);
  const lookup = createPromotionLookup({
    supabase: { baseUrl: 'https://example.test/rest/v1', key: 'k' },
    shopId: 's1',
    logger: null
  });
  return { lookup, restore };
}

test('a bulk discount is one offer, not six hundred', async () => {
  // THE REGRESSION. Flattening per code is correct for `lookupPromotion`, which
  // needs per-code usage to answer "you have already used this one". Reusing it
  // here multiplied a 2-offer shop into 601 lines.
  const { lookup, restore } = lookupOver([ACTIVE, BULK]);
  try {
    const { promotions, total } = await lookup.listActive();
    assert.equal(promotions.length, 2);
    assert.equal(total, 2);
    assert.deepEqual(promotions.map((p) => p.title).sort(), ['QIRINESS20', 'Welcome bulk']);
  } finally { restore(); }
});

test("a bulk discount's codes never leave the module", async () => {
  // They are other customers' property: each is single-use and belongs to one
  // person. One turn from here is a drafted reply.
  const { lookup, restore } = lookupOver([BULK]);
  try {
    const { promotions } = await lookup.listActive();
    assert.equal(promotions[0].code, null, 'no code is named for a bulk discount');
    assert.equal(promotions[0].codeCount, 600, 'but how many exist is still reported');
    assert.ok(!JSON.stringify(promotions).includes('GEN0'), 'no generated code is carried');
  } finally { restore(); }
});

test('a single shared code is named, because that is what advertised looks like', async () => {
  const { lookup, restore } = lookupOver([ACTIVE]);
  try {
    const { promotions } = await lookup.listActive();
    assert.equal(promotions[0].code, 'QIRINESS20');
  } finally { restore(); }
});

test('the listing is bounded even when every offer is distinct', async () => {
  // The dedup is what fixes this shop; the cap is what stops a shop with
  // hundreds of genuinely distinct offers reproducing the failure another way.
  const many = Array.from({ length: 90 }, (_, i) => ({
    id: `p${i}`,
    title: `Offer ${i}`,
    status: 'ACTIVE',
    summary: 's',
    codes: [],
    offerable_in_replies: true
  }));
  const { lookup, restore } = lookupOver(many);
  try {
    const { promotions, total, truncated } = await lookup.listActive();
    assert.equal(total, 90, 'the true count is still reported');
    assert.ok(promotions.length < 90, 'but the list is capped');
    assert.equal(truncated, true);
  } finally { restore(); }
});

test('inactive and out-of-window promotions are not listed', async () => {
  const now = new Date('2026-08-14T00:00:00Z');
  const rows = [
    ACTIVE,
    { ...ACTIVE, id: 'p3', title: 'EXPIRED', ends_at: '2026-01-01T00:00:00Z' },
    { ...ACTIVE, id: 'p4', title: 'FUTURE', starts_at: '2027-01-01T00:00:00Z' },
    { ...ACTIVE, id: 'p5', title: 'DISABLED', status: 'EXPIRED' }
  ];
  const { lookup, restore } = lookupOver(rows);
  try {
    const { promotions } = await lookup.listActive({ now });
    assert.deepEqual(promotions.map((p) => p.title), ['QIRINESS20']);
  } finally { restore(); }
});

test('an automatic offer an operator kept out of replies is not listed', async () => {
  const shipping = {
    id: 'p20',
    title: 'Frais de port offerts dès 70€',
    method: 'automatic',
    discount_type: 'DiscountAutomaticFreeShipping',
    discount_classes: ['SHIPPING'],
    status: 'ACTIVE',
    codes: []
  };
  const { lookup, restore } = lookupOver([
    ACTIVE,
    shipping,
    { ...shipping, id: 'p21', title: 'Masque offert', describable_in_replies: false }
  ]);
  try {
    const { promotions } = await lookup.listActive();
    assert.deepEqual(promotions.map((p) => p.title).sort(), ['Frais de port offerts dès 70€', 'QIRINESS20']);
    assert.equal(promotions.find((p) => p.method === 'automatic').mechanic, 'free_shipping');
  } finally { restore(); }
});

test('refresh drops the row cache too, not only the flattened one', async () => {
  // Two caches now sit behind this module; clearing one would rebuild the
  // flattened list from stale rows.
  let rows = [ACTIVE];
  const restore = stubFetch(() => rows);
  try {
    const lookup = createPromotionLookup({
      supabase: { baseUrl: 'https://example.test/rest/v1', key: 'k' },
      shopId: 's1',
      logger: null
    });

    await lookup.listActive();
    rows = [ACTIVE, { ...ACTIVE, id: 'p9', title: 'NOUVEAU' }];
    lookup.refresh();

    const { promotions } = await lookup.listActive();
    assert.equal(promotions.length, 2, 'the second read saw the new row');
  } finally { restore(); }
});

// --- offers scoped to one product --------------------------------------------

const LED = 'gid://shopify/Product/led';

/** An offerable, active promotion scoped to `count` products including the LED. */
const scopedTo = (code, count) => ({
  id: `p-${code}`,
  title: code,
  codes: [{ code }],
  method: 'CODE',
  discount_type: 'PERCENTAGE',
  status: 'ACTIVE',
  summary: `${code} summary`,
  offerable_in_replies: true,
  rule_snapshot: {
    customer_gets: {
      items: {
        scope: 'products',
        products: [
          { id: LED, title: 'Masque LED' },
          ...Array.from({ length: count - 1 }, (_, i) => ({ id: `gid://other/${i}`, title: `Other ${i}` }))
        ]
      }
    }
  }
});

test('an offer on one product is specific; one on the whole catalogue is not', async () => {
  // THE LINE IS TEN OTHER PRODUCTS. A code scoped to 94 products is a general
  // sale wearing a product scope: naming it as "an offer on your product" would
  // be true and misleading.
  const { lookup, restore } = lookupOver([scopedTo('UKLED20', 1), scopedTo('SALE94', 94)]);
  try {
    const { specific, general } = await lookup.offersForProduct(LED);
    assert.deepEqual(specific.map((p) => p.code), ['UKLED20']);
    assert.deepEqual(general.map((p) => p.code), ['SALE94']);
  } finally {
    restore();
  }
});

test('the boundary is ten others, not eleven', async () => {
  const { lookup, restore } = lookupOver([scopedTo('ELEVEN', 11), scopedTo('TWELVE', 12)]);
  try {
    const { specific, general } = await lookup.offersForProduct(LED);
    assert.deepEqual(specific.map((p) => p.code), ['ELEVEN'], 'ten others is still about this product');
    assert.deepEqual(general.map((p) => p.code), ['TWELVE'], 'eleven others is about the catalogue');
  } finally {
    restore();
  }
});

test('a code nobody cleared is never returned, however well it fits', async () => {
  // The same gate the rule editor's picker uses. A partner rate or a 100%-off
  // code must not reach a customer because a lookup happened to find it.
  const hidden = { ...scopedTo('SECRET', 1), offerable_in_replies: false };
  const { lookup, restore } = lookupOver([hidden]);
  try {
    const { specific, general } = await lookup.offersForProduct(LED);
    assert.deepEqual(specific, []);
    assert.deepEqual(general, []);
  } finally {
    restore();
  }
});

test('an order-wide offer is general even though it covers the product', async () => {
  const orderWide = {
    id: 'p-order', title: 'ORDER10', codes: [{ code: 'ORDER10' }], method: 'CODE',
    discount_type: 'PERCENTAGE', status: 'ACTIVE', summary: '10% off the order',
    offerable_in_replies: true, rule_snapshot: { customer_gets: { items: null } }
  };
  const { lookup, restore } = lookupOver([orderWide]);
  try {
    const { specific, general } = await lookup.offersForProduct(LED);
    assert.deepEqual(specific, []);
    assert.deepEqual(general.map((p) => p.code), ['ORDER10']);
  } finally {
    restore();
  }
});

test('a product with no offer at all comes back empty rather than guessing', async () => {
  const { lookup, restore } = lookupOver([scopedTo('OTHER', 1)]);
  try {
    const { specific, general } = await lookup.offersForProduct('gid://shopify/Product/nothing');
    assert.deepEqual(specific, []);
    assert.deepEqual(general, []);
  } finally {
    restore();
  }
});

// --- which promotion a message is about ---------------------------------------
//
// Fixtures shaped like the live offers of 2026-10-01: free shipping from 70 €
// (France only), gifts that are all masks, a 3+1, and the welcome codes.

const NOW = new Date('2026-10-01T12:00:00Z');

const auto = (id, title, discount_type, rule_snapshot, extra = {}) => ({
  id,
  title,
  method: 'automatic',
  discount_type,
  discount_classes: discount_type.endsWith('FreeShipping') ? ['SHIPPING'] : ['PRODUCT'],
  status: 'ACTIVE',
  summary: title,
  codes: [],
  rule_snapshot,
  ...extra
});
const giftRule = (amount, product) => ({
  customer_buys: { amount },
  customer_gets: { percentage: 1, quantity: 1, items: { scope: 'products', products: [{ id: product, title: product }] } }
});

const SHIPPING = auto('a1', 'Frais de port offerts à partir de 70€', 'DiscountAutomaticFreeShipping', {
  minimum_requirement: { type: 'subtotal', amount: '70.0' },
  destination: { scope: 'countries', countries: ['FR'] }
});
const VITAMINE = auto('a2', 'wrap vitaminé Offert dès 65€', 'DiscountAutomaticBxgy', giftRule('65.0', 'Masque Exfoliant Grenade Citron'));
const OR = auto('a3', 'Masque Or offert', 'DiscountAutomaticBxgy', giftRule('1.0', "Masque Repulpant Wrap d'Or"));
const ECLAT = auto('a4', 'MASQUE ÉCLAT OFFERT', 'DiscountAutomaticBxgy', giftRule('1.0', 'Masque Visage Wrap Éclat'));
const THREE_PLUS_ONE = auto('a5', '3+1 Offert : 3 masques achetés', 'DiscountAutomaticBxgy', {
  customer_buys: { quantity: '3' },
  customer_gets: { percentage: 1, quantity: 1 }
});
const WELCOME = {
  id: 'c1',
  title: 'BIENVENUEQIRINESS',
  method: 'code',
  discount_type: 'DiscountCodeBasic',
  discount_classes: ['PRODUCT'],
  status: 'ACTIVE',
  summary: '20% off 55 products',
  codes: [{ code: 'BIENVENUEQIRINESS', usage_count: 4 }],
  rule_snapshot: { customer_gets: { percentage: 0.2 } }
};
const NEWYEAR = {
  ...WELCOME,
  id: 'c2',
  title: 'NEWYEAR26',
  status: 'EXPIRED',
  summary: '30% off',
  codes: [{ code: 'NEWYEAR26' }],
  rule_snapshot: { customer_gets: { percentage: 0.3 } }
};

const SHOP = [SHIPPING, VITAMINE, OR, ECLAT, THREE_PLUS_ONE, WELCOME, NEWYEAR];
const offer = (mechanic, { threshold = null, percentage = null, product = null } = {}) => ({ mechanic, threshold, percentage, product });

test('free shipping not applied on 72 € is the automatic shipping offer', async () => {
  // 0e0ee123: « ma commande fait 72 €, et pourtant des frais de livraison ».
  const { lookup, restore } = lookupOver(SHOP);
  try {
    const result = await lookup.identify({
      text: 'ma commande fait 72 €, livraison gratuite à compter de 70 €',
      offers: [offer('free_shipping', { threshold: 70 })],
      now: NOW
    });
    assert.equal(result.kind, 'automatic');
    assert.equal(result.offers[0].match.title, SHIPPING.title);
    assert.equal(result.offers[0].match.mechanic, 'free_shipping');
    assert.match(result.promptText, /s'applique seule, sans code/);
  } finally { restore(); }
});

test('a threshold the customer misquotes is matched anyway, and the gap is said', async () => {
  // ffd38002: an email promised free shipping from 49 €; Shopify applies 70 €.
  const { lookup, restore } = lookupOver(SHOP);
  try {
    const result = await lookup.identify({ text: 'livraison offerte dès 49 €', offers: [offer('free_shipping', { threshold: 49 })], now: NOW });
    assert.equal(result.kind, 'automatic');
    assert.deepEqual(result.offers[0].match.thresholdNote, { said: 49, actual: 70 });
    assert.match(result.promptText, /seuil de 49 € ; le seuil réel de cette offre est 70 €/);
  } finally { restore(); }
});

test('a gift is picked out of several masks by its threshold or its name', async () => {
  const { lookup, restore } = lookupOver(SHOP);
  try {
    // b474f63b: « un masque de 6,23 € qui était offert à partir de 65 € ».
    const byThreshold = await lookup.identify({ text: 'x', offers: [offer('gift', { threshold: 65, product: 'masque' })], now: NOW });
    assert.equal(byThreshold.offers[0].match.title, VITAMINE.title);

    // « le masque or offert » — « masque » is in every gift and counts for nothing.
    const byName = await lookup.identify({ text: 'x', offers: [offer('gift', { product: 'le masque or' })], now: NOW });
    assert.equal(byName.offers[0].match.title, OR.title);
  } finally { restore(); }
});

test('« un masque offert » is an automatic gift even when which gift is open, and says between which', async () => {
  // The kind is settled, the offer is not: 5836ab80, d6d0d1c3 and their like.
  const { lookup, restore } = lookupOver(SHOP);
  try {
    const result = await lookup.identify({ text: 'x', offers: [offer('gift', { product: 'masque' })], now: NOW });
    assert.equal(result.kind, 'automatic');
    assert.equal(result.offers[0].match, null);
    assert.ok(result.offers[0].candidates.length >= 2);
    assert.match(result.promptText, /sans pouvoir trancher/);
  } finally { restore(); }
});

test('3+1 is the multi-buy offer', async () => {
  const { lookup, restore } = lookupOver(SHOP);
  try {
    const result = await lookup.identify({ text: "l'offre 3+1 sur les masques", offers: [offer('multi_buy', { product: 'masques' })], now: NOW });
    assert.equal(result.kind, 'automatic');
    assert.equal(result.offers[0].match.title, THREE_PLUS_ONE.title);
  } finally { restore(); }
});

test('a typed code is a code, in any case and spacing the customer used', async () => {
  // 3b64e768 typed « Newyear26 »: the uppercase scan misses it, the decomposer does not.
  const { lookup, restore } = lookupOver(SHOP);
  try {
    const result = await lookup.identify({ text: 'avec code Newyear26 la remise ne passe pas', codes: ['Newyear26'], now: NOW });
    assert.equal(result.kind, 'code');
    assert.deepEqual(result.codes.map((c) => c.code), ['NEWYEAR26']);
  } finally { restore(); }
});

test('with a reading, a product name that is also a code is not a code', async () => {
  // 1d5445ac: « WRAP ECLAT commandé 3 reçu 4 » — WRAP is a real code here.
  const wrap = { ...WELCOME, id: 'c3', title: 'WRAP', codes: [{ code: 'WRAP' }] };
  const { lookup, restore } = lookupOver([...SHOP, wrap]);
  try {
    const read = await lookup.identify({ text: 'WRAP ECLAT commandé 3 reçu 4', codes: [], offers: [offer('multi_buy')], now: NOW });
    assert.equal(read.kind, 'automatic');
    // No reading at all: the scan is the fallback, and it is crude on purpose.
    const bare = await lookup.identify({ text: 'WRAP ECLAT commandé 3 reçu 4', now: NOW });
    assert.equal(bare.kind, 'code');
  } finally { restore(); }
});

test('a typed code the shop does not hold is kept, marked unknown', async () => {
  // 36211a3b typed a wheel-of-fortune code that was never synced.
  const { lookup, restore } = lookupOver(SHOP);
  try {
    const result = await lookup.identify({ text: 'les 10% de la roue 9FM7BQFZ', codes: ['9FM7BQFZ'], now: NOW });
    assert.equal(result.kind, 'code');
    assert.equal(result.codes[0].known, false);
    assert.match(result.promptText, /n'existe pas dans la boutique/);
  } finally { restore(); }
});

test('a stated percentage excludes an offer of another percentage', async () => {
  // 1e3d9dcb: « -20 % » once matched a past 25 % automatic offer.
  const quarter = auto('a9', '25% offerts sans minimum', 'DiscountAutomaticBasic', { customer_gets: { percentage: 0.25 } });
  const { lookup, restore } = lookupOver([quarter, WELCOME]);
  try {
    const result = await lookup.identify({ text: 'les 20% ne passent pas', offers: [offer('percent_off', { percentage: 20 })], now: NOW });
    assert.equal(result.kind, 'code');
    assert.equal(result.offers[0].match, null);
  } finally { restore(); }
});

test('a code the decomposer reports but the message does not contain is refused', async () => {
  const { lookup, restore } = lookupOver(SHOP);
  try {
    const result = await lookup.identify({ text: 'mon code ne marche pas', codes: ['BIENVENUEQIRINESS'], now: NOW });
    assert.equal(result.kind, 'none');
  } finally { restore(); }
});

test('424b4702: a campaign name in prose is not a code, so the gift it came with is still found', async () => {
  const { lookup, restore } = lookupOver(SHOP);
  try {
    const result = await lookup.identify({
      text: "pourriez-vous rajouter le masque éclat ? avec la promo octobre rose j'aurais dû avoir ce masque",
      codes: ['octobre rose'],
      offers: [offer('gift', { product: 'masque éclat' })],
      now: NOW
    });
    assert.deepEqual(result.codes, []);
    assert.equal(result.kind, 'automatic');
    assert.doesNotMatch(result.promptText, /OCTOBREROSE/);
  } finally { restore(); }
});

test('the phrase guard leaves real codes alone: capitals, one word, or a code the shop holds', async () => {
  const { lookup, restore } = lookupOver(SHOP);
  try {
    // Unknown but typed as a code: kept, so « code introuvable » can be said.
    const caps = await lookup.identify({ text: 'mon code PANIER 10 ne marche pas', codes: ['PANIER 10'], now: NOW });
    assert.deepEqual(caps.codes.map((c) => [c.code, c.known]), [['PANIER10', false]]);
    const oneWord = await lookup.identify({ text: 'le code octobrerose ne marche pas', codes: ['octobrerose'], now: NOW });
    assert.deepEqual(oneWord.codes.map((c) => [c.code, c.known]), [['OCTOBREROSE', false]]);
    // Known, even typed in lowercase across two words.
    const known = await lookup.identify({ text: 'le code bienvenue qiriness est refusé', codes: ['bienvenue qiriness'], now: NOW });
    assert.deepEqual(known.codes.map((c) => [c.code, c.known]), [['BIENVENUEQIRINESS', true]]);
  } finally { restore(); }
});

test('« les 20 % de la première commande » is a code the customer never typed', async () => {
  // No automatic offer gives 20 %, so the codes that do are named — and not chosen between.
  const { lookup, restore } = lookupOver(SHOP);
  try {
    const result = await lookup.identify({ text: 'les 20% ne passent pas', offers: [offer('percent_off', { percentage: 20 })], now: NOW });
    assert.equal(result.kind, 'code');
    assert.deepEqual(result.codeCandidates.map((c) => c.code), ['BIENVENUEQIRINESS']);
    assert.match(result.promptText, /Ne pas supposer lequel/);
  } finally { restore(); }
});

test('a code and an automatic offer in one message is both', async () => {
  const { lookup, restore } = lookupOver(SHOP);
  try {
    const result = await lookup.identify({
      text: 'le code BIENVENUEQIRINESS et le masque or offert',
      offers: [offer('gift', { product: 'masque or' })],
      now: NOW
    });
    assert.equal(result.kind, 'both');
  } finally { restore(); }
});

test('an offer that matches nothing in the shop is none, said plainly', async () => {
  const { lookup, restore } = lookupOver([WELCOME]);
  try {
    const result = await lookup.identify({ text: 'le cabas offert dès 59 €', offers: [offer('gift', { threshold: 59, product: 'cabas' })], now: NOW });
    assert.equal(result.kind, 'none');
    assert.match(result.promptText, /Aucune offre de la boutique ne correspond/);
  } finally { restore(); }
});

test('an automatic offer switched off is identified but flagged, and a long-ended one is not a candidate', async () => {
  const hidden = { ...SHIPPING, describable_in_replies: false };
  const ended = { ...THREE_PLUS_ONE, status: 'EXPIRED', ends_at: '2025-01-01T00:00:00Z' };
  const { lookup, restore } = lookupOver([hidden, ended]);
  try {
    const shipping = await lookup.identify({ text: 'x', offers: [offer('free_shipping')], now: NOW });
    assert.equal(shipping.offers[0].match.describable, false);
    assert.match(shipping.promptText, /ne pas la décrire au client/);

    const multi = await lookup.identify({ text: 'x', offers: [offer('multi_buy')], now: NOW });
    assert.equal(multi.kind, 'none');
  } finally { restore(); }
});

// --- why an identified promotion did or did not apply -------------------------

const orderBasket = (lines, applied = []) => ({
  source: 'order',
  at: '2026-07-12T07:00:00Z',
  countryCode: 'FR',
  lines,
  applied,
  codes: []
});
const paidLine = (productId, price, paid = price) => ({ productId, title: productId, quantity: 1, price, paid });

test('#6452: the offer asked about was applied, but the charged free item names another — that one is reported', async () => {
  const vitamine = { ...VITAMINE, rule_snapshot: { ...VITAMINE.rule_snapshot, customer_buys: { amount: '65.0', items: { scope: 'all' } } } };
  const or = { ...OR, rule_snapshot: { ...OR.rule_snapshot, customer_buys: { amount: '1.0', items: { scope: 'all' } } } };
  const { lookup, restore } = lookupOver([vitamine, or]);
  try {
    const basket = orderBasket(
      [paidLine("Masque Repulpant Wrap d'Or", 6.23), paidLine('Masque Exfoliant Grenade Citron', 6.23, 0), paidLine('lotion', 79.33)],
      [VITAMINE.title]
    );
    const result = await lookup.outcome({ ref: VITAMINE.title, basket });
    assert.equal(result.promotion.title, OR.title);
    assert.equal(result.instead, VITAMINE.title);
    assert.equal(result.outcome, 'conditions_met');
    assert.match(result.promptText, /a bien été appliquée ; l'article facturé relève d'une autre offre/);

    // Asked with no reference at all, the order still names it.
    const open = await lookup.outcome({ ref: '', basket });
    assert.equal(open.promotion.title, OR.title);
    assert.equal(open.instead, null);
  } finally { restore(); }
});

test('an outcome reference that resolves to nothing is refused, not approximated', async () => {
  const { lookup, restore } = lookupOver(SHOP);
  try {
    const result = await lookup.outcome({ ref: 'Masque Or', basket: null });
    assert.equal(result.found, false);
  } finally { restore(); }
});

// --- named only if usable, ranked by use --------------------------------------

/** A lookup whose three reads — promotions, orders, collections — answer separately. */
function lookupOverTables({ promotions = [], orders = [], collections = [], products = [] }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const from = Number(String(init?.headers?.Range || '0-999').split('-')[0]);
    const path = String(url);
    const table = path.includes('/orders') ? orders : path.includes('/advice_collections') ? collections : path.includes('/products') ? products : promotions;
    const rows = from === 0 ? table : [];
    return { ok: true, status: 200, async json() { return rows; }, async text() { return JSON.stringify(rows); } };
  };
  const lookup = createPromotionLookup({ supabase: { baseUrl: 'https://example.test/rest/v1', key: 'k' }, shopId: 's1', logger: null });
  return { lookup, restore: () => { globalThis.fetch = originalFetch; } };
}

const PARTNER = { id: 'p40', title: 'LAPFAM26', method: 'code', status: 'ACTIVE', summary: '50% off', codes: [{ code: 'LAPFAM26' }], offerable_in_replies: false };
const GIFT_OR = {
  id: 'a40',
  title: 'Masque Or offert',
  method: 'automatic',
  discount_type: 'DiscountAutomaticBxgy',
  discount_classes: ['PRODUCT'],
  status: 'ACTIVE',
  summary: 'Spend €1.00, get 1 item free',
  codes: [],
  rule_snapshot: {
    customer_buys: { amount: '1.0', items: { scope: 'products', products: [{ id: 'gid://shopify/Product/1' }, { id: 'gid://shopify/Product/2' }] } },
    customer_gets: { percentage: 1, quantity: 1, items: { scope: 'products', products: [{ id: 'gid://shopify/Product/91' }] } }
  }
};
const MONODOSE = 'gid://shopify/Collection/474641695002';
const THREE_ONE = {
  ...GIFT_OR,
  id: 'a41',
  title: '3+1 Offert',
  summary: 'Buy 3 items, get 1 item free',
  rule_snapshot: {
    customer_buys: { quantity: '3', items: { scope: 'collections', collections: [{ id: MONODOSE }] } },
    customer_gets: { percentage: 1, quantity: 1, items: { scope: 'collections', collections: [{ id: MONODOSE }] } }
  }
};
const SHIP = {
  id: 'a42',
  title: 'Frais de port offerts',
  method: 'automatic',
  discount_type: 'DiscountAutomaticFreeShipping',
  discount_classes: ['SHIPPING'],
  status: 'ACTIVE',
  summary: 'Free shipping • Minimum purchase of €70.00',
  codes: [],
  rule_snapshot: { minimum_requirement: { type: 'subtotal', amount: '70.0' } }
};
const usedBy = (name, n) => Array.from({ length: n }, () => ({ discount_applications: [{ name }], discount_codes: [] }));

test('a code nobody cleared is counted, never named — partner rates stay out of the prompt', async () => {
  const { lookup, restore } = lookupOverTables({ promotions: [ACTIVE, PARTNER, SHIP] });
  try {
    const { promotions, withheld } = await lookup.listActive();
    assert.deepEqual(promotions.map((p) => p.title).sort(), ['Frais de port offerts', 'QIRINESS20']);
    assert.equal(withheld, 1);
    assert.ok(!JSON.stringify(promotions).includes('LAPFAM26'));
  } finally { restore(); }
});

test('the active list is ranked by orders in the last 30 days', async () => {
  const orders = [...usedBy('QIRINESS20', 2), ...usedBy('Frais de port offerts', 9)];
  const { lookup, restore } = lookupOverTables({ promotions: [ACTIVE, SHIP], orders });
  try {
    const { promotions } = await lookup.listActive();
    assert.deepEqual(promotions.map((p) => p.title), ['Frais de port offerts', 'QIRINESS20']);
    assert.equal(promotions[0].recentUses, 9);
  } finally { restore(); }
});

test('an automatic offer is « on » the products that earn it and the one it gives', async () => {
  const { lookup, restore } = lookupOverTables({ promotions: [GIFT_OR, SHIP] });
  try {
    const onBuy = await lookup.offersForProduct('gid://shopify/Product/2');
    assert.deepEqual(onBuy.specific.map((p) => p.title), ['Masque Or offert']);
    assert.equal(onBuy.specific[0].kind, 'automatic');
    assert.deepEqual(onBuy.general.map((p) => p.title), ['Frais de port offerts'], 'free shipping is about the order');

    const onGift = await lookup.offersForProduct('gid://shopify/Product/91');
    assert.deepEqual(onGift.specific.map((p) => p.title), ['Masque Or offert']);
  } finally { restore(); }
});

test('a collection-scoped offer needs the synced membership, and is ranked against the rest', async () => {
  const collections = [{ shopify_collection_id: MONODOSE, product_ids: ['gid://shopify/Product/50', 'gid://shopify/Product/2'], products_synced_at: '2026-10-01' }];
  const orders = [...usedBy('3+1 Offert', 7), ...usedBy('Masque Or offert', 61)];
  const { lookup, restore } = lookupOverTables({ promotions: [GIFT_OR, THREE_ONE], orders, collections });
  try {
    const { specific } = await lookup.offersForProduct('gid://shopify/Product/2');
    assert.deepEqual(specific.map((p) => p.title), ['Masque Or offert', '3+1 Offert'], 'most used first');
  } finally { restore(); }

  const unsynced = lookupOverTables({ promotions: [THREE_ONE] });
  try {
    const { specific, general } = await unsynced.lookup.offersForProduct('gid://shopify/Product/50');
    assert.equal(specific.length + general.length, 0, 'unknown membership is left out, not guessed');
  } finally { unsynced.restore(); }
});

test('an automatic offer switched off, or a code not cleared, is not offered on a product', async () => {
  const hidden = { ...GIFT_OR, describable_in_replies: false };
  const partnerOnProduct = { ...PARTNER, rule_snapshot: { customer_gets: { items: { scope: 'products', products: [{ id: 'gid://shopify/Product/2' }] } } } };
  const { lookup, restore } = lookupOverTables({ promotions: [hidden, partnerOnProduct] });
  try {
    const { specific, general } = await lookup.offersForProduct('gid://shopify/Product/2');
    assert.equal(specific.length + general.length, 0);
  } finally { restore(); }
});

// --- the free item's stock now ------------------------------------------------

const giftOrder = (lines) => ({ source: 'order', at: '2026-07-12T07:00:00Z', countryCode: 'FR', lines, applied: [], codes: [] });
const orLine = (id, price, paid = price) => ({ productId: `gid://shopify/Product/${id}`, title: `p${id}`, quantity: 1, price, paid });

test('a gift left out of the basket carries its stock now, so the reply knows whether it can be sent', async () => {
  const products = [{ shopify_product_id: 'gid://shopify/Product/91', title: "Masque Repulpant Wrap d'Or", status: 'active', available_stock: 907, deleted_at: null }];
  const { lookup, restore } = lookupOverTables({ promotions: [GIFT_OR], products });
  try {
    const result = await lookup.outcome({ ref: GIFT_OR.title, basket: giftOrder([orLine(1, 40)]) });
    assert.equal(result.outcome, 'reward_not_in_basket');
    assert.equal(result.reward.stock, 'in_stock');
    assert.match(result.promptText, /Stock actuel de l'article offert : « Masque Repulpant Wrap d'Or » en stock/);
  } finally { restore(); }
});

test('a gift at -1 or archived is not sendable, whatever the count says', async () => {
  for (const row of [{ status: 'active', available_stock: -1 }, { status: 'archived', available_stock: 50 }]) {
    const products = [{ shopify_product_id: 'gid://shopify/Product/91', title: "Wrap d'Or", deleted_at: null, ...row }];
    const { lookup, restore } = lookupOverTables({ promotions: [GIFT_OR], products });
    try {
      const result = await lookup.outcome({ ref: GIFT_OR.title, basket: giftOrder([orLine(1, 40)]) });
      assert.equal(result.reward.stock, 'out_of_stock', JSON.stringify(row));
      assert.match(result.promptText, /« Wrap d'Or » indisponible/);
    } finally { restore(); }
  }
});

test('an offer with no free item says nothing about stock; an unreadable product is unknown', async () => {
  const ship = await (async () => {
    const { lookup, restore } = lookupOverTables({ promotions: [SHIP] });
    try { return await lookup.outcome({ ref: SHIP.title, basket: giftOrder([orLine(1, 40)]) }); } finally { restore(); }
  })();
  assert.equal(ship.reward.stock, 'no_reward');
  assert.doesNotMatch(ship.promptText, /Stock actuel/);

  const { lookup, restore } = lookupOverTables({ promotions: [GIFT_OR], products: [] });
  try {
    const result = await lookup.outcome({ ref: GIFT_OR.title, basket: giftOrder([orLine(1, 40)]) });
    assert.equal(result.reward.stock, 'unknown');
    assert.match(result.promptText, /impossible à établir/);
  } finally { restore(); }
});
