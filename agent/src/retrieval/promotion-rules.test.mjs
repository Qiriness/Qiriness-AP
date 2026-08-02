import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAIL,
  PASS,
  UNKNOWN,
  evaluateEligibility,
  findPromotionByCode,
  normaliseCode
} from './promotion-rules.mjs';

// Modelled on the three real discounts in the store.
const QIRINESS10 = {
  code: 'QIRINESS10',
  title: 'QIRINESS10',
  status: 'ACTIVE',
  summary: '10% off entire order • One use per customer',
  starts_at: '2026-07-14T09:17:00Z',
  ends_at: null,
  usage_limit: null,
  code_usage_count: 0,
  applies_once_per_customer: true,
  combines_with: { order_discounts: true, product_discounts: true, shipping_discounts: true },
  rule_snapshot: {}
};

const UKLED20 = {
  code: 'UKLED20',
  title: 'UKLED20',
  status: 'ACTIVE',
  starts_at: '2026-07-14T09:19:10Z',
  ends_at: null,
  usage_limit: null,
  code_usage_count: 0,
  applies_once_per_customer: false,
  // The real row: this one stacks with nothing.
  combines_with: { order_discounts: false, product_discounts: false, shipping_discounts: false },
  rule_snapshot: {}
};

const NOW = new Date('2026-08-01T12:00:00Z');
const statusOf = (result, id) => result.checks.find((c) => c.id === id)?.status;

test('codes match however the customer types them', () => {
  const list = [QIRINESS10];
  for (const typed of ['qiriness10', 'QIRINESS 10', ' Qiriness10 ']) {
    assert.equal(findPromotionByCode(typed, list).promotion, QIRINESS10, typed);
  }
  assert.equal(normaliseCode(' qir 10 '), 'QIR10');
});

test('a near miss is a suggestion, never a silent match', () => {
  // Resolving BIENVENU10 to BIENVENUE10 would answer confidently about a
  // different discount. "Did you mean…?" is the useful reply anyway.
  const result = findPromotionByCode('QIRINES10', [QIRINESS10, UKLED20]);
  assert.equal(result.promotion, null);
  assert.deepEqual(result.suggestions.map((p) => p.code), ['QIRINESS10']);
});

test('an unrelated code suggests nothing', () => {
  assert.deepEqual(findPromotionByCode('SOLDES2026', [QIRINESS10, UKLED20]).suggestions, []);
});

test('a code that does not exist is reported as such', () => {
  const r = evaluateEligibility({ promotion: null, now: NOW });
  assert.equal(r.verdict, 'not_found');
  assert.equal(statusOf(r, 'exists'), FAIL);
});

// --- what we can settle outright --------------------------------------------

test('an expired promotion is a definite blocking cause', () => {
  const r = evaluateEligibility({
    promotion: { ...QIRINESS10, ends_at: '2026-07-20T00:00:00Z' },
    now: NOW
  });
  assert.equal(statusOf(r, 'window'), FAIL);
  assert.equal(r.verdict, 'blocked');
  assert.match(r.blocking[0], /expiré le 2026-07-20/);
});

test('a promotion that has not started yet is blocking', () => {
  const r = evaluateEligibility({
    promotion: { ...QIRINESS10, starts_at: '2026-09-01T00:00:00Z' },
    now: NOW
  });
  assert.equal(statusOf(r, 'window'), FAIL);
});

test('an exhausted usage limit is blocking, and says the numbers', () => {
  const r = evaluateEligibility({
    promotion: { ...QIRINESS10, usage_limit: 100, code_usage_count: 100 },
    now: NOW
  });
  assert.equal(statusOf(r, 'usage_limit'), FAIL);
  assert.match(r.blocking.join(' '), /100\/100/);
});

test('an inactive promotion is blocking', () => {
  const r = evaluateEligibility({ promotion: { ...QIRINESS10, status: 'EXPIRED' }, now: NOW });
  assert.equal(statusOf(r, 'status'), FAIL);
});

