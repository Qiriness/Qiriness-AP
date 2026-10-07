import { cartDiscountTrace, evaluatePromotionsForCart, getActivePromotions, getCartContext, getStockContext, needsShoppingContext } from './shopping-evaluator.mjs';
import cartContract from '../../../storefront-app/extensions/storefront-advisor/assets/advisor-cart.js';
import { simulateOffers } from './offer-solver.mjs';
import { countryAnswer } from './knowledge-topics.mjs';

export const SHOPPING_TOOL_NAMES = ['get_cart_context', 'get_stock_context', 'get_active_promotions', 'evaluate_promotions_for_cart', 'simulate_offers'];
export function shoppingToolDefinitions() {
  const definition = (name, description, properties = {}) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, additionalProperties: false } } });
  return [
    definition('get_cart_context', 'Read the current cart snapshot. No modifications. Prices, totals and public applied discounts only.'),
    definition('get_stock_context', 'Read synced variant inventory for the cart or products already resolved this turn. Never infer stock from descriptions.', { product_ids: { type: 'array', items: { type: 'string' }, maxItems: 8 }, variant_id: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 999 } }),
    definition('get_active_promotions', 'List current public offers (all of them by default, free delivery included). Free-delivery offers carry their published terms only — minimum, destinations — never a delivery cost. Use evaluate_promotions_for_cart to know whether the cart qualifies.', { limit: { type: 'integer', minimum: 1, maximum: 12 }, topic: { type: 'string', enum: ['all', 'non_shipping', 'free_shipping'] } }),
    definition('evaluate_promotions_for_cart', 'Determine eligibility and combinations from current cart and public promotion rules, free delivery included (its minimum against the cart; destination stated, cost never). Unknown means do not infer. Code must be explicitly supplied by the shopper; no private-code lookup.', { code: { type: 'string', maxLength: 80 }, promotion_ids: { type: 'array', items: { type: 'string' }, maxItems: 12 } }),
    definition('simulate_offers', 'Predict which offers Shopify would apply TOGETHER, choosing the combination with the largest saving, for the current cart or the cart plus products the customer is considering (« what if I add … »). Only products already resolved this turn can be added. Reaches public automatic offers and codes already entered in the cart. A prediction, not a checkout: on the current cart, the discounts the cart shows remain the authority.', { add: { type: 'array', maxItems: 4, items: { type: 'object', properties: { product_id: { type: 'string' }, variant_id: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 99 } }, required: ['product_id'], additionalProperties: false } } })
  ];
}

