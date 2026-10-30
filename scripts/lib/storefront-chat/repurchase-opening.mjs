/**
 * The repurchase message when a signed-in customer opens the chat (owner,
 * 2026-10-29): « are they logged in, yes — do they have products in the
 * repurchase window, yes — identify the favourite product », said under the
 * greeting, before they type anything. Code, never the model: one product, one
 * sentence, its card (« Ajouter au panier » when it has one size to buy).
 *
 * IN THE WINDOW: from the product's interval (measured, else the brand's
 * « Durée d'utilisation ») less the larger of `window_share` of it and
 * `window_days` (owner: « something like 20 %, or 2 weeks »), to
 * `window_after_share` of the interval after it (owner: « not forever … like
 * 50 % »): just before they run out counts, and so does a while after.
 *
 * THE FAVOURITE, among those: the type first (`type_order`: creams, serums,
 * lotions…, sheet masks last; owner), then bought most often, then most
 * recent, then the more expensive (the shop's current price).
 *
 * Never an accessory, a device, a kit or a coffret; never a free line, a
 * return, a product no longer sold or out of stock.
 */
import { isAccessory, isBundle } from '../advisory/product-knowledge.mjs';
import { messages } from '../i18n/languages.mjs';

const DAY_MS = 24 * 3600 * 1000;

/** The brand's choices; `routines.repurchase_opening` (routine settings) overrides each. */
export const REPURCHASE_OPENING_DEFAULTS = {
  window_share: 0.2,
  window_days: 14,
  window_after_share: 0.5,
  type_order: ['cream', 'serum', 'lotion', 'eye', 'cleanser', 'makeup_remover', 'spf', 'exfoliant', 'patch', 'out_of_routine', 'mask', 'sheet_mask'],
};

// The owner's wording (2026-10-29), in each language: i18n/<code>/messages.mjs, `repurchase`.

/**
 * The offer to mention (owner: « if there is give them the discount, no need to name »): one that gives
 * it by itself, so the card's « Ajouter au panier » gets it too. An automatic one only (a code would
 * have to be named, and codes are not volunteered), with a percentage or an amount off and no minimum
 * or « buy X »: « sur ce produit » must hold for this product alone.
 * @param {object[]} offers  promotionsForProduct (shopping-evaluator.mjs)
 */
export function openingPromotion(offers) {
  return (offers ?? []).find((o) => o?.type === 'automatic' && !o.minimum && !o.requires && (o.reward?.percentage > 0 || o.reward?.amount > 0)) ?? null;
}

/** « 20 % », « 5,00 € »: the reward as said in the sentence. */
export function promotionLabel(offer, money, locale = 'fr') {
  const pct = offer?.reward?.percentage;
  if (pct > 0) return messages(locale).percent(Math.round(pct));
  return offer?.reward?.amount > 0 ? money(offer.reward.amount) : null;
}

export function openingSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const share = Number(s.window_share);
  const days = Number(s.window_days);
  const after = Number(s.window_after_share);
  return {
    window_share: share >= 0 && share <= 1 ? share : REPURCHASE_OPENING_DEFAULTS.window_share,
    window_days: days >= 0 && days <= 120 ? days : REPURCHASE_OPENING_DEFAULTS.window_days,
    window_after_share: s.window_after_share !== undefined && after >= 0 && after <= 10 ? after : REPURCHASE_OPENING_DEFAULTS.window_after_share,
    type_order: Array.isArray(s.type_order) && s.type_order.length ? s.type_order.map(String) : REPURCHASE_OPENING_DEFAULTS.type_order,
  };
}

/** Weeks between purchases: measured when the shop has seen enough, else the brand's stated duration. */
function intervalWeeks(handle, k, measured) {
  const m = measured?.get(handle)?.median_weeks;
  if (m > 0) return m;
  return k?.usage_weeks > 0 ? k.usage_weeks : null;
}

/**
 * @param {ReturnType<import('./purchase-turn.mjs').purchaseItems>} items
 * @returns {object | null} the purchase item to offer, with `days_since` and `expected_days`
 */
export function repurchaseFavourite(items, { catalogue, knowledge, measured = null, settings = null, now = new Date() } = {}) {
  const s = openingSettings(settings);
  const live = new Map((catalogue?.products ?? []).map((p) => [p.id, p]));
  const rank = (type) => {
    const at = s.type_order.indexOf(type);
    return at >= 0 ? at : s.type_order.length;
  };
  const due = [];
  for (const item of items ?? []) {
    const product = live.get(item.product_id);
    const k = item.handle ? knowledge?.get(item.handle) : null;
    if (!product?.inStock || !k || item.free_gift || item.returned || isAccessory(k) || isBundle(k) || k.status === 'do_not_advise') continue;
    const weeks = intervalWeeks(item.handle, k, measured);
    const last = Date.parse(`${item.last_purchased_on}T00:00:00Z`);
    if (!weeks || !Number.isFinite(last)) continue;
    const expected = weeks * 7;
    const since = Math.floor((now.getTime() - last) / DAY_MS);
    // From a little before the date to half an interval after it (owner, same day: « not forever … like 50 % »).
    if (since < expected - Math.max(expected * s.window_share, s.window_days) || since > expected * (1 + s.window_after_share)) continue;
    due.push({ ...item, type: k.functional_type, days_since: since, expected_days: Math.round(expected) });
  }
  return due.sort((a, b) =>
    rank(a.type) - rank(b.type)
    || (b.times_purchased ?? 0) - (a.times_purchased ?? 0)
    || String(b.last_purchased_on ?? '').localeCompare(String(a.last_purchased_on ?? ''))
    || (b.price ?? 0) - (a.price ?? 0))[0] ?? null;
}

export function repurchaseText(name, locale = 'fr', { days, promo = null } = {}) {
  return messages(locale).repurchase(name, days, promo);
}
