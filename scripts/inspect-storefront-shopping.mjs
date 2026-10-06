// Read-only inventory. Never print codes, raw cart payloads, customer/order data or credentials.
import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelectAll } from './lib/supabase-rest-client.mjs';
import { createShoppingReader, createPublicPromotionReader } from './lib/storefront-chat/shopping-repository.mjs';
import { getActivePromotions } from './lib/storefront-chat/shopping-evaluator.mjs';
import { promotionMechanic } from './lib/promotion-mechanic.mjs';
import { parseAllowedShops } from './lib/storefront-chat/app-proxy-signature.mjs';
const env = loadEnv();
const config = loadConfig(env);
const db = createSupabaseClient(config);
const reader = createShoppingReader({ selectAll: (table, filters, columns) => supabaseSelectAll(db, table, filters, columns) });
const allowedShops = parseAllowedShops(env.STOREFRONT_CHAT_ALLOWED_SHOPS);
const [catalogueShop] = await supabaseSelectAll(db, 'shops', { shop_domain: config.shopDomain }, 'id');
const previewReader = createPublicPromotionReader({ selectAll: (table, filters, columns) => supabaseSelectAll(db, table, filters, columns) }, { shopId: catalogueShop?.id, catalogueShopDomain: config.shopDomain, allowedShops });
const domains = [...new Set([config.shopDomain, ...allowedShops])];
for (const domain of domains) {
  const source = await reader(domain);
  if (source.reason === 'shop_not_synced' && allowedShops.has(domain)) {
    const preview = await previewReader(domain);
    console.log(JSON.stringify({ shop: domain, publicOfferPreview: { status: preview.status, activeNonShippingOffers: getActivePromotions(preview, { limit: 12 }).promotions.length, activeFreeShippingOffers: getActivePromotions(preview, { topic: 'free_shipping' }).promotions.length, storeEligibility: 'not_confirmed' } }, null, 2));
  }
  const mechanics = {};
  for (const p of source.promotions ?? []) { const m = promotionMechanic(p); mechanics[m] = (mechanics[m] ?? 0) + 1; }
  console.log(JSON.stringify({ shop: domain, status: source.status, reason: source.reason ?? null, products: source.products?.length ?? 0, variantsWithQuantity: (source.products ?? []).flatMap((p) => p.variants ?? []).filter((v) => Number.isInteger(v.inventory_quantity)).length, publicPromotionCount: source.promotions?.length ?? 0, activePublicPromotionCount: source.promotions?.filter((p) => p.status === 'ACTIVE').length ?? 0, publicMechanics: mechanics, syncedCollections: source.members?.size ?? 0, productSyncRange: (source.products ?? []).map((p) => p.synced_at).filter(Boolean).sort().filter((_, i, all) => i === 0 || i === all.length - 1) }, null, 2));
}
