// Why a discount code is not working — and, where the data allows it, whether a
// given customer is eligible for it.
//
// Pure: promotion row in, customer facts in, verdict out. No database, no clock
// of its own (`now` is injected so a "has it expired?" answer is testable).
//
// THE CENTRAL HONESTY PROBLEM. "Why doesn't my code work?" has maybe eight
// causes, and we can settle some of them outright and none of the others. The
// dangerous shape is a boolean: told `eligible: true`, a drafting agent will say
// "your code is valid, please try again" to someone whose basket is €20 below
// the minimum, and support has now confirmed a falsehood in writing. So every
// check reports pass / fail / unknown separately, and the overall verdict is
// three-valued. `unknown` is a first-class answer here, not a failure to
// compute — it is the signal to ask the customer rather than assert.

export const PASS = 'pass';
export const FAIL = 'fail';
export const UNKNOWN = 'unknown';

/**
 * Finds the promotion a customer is asking about.
 *
 * Codes are compared case- and space-insensitively because customers type
 * "qiriness10", "QIRINESS 10" and "Qiriness10" for one code. A near-miss is
 * returned separately as a suggestion rather than treated as a match: silently
 * resolving BIENVENUE10 to BIENVENU10 would answer confidently about the wrong
 * discount, and "did you mean…?" is the useful reply anyway.
 */
export function findPromotionByCode(code, promotions) {
  const wanted = normaliseCode(code);
  if (!wanted) {
    return { promotion: null, suggestions: [] };
  }

  const exact = promotions.find((p) => normaliseCode(p.code) === wanted);
  if (exact) {
    return { promotion: exact, suggestions: [] };
  }

  const suggestions = promotions
    .filter((p) => p.code)
    .map((p) => ({ promotion: p, distance: editDistance(wanted, normaliseCode(p.code)) }))
    // Within two edits of a code of reasonable length: catches a transposed or
    // dropped character without proposing an unrelated code.
    .filter((s) => s.distance <= 2 && Math.abs(s.promotion.code.length - wanted.length) <= 2)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((s) => s.promotion);

  return { promotion: null, suggestions };
}

export function normaliseCode(value) {
  return String(value || '').replace(/\s+/g, '').trim().toUpperCase();
}

/**
 * Every check we can make, each with its own verdict.
 *
 * `customer` is optional and may be partial — a ticket often has no identified
 * customer at all. An absent fact yields `unknown`, never `fail`: "we could not
 * confirm you are subscribed" and "you are not subscribed" are different
 * statements and only one of them is safe to put in a reply.
 */
export function evaluateEligibility({ promotion, customer = null, basket = null, now = new Date() } = {}) {
  if (!promotion) {
    return {
      verdict: 'not_found',
      checks: [check('exists', FAIL, "Ce code n'existe pas dans la boutique.")],
      blocking: ["Ce code n'existe pas dans la boutique."],
      unknowns: []
    };
  }

  const checks = [check('exists', PASS, `Code « ${promotion.code || promotion.title} » trouvé.`)];

  // --- things we can settle outright --------------------------------------
  const status = String(promotion.status || '').toUpperCase();
  if (status === 'ACTIVE') {
    checks.push(check('status', PASS, 'La promotion est active.'));
  } else if (status) {
    checks.push(check('status', FAIL, `La promotion n'est pas active (statut : ${status}).`));
  } else {
    checks.push(check('status', UNKNOWN, 'Statut de la promotion inconnu.'));
  }

  checks.push(evaluateWindow(promotion, now));
  checks.push(evaluateUsageLimit(promotion));
  checks.push(evaluateStacking(promotion));
  checks.push(evaluateOncePerCustomer(promotion));
  checks.push(evaluateNewsletter(promotion, customer));

  // --- rules we now know exactly, but cannot test against a basket ----------
  // The threshold and the eligible products ARE synced (see the promotion
  // mapper); what is missing is the basket to measure them against. So these
  // report the rule precisely — "il faut au moins 50 € de commande" is a usable
  // reply — while staying `unknown` about whether it is met.
  // Skipped entirely when a basket is available: `evaluateBasket` answers these
  // two for real, and emitting both would put "il faut au moins 50 €" in the
  // must-ask list beside "il manque 8 €" in the known list — the same rule
  // stated twice, once uselessly.
  const rules = promotion.rule_snapshot || {};
  if (!basket) {
    const minimum = describeMinimum(rules.minimum_requirement, rules.customer_buys);
    if (minimum) {
      checks.push(check('minimum_requirement', UNKNOWN, minimum));
    }

    const restriction = describeItemRestriction(rules.customer_gets);
    if (restriction) {
      checks.push(check('eligible_items', UNKNOWN, restriction));
    }
  }

  checks.push(evaluateCustomerSelection(rules.customer_selection));

  // --- the basket, if we managed to recover one -----------------------------
  // Without it these stay `unknown` and the reply has to ask. With it — from an
  // abandoned checkout — the same rules become real pass/fail answers, which is
  // the whole reason that lookup exists.
  checks.push(...evaluateBasket(promotion, basket));

  const blocking = checks.filter((c) => c.status === FAIL).map((c) => c.detail);
  const unknowns = checks.filter((c) => c.status === UNKNOWN).map((c) => c.detail);

  return {
    // `eligible` is never claimed outright while anything is unknown — the whole
    // point of the three-valued verdict.
    verdict: blocking.length > 0 ? 'blocked' : unknowns.length > 0 ? 'undetermined' : 'eligible',
    checks,
    blocking,
    unknowns
  };
}

