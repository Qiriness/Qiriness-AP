/**
 * The routine builder flow (owner, 2026-10-13): how a conversation leads to a
 * personalised routine, decided here and never in the prompt.
 *
 *   entry       a product question, a concern (« pour les imperfections »), or
 *               « construisez-moi une routine » (straight into the builder)
 *   offer       after we propose products, a FOLLOW-UP message: « Souhaitez-vous
 *               une routine personnalisée ? » Oui / Non (buttons or typed)
 *   builder     the engine asks the concern; then, signed in, ONE past purchase:
 *               build around it / « il m'en reste peu » (its card, view or add
 *               to cart) / focus on the concern
 *   anchor      the product they came in with (page, named, our top pick) is
 *               built into the routine (`pinned` in the engine)
 *   treat       one « petit plaisir » after the routine, or after a « Non »
 *
 * The follow-up's words and buttons both come from here, so they always agree
 * (the live run of 2026-10-13 had the model's text ask one thing and the
 * buttons answer another). The model is only told that a follow-up comes.
 *
 * State, with the consultation (`context.advisor.flow`):
 *   { offer: null | 'offered' | 'accepted' | 'declined',
 *     anchor: { id, source: 'page' | 'request' | 'suggested' } | null,
 *     treat_offered: boolean,
 *     cart: { pending: [{ id, variant_id | null }], asked: [id] },   the add-to-cart question
 *     routine_ref: uuid | null }                                    the routine just built (advisor_routines)
 *
 * ADD TO CART (owner, 2026-10-13): after a recommended routine (in place of the
 * treat, which then follows the answer) or after a single product once the
 * routine offer has had its turn: « Souhaitez-vous que je l'ajoute à votre
 * panier ? », « Oui, ajouter » / « Je cherche encore ». The server never holds
 * the customer's cart: on « Oui » the reply tells the widget what to add, and
 * the widget adds it, on that click only.
 */

export const FLOW_CHOICE = /^flow:routine:(yes|no)$/;
export const CART_CHOICE = /^flow:cart:(yes|no)$/;
const GID_VARIANT = /^gid:\/\/shopify\/ProductVariant\/\d{1,20}$/;
const OFFERS = ['offered', 'accepted', 'declined'];
const SOURCES = ['page', 'request', 'suggested'];
const ID = /^[0-9a-f-]{36}$/;