/** A lazy reader shared by opening retrieval and tools within ONE turn. */
export function createShoppingTurn({ readShopping, readPublicPromotions = null, shopDomain, cart, context = {}, message = '', history = [], resolvedProducts = [], baseCurrency = null }) {
  let source;
  // THE NAME OF A PUBLIC AUTOMATIC OFFER IS NOT A CODE. « TEST02 » looks like
  // one (capitals and a digit), and the code backstop replaced it with « ce
  // code » in every reply about it (dev store, 2026-10-06).
  const offerNames = new Set();
  const load = () => source ??= Promise.resolve().then(() => readShopping(shopDomain)).catch(() => ({ status: 'unavailable', reason: 'shopping_source_unavailable' })).then((data) => {
    for (const p of data?.promotions ?? []) if (p.method === 'automatic' && p.title) offerNames.add(p.title.trim().toUpperCase());
    return data;
  });
  const ids = new Set(resolvedProducts.map((p) => p.id));
  const shopifyIds = new Map(resolvedProducts.map((p) => [p.id, p.shopifyId]));
  const pageIds = new Set(resolvedProducts.filter((p) => p.handle === context.productHandle).map((p) => p.id));
  const returnedCodes = new Set();
  const requestedCodes = () => {
    const explicit = [...message.matchAll(/\bcode\s+(?:promo\s+)?[«"']?([a-z0-9_-]{2,80})/gi)].map((m) => m[1].toUpperCase()).filter((c) => !['PROMO', 'NE', 'DE', 'EST', 'REDUCTION'].includes(c));
    return [...new Set([...explicit, ...message.match(/\b(?=[A-Z0-9_-]*\d)[A-Z][A-Z0-9_-]{2,79}\b/g) ?? []])].slice(0, 3);
  };
  async function execute(name, args = {}) {
    if (!SHOPPING_TOOL_NAMES.includes(name)) return { status: 'unavailable', reason: 'unknown_tool' };
    const data = await load();
    if (name === 'get_cart_context') return getCartContext(cart, data, context);
    if (name === 'get_active_promotions') {
      if (data.reason === 'shop_not_synced' && readPublicPromotions) {
        const preview = await readPublicPromotions(shopDomain).catch(() => ({ status: 'unavailable', reason: 'offer_preview_unavailable' }));
        const result = getActivePromotions(preview, args);
        return { ...result, offer_preview: true, store_eligibility: 'not_confirmed' };
      }
      return getActivePromotions(data, args);
    }
    if (name === 'get_stock_context') {
      const productIds = Array.isArray(args.product_ids) ? args.product_ids.filter((id) => ids.has(id)).slice(0, 8) : [];
      if (args.product_ids?.length && productIds.length !== args.product_ids.length) return { status: 'unknown', reason: 'product_not_resolved' };
      if (args.quantity !== undefined && (!Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > 999)) return { status: 'unknown', reason: 'quantity_invalid' };
      return getStockContext(cart, data, { productIds: productIds.map((id) => shopifyIds.get(id) ?? id), variantId: args.variant_id ?? (productIds.length === 1 && pageIds.has(productIds[0]) ? context.variantId : null), quantity: args.quantity ?? null, cartScope: !productIds.length });
    }
    if (name === 'simulate_offers') {
      const add = Array.isArray(args.add) ? args.add.slice(0, 4) : [];
      if (add.some((a) => !ids.has(a?.product_id))) return { status: 'unknown', reason: 'product_not_resolved' };
      return simulateOffers(cart, data, { add: add.map((a) => ({ ...a, product_id: shopifyIds.get(a.product_id) ?? a.product_id })) }, { baseCurrency });
    }
    const code = typeof args.code === 'string' ? args.code.toUpperCase() : null;
    // A « code » that is the name of a public automatic offer means that offer.
    const automatic = code ? (data?.promotions ?? []).filter((p) => p.method === 'automatic' && p.title?.trim().toUpperCase() === code) : [];
    if (automatic.length === 1) return evaluatePromotionsForCart(cart, data, { promotion_ids: [automatic[0].id] }, { baseCurrency });
    const typedAsWord = code && /^[A-Z0-9_-]{1,80}$/.test(code) && new RegExp('(?<![A-Za-z0-9_-])' + code + '(?![A-Za-z0-9_-])', 'i').test(message);
    if (code && !typedAsWord && !cart?.codes?.includes(code)) return { status: 'not_found', reason: 'code_not_supplied_by_customer', promotions: [] };
    const promotionIds = Array.isArray(args.promotion_ids) ? args.promotion_ids.filter((id) => typeof id === 'string').slice(0, 12) : [];
    return evaluatePromotionsForCart(cart, data, { code, promotion_ids: promotionIds }, { baseCurrency });
  }
  /**
   * Public offers the message names: by its percentage (« 30 % »), its name,
   * the product it gives (« l'offre qui donne une Eau Qi ») or its spend
   * threshold (« dès 65 € »). A product is recognised by the short name before
   * the title's dash, as customers say it.
   */
  async function namedOffers() {
    const data = await load();
    if (data?.status !== 'ok') return [];
    const listed = getActivePromotions(data, { limit: 12 }).promotions;
    const plain = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const text = plain(message);
    const percentages = [...message.matchAll(/(\d{1,3})\s*(?:%|percent|pour\s?cent)/gi)].map((m) => Number(m[1]));
    const numbers = [...message.matchAll(/(?<![\d.,])(\d{1,4})(?:[.,]\d{1,2})?(?![\d%])/g)].map((m) => Number(m[1]));
    const short = (title) => plain(title).split(/\s+[–-]\s+/)[0].trim();
    const givesNamed = (p) => Array.isArray(p.reward?.items) && p.reward.items.some((t) => short(t).length > 3 && text.includes(short(t)));
    const spendNamed = (p) => [p.requires?.spend, p.minimum?.amount].some((a) => Number.isFinite(a) && a > 0 && numbers.includes(Math.round(a)));
    return listed
      .filter((p) => percentages.includes(Math.round(p.reward?.percentage ?? -1)) || (p.name && p.name.length > 3 && text.includes(plain(p.name))) || givesNamed(p) || spendNamed(p) && (p.requires || givesNamed(p)))
      .map((p) => p.promotion_id);
  }
  async function run(name, args = {}) {
    const result = await execute(name, args);
    for (const p of result.promotions ?? []) if (p.code) returnedCodes.add(p.code.toUpperCase());
    for (const code of result.applied_codes ?? []) returnedCodes.add(code.toUpperCase());
    for (const set of [result.best, ...(result.alternatives ?? [])]) for (const o of set?.offers ?? []) if (o.code) returnedCodes.add(o.code.toUpperCase());
    return result;
  }
  return {
    run,
    /** What the cart's discounts were and whether each matched an offer (codes never named). */
    async cartDiscounts() {
      const data = await load();
      return data?.status === 'ok' ? cartDiscountTrace(cart, data) : null;
    },
    /** Offer names must be known before the backstop runs, even when no shopping tool did. */
    async beforeSanitize(text) {
      if (/\b(?=[A-Z0-9_-]*\d)[A-Z][A-Z0-9_-]{2,79}\b/.test(text ?? '')) await load().catch(() => null);
    },
    sanitizeReply(text, replyLanguage = 'fr') {
      const placeholder = replyLanguage?.startsWith('en') ? 'that code' : replyLanguage?.startsWith('es') ? 'ese código' : 'ce code';
      const typedNow = new Set((message.match(/(?<![A-Za-z0-9_-])[A-Za-z][A-Za-z0-9_-]{2,79}(?![A-Za-z0-9_-])/g) ?? []).filter((w) => /\d/.test(w)).map((w) => w.toUpperCase()));
      const candidates = new Set([...(cart?.codes ?? []), ...(cart?.discounts ?? []).filter((d) => d.type === 'code').map((d) => d.title), ...requestedCodes()]);
      for (const body of [text, ...history.map((h) => h.content ?? '')]) {
        for (const m of body.matchAll(/\bcode\s+(?:promo\s+)?[«"']?([A-Z][A-Z0-9_-]{2,79})\b/g)) candidates.add(m[1]);
        for (const m of body.match(/\b(?=[A-Z0-9_-]*\d)[A-Z][A-Z0-9_-]{2,79}\b/g) ?? []) candidates.add(m);
      }
      for (const code of candidates) {
        // A code the customer typed in THIS message is theirs: repeating it back
        // discloses nothing (« le code ce code » read as broken, 2026-10-07).
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(code) || returnedCodes.has(code.toUpperCase()) || offerNames.has(code.toUpperCase()) || typedNow.has(code.toUpperCase())) continue;
        const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp('(?<![A-Za-z0-9_-])' + escaped + '(?![A-Za-z0-9_-])', 'gi'), placeholder);
      }
      return text;
    },
    addResolved(product) { ids.add(product.id); shopifyIds.set(product.id, product.shopifyId); if (product.handle === context.productHandle) pageIds.add(product.id); },
    async opening() {
      const previous = [...history].reverse().find((m) => m.role === 'assistant');
      const previousUser = [...history].reverse().find((m) => m.role === 'user');
      const shippingTerms = /free\s+(?:shipping|delivery)|livraison\s+(?:gratuite|offerte)|frais\s+de\s+port\s+(?:offerts|gratuits)/i;
      const shippingOffer = shippingTerms.test(message) || Boolean(countryAnswer(message) && (previous?.context?.trace?.shopping?.topics?.includes('free_shipping') || previous?.context?.trace?.knowledge?.topics?.includes('delivery') && shippingTerms.test(previousUser?.content ?? '')));
      // A follow-up that came WITH a cart, right after a reply built on shopping
      // data, is still about the cart even without a shopping word.
      const followsShopping = Boolean(cartContract.normalizeSnapshot(cart) && previous?.context?.trace?.shopping);
      if (!shippingOffer && !followsShopping && !needsShoppingContext(message, null, context)) return null;
      // « why did the 30 percent off not apply? »: an amount names an offer.
      const discountAmount = /\d+\s*(?:%|percent|pour\s?cent)|\b\d+\s*off\b/i.test(message);
      const withCart = Boolean(cartContract.normalizeSnapshot(cart));
      if ((followsShopping && !needsShoppingContext(message, null, context)) || (withCart && discountAmount)) {
        const results = [];
        results.push({ tool: 'get_cart_context', result: await run('get_cart_context') });
        // THE OFFER THE CUSTOMER MEANT, evaluated on its own and marked so: left to
        // the model, « 30 percent » was linked to September Rose on one run and
        // answered « which promotion do you mean? » on the next (2026-10-06).
        const named = await namedOffers();
        if (named.length) {
          const result = await run('evaluate_promotions_for_cart', { promotion_ids: named });
          results.push({ tool: 'evaluate_promotions_for_cart', result: { ...result, mentioned_by_customer: true } });
        } else {
          results.push({ tool: 'evaluate_promotions_for_cart', result: await run('evaluate_promotions_for_cart') });
        }
        return { route: 'shopping_context', topics: ['follow_up'], results: await withBest(results) };
      }
      const results = [];
      const add = async (tool, args = {}) => results.push({ tool, result: await run(tool, args) });
      if (shippingOffer) {
        await add('get_active_promotions', { topic: 'free_shipping' });
        // With a cart, « ai-je droit à la livraison gratuite ? » is answered, not just described.
        const offerIds = (results[0].result.promotions ?? []).map((p) => p.promotion_id).filter(Boolean);
        if (offerIds.length && cartContract.normalizeSnapshot(cart)) await add('evaluate_promotions_for_cart', { promotion_ids: offerIds });
        return { route: 'shopping_context', topics: ['free_shipping'], results };
      }
      if (/panier|cart|basket|déjà|deja|appliqu|reduction|réduction|discount/i.test(message) || context.pageType === 'cart' && cartContract.needsCartSnapshot(message, null, context)) await add('get_cart_context');
      if (/stock|disponib|availab/i.test(message) && !/\b(offres?|promotions?|offers?|codes?)\s+(?:sont\s+)?(?:disponib|availab)/i.test(message)) {
        const q = message.match(/(?:prends?|prendre|acheter|commande|veux|want|buy)\s+(\d{1,3}|un|une|deux|trois|quatre|cinq|two|three)\b/i)?.[1]?.toLowerCase();
        const quantity = q ? Number(q) || ({ un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, two: 2, three: 3 })[q] : undefined;
        await add('get_stock_context', /panier|cart|basket|tout|everything/i.test(message) || !ids.size ? {} : { product_ids: [...ids], ...(quantity ? { quantity } : {}) });
      }
      if (/promo|offre|offer|code|cumul|stack|remise|discount|réduction|reduction/i.test(message)) {
        const codes = requestedCodes();
        if (codes.length) for (const code of codes) await add('evaluate_promotions_for_cart', { code });
        else if (/panier|cart|basket|cumul|stack|manque|fonctionn|appliqu|réduction|reduction|remise|discount/i.test(message)) await add('evaluate_promotions_for_cart');
        else {
          await add('get_active_promotions');
          // WITH A CART, AN OFFERS QUESTION IS ALSO AN ELIGIBILITY QUESTION.
          // « Quelle offre puis-je avoir ? » listed the free delivery and then
          // said « je ne peux pas confirmer » about the cart it had been sent
          // (dev store, 2026-10-06). The same rule the widget uses to decide
          // whether to send the cart decides here: « quelles offres en ce
          // moment ? » stays a listing, « quelle offre puis-je avoir ? » does not.
          const offerIds = (results.at(-1).result.promotions ?? []).map((p) => p.promotion_id).filter(Boolean);
          if (offerIds.length && cartContract.normalizeSnapshot(cart) && cartContract.needsCartSnapshot(message, null, context)) {
            await add('evaluate_promotions_for_cart', { promotion_ids: offerIds });
          }
        }
        if (codes.length > 1) {
          const promotion_ids = [...new Set(results.flatMap(({ result }) => result.promotions ?? []).map((p) => p.promotion_id))];
          if (promotion_ids.length > 1) await add('evaluate_promotions_for_cart', { promotion_ids });
        }
      }
      // A SHOPPING QUESTION WITH A CART NEVER OPENS EMPTY. « Why did September
      // Rose apply to my checkout and not the … free Eau Qi » matched none of
      // the words above and fetched nothing; the model then answered « cannot
      // confirm » (dev store, 2026-10-06). Word lists miss phrasings and
      // languages; the cart and its evaluation are the safe default.
      if (!results.length && cartContract.normalizeSnapshot(cart)) {
        await add('get_cart_context');
        await add('evaluate_promotions_for_cart');
      }
      return { route: 'shopping_context', results: await withBest(results) };
    }
  };
  /**
   * WHY ONE OFFER AND NOT ANOTHER is a combination question: « why did
   * September Rose apply and not the free Eau Qi? » was answered « cannot
   * confirm » with the whole cart in hand (dev store, 2026-10-06). Every
   * evaluation of a real cart therefore comes with the combination Shopify
   * keeps. In memory, about a millisecond.
   */
  async function withBest(results) {
    if (!cartContract.normalizeSnapshot(cart) || !results.some((r) => r.tool === 'evaluate_promotions_for_cart' && r.result?.status === 'ok')) return results;
    const best = await run('simulate_offers');
    if (best.status !== 'ok') return results;
    // On the offer itself, not in a separate result the model has to connect:
    // the reply « TEST02 ne s'applique pas car vos articles ont déjà September
    // Rose » stopped there, with the comparison one result away (2026-10-06).
    const named = new Set(await namedOffers());
    const notChosen = new Map((best.not_chosen ?? []).filter((n) => n.possible).map((n) => [n.promotion_id, n]));
    const annotate = (result) => result?.status === 'ok' && Array.isArray(result.promotions) ? { ...result, promotions: result.promotions.map((p) => ({
      ...p,
      ...(named.has(p.promotion_id) ? { mentioned_by_customer: true } : {}),
      ...(p.status !== 'applied' && notChosen.has(p.promotion_id) ? { not_chosen_by_shopify: { applied_instead: best.best.offers.filter((o) => o.class !== 'SHIPPING').map((o) => o.name), saving_applied: notChosen.get(p.promotion_id).saving_chosen, saving_if_this_offer: notChosen.get(p.promotion_id).saving_with_it, would_combine_with: notChosen.get(p.promotion_id).set_with_it.filter((n) => n !== p.name) } } : {})
    })) } : result;
    return [...results.map((r) => r.tool === 'evaluate_promotions_for_cart' ? { ...r, result: annotate(r.result) } : r), { tool: 'simulate_offers', result: best }];
  }
}