function evaluateWindow(promotion, now) {
  const starts = promotion.starts_at ? new Date(promotion.starts_at) : null;
  const ends = promotion.ends_at ? new Date(promotion.ends_at) : null;

  if (starts && now < starts) {
    return check('window', FAIL, `La promotion ne commence que le ${formatDate(starts)}.`);
  }
  if (ends && now > ends) {
    return check('window', FAIL, `La promotion a expiré le ${formatDate(ends)}.`);
  }
  return check(
    'window',
    PASS,
    ends ? `Valable jusqu'au ${formatDate(ends)}.` : "Pas de date d'expiration."
  );
}

function evaluateUsageLimit(promotion) {
  const limit = promotion.usage_limit;
  if (limit === null || limit === undefined) {
    return check('usage_limit', PASS, "Pas de limite d'utilisation globale.");
  }
  const used = promotion.code_usage_count ?? promotion.discount_usage_count ?? 0;
  if (used >= limit) {
    return check('usage_limit', FAIL, `La limite d'utilisation est atteinte (${used}/${limit}).`);
  }
  return check('usage_limit', PASS, `Utilisations : ${used}/${limit}.`);
}

/**
 * Stacking. Reported as a rule, not as a verdict, because whether it *bites*
 * depends on what else is in the basket — which we cannot see. "This code
 * cannot be combined with another discount" is nonetheless the single most
 * useful sentence support can send about a rejected code.
 */
function evaluateStacking(promotion) {
  const combines = promotion.combines_with || {};
  const blocked = Object.entries({
    order_discounts: 'une remise sur commande',
    product_discounts: 'une remise produit',
    shipping_discounts: 'une remise livraison'
  })
    .filter(([key]) => combines[key] === false)
    .map(([, label]) => label);

  if (blocked.length === 0) {
    return check('stacking', PASS, "Ce code peut être cumulé avec d'autres remises.");
  }
  return check(
    'stacking',
    UNKNOWN,
    `Ce code ne peut pas être cumulé avec ${blocked.join(', ')}. ` +
      "S'il y a déjà une autre remise sur la commande, c'est la cause la plus probable."
  );
}

function evaluateOncePerCustomer(promotion) {
  if (!promotion.applies_once_per_customer) {
    return check('once_per_customer', PASS, 'Utilisable plusieurs fois par client.');
  }
  // The rule is known; whether THIS customer already used it is not — orders
  // store a discount total, never the codes applied.
  return check(
    'once_per_customer',
    UNKNOWN,
    "Ce code est limité à une utilisation par client. L'historique des codes utilisés " +
      "n'est pas synchronisé, donc une utilisation précédente ne peut pas être vérifiée."
  );
}

/**
 * The newsletter case, which is the biggest single promotions topic in the
 * corpus — 20 messages of "je suis inscrite à la newsletter pour bénéficier de
 * la remise mais…".
 *
 * Only claims anything when the customer is actually identified. `on_email_
 * marketing_list` is a generated column on `customers`, so this is a fact, not
 * an inference — but only for a customer we resolved.
 */
function evaluateNewsletter(promotion, customer) {
  const looksLikeWelcome = /welcome|bienvenue|newsletter|inscription/i.test(
    `${promotion.code || ''} ${promotion.title || ''} ${promotion.summary || ''}`
  );
  if (!looksLikeWelcome) {
    return check('newsletter', PASS, 'Pas de condition d’inscription à la newsletter.');
  }
  if (!customer) {
    return check(
      'newsletter',
      UNKNOWN,
      "Ce code semble lié à l'inscription newsletter, mais le client n'est pas identifié."
    );
  }
  if (customer.on_email_marketing_list === true) {
    return check('newsletter', PASS, 'Le client est bien inscrit à la newsletter.');
  }
  if (customer.on_email_marketing_list === false) {
    return check(
      'newsletter',
      FAIL,
      "Le client n'est pas inscrit à la newsletter, ce que ce code semble exiger."
    );
  }
  return check('newsletter', UNKNOWN, "Statut d'inscription newsletter inconnu.");
}

