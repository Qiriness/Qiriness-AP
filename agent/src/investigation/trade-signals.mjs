// Is the person writing a trade customer rather than a consumer?
//
// WHY THIS IS NOT A CATEGORY. « Comment obtenir la facture définitive » IS a
// payment question, and a pharmacy asking it is asking the same question a
// consumer would. The subject is right; what was missing is WHO is asking. So
// this is a fact on the findings axis, next to `customer_account_state` — never
// a re-categorisation, which would file a trade invoice request alongside
// supplier dunning and lose what it was about.
//
// MEASURED ON THE CORPUS. Four trade tickets were categorised `payment` or
// `promotions`: a pharmacy and a company asking for invoice duplicates, an
// invoice reminder, and a €1,901.93 « facture définitive » request against an
// order Shopify has never seen. All four are caught by the two signals below;
// no consumer ticket trips either.
//
// Pure: no database, no model, no clock.

/**
 * Amounts written as money in a French message.
 *
 * THE PARSING IS THE HARD PART, and it produced two wrong answers before this
 * one. French writes « 1 901,93 » while the ERP exports in these mailboxes write
 * « 1605.71 », so neither separator can be assumed: reading `.` as thousands
 * turned €1,605.71 into €160,571, and a stricter pattern then matched nothing at
 * all. The decimal mark is therefore decided per-amount, from a separator
 * followed by exactly two digits at the end.
 *
 * PLAUSIBILITY IS PART OF PARSING, NOT A CALLER'S PROBLEM. « 8829,6201 » is two
 * reference numbers with a comma between them, and read as money it invents an
 * €8,829.62 order. An amount with more than two decimals, or above
 * `MAX_PLAUSIBLE`, is not money somebody typed about their order.
 */
//
// A LOOKBEHIND, BECAUSE THE FIRST VERSION READ ACROSS A DATE. « 06/08 1605.71€ »
// matched `8 1605.71` — the space was a thousands separator, so the pattern
// reached back into the date and produced €81,605.71. An amount may not begin
// immediately after a digit or a separator.
//
// Decimals are capped at two by the pattern itself, which is what refuses
// « 8829,6201 »: with `,62` consumed the next character is a digit rather than
// a currency mark, and no shorter match can start at `6201` because the comma
// before it is in the lookbehind.
const MONEY = new RegExp(
  '(?<![\\d/.,])' +           // not mid-number, not mid-date
    '(\\d{1,3}(?:[  \\u00a0\\u202f]\\d{3})+|\\d+)' +  // 1 901 | 1605
    '(?:[.,](\\d{1,2}))?' +   // ,93 | .71
    '\\s?(?:€|EUR\\b|eur\\b)',
  'g'
);

/** Above this, it is a reference number wearing a currency symbol. */
const MAX_PLAUSIBLE = 1_000_000;

export function amountsIn(text) {
  const found = [];

  for (const match of String(text ?? '').matchAll(MONEY)) {
    const whole = match[1].replace(/\D/g, '');
    const decimals = match[2] ?? '';
    const value = Number(decimals ? `${whole}.${decimals}` : whole);

    if (Number.isFinite(value) && value > 0 && value <= MAX_PLAUSIBLE) {
      found.push(value);
    }
  }

  return found;
}

export function amountAboveConsumerCeiling(text, threshold) {
  if (!Number.isFinite(threshold) || threshold <= 0) return null;
  const over = amountsIn(text).filter((value) => value > threshold);
  return over.length > 0 ? Math.max(...over) : null;
}

/**
 * `trade` · `consumer` · `unknown`
 *
 * ONLY THE AMOUNT ESTABLISHES `trade`, and a missing order deliberately does
 * not. « Shopify cannot find this order » is the cheaper signal and it is why
 * PA-30 asks for a number before answering — but it is far too common among
 * consumers to mean trade: a mistyped reference, a guest checkout, or a
 * customer quoting the confirmation email's own wording all produce it. Using
 * it here would label ordinary customers as wholesale on the strength of a typo.
 *
 * The amount is the signal that measured clean: on this corpus every ticket
 * naming a sum above the consumer ceiling is trade, and no consumer ticket
 * names one.
 *
 * A CONFIRMED ORDER IS WHAT SAYS `consumer` — the person demonstrably bought
 * through the storefront. Everything else is `unknown`, because the absence of
 * a trade signal is not evidence of a consumer: most trade mail looks ordinary.
 */
export function deriveBuyerType({ orderFound = null, namedAmountOverCeiling = null } = {}) {
  if (namedAmountOverCeiling != null) return 'trade';
  if (orderFound === true) return 'consumer';
  return 'unknown';
}