// --- what we can only state, not verify --------------------------------------

test('a non-stackable code is reported as a likely cause, not a proven one', () => {
  // Whether it bites depends on what else is in the basket, which we cannot see.
  const r = evaluateEligibility({ promotion: UKLED20, now: NOW });
  assert.equal(statusOf(r, 'stacking'), UNKNOWN);
  assert.match(r.unknowns.join(' '), /ne peut pas être cumulé/);
  assert.equal(r.verdict, 'undetermined', 'never "eligible" while this is open');
});

test('a stackable code passes the stacking check outright', () => {
  const r = evaluateEligibility({ promotion: QIRINESS10, now: NOW });
  assert.equal(statusOf(r, 'stacking'), PASS);
});

test('once-per-customer is stated as a rule but never verified', () => {
  // Orders store a discount total, never the codes applied.
  const r = evaluateEligibility({ promotion: QIRINESS10, now: NOW });
  assert.equal(statusOf(r, 'once_per_customer'), UNKNOWN);
});

test('the basket is always reported as unseeable, never silently omitted', () => {
  // A check missing from the list reads as "fine", and this is one of the two
  // most common real causes.
  const r = evaluateEligibility({ promotion: QIRINESS10, now: NOW });
  assert.equal(statusOf(r, 'basket'), UNKNOWN);
});

test('a minimum spend is stated with its actual value', () => {
  // Before the sync change this could only say "there is a minimum". The
  // threshold is what makes the sentence usable in a reply.
  const r = evaluateEligibility({
    promotion: {
      ...QIRINESS10,
      rule_snapshot: { minimum_requirement: { type: 'subtotal', amount: '50.0', currency: 'EUR' } }
    },
    now: NOW
  });
  assert.equal(statusOf(r, 'minimum_requirement'), UNKNOWN, 'stated, not verified');
  assert.match(r.unknowns.join(' '), /minimum de 50\.00 EUR/);
});

test('a buy-X-get-Y threshold is stated with its scope', () => {
  // The real WRAP-V row: spend 6500 across a collection, get an item free.
  const r = evaluateEligibility({
    promotion: {
      ...QIRINESS10,
      rule_snapshot: {
        customer_buys: { amount: '6500.0', items: { scope: 'collections', collections: [{ title: 'Tous les produits' }] } }
      }
    },
    now: NOW
  });
  assert.match(r.unknowns.join(' '), /6500\.00 EUR dans « Tous les produits »/);
});

test('a product-restricted code names the products it applies to', () => {
  // The real UKLED20 row, and the check the sync change unlocked: "j'ai mis
  // UKLED20 sur ma crème" now has a precise answer instead of a shrug.
  const r = evaluateEligibility({
    promotion: {
      ...QIRINESS10,
      rule_snapshot: {
        customer_gets: { items: { scope: 'products', products: [{ title: 'Masque LED Visage Éclat & Régénération' }] } }
      }
    },
    now: NOW
  });
  assert.equal(statusOf(r, 'eligible_items'), UNKNOWN);
  assert.match(r.unknowns.join(' '), /ne s'applique qu'à : « Masque LED/);
});

test('a code open to everyone raises no customer restriction', () => {
  const r = evaluateEligibility({
    promotion: { ...QIRINESS10, rule_snapshot: { customer_selection: { scope: 'all' } } },
    now: NOW
  });
  assert.equal(statusOf(r, 'customer_selection'), PASS);
});

test('a segment-restricted code is stated without accusing the customer', () => {
  // Segment membership is not synced. "Reserved for a segment" is true;
  // "you are not in it" would not be.
  const r = evaluateEligibility({
    promotion: {
      ...QIRINESS10,
      rule_snapshot: { customer_selection: { scope: 'segments', segments: [{ name: 'VIP' }] } }
    },
    now: NOW
  });
  assert.equal(statusOf(r, 'customer_selection'), UNKNOWN);
  assert.match(r.unknowns.join(' '), /réservé à un segment de clients \(VIP\)/);
});