/**
 * The spend or quantity threshold, from either shape Shopify uses: a plain
 * minimum requirement, or the "customer buys" leg of a buy-X-get-Y discount.
 */
function describeMinimum(minimumRequirement, customerBuys) {
  if (minimumRequirement?.type === 'subtotal' && minimumRequirement.amount) {
    return `Cette promotion exige un minimum de ${formatMoney(minimumRequirement.amount, minimumRequirement.currency)} de commande.`;
  }
  if (minimumRequirement?.type === 'quantity' && minimumRequirement.quantity) {
    return `Cette promotion exige au moins ${minimumRequirement.quantity} article(s).`;
  }
  if (minimumRequirement?.type === 'unknown') {
    return 'Cette promotion a un minimum de commande, dont la valeur exacte est inconnue.';
  }
  if (customerBuys?.amount) {
    const scope = describeScope(customerBuys.items);
    return `Cette promotion exige un achat d'au moins ${formatMoney(customerBuys.amount)}${scope ? ` ${scope}` : ''}.`;
  }
  if (customerBuys?.quantity) {
    return `Cette promotion exige l'achat d'au moins ${customerBuys.quantity} article(s).`;
  }
  return null;
}

/**
 * Which products the discount actually applies to.
 *
 * This is the check the sync change unlocked, and on the real data it is the
 * useful one: UKLED20 applies only to the Masque LED, so "j'ai mis UKLED20 sur
 * ma crème et ça ne marche pas" now has a precise answer instead of a shrug.
 */
function describeItemRestriction(customerGets) {
  const scope = customerGets?.items;
  if (!scope || scope.scope === 'all') {
    return null;
  }
  if (scope.scope === 'products' && scope.products?.length) {
    const names = scope.products.map((p) => `« ${p.title} »`).join(', ');
    return `Ce code ne s'applique qu'à : ${names}. Il est sans effet sur les autres articles.`;
  }
  if (scope.scope === 'collections' && scope.collections?.length) {
    const names = scope.collections.map((c) => `« ${c.title} »`).join(', ');
    return `Ce code ne s'applique qu'aux produits de : ${names}.`;
  }
  return null;
}

/**
 * A code restricted to a customer segment is a real cause of "it works for my
 * friend but not for me", and nothing about it was stored before the sync
 * change. Segment membership itself is not synced, so this states the
 * restriction without claiming the customer is outside it.
 */
function evaluateCustomerSelection(selection) {
  if (!selection || selection.scope === 'all') {
    return check('customer_selection', PASS, 'Ouvert à tous les clients.');
  }
  if (selection.scope === 'segments') {
    const names = (selection.segments || []).map((s) => s.name).filter(Boolean).join(', ');
    return check(
      'customer_selection',
      UNKNOWN,
      `Ce code est réservé à un segment de clients${names ? ` (${names})` : ''}. ` +
        "L'appartenance au segment n'est pas vérifiable depuis le support."
    );
  }
  if (selection.scope === 'customers') {
    return check(
      'customer_selection',
      UNKNOWN,
      `Ce code est réservé à une liste de ${selection.customer_count ?? ''} client(s) nommés.`.replace('  ', ' ')
    );
  }
  return check('customer_selection', UNKNOWN, 'Restriction client inconnue.');
}

function formatMoney(amount, currency) {
  const value = Number(amount);
  const formatted = Number.isFinite(value) ? value.toFixed(2) : String(amount);
  return `${formatted} ${currency || 'EUR'}`;
}

function describeScope(items) {
  if (items?.scope === 'collections' && items.collections?.length) {
    return `dans « ${items.collections.map((c) => c.title).join(', ')} »`;
  }
  if (items?.scope === 'products' && items.products?.length) {
    return `sur « ${items.products.map((p) => p.title).join(', ')} »`;
  }
  return '';
}