const TEXT = {
  fr: {
    offer: 'Souhaitez-vous que je vous construise une routine personnalisée ?',
    yes: 'Oui, avec plaisir',
    no: 'Non merci',
    purchase: (name) => `Je vois que vous avez déjà acheté ${name}. Souhaitez-vous construire votre routine autour, vous en reste-t-il peu, ou préférez-vous vous concentrer sur votre préoccupation ?`,
    runningLow: (name) => `Vous pouvez retrouver ${name} ici, ou l'ajouter directement à votre panier.`,
    // With their concern (owner, 2026-10-19): « parfait pour atténuer vos imperfections ».
    treatAfterRoutine: (concern) => concern ? `Et pour un moment de douceur, parfait pour atténuer ${frPossessive(concern)} ${concern}, ce petit plaisir pourrait vous plaire :` : 'Et pour un moment de douceur, ce petit plaisir pourrait vous plaire :',
    treatAfterNo: "Très bien. Si l'envie vous prend d'un petit plaisir, celui-ci pourrait vous plaire :",
    cartOne: (name) => `Souhaitez-vous que j'ajoute ${name} à votre panier ?`,
    cartRoutine: 'Souhaitez-vous que j\'ajoute cette routine à votre panier ?',
    cartRoutineDiscount: 'Souhaitez-vous que j\'ajoute cette routine à votre panier ? Votre remise routine s\'y appliquera automatiquement.',
    cartYes: 'Oui, ajouter',
    cartYesDiscount: 'Oui, ajouter avec la remise',
    cartDiscount: 'Votre remise routine est appliquée à votre panier.',
    cartNo: 'Je cherche encore',
    cartDone: (names) => `C'est noté, j'ajoute à votre panier : ${names}.`,
    cartSize: (names) => `Pour ${names}, choisissez la taille sur sa page.`,
    cartRoutineDone: "C'est noté, j'ajoute à votre panier les soins inclus dans votre routine.",
    cartNoDone: 'Très bien, prenez votre temps.',
    routineReady: 'Voici votre routine personnalisée, matin et soir.',
  },
  en: {
    offer: 'Would you like me to build you a personalised routine?',
    yes: 'Yes please',
    no: 'No thanks',
    purchase: (name) => `I can see you've bought ${name} before. Would you like to build your routine around it, are you running low on it, or would you rather focus on your concern?`,
    runningLow: (name) => `You'll find ${name} here, or you can add it straight to your cart.`,
    treatAfterRoutine: (concern) => concern ? `And for a little moment of pampering, perfect for easing your ${concern}, you might like this treat:` : 'And for a little moment of pampering, you might like this treat:',
    treatAfterNo: 'Of course. If you fancy a little treat, you might like this one:',
    cartOne: (name) => `Would you like me to add ${name} to your cart?`,
    cartRoutine: 'Would you like me to add this routine to your cart?',
    cartRoutineDiscount: 'Would you like me to add this routine to your cart? Your routine discount will be applied automatically.',
    cartYes: 'Yes, add it',
    cartYesDiscount: 'Yes, add it with the discount',
    cartDiscount: 'Your routine discount is applied to your cart.',
    cartNo: "I'm still looking",
    cartDone: (names) => `Done, adding to your cart: ${names}.`,
    cartSize: (names) => `For ${names}, please choose the size on its page.`,
    cartRoutineDone: 'Done, adding the products included in your routine to your cart.',
    cartNoDone: 'Of course, take your time.',
    routineReady: 'Here is your personalised routine, morning and evening.',
  },
};
const text = (lang) => TEXT[String(lang).slice(0, 2)] ?? TEXT.fr;
// « vos rides », « votre déshydratation »: the concern's first word in the plural or not.
const frPossessive = (concern) => (/[sx]$/i.test(concern.split(/\s+/)[0]) ? 'vos' : 'votre');
/** A concern's name inside a sentence: « Teint terne » → « teint terne ». */
const inSentence = (label) => (typeof label === 'string' && label.trim() ? label.trim().charAt(0).toLocaleLowerCase() + label.trim().slice(1) : null);

