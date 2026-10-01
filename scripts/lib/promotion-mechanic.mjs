/**
 * WHAT A PROMOTION DOES, derived from Shopify's own fields on a `promotions` row.
 *
 * NEVER FROM THE TITLE. Titles are free text a merchant writes — « Masque Or
 * offert », « 3+1 Offert : 3 masques achetés » — and vary by shop and language.
 * The discount type, its classes and the stored rule values are Shopify's
 * structure and mean the same thing on every shop, so the label is recomputed
 * on every read and nobody maintains it.
 *
 * The vocabulary is closed, because rules and screens branch on it:
 *
 * - `free_shipping`    — shipping discount (« frais de port offerts dès 70 € »)
 * - `gift`             — buy-X-get-Y where the customer must SPEND an amount
 *                        (« masque offert dès 65 € »)
 * - `multi_buy`        — buy-X-get-Y where the customer must BUY a quantity
 *                        (« 3 achetés, le 4e offert »)
 * - `order_discount`   — % or amount off the whole order
 * - `product_discount` — % or amount off listed products or collections
 * - `app`              — built by a third-party app; its mechanics are the app's
 * - `unknown`          — a shape this function does not recognise; said, not guessed
 */

export const MECHANICS = Object.freeze([
  'free_shipping',
  'gift',
  'multi_buy',
  'order_discount',
  'product_discount',
  'app',
  'unknown'
]);

export function promotionMechanic(row) {
  const type = String(row?.discount_type || '');
  const classes = Array.isArray(row?.discount_classes) ? row.discount_classes : [];

  if (/FreeShipping$/.test(type)) return 'free_shipping';
  if (/App$/.test(type)) return 'app';

  if (/Bxgy$/.test(type)) {
    const buys = row?.rule_snapshot?.customer_buys || {};
    if (buys.amount !== undefined && buys.amount !== null) return 'gift';
    if (buys.quantity !== undefined && buys.quantity !== null) return 'multi_buy';
    return 'unknown';
  }

  if (/Basic$/.test(type)) {
    if (classes.includes('ORDER')) return 'order_discount';
    if (classes.includes('PRODUCT')) return 'product_discount';
    return 'unknown';
  }

  return 'unknown';
}

/**
 * Whether the reward of a buy-X-get-Y offer is the item for FREE.
 *
 * `true` at 100 %, `false` for a partial reward (« -50 % sur le 2e »), `null`
 * when the value was not synced — a row from before the reward was fetched
 * must not read as either.
 */
export function rewardIsFree(row) {
  const gets = row?.rule_snapshot?.customer_gets || {};
  if (gets.percentage === undefined || gets.percentage === null) {
    return gets.amount !== undefined && gets.amount !== null ? false : null;
  }
  // A fraction on discounts (`QIRINESS20` stores 0.2, `WRAP` stores 1), unlike
  // the 0–100 an ORDER's discount application carries.
  return Number(gets.percentage) === 1;
}