// --- the newsletter case, the biggest single topic in the corpus -------------

const WELCOME = { ...QIRINESS10, code: 'BIENVENUE10', title: 'Code de bienvenue newsletter' };

test('a subscribed customer passes the newsletter check', () => {
  const r = evaluateEligibility({
    promotion: WELCOME,
    customer: { on_email_marketing_list: true },
    now: NOW
  });
  assert.equal(statusOf(r, 'newsletter'), PASS);
});

test('an unsubscribed customer is a definite blocking cause', () => {
  const r = evaluateEligibility({
    promotion: WELCOME,
    customer: { on_email_marketing_list: false },
    now: NOW
  });
  assert.equal(statusOf(r, 'newsletter'), FAIL);
  assert.equal(r.verdict, 'blocked');
});

test('an unidentified customer yields unknown, never "not subscribed"', () => {
  // "We could not confirm you are subscribed" and "you are not subscribed" are
  // different statements, and only one is safe to send.
  const r = evaluateEligibility({ promotion: WELCOME, customer: null, now: NOW });
  assert.equal(statusOf(r, 'newsletter'), UNKNOWN);
});

test('a code unrelated to the newsletter does not raise the question at all', () => {
  const r = evaluateEligibility({ promotion: UKLED20, customer: null, now: NOW });
  assert.equal(statusOf(r, 'newsletter'), PASS);
});

// --- the verdict --------------------------------------------------------------

test('eligible is never claimed while anything is unknown', () => {
  // The failure this prevents: telling someone "your code is valid, try again"
  // when their basket is below a minimum we cannot see.
  const r = evaluateEligibility({ promotion: QIRINESS10, now: NOW });
  assert.notEqual(r.verdict, 'eligible');
  assert.ok(r.unknowns.length > 0);
});

test('a blocking cause outranks any number of unknowns', () => {
  const r = evaluateEligibility({
    promotion: { ...UKLED20, ends_at: '2026-07-20T00:00:00Z' },
    now: NOW
  });
  assert.equal(r.verdict, 'blocked');
});

// --- with a recovered basket -------------------------------------------------

const BASKET = {
  createdAt: '2026-07-30T10:00:00Z',
  currency: 'EUR',
  subtotal: 42,
  discountCodes: [],
  lineItems: [
    { productId: 'gid://shopify/Product/1', productTitle: 'Crème Mains Velours', quantity: 1 }
  ]
};

const MIN_50 = {
  ...QIRINESS10,
  rule_snapshot: { minimum_requirement: { type: 'subtotal', amount: '50.0', currency: 'EUR' } }
};

test('a basket turns the minimum-spend rule into a real answer', () => {
  // This is what the abandoned-checkout lookup is for: the same rule, decided.
  const r = evaluateEligibility({ promotion: MIN_50, basket: BASKET, now: NOW });
  assert.equal(statusOf(r, 'minimum_requirement'), FAIL);
  assert.match(r.blocking.join(' '), /il manque 8\.00 EUR/);
  assert.equal(r.verdict, 'blocked');
});

test('a sufficient basket passes the same check', () => {
  const r = evaluateEligibility({ promotion: MIN_50, basket: { ...BASKET, subtotal: 80 }, now: NOW });
  assert.equal(statusOf(r, 'minimum_requirement'), PASS);
});

test('the rule is never stated twice when a basket decided it', () => {
  // Otherwise "il faut au moins 50 €" sits in the must-ask list beside
  // "il manque 8 €" in the known list — the same rule, once uselessly.
  const r = evaluateEligibility({ promotion: MIN_50, basket: BASKET, now: NOW });
  assert.equal(r.checks.filter((c) => c.id === 'minimum_requirement').length, 1);
});