// A typed answer to the offer, French and English. Only read while an offer is pending.
const YES = /^\s*(oui|ouais|volontiers|avec plaisir|d'accord|ok(ay)?|bien s[uû]r|carr[ée]ment|go|yes|yeah|yep|sure|please|of course|let'?s (do it|go))\b(?!.*\b(pas|not|non|no)\b)/iu;
const NO = /^\s*(non|nan|pas (maintenant|pour l'instant|besoin)|sans fa[cç]on|no|nope|not (now|right now|today)|no thanks?)\b/iu;
// « Je cherche encore »: not now, still browsing (the cart question's « no »).
const STILL_LOOKING = /\b(je cherche encore|je regarde encore|pas encore|plus tard|je reflechis|je réfléchis|still looking|just looking|not yet|maybe later|later)\b/iu;

export function emptyFlow() {
  return { offer: null, anchor: null, treat_offered: false, cart: { pending: [], asked: [] }, routine_ref: null };
}

/** From the message log: re-checked like the rest of the state. */
export function cleanFlow(saved) {
  const anchor = saved?.anchor && ID.test(saved.anchor.id ?? '') && SOURCES.includes(saved.anchor.source) ? { id: saved.anchor.id, source: saved.anchor.source } : null;
  const pending = (Array.isArray(saved?.cart?.pending) ? saved.cart.pending : [])
    .filter((x) => x && ID.test(x.id ?? '') && (x.variant_id === null || GID_VARIANT.test(x.variant_id ?? '')))
    .slice(0, 8).map((x) => ({ id: x.id, variant_id: x.variant_id }));
  const asked = (Array.isArray(saved?.cart?.asked) ? saved.cart.asked : []).filter((id) => ID.test(id ?? '')).slice(-20);
  // The routine just built (advisor_routines.ref): « Oui, ajouter » marks it added to the cart.
  const routineRef = typeof saved?.routine_ref === 'string' && ID.test(saved.routine_ref) ? saved.routine_ref : null;
  return { offer: OFFERS.includes(saved?.offer) ? saved.offer : null, anchor, treat_offered: saved?.treat_offered === true, cart: { pending, asked }, routine_ref: routineRef };
}

/** The answer to the cart question: a button, or typed words while it is pending. */
export function cartAnswer(flow, { choice = null, message = '' } = {}) {
  const m = typeof choice === 'string' ? choice.match(CART_CHOICE) : null;
  if (m) return m[1];
  if (!cleanFlow(flow).cart.pending.length || choice) return null;
  if (NO.test(message) || STILL_LOOKING.test(message)) return 'no';
  if (YES.test(message)) return 'yes';
  return null;
}

/**
 * What a « Oui, ajouter » adds: the pending products with one size to buy;
 * the others are named so the customer picks the size on the product page.
 * @returns {{ add: { product_id: string, variant_id: string }[], needs_size: string[] }}
 */
export function cartToAdd(flow, nameOf = () => null) {
  const pending = cleanFlow(flow).cart.pending;
  return {
    add: pending.filter((x) => x.variant_id).map((x) => ({ product_id: x.id, variant_id: x.variant_id })),
    needs_size: pending.filter((x) => !x.variant_id).map((x) => nameOf(x.id)).filter(Boolean),
  };
}

/** The code's own reply to « Oui, ajouter » (no model call); a finished routine's discount said, never its code. */
export function cartDoneText(lang, added, needsSize, { discount = false, routine = false } = {}) {
  const t = text(lang);
  // Under the routine cards: what they include, which the widget knows (it says how it went).
  if (routine) return t.cartRoutineDone;
  return [added.length ? t.cartDone(added.join(', ')) : null, added.length && discount ? t.cartDiscount : null, needsSize.length ? t.cartSize(needsSize.join(', ')) : null].filter(Boolean).join(' ');
}

/** The code's own reply to « Je cherche encore » (no model call): the treat, when there is one, follows it. */
export function cartNoText(lang) {
  return text(lang).cartNoDone;
}

/** The one sentence above the routine cards (no model reply: the cards say it all). */
export function routineReadyText(lang) {
  return text(lang).routineReady;
}

/** The customer's answer to the offer: a button, or typed words while it is pending. */
export function offerAnswer(flow, { choice = null, message = '' } = {}) {
  const m = typeof choice === 'string' ? choice.match(FLOW_CHOICE) : null;
  if (m) return m[1];
  if (cleanFlow(flow).offer !== 'offered' || choice) return null;
  if (NO.test(message)) return 'no';
  if (YES.test(message)) return 'yes';
  return null;
}

/**
 * Before the advice: the offer answered, and whether the builder starts.
 * @returns {{ flow: object, answer: 'yes' | 'no' | null, startBuilder: boolean }}
 */
export function beforeAdvice(flow, { choice, message }) {
  const next = cleanFlow(flow);
  const cart = cartAnswer(next, { choice, message });
  // A cart answer answers the cart question only: it never starts the builder.
  const answer = cart ? null : offerAnswer(next, { choice, message });
  if (answer === 'yes') next.offer = 'accepted';
  if (answer === 'no') next.offer = 'declined';
  return { flow: next, answer, cart, startBuilder: answer === 'yes' };
}

/**
 * The product they came in with: the page they are on, else the product they
 * named, else our top pick for their concern.
 */
export function anchorFor({ pageProductId = null, resolvedIds = [], advice = null }) {
  if (pageProductId) return { id: pageProductId, source: 'page' };
  if (resolvedIds.length) return { id: resolvedIds[0], source: 'request' };
  const top = advice?.status === 'recommended' ? advice.steps?.[0]?.product_id : null;
  return top ? { id: top, source: 'suggested' } : null;
}

/**
 * After the advice, before the model: this turn's follow-up message (one at
 * most), in this order: the answer to « il m'en reste peu », the treat after a
 * « Non », the purchase question, the treat after the routine, the offer.
 *
 * @param {{
 *   flow: object, lang: string, builder: boolean, answer: 'yes' | 'no' | null,
 *   advice: object | null,           the engine's advice this turn
 *   showsProducts: boolean,          this reply will show product cards
 *   anchor: { id: string, source: string } | null,
 *   purchaseAsk: { product_id: string, name: string } | null,   purchase-turn's pick, builder only
 *   runningLow: { product_id: string, name: string } | null,    just answered « il m'en reste peu »
 *   treat: { product_id: string } | null,                        the engine's treat, when one is due
 *   purchaseChoices: (item) => { label: string, value: string }[],
 *   cartable: { product_id: string, variant_id: string | null, name: string }[],   what « add to cart » would add (one product, or a routine)
 *   cart: 'yes' | 'no' | null                                    this turn's answer to the cart question
 *   discount: boolean                                            a finished routine with the shop's routine discount
 *   concern: string | null                                       their main concern's name, in their language (the treat's sentence)
 * }} input
 * @returns {{ flow: object, followUp: { kind: string, text: string, choices: object[], productIds: string[] } | null }}
 */
export function followUpFor({ flow, lang, builder, answer, advice, showsProducts, anchor, purchaseAsk, runningLow, treat, purchaseChoices, cartable = [], cart = null, discount = false, concern = null }) {
  const next = cleanFlow(flow);
  const t = text(lang);
  const say = (kind, words, { choices = [], productIds = [] } = {}) => ({ flow: next, followUp: { kind, text: words, choices, productIds } });
  const askCart = (items) => {
    next.cart = { pending: items.map((x) => ({ id: x.product_id, variant_id: x.variant_id ?? null })), asked: [...next.cart.asked, ...items.map((x) => x.product_id)] };
    // A finished routine with the shop's routine discount (owner, 2026-10-17): « ajouter avec la remise ».
    const withDiscount = discount && items.length > 1;
    return say('cart', withDiscount ? t.cartRoutineDiscount : items.length > 1 ? t.cartRoutine : t.cartOne(items[0].name), { choices: [{ label: withDiscount ? t.cartYesDiscount : t.cartYes, value: 'flow:cart:yes' }, { label: t.cartNo, value: 'flow:cart:no' }] });
  };
  // The cart question is the last message's question only: answered or passed
  // over, nothing is pending any more. Left pending, a « oui » four turns later
  // to the model's own question added the retinol cream the customer had just
  // excluded (dev store, 2026-10-16). askCart below sets a new one.
  next.cart = { ...next.cart, pending: [] };

  if (runningLow) return say('running_low', t.runningLow(runningLow.name), { productIds: [runningLow.product_id] });
  if (answer === 'no' && treat && !next.treat_offered) {
    next.treat_offered = true;
    return say('treat', t.treatAfterNo, { productIds: [treat.product_id] });
  }
  if (builder && purchaseAsk) return say('purchase', t.purchase(purchaseAsk.name), { choices: purchaseChoices(purchaseAsk) });
  // A routine is ready: « shall I add it to your cart? » first; the treat follows the answer.
  if (builder && advice?.status === 'recommended' && cartable.length && !cart) return askCart(cartable);
  if (cart && treat && !next.treat_offered) {
    next.treat_offered = true;
    return say('treat', t.treatAfterRoutine(inSentence(concern)), { productIds: [treat.product_id] });
  }
  if (builder && advice?.status === 'recommended' && treat && !next.treat_offered) {
    next.treat_offered = true;
    return say('treat', t.treatAfterRoutine(inSentence(concern)), { productIds: [treat.product_id] });
  }
  if (!builder && next.offer === null && showsProducts) {
    next.offer = 'offered';
    if (anchor) next.anchor = anchor;
    return say('offer', t.offer, { choices: [{ label: t.yes, value: 'flow:routine:yes' }, { label: t.no, value: 'flow:routine:no' }] });
  }
  // One product, once the routine offer has had its turn, never twice for the same product.
  if (!builder && next.offer !== null && !cart && cartable.length === 1 && !next.cart.asked.includes(cartable[0].product_id)) return askCart(cartable);
  return { flow: next, followUp: null };
}

/**
 * What the model is told: the app sends this itself, after its reply. When the
 * follow-up is a question, the reply asks none (the live run had the reply ask
 * the skin type while the follow-up asked about a purchase).
 */
const ABOUT = {
  offer: 'asks whether they would like a personalised routine',
  purchase: 'asks what to do about a product they bought before',
  running_low: 'shows the card of the product they are running low on, to view or add to cart',
  treat: 'suggests one small treat, with its card',
  cart: 'asks whether to add it to their cart',
};
export function followUpNote(followUp) {
  if (!followUp) return null;
  const base = `After your reply, the app sends its own message that ${ABOUT[followUp.kind] ?? 'follows up'}. Never write it, quote it or announce it; do not offer a routine or a treat yourself.`;
  return followUp.choices.length ? `${base} That message is this turn's only question: your reply asks none.` : `${base} Ask ADVICE next_question as usual, if there is one.`;
}
