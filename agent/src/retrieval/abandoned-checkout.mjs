import { shopifyGraphql } from '../../../scripts/lib/shopify-admin-client.mjs';

// Recovers the basket a customer abandoned at checkout — the only view we ever
// get of what someone was actually trying to buy.
//
// WHY THIS EXISTS. "Pourquoi mon code ne marche pas ?" is unanswerable without
// the basket, and carts are not synced and not exposed by the Admin API. An
// abandoned checkout is the one exception: it is a real, queryable record of the
// line items, the subtotal and any applied discount codes. It closes the gap for
// the subset of customers who reached checkout, which is most of the people who
// were trying to apply a code.
//
// LIVE, NOT SYNCED, and deliberately so. This is a per-ticket lookup for one
// identified customer, not a table we mirror: abandoned checkouts are transient,
// carry a full basket and both addresses, and syncing them wholesale would mean
// storing the shopping habits of every customer who ever bounced. Fetched when a
// specific question needs it, kept in memory, never written.
//
// VALIDATED against a real abandoned checkout 2026-08-01, which corrected two
// assumptions: `subtotalPriceSet` is net of discount, and the record is mutated
// in place rather than re-created. See VALIDATION_LOG.md for what is still open.
//
// WHEN A RECORD EXISTS AT ALL: Shopify creates one once the shopper has entered
// their email and then left the basket unattended for roughly ten minutes. A
// shopper who never got that far leaves no trace — but that is also the
// population that could not have been trying a code, so the overlap with the
// question this serves is favourable.

const CHECKOUT_FIELDS = `#graphql
  id
  name
  createdAt
  updatedAt
  abandonedCheckoutUrl
  discountCodes
  customer {
    id
    email
  }
  subtotalPriceSet { shopMoney { amount currencyCode } }
  totalPriceSet { shopMoney { amount currencyCode } }
  totalDiscountSet { shopMoney { amount currencyCode } }
  lineItems(first: 50) {
    nodes {
      title
      variantTitle
      quantity
      sku
      product { id title }
      originalTotalPriceSet { shopMoney { amount } }
      discountedTotalPriceWithCodeDiscount { shopMoney { amount } }
    }
  }
`;

const QUERY = `#graphql
  query AbandonedCheckouts($first: Int!, $after: String, $query: String) {
    abandonedCheckouts(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes { ${CHECKOUT_FIELDS} }
    }
  }
`;

/**
 * Builds the `query:` filter.
 *
 * DATE WINDOW, NOT AN EMAIL FILTER — and this is the part that surprised me.
 * `abandonedCheckouts(query:)` supports only `default` (a free-text search of
 * unspecified fields), `created_at`, `email_state`, `id`, `recovery_state`,
 * `status` and `updated_at`. There is no documented email key. Filtering by a
 * date range and matching the email client-side is therefore the only
 * *deterministic* approach; free-text search on an address might work and might
 * silently match nothing, and with zero rows in the dev store that could not be
 * told apart. If the free-text path is confirmed later it becomes an
 * optimisation, not a correctness fix.
 */
export function buildCheckoutQuery({ since, until } = {}) {
  const terms = [];
  if (since) {
    terms.push(`created_at:>=${toDay(since)}`);
  }
  if (until) {
    terms.push(`created_at:<=${toDay(until)}`);
  }
  return terms.join(' ') || null;
}

/**
 * Normalises a checkout into the shape the promotion checks consume.
 *
 * Addresses are deliberately dropped. The question is "what was in the basket
 * and what did it cost" — a street address answers neither, and this data is
 * fetched live into an AI-adjacent path where the less personal data present the
 * better.
 */