test('a basket decides whether an eligible product is present', () => {
  const restricted = {
    ...QIRINESS10,
    rule_snapshot: {
      customer_gets: { items: { scope: 'products', products: [{ id: 'gid://shopify/Product/99', title: 'Masque LED' }] } }
    }
  };
  const absent = evaluateEligibility({ promotion: restricted, basket: BASKET, now: NOW });
  assert.equal(statusOf(absent, 'eligible_items'), FAIL);
  assert.match(absent.blocking.join(' '), /aucun produit éligible/);

  const present = evaluateEligibility({
    promotion: restricted,
    basket: { ...BASKET, lineItems: [{ productId: 'gid://shopify/Product/99', productTitle: 'Masque LED', quantity: 1 }] },
    now: NOW
  });
  assert.equal(statusOf(present, 'eligible_items'), PASS);
});

test('the basket check reports what was found and when', () => {
  // "Votre panier est à 42 €" about a basket from last Tuesday is wrong in a
  // way the customer will notice, so the date is part of the sentence.
  const r = evaluateEligibility({ promotion: QIRINESS10, basket: BASKET, now: NOW });
  assert.equal(statusOf(r, 'basket'), PASS);
  assert.match(r.checks.find((c) => c.id === 'basket').detail, /état du 2026-07-30/);
});

test('a code absent from the basket is reported, not concluded from', () => {
  // Shopify records APPLIED codes; a rejected one may simply never appear.
  const r = evaluateEligibility({
    promotion: QIRINESS10,
    basket: { ...BASKET, discountCodes: ['UKLED20'] },
    now: NOW
  });
  assert.equal(statusOf(r, 'code_applied'), UNKNOWN);
  assert.match(r.unknowns.join(' '), /« UKLED20 » et non « QIRINESS10 »/);
});

test('without a basket nothing changes', () => {
  const r = evaluateEligibility({ promotion: MIN_50, now: NOW });
  assert.equal(statusOf(r, 'basket'), UNKNOWN);
  assert.equal(statusOf(r, 'minimum_requirement'), UNKNOWN);
});

test('the minimum is measured before the discount, not after', () => {
  // The live bug this covers: a 244.30 basket with a 24.43 discount reports a
  // 219.87 subtotal. Against a 240 minimum the customer qualifies, and using
  // the net figure would have told them they were 20 € short.
  const promotion = {
    ...QIRINESS10,
    rule_snapshot: { minimum_requirement: { type: 'subtotal', amount: '240.0', currency: 'EUR' } }
  };
  const r = evaluateEligibility({
    promotion,
    basket: { ...BASKET, subtotal: 219.87, subtotalBeforeDiscount: 244.3, currency: 'EUR' },
    now: NOW
  });
  assert.equal(statusOf(r, 'minimum_requirement'), PASS);
});

test('a genuinely short basket still fails, and says "avant remise"', () => {
  const promotion = {
    ...QIRINESS10,
    rule_snapshot: { minimum_requirement: { type: 'subtotal', amount: '300.0', currency: 'EUR' } }
  };
  const r = evaluateEligibility({
    promotion,
    basket: { ...BASKET, subtotal: 219.87, subtotalBeforeDiscount: 244.3, currency: 'EUR' },
    now: NOW
  });
  assert.equal(statusOf(r, 'minimum_requirement'), FAIL);
  assert.match(r.blocking.join(' '), /244\.30 EUR \(avant remise\).*il manque 55\.70 EUR/);
});

test('the basket is dated from updatedAt, not the session start', () => {
  // Shopify mutates the record in place, so createdAt can be long before the
  // contents in hand.
  const r = evaluateEligibility({
    promotion: QIRINESS10,
    basket: { ...BASKET, createdAt: '2026-07-30T10:00:00Z', updatedAt: '2026-08-01T18:57:00Z' },
    now: NOW
  });
  assert.match(r.checks.find((c) => c.id === 'basket').detail, /état du 2026-08-01/);
});
