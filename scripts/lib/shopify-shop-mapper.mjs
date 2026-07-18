import { stripUndefined } from './collections.mjs';

export function mapShop(shop, config) {
  return {
    shopify_shop_id: shop.id,
    shop_domain: shop.myshopifyDomain || config.shopDomain,
    shop_name: shop.name,
    environment: config.appEnv,
    sync_cursors: {},
    app_settings: {},
    raw_shopify_payload: stripUndefined({
      id: shop.id,
      name: shop.name,
      myshopifyDomain: shop.myshopifyDomain
    })
  };
}