export function normaliseCheckout(node) {
  if (!node) {
    return null;
  }
  return {
    id: node.id,
    name: node.name || null,
    createdAt: node.createdAt || null,
    // WHEN THE BASKET WE ARE LOOKING AT WAS ACTUALLY TRUE. Shopify keeps ONE
    // abandoned-checkout record per checkout session and mutates it: observed
    // live, the same id went from ["QIRINESS10"] / 1 item / 219.87 to [] /
    // 2 items / 82.25 with `createdAt` unchanged and only `updatedAt` moving.
    // So the record is a current snapshot, not a log of the attempt — dating a
    // reply from `createdAt` would put the session's start time next to
    // contents from twenty minutes later.
    updatedAt: node.updatedAt || null,
    recoveryUrl: node.abandonedCheckoutUrl || null,
    email: node.customer?.email || null,
    customerId: node.customer?.id || null,
    discountCodes: Array.isArray(node.discountCodes) ? node.discountCodes : [],
    subtotal: money(node.subtotalPriceSet),
    total: money(node.totalPriceSet),
    totalDiscount: money(node.totalDiscountSet),
    // THE NUMBER MINIMUM REQUIREMENTS ARE MEASURED AGAINST, and not the same as
    // `subtotal`. Measured on a real abandoned checkout: line items totalled
    // 244.30, totalDiscount was 24.43, and `subtotalPriceSet` came back 219.87 —
    // i.e. already net of the discount. Comparing that against a threshold would
    // tell a customer whose basket qualifies that they are 20 € short, which is
    // exactly the confident falsehood this whole tool exists to avoid. Shopify
    // evaluates the requirement before the discount, so we reconstruct it.
    subtotalBeforeDiscount: beforeDiscount(node),
    currency: node.subtotalPriceSet?.shopMoney?.currencyCode || null,
    lineItems: (node.lineItems?.nodes || []).map((item) => ({
      title: item.title,
      variantTitle: item.variantTitle || null,
      quantity: item.quantity ?? null,
      sku: item.sku || null,
      productId: item.product?.id || null,
      productTitle: item.product?.title || item.title,
      originalTotal: money(item.originalTotalPriceSet),
      discountedTotal: money(item.discountedTotalPriceWithCodeDiscount)
    }))
  };
}

/**
 * Most recent abandoned checkout for an email inside a time window.
 *
 * Matching is on the email, case-insensitively, after fetching the window —
 * see `buildCheckoutQuery` for why the filter cannot do it. `maxPages` bounds
 * the cost: a wide window on a busy store is a lot of pages, and a support
 * lookup should not be able to walk the entire history.
 */
export function createAbandonedCheckoutLookup({ shopify, logger }) {
  return async function findAbandonedCheckout({
    email,
    since,
    until = new Date(),
    pageSize = 50,
    maxPages = 6
  } = {}) {
    const wanted = String(email || '').trim().toLowerCase();
    if (!wanted) {
      return { found: false, reason: 'no_email', checkout: null };
    }

    const query = buildCheckoutQuery({ since, until });
    let after = null;
    let scanned = 0;

    for (let page = 0; page < maxPages; page += 1) {
      const result = await shopifyGraphql(shopify, QUERY, { first: pageSize, after, query });
      const connection = result?.abandonedCheckouts;
      const nodes = connection?.nodes || [];
      scanned += nodes.length;

      const hit = nodes.find((node) => (node.customer?.email || '').trim().toLowerCase() === wanted);
      if (hit) {
        logger?.info?.('checkout.found', { scanned, pages: page + 1 });
        // Sorted newest first, so the first match is the latest attempt — the
        // one the customer is almost certainly writing about.
        return { found: true, checkout: normaliseCheckout(hit), scanned };
      }

      if (!connection?.pageInfo?.hasNextPage) {
        break;
      }
      after = connection.pageInfo.endCursor;
    }

    logger?.info?.('checkout.not_found', { scanned });
    return { found: false, reason: scanned === 0 ? 'none_in_window' : 'no_match', checkout: null, scanned };
  };
}

function money(set) {
  const amount = set?.shopMoney?.amount;
  return amount === undefined || amount === null ? null : Number(amount);
}

/**
 * Basket value before any discount.
 *
 * Summing the line items' original totals is preferred over `subtotal +
 * totalDiscount`: it is what Shopify itself measures, and it stays right when a
 * discount applies to shipping rather than the goods. The addition is the
 * fallback for a checkout whose line items did not come back.
 */
function beforeDiscount(node) {
  const items = node.lineItems?.nodes || [];
  const summed = items.reduce((total, item) => {
    const value = money(item.originalTotalPriceSet);
    return value === null ? total : total + value;
  }, 0);
  if (items.length > 0 && summed > 0) {
    return summed;
  }
  const subtotal = money(node.subtotalPriceSet);
  const discount = money(node.totalDiscountSet);
  if (subtotal === null) {
    return null;
  }
  return discount === null ? subtotal : subtotal + discount;
}

function toDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}
