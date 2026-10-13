/**
 * Purchase awareness in a chat turn — Phase 1 (docs/storefront-advisor-plan.md § 5).
 *
 * A purchase is a fact to ASK about, never a profile: it does not prove the
 * customer likes it, uses it, still has it or bought it for themselves. So the
 * consultant asks (« I can see you bought X — still using it? ») with chips
 * from here, never the model, and only the customer's answer is recorded.
 *
 * READ ONLY WHEN IT SERVES THE TURN: a consultation turn, a purchase chip, or a
 * message about past purchases (« ce que j'ai acheté », « reorder »). A policy
 * or product question never reads the customer's orders.
 *
 * State lives with the consultation (`context.advisor.purchases`):
 *   { asked: [id], using: [id], finished: [id], gift: [id] }   catalogue product ids
 */

/** Chip value: `purchase:<answer>:<catalogue product id>`. */
export const PURCHASE_CHOICE = /^purchase:(using|finished|gift):([0-9a-f-]{36})$/;
export const ANSWERS = ['using', 'finished', 'gift'];
/** One question per turn, and at most this many per conversation. */
export const MAX_PURCHASE_QUESTIONS = 2;
/** Shown to the model: the most recent, enough to answer « what did I buy? ». */
export const MAX_PROMPT_PURCHASES = 8;

const LABELS = {
  fr: { using: "Je l'utilise encore", finished: "Je l'ai terminé", gift: "C'était un cadeau" },
  en: { using: 'Still using it', finished: "I've finished it", gift: 'It was a gift' },
};

// French and English, the minimum for every chatbot layer.
const PAST_PURCHASE = new RegExp(
  [
    "(?:j'|j’|je )ai (?:déjà )?(?:acheté|commandé|pris)",
    'mes (?:derniers? |précédents? )?(?:achats?|commandes?)',
    'ma (?:dernière |précédente )?commande',
    'la dernière fois',
    'racheter|recommander|reprendre (?:le|la|les|mon|ma|mes)',
    'mes produits',
    'i (?:have |\'ve )?(?:already )?(?:bought|ordered|purchased|got)',
    'my (?:last |previous |past )?(?:orders?|purchases?)',
    'last time',
    're-?order|re-?buy|buy (?:it|that|them) again',
    'my products',
  ].join('|'),
  'iu'
);

export function mentionsPastPurchase(message) {
  return PAST_PURCHASE.test(String(message ?? ''));
}

export function emptyPurchaseState() {
  return { asked: [], using: [], finished: [], gift: [] };
}

const ID = /^[0-9a-f-]{36}$/;
/** From the message log: the public internet's input once removed, so re-checked. */
export function cleanPurchaseState(saved) {
  const list = (v) => (Array.isArray(v) ? [...new Set(v.filter((id) => typeof id === 'string' && ID.test(id)))].slice(0, 20) : []);
  return { asked: list(saved?.asked), using: list(saved?.using), finished: list(saved?.finished), gift: list(saved?.gift) };
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
      name: live?.name ?? live?.title ?? p.title,
      in_catalogue: Boolean(live),
      last_purchased_on: p.last_purchased_on,
      first_purchased_on: p.first_purchased_on,
      times_purchased: p.times_purchased,
      free_gift: p.free_gift,
      returned: p.returned,
    };
  });
}

/**
 * The purchase worth asking about now: the most recent one the customer paid
 * for and kept, still in the catalogue, not yet asked. Null when there is none
 * or the conversation has asked enough.
 */
export function purchaseToAsk(items, state) {
  const s = cleanPurchaseState(state);
  if (s.asked.length >= MAX_PURCHASE_QUESTIONS) return null;
  return items.find((i) => i.in_catalogue && !i.free_gift && !i.returned && !s.asked.includes(i.product_id)) ?? null;
}

export function purchaseChoices(item, locale = 'fr') {
  const labels = LABELS[String(locale).slice(0, 2)] ?? LABELS.fr;
  return ANSWERS.map((a) => ({ label: labels[a], value: `purchase:${a}:${item.product_id}` }));
}

/**
 * What the prompt shows: the purchases, what the customer said about them, and
 * the one question to ask this turn (if any). Products and days only.
 */
export function describePurchases(items, state, { ask = null, answered = null } = {}) {
  const s = cleanPurchaseState(state);
  const said = (id) => (s.using.includes(id) ? 'still_using' : s.finished.includes(id) ? 'finished' : s.gift.includes(id) ? 'bought_as_gift' : null);
  return {
    purchases: items.slice(0, MAX_PROMPT_PURCHASES).map((i) => ({
      name: i.name,
      last_purchased_on: i.last_purchased_on,
      times_purchased: i.times_purchased,
      ...(i.free_gift ? { free_gift: true } : {}),
      ...(i.returned ? { returned: true } : {}),
      ...(i.in_catalogue ? {} : { no_longer_sold: true }),
      ...(i.product_id && said(i.product_id) ? { customer_said: said(i.product_id) } : {}),
    })),
    ...(ask ? { ask_about: ask.name } : {}),
    ...(answered ? { just_answered: { name: answered.name, customer_said: said(answered.product_id) } } : {}),
  };
}
