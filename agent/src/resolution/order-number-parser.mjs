// Pulls candidate order numbers out of a customer's email.
//
// Pure: text in, candidates out. No database, no judgement about whether the
// order exists — that is the resolver's job.
//
// WHAT THE CORPUS ACTUALLY CONTAINS, counted over every inbound message:
//   1152  `#4854`, `#6216`            -> Shopify web orders
//    225  `commande n° 3985`          -> the same numbers, written out
//    911  `Q00 26200111`              -> NOT a Shopify order number
//      2  `CL 59088`
//     73  `FA015974`, `DS251105`      -> invoice and shipment references
//
// The `Q00` family is the surprise and the reason this module classifies rather
// than just extracts. Those are internal/ERP references, overwhelmingly from
// staff threads, and they will never be found in `orders`. Silently failing to
// match one looks identical to "we could not find your order"; naming the format
// lets the caller say "that is an internal reference, could you give us the
// number beginning with #" instead.
//
// This module decides only what LOOKS like an order reference. Whether it IS one
// is settled by looking it up — see order-resolution-runner.mjs.

// NO UPPER BOUND WORTH TRUSTING, and this matters. Shopify order numbers start
// at four digits and keep counting as a store sells more, so any tight cap is a
// time bomb: `{3,6}` would silently stop parsing the day the store passed
// 999,999 orders, and the failure would read as "we cannot find your order"
// rather than as a bug. Length is not evidence — WHETHER A NUMBER IS AN ORDER IS
// DECIDED BY THE DATABASE. Ten digits is a sanity ceiling against swallowing a
// phone number, not a claim about how big an order number can get.
const PATTERNS = [
  // `#4854`, `# 4854`. The hash prefix is the signal, not the length.
  { format: 'web', regex: /#\s?(\d{3,10})\b/g, take: 1 },
  // `commande n° 3985`, `commande 5281`, `order 4687`.
  { format: 'web', regex: /\b(?:commande|order)\s+(?:n[°ºo]\s*)?(\d{3,10})\b/gi, take: 1 },
  // `Q00 26200111`, `Q0026200111` — internal reference, never a Shopify order.
  { format: 'internal_erp', regex: /\bQ0{0,2}\s?(\d{6,})\b/gi, take: 0 },
  { format: 'internal_other', regex: /\b(?:CL|FA|DS|WW)\s?\d{4,}\b/gi, take: 0 }
];

/**
 * Every distinct candidate, in the order first seen.
 *
 * A BARE NUMBER IS NEVER A CANDIDATE. French support mail is full of numbers
 * that are not orders — years, postcodes, prices, phone fragments, « 2x50ml ».
 * Requiring `#` or the word `commande` is the one heuristic kept, because it is
 * about *intent to name an order* rather than about the number's shape.
 *
 * Everything else is left to the lookup. A candidate that is not a real order
 * simply does not match, and a candidate that coincidentally matches somebody
 * else's order is caught by the email-hash check and never written — so being
 * generous here costs a wasted lookup, not a wrong answer.
 */
export function parseOrderCandidates(text) {
  const source = String(text || '');
  const seen = new Set();
  const candidates = [];

  for (const { format, regex, take } of PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(source)) !== null) {
      const raw = match[0].trim();
      const number = take === 1 ? Number(match[1]) : null;
      const key = `${format}:${number ?? raw.toUpperCase().replace(/\s+/g, '')}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({
        raw,
        format,
        orderNumber: Number.isFinite(number) ? number : null,
        index: match.index
      });
    }
  }

  return candidates.sort((a, b) => a.index - b.index).map(({ index, ...rest }) => rest);
}

/** The Shopify-looking candidates only, which are the ones worth a lookup. */
export function shopifyOrderCandidates(text) {
  return parseOrderCandidates(text).filter((c) => c.format === 'web' && c.orderNumber !== null);
}

/**
 * `orders.name` is the display form (`#1006`) while `order_number` is the
 * integer. Callers write the display form to the ticket, so it is built here
 * rather than string-concatenated at four call sites.
 */
export function toOrderName(orderNumber) {
  return Number.isFinite(orderNumber) ? `#${orderNumber}` : null;
}
