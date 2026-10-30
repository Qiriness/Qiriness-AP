/**
 * Purchase awareness in a chat turn (docs/storefront-advisor-plan.md § 5).
 *
 * A purchase is a fact to ASK about, never a profile: it does not prove the
 * customer likes it, uses it, still has it or bought it for themselves. Inside
 * the routine builder only (routine-flow.mjs), the consultant asks about ONE:
 * build the routine around it, « il m'en reste peu » (its card: view or add to
 * cart), or focus on the concern. Only the answer is recorded.
 *
 * READ ONLY WHEN IT SERVES THE TURN: a consultation turn, a purchase chip, or a
 * message about past purchases (« ce que j'ai acheté », « reorder »). A policy
 * or product question never reads the customer's orders.
 *
 * State lives with the consultation (`context.advisor.purchases`):
 *   { asked: [id], around: [id], running_low: [id], focus: [id] }   catalogue product ids
 *   (a session from before 2026-10-13 had `using`: read as `around`)
 *
 * Phase 2: « around » products go to the engine, which lets each fill its
 * routine step (a kit, what it contains); « running low » ones are put into
 * their step (`pinned`). Phase 3, with product knowledge:
 * a daily product probably used up is flagged for the consultant to ASK about
 * (replenishment.mjs), and the ranges they use nudge the ranking.
 */

import { replenishment } from '../advisory/replenishment.mjs';
import { alternation, messages } from '../i18n/languages.mjs';

/** Chip value: `purchase:<answer>:<catalogue product id>`. */
export const PURCHASE_CHOICE = /^purchase:(around|running_low|focus):([0-9a-f-]{36})$/;
export const ANSWERS = ['around', 'running_low', 'focus'];
/** One purchase question per conversation, inside the builder. */
export const MAX_PURCHASE_QUESTIONS = 1;
/** Shown to the model: the most recent, enough to answer « what did I buy? ». */
export const MAX_PROMPT_PURCHASES = 8;


// Every language the chat speaks (i18n/<code>/words.mjs, `pastPurchase`).
const PAST_PURCHASE = new RegExp(alternation('pastPurchase'), 'iu');

export function mentionsPastPurchase(message) {
  return PAST_PURCHASE.test(String(message ?? ''));
}

export function emptyPurchaseState() {
  return { asked: [], around: [], running_low: [], focus: [] };
}

const ID = /^[0-9a-f-]{36}$/;
/** From the message log: the public internet's input once removed, so re-checked. */
export function cleanPurchaseState(saved) {
  const list = (v) => (Array.isArray(v) ? [...new Set(v.filter((id) => typeof id === 'string' && ID.test(id)))].slice(0, 20) : []);
  return { asked: list(saved?.asked), around: list([...(Array.isArray(saved?.around) ? saved.around : []), ...(Array.isArray(saved?.using) ? saved.using : [])]), running_low: list(saved?.running_low), focus: list(saved?.focus) };
}

/** A purchase chip → { answer, productId }, or null. */
export function parsePurchaseChoice(choice) {
  const m = typeof choice === 'string' ? choice.match(PURCHASE_CHOICE) : null;
  return m ? { answer: m[1], productId: m[2] } : null;
}

/** Record an answer: a product sits in exactly one answer list. */
export function recordAnswer(state, { answer, productId }) {
  const next = cleanPurchaseState(state);
  for (const a of ANSWERS) next[a] = next[a].filter((id) => id !== productId);
  next[answer] = [...next[answer], productId];
  if (!next.asked.includes(productId)) next.asked = [...next.asked, productId];
  return next;
}

/** The price the shop shows for it (its cheapest variant), or null. Ranking only, never shown. */
function shopPrice(product) {
  const prices = (product?.variants ?? []).map((v) => Number(v?.price)).filter((n) => Number.isFinite(n) && n > 0);
  return prices.length ? Math.min(...prices) : null;
}

/**
 * The summary joined to the catalogue: names from the catalogue where the
 * product is still sold, the order line's title otherwise.
 * @param {{ products: object[] } | null} summary toPurchaseSummary output
 * @param {{ products: { id: string, shopifyId?: string | null, name?: string, title?: string }[] } | null} catalogue
 */
