import { stripUndefined } from './collections.mjs';
import { cleanJsonValue, cleanTextValue } from './text-cleaning.mjs';

const CODE_DISCOUNT_TYPES = new Set([
  'DiscountCodeBasic',
  'DiscountCodeBxgy',
  'DiscountCodeFreeShipping',
  'DiscountCodeApp'
]);

export function mapPromotionRows(discountNode, shopId, syncedAt) {
  const discount = discountNode.discount || {};
  const method = CODE_DISCOUNT_TYPES.has(discount.__typename) ? 'code' : 'automatic';

  if (method === 'code') {
    const codes = discount.codes?.nodes || [];
    return codes.map((redeemCode) => mapPromotionRow({
      discountNode,
      discount,
      redeemCode,
      method,
      shopId,
      syncedAt
    }));
  }

  return [mapPromotionRow({
    discountNode,
    discount,
    redeemCode: null,
    method,
    shopId,
    syncedAt
  })];
}

function mapPromotionRow({ discountNode, discount, redeemCode, method, shopId, syncedAt }) {
  const sourceAppName = cleanTextValue(
    redeemCode?.createdBy?.title || discount.appDiscountType?.app?.title || null
  );
  const promotionKey = redeemCode?.id || discountNode.id;

  return stripUndefined({
    shop_id: shopId,
    shopify_discount_node_id: discountNode.id,
    shopify_redeem_code_id: redeemCode?.id || null,
    promotion_key: promotionKey,
    title: cleanTextValue(discount.title) || promotionKey,
    code: cleanTextValue(redeemCode?.code) || null,
    method,
    discount_type: discount.__typename,
    status: discount.status,
    summary: cleanTextValue(discount.summary),
    short_summary: cleanTextValue(discount.shortSummary),
    starts_at: discount.startsAt,
    ends_at: discount.endsAt,
    usage_limit: integerValue(discount.usageLimit),
    discount_usage_count: integerValue(discount.asyncUsageCount),
    code_usage_count: integerValue(redeemCode?.asyncUsageCount),
    applies_once_per_customer: booleanOrNull(discount.appliesOncePerCustomer),
    discount_classes: cleanJsonValue(discount.discountClasses || []),
    combines_with: cleanJsonValue(combinesWithObject(discount.combinesWith)),
    source_app_name: sourceAppName,
    rule_snapshot: buildRuleSnapshot(discount),
    source_metadata: buildSourceMetadata(discount, redeemCode),
    synced_at: syncedAt,
    shopify_created_at: discount.createdAt,
    shopify_updated_at: discount.updatedAt,
    raw_shopify_payload: buildRawPayload(discountNode, discount, redeemCode)
  });
}

function buildRuleSnapshot(discount) {
  return cleanJsonValue(stripUndefined({
    discount_type: discount.__typename,
    discount_classes: discount.discountClasses || [],
    combines_with: combinesWithObject(discount.combinesWith),
    customer_gets_type: discount.customerGets?.__typename,
    customer_buys_type: discount.customerBuys?.__typename,
    minimum_requirement_type: discount.minimumRequirement?.__typename,
    destination_selection_type: discount.destinationSelection?.__typename,
    maximum_shipping_price: discount.maximumShippingPrice || null,
    app_discount_type: discount.appDiscountType
      ? {
          app_key: discount.appDiscountType.appKey,
          function_id: discount.appDiscountType.functionId,
          title: discount.appDiscountType.title,
          description: discount.appDiscountType.description,
          discount_classes: discount.appDiscountType.discountClasses || []
        }
      : null
  }));
}

function buildSourceMetadata(discount, redeemCode) {
  return cleanJsonValue(stripUndefined({
    codes_count: integerValue(discount.codesCount?.count),
    code_created_by_app_name: redeemCode?.createdBy?.title,
    app_discount_type_title: discount.appDiscountType?.title,
    app_discount_type_app_name: discount.appDiscountType?.app?.title,
    app_discount_type_app_key: discount.appDiscountType?.appKey
  }));
}

function buildRawPayload(discountNode, discount, redeemCode) {
  return cleanJsonValue(stripUndefined({
    id: discountNode.id,
    discount: stripUndefined({
      __typename: discount.__typename,
      title: discount.title,
      status: discount.status,
      summary: discount.summary,
      shortSummary: discount.shortSummary,
      startsAt: discount.startsAt,
      endsAt: discount.endsAt,
      createdAt: discount.createdAt,
      updatedAt: discount.updatedAt,
      usageLimit: discount.usageLimit,
      asyncUsageCount: discount.asyncUsageCount,
      appliesOncePerCustomer: discount.appliesOncePerCustomer,
      discountClasses: discount.discountClasses,
      combinesWith: combinesWithObject(discount.combinesWith),
      codesCount: discount.codesCount,
      appDiscountType: discount.appDiscountType
        ? {
            title: discount.appDiscountType.title,
            app: discount.appDiscountType.app
              ? { title: discount.appDiscountType.app.title }
              : null,
            appKey: discount.appDiscountType.appKey,
            functionId: discount.appDiscountType.functionId,
            discountClasses: discount.appDiscountType.discountClasses
          }
        : null
    }),
    redeemCode: redeemCode
      ? {
          id: redeemCode.id,
          code: redeemCode.code,
          asyncUsageCount: redeemCode.asyncUsageCount,
          createdBy: redeemCode.createdBy ? { title: redeemCode.createdBy.title } : null
        }
      : null
  }));
}

function combinesWithObject(value) {
  return stripUndefined({
    order_discounts: value?.orderDiscounts,
    product_discounts: value?.productDiscounts,
    shipping_discounts: value?.shippingDiscounts
  });
}

function integerValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}