function check(id, status, detail) {
  return { id, status, detail };
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

/** Levenshtein, capped in practice by the length guard at the call site. */
function editDistance(a, b) {
  if (a === b) return 0;
  const rows = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = rows[0];
    rows[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = rows[j];
      rows[j] = Math.min(
        rows[j] + 1,
        rows[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      previous = temp;
    }
  }
  return rows[b.length];
}

/**
 * The checks that only become answerable once a basket is in hand.
 *
 * Recovered from an abandoned checkout, so it is what the customer had at
 * checkout — not necessarily what they have now. That distinction is stated in
 * the wording rather than hidden, because a reply that says "votre panier est à
 * 42 €" about a basket from last Tuesday is wrong in a way the customer will
 * notice.
 *
 * WITHOUT A BASKET these are `unknown`, exactly as before. Nothing about the
 * three-valued verdict changes; the basket simply moves some checks off the
 * "must ask" list and onto the "we know" list.
 */
function evaluateBasket(promotion, basket) {
  if (!basket) {
    return [
      check(
        'basket',
        UNKNOWN,
        "Le contenu du panier n'est pas visible depuis le support : il faut demander au " +
          'client ce qu’il contient pour confirmer.'
      )
    ];
  }

  const rules = promotion.rule_snapshot || {};
  // `updatedAt`, not `createdAt`: the record is mutated in place as the shopper
  // edits, so the creation time can be long before the contents we are holding.
  const asOf = basket.updatedAt || basket.createdAt;
  const when = asOf ? ` (panier abandonné, état du ${String(asOf).slice(0, 10)})` : '';
  const results = [
    check(
      'basket',
      PASS,
      `Panier retrouvé${when} : ${basket.lineItems.length} article(s), sous-total ` +
        `${formatMoney(basket.subtotal, basket.currency)}.`
    )
  ];

  // Was the code even applied? Its absence is not proof of anything — Shopify
  // records applied codes, and a rejected one may simply never appear — so this
  // reports rather than concludes.
  const codes = (basket.discountCodes || []).map(normaliseCode);
  const wanted = normaliseCode(promotion.code);
  if (wanted && codes.length > 0) {
    results.push(
      codes.includes(wanted)
        ? check('code_applied', PASS, 'Le code était bien appliqué sur ce panier.')
        : check(
            'code_applied',
            UNKNOWN,
            `Le panier portait ${codes.map((c) => `« ${c} »`).join(', ')} et non « ${wanted} ».`
          )
    );
  }

  // Minimum spend, now measurable.
  const minimum = rules.minimum_requirement;
  const buysAmount = rules.customer_buys?.amount;
  const threshold = minimum?.type === 'subtotal' ? Number(minimum.amount) : Number(buysAmount);
  // Measured BEFORE the discount, which is not the same number as `subtotal`:
  // Shopify reports `subtotalPriceSet` net of any code already applied, and
  // comparing that against a threshold would tell a qualifying customer they
  // are short. See abandoned-checkout.mjs.
  const measured = Number.isFinite(basket.subtotalBeforeDiscount)
    ? basket.subtotalBeforeDiscount
    : basket.subtotal;
  if (Number.isFinite(threshold) && Number.isFinite(measured)) {
    if (measured >= threshold) {
      results.push(
        check('minimum_requirement', PASS, `Le minimum de ${formatMoney(threshold, basket.currency)} est atteint.`)
      );
    } else {
      const missing = threshold - measured;
      results.push(
        check(
          'minimum_requirement',
          FAIL,
          `Le panier est à ${formatMoney(measured, basket.currency)} (avant remise) pour un minimum de ` +
            `${formatMoney(threshold, basket.currency)} : il manque ${formatMoney(missing, basket.currency)}.`
        )
      );
    }
  }

  // Minimum quantity, likewise.
  if (minimum?.type === 'quantity' && Number.isFinite(Number(minimum.quantity))) {
    const total = basket.lineItems.reduce((n, item) => n + (item.quantity || 0), 0);
    const needed = Number(minimum.quantity);
    results.push(
      total >= needed
        ? check('minimum_requirement', PASS, `${total} article(s) pour un minimum de ${needed}.`)
        : check('minimum_requirement', FAIL, `Le panier contient ${total} article(s) pour un minimum de ${needed}.`)
    );
  }

  // Eligible products — the check the sync change unlocked, now decidable.
  const eligible = rules.customer_gets?.items;
  if (eligible?.scope === 'products' && eligible.products?.length) {
    const wantedIds = new Set(eligible.products.map((p) => p.id).filter(Boolean));
    const wantedTitles = eligible.products.map((p) => p.title);
    const present = basket.lineItems.some(
      (item) => wantedIds.has(item.productId) || wantedTitles.includes(item.productTitle)
    );
    results.push(
      present
        ? check('eligible_items', PASS, "Le panier contient bien un produit éligible à ce code.")
        : check(
            'eligible_items',
            FAIL,
            `Le panier ne contient aucun produit éligible. Ce code ne s'applique qu'à : ` +
              `${wantedTitles.map((t) => `« ${t} »`).join(', ')}.`
          )
    );
  }

  return results;
}