export function purchaseItems(summary, catalogue) {
  const byShopifyId = new Map((catalogue?.products ?? []).filter((p) => p.shopifyId).map((p) => [p.shopifyId, p]));
  return (summary?.products ?? []).map((p) => {
    const live = byShopifyId.get(p.product_id) ?? null;
    return {
      product_id: live?.id ?? null,
      handle: live?.handle ?? null,
      name: live?.name ?? live?.title ?? p.title,
      in_catalogue: Boolean(live),
      price: shopPrice(live),
      last_purchased_on: p.last_purchased_on,
      first_purchased_on: p.first_purchased_on,
      times_purchased: p.times_purchased,
      free_gift: p.free_gift,
      returned: p.returned,
    };
  });
}

/**
 * The purchase worth asking about now: one the customer paid for and kept,
 * still in the catalogue, not yet asked. One probably running low first
 * (`isDue`, Phase 3); then the most recent; on the same day, the one bought
 * most often; then the more expensive. Null when there is none or the
 * conversation has asked enough.
 */
export function purchaseToAsk(items, state, { isDue = () => false } = {}) {
  const s = cleanPurchaseState(state);
  if (s.asked.length >= MAX_PURCHASE_QUESTIONS) return null;
  const candidates = items.filter((i) => i.in_catalogue && !i.free_gift && !i.returned && !s.asked.includes(i.product_id));
  const due = new Set(candidates.filter((i) => isDue(i)));
  return candidates.sort((a, b) =>
    Number(due.has(b)) - Number(due.has(a))
    || String(b.last_purchased_on ?? '').localeCompare(String(a.last_purchased_on ?? ''))
    || (b.times_purchased ?? 0) - (a.times_purchased ?? 0)
    || (b.price ?? 0) - (a.price ?? 0))[0] ?? null;
}

export function purchaseChoices(item, locale = 'fr') {
  const labels = messages(locale).purchase;
  return ANSWERS.map((a) => ({ label: labels[a], value: `purchase:${a}:${item.product_id}` }));
}

/** A daily product past its usual interval, unless they already answered about it (running low, or set aside). */
export function mayBeRunningLow(item, state, { knowledge = null, measured = null, now = new Date() } = {}) {
  const s = cleanPurchaseState(state);
  if (!item.handle || !item.in_catalogue || item.free_gift || item.returned) return false;
  if (s.running_low.includes(item.product_id) || s.focus.includes(item.product_id)) return false;
  return replenishment(item.handle, item.last_purchased_on, { knowledge, measured, now })?.due === true;
}

/**
 * The ranges of what the customer uses: products they build the routine around,
 * or paid for more than once. Never one set aside, never a free line. Product knowledge only.
 */
export function customerRanges(items, state, knowledge) {
  const s = cleanPurchaseState(state);
  const ranges = new Set();
  for (const i of items) {
    if (!i.handle || i.free_gift || i.returned || s.focus.includes(i.product_id)) continue;
    if (!s.around.includes(i.product_id) && !(i.times_purchased >= 2)) continue;
    const range = knowledge?.get(i.handle)?.range;
    if (range) ranges.add(range);
  }
  return [...ranges];
}

/**
 * What the prompt shows: the purchases, what the customer said about them, and
 * the answer just given (if any). Products and days only: the question itself is the app's follow-up.
 * With product knowledge: `may_be_running_low` on a daily product whose usual
 * interval has passed (never once they answered about it),
 * and `bought_repeatedly` when they paid for it more than once.
 */
export function describePurchases(items, state, { answered = null, knowledge = null, measured = null, now = new Date() } = {}) {
  const s = cleanPurchaseState(state);
  const said = (id) => (s.around.includes(id) ? 'build_around' : s.running_low.includes(id) ? 'running_low' : s.focus.includes(id) ? 'set_aside' : null);
  const runningLow = (i) => mayBeRunningLow(i, s, { knowledge, measured, now });
  return {
    purchases: items.slice(0, MAX_PROMPT_PURCHASES).map((i) => ({
      name: i.name,
      last_purchased_on: i.last_purchased_on,
      times_purchased: i.times_purchased,
      ...(i.free_gift ? { free_gift: true } : {}),
      ...(i.returned ? { returned: true } : {}),
      ...(i.in_catalogue ? {} : { no_longer_sold: true }),
      ...(i.product_id && said(i.product_id) ? { customer_said: said(i.product_id) } : {}),
      ...(!i.free_gift && i.times_purchased >= 2 ? { bought_repeatedly: true } : {}),
      ...(runningLow(i) ? { may_be_running_low: true } : {}),
    })),
    ...(answered ? { just_answered: { name: answered.name, customer_said: said(answered.product_id) } } : {}),
  };
}
