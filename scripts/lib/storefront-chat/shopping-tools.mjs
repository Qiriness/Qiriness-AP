import { evaluatePromotionsForCart, getActivePromotions, getCartContext, getStockContext, needsShoppingContext } from './shopping-evaluator.mjs';
import cartContract from '../../../storefront-app/extensions/storefront-advisor/assets/advisor-cart.js';
import { countryAnswer } from './knowledge-topics.mjs';

export const SHOPPING_TOOL_NAMES = ['get_cart_context', 'get_stock_context', 'get_active_promotions', 'evaluate_promotions_for_cart'];
export function shoppingToolDefinitions() {
  const definition = (name, description, properties = {}) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, additionalProperties: false } } });
  return [
    definition('get_cart_context', 'Read the current cart snapshot. No modifications. Prices, totals and public applied discounts only.'),
    definition('get_stock_context', 'Read synced variant inventory for the cart or products already resolved this turn. Never infer stock from descriptions.', { product_ids: { type: 'array', items: { type: 'string' }, maxItems: 8 }, variant_id: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 999 } }),
    definition('get_active_promotions', 'List current public offers. free_shipping returns published promotion terms only, never a delivery cost estimate or cart eligibility.', { limit: { type: 'integer', minimum: 1, maximum: 12 }, topic: { type: 'string', enum: ['non_shipping', 'free_shipping'] } }),
    definition('evaluate_promotions_for_cart', 'Determine eligibility and combinations from current cart and public promotion rules. Unknown means do not infer. Code must be explicitly supplied by the shopper; no private-code lookup.', { code: { type: 'string', maxLength: 80 }, promotion_ids: { type: 'array', items: { type: 'string' }, maxItems: 12 } })
  ];
}

/** A lazy reader shared by opening retrieval and tools within ONE turn. */
export function createShoppingTurn({ readShopping, readPublicPromotions = null, shopDomain, cart, context = {}, message = '', history = [], resolvedProducts = [], baseCurrency = null }) {
  let source;
  const load = () => source ??= Promise.resolve().then(() => readShopping(shopDomain)).catch(() => ({ status: 'unavailable', reason: 'shopping_source_unavailable' }));
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
    const code = typeof args.code === 'string' ? args.code.toUpperCase() : null;
    const typedAsWord = code && /^[A-Z0-9_-]{1,80}$/.test(code) && new RegExp('(?<![A-Za-z0-9_-])' + code + '(?![A-Za-z0-9_-])', 'i').test(message);
    if (code && !typedAsWord && !cart?.codes?.includes(code)) return { status: 'not_found', reason: 'code_not_supplied_by_customer', promotions: [] };
    const promotionIds = Array.isArray(args.promotion_ids) ? args.promotion_ids.filter((id) => typeof id === 'string').slice(0, 12) : [];
    return evaluatePromotionsForCart(cart, data, { code, promotion_ids: promotionIds }, { baseCurrency });
  }
  async function run(name, args = {}) {
    const result = await execute(name, args);
    for (const p of result.promotions ?? []) if (p.code) returnedCodes.add(p.code.toUpperCase());
    for (const code of result.applied_codes ?? []) returnedCodes.add(code.toUpperCase());
    return result;
  }
  return {
    run,
    sanitizeReply(text, replyLanguage = 'fr') {
      const placeholder = replyLanguage?.startsWith('en') ? 'that code' : replyLanguage?.startsWith('es') ? 'ese código' : 'ce code';
      const candidates = new Set([...(cart?.codes ?? []), ...(cart?.discounts ?? []).filter((d) => d.type === 'code').map((d) => d.title), ...requestedCodes()]);
      for (const body of [text, ...history.map((h) => h.content ?? '')]) {
        for (const m of body.matchAll(/\bcode\s+(?:promo\s+)?[«"']?([A-Z][A-Z0-9_-]{2,79})\b/g)) candidates.add(m[1]);
        for (const m of body.match(/\b(?=[A-Z0-9_-]*\d)[A-Z][A-Z0-9_-]{2,79}\b/g) ?? []) candidates.add(m);
      }
      for (const code of candidates) {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(code) || returnedCodes.has(code.toUpperCase())) continue;
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
      if (!shippingOffer && !needsShoppingContext(message, null, context)) return null;
      const results = [];
      const add = async (tool, args = {}) => results.push({ tool, result: await run(tool, args) });
      if (shippingOffer) {
        await add('get_active_promotions', { topic: 'free_shipping' });
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
        else await add('get_active_promotions');
        if (codes.length > 1) {
          const promotion_ids = [...new Set(results.flatMap(({ result }) => result.promotions ?? []).map((p) => p.promotion_id))];
          if (promotion_ids.length > 1) await add('evaluate_promotions_for_cart', { promotion_ids });
        }
      }
      return { route: 'shopping_context', results };
    }
  };
}
