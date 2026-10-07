/** Shop-scoped, read-only checkout snapshot. No customer/order access or raw payloads. */
export const SHOPPING_PRODUCT_COLUMNS = 'id,shopify_product_id,title,handle,status,published_at,deleted_at,variants,synced_at';
export const SHOPPING_PROMOTION_COLUMNS = 'id,promotion_key,title,codes,method,discount_type,status,starts_at,ends_at,usage_limit,discount_usage_count,applies_once_per_customer,discount_classes,combines_with,rule_snapshot,synced_at,offerable_in_replies,describable_in_replies';
export const SHOPPING_TTL_MS = 30_000;
/**
 * ACTIVE codes of the shop, public or not — ONLY to recognise a code the
 * shopper has ALREADY applied to this cart (`cartCodeRows`). Never listed,
 * offered or evaluated on their own: naming back a code the shopper entered
 * discloses nothing to them, and it is what lets stacking be judged.
 */
export const CART_CODE_COLUMNS = 'id,title,codes,method,discount_type,discount_classes,combines_with,status,starts_at,ends_at';

/** Each agent owns a bounded cache; a missing shop/failure is never cached. */
export function createShoppingReader(db, { now = Date.now, ttlMs = SHOPPING_TTL_MS } = {}) {
  const cache = new Map();
  return async function readShopping(shopDomain) {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain || '')) return { status: 'unavailable', reason: 'shop_unknown' };
    const cached = cache.get(shopDomain);
    if (cached && now() - cached.at < ttlMs) return cached.value;
    const value = (async () => {
      const shops = await db.selectAll('shops', { shop_domain: shopDomain }, 'id');
      if (!shops[0]?.id) return { status: 'unavailable', reason: 'shop_not_synced' };
      const shopId = shops[0].id;
      const live = { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } };
      // Visibility is enforced in the database read, before codes can reach tools/model.
      const [products, codes, automatic, collections, cartCodeRows] = await Promise.all([
        db.selectAll('products', { shop_id: shopId }, SHOPPING_PRODUCT_COLUMNS),
        db.selectAll('promotions', { ...live, method: 'code', offerable_in_replies: true }, SHOPPING_PROMOTION_COLUMNS),
        db.selectAll('promotions', { ...live, method: 'automatic', describable_in_replies: true }, SHOPPING_PROMOTION_COLUMNS),
        db.selectAll('advice_collections', live, 'shopify_collection_id,product_ids,products_synced_at'),
        db.selectAll('promotions', { ...live, method: 'code', status: 'ACTIVE' }, CART_CODE_COLUMNS)
      ]);
      const promotions = [...codes, ...automatic].filter(isPublicPromotion);
      const members = new Map(collections.filter((c) => c.products_synced_at && Array.isArray(c.product_ids)).map((c) => [c.shopify_collection_id, new Set(c.product_ids)]));
      return { status: 'ok', shopDomain, products, promotions, members, cartCodeRows, loadedAt: now() };
    })();
    const entry = { at: now(), value };
    cache.set(shopDomain, entry);
    if (cache.size > 10) cache.delete(cache.keys().next().value);
    value.then((result) => { if (result.status !== 'ok' && cache.get(shopDomain) === entry) cache.delete(shopDomain); }, () => { if (cache.get(shopDomain) === entry) cache.delete(shopDomain); });
    return value;
  };
}

export function isPublicPromotion(p) {
  return p?.method === 'code' ? p.offerable_in_replies === true : p?.method === 'automatic' && p.describable_in_replies === true;
}

/** Brand-offer preview for an explicitly allowed, unsynced storefront. No cart data. */
export function createPublicPromotionReader(db, { shopId = '', catalogueShopDomain = '', allowedShops = new Set(), now = Date.now } = {}) {
  let remembered = null;
  return async function readPublicPromotions(shopDomain) {
    if (!shopId || !catalogueShopDomain || shopDomain === catalogueShopDomain || !allowedShops.has(shopDomain)) return { status: 'unavailable', reason: 'offer_preview_not_allowed' };
    if (remembered && now() - remembered.at < SHOPPING_TTL_MS) return remembered.value;
    const live = { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } };
    const entry = { at: now(), value: Promise.all([
      db.selectAll('promotions', { ...live, method: 'code', offerable_in_replies: true }, SHOPPING_PROMOTION_COLUMNS),
      db.selectAll('promotions', { ...live, method: 'automatic', describable_in_replies: true }, SHOPPING_PROMOTION_COLUMNS)
    ]).then(([codes, automatic]) => ({ status: 'ok', promotions: [...codes, ...automatic].filter(isPublicPromotion), loadedAt: now(), shopDomain: catalogueShopDomain })) };
    remembered = entry;
    entry.value.catch(() => { if (remembered === entry) remembered = null; });
    return entry.value;
  };
}
