import { stripUndefined } from './collections.mjs';
import { cleanJsonValue, cleanTextValue } from './text-cleaning.mjs';

const CODE_DISCOUNT_TYPES = new Set([
  'DiscountCodeBasic',
  'DiscountCodeBxgy',
  'DiscountCodeFreeShipping',
  'DiscountCodeApp'
]);

/**
 * ONE ROW PER DISCOUNT, with the redeem codes carried inside it.
 *
 * This used to return one row per CODE, which on a real store meant the same
 * discount duplicated up to 600 times — 324 discounts became 7,512 rows and a
 * 22 MB table, 4.4 MB of it the identical rule_snapshot copied over and over.
 *
 * The per-code usage count is the one thing that genuinely varies, so it travels
 * inside the codes array rather than being dropped: most of this store's codes
 * are single-use, and "you have already used this code" is the promotion tool's
 * most actionable answer.
 */
export function mapPromotionRows(discountNode, shopId, syncedAt) {
  const discount = discountNode.discount || {};
  const method = CODE_DISCOUNT_TYPES.has(discount.__typename) ? 'code' : 'automatic';
  const redeemCodes = method === 'code' ? discount.codes?.nodes || [] : [];

  // Still an array: the sync upserts pages of rows, and returning one keeps that
  // contract unchanged now that the fan-out has gone.
  return [mapPromotionRow({ discountNode, discount, redeemCodes, method, shopId, syncedAt })];
}

function mapPromotionRow({ discountNode, discount, redeemCodes, method, shopId, syncedAt }) {
  const sourceAppName = cleanTextValue(
    redeemCodes[0]?.createdBy?.title || discount.appDiscountType?.app?.title || null
  );
  // The discount node, always — there is no longer a row per redeem code.
  const promotionKey = discountNode.id;

  return stripUndefined({
    shop_id: shopId,
    shopify_discount_node_id: discountNode.id,
    promotion_key: promotionKey,
    title: cleanTextValue(discount.title) || promotionKey,
    codes: mapRedeemCodes(redeemCodes),
    method,
    discount_type: discount.__typename,
    status: discount.status,
    summary: cleanTextValue(discount.summary),
    short_summary: cleanTextValue(discount.shortSummary),
    starts_at: discount.startsAt,
    ends_at: discount.endsAt,
    usage_limit: integerValue(discount.usageLimit),
    discount_usage_count: integerValue(discount.asyncUsageCount),
    applies_once_per_customer: booleanOrNull(discount.appliesOncePerCustomer),
    discount_classes: cleanJsonValue(discount.discountClasses || []),
    combines_with: cleanJsonValue(combinesWithObject(discount.combinesWith)),
    source_app_name: sourceAppName,
    rule_snapshot: buildRuleSnapshot(discount),
    source_metadata: buildSourceMetadata(discount, redeemCodes[0] || null),
    synced_at: syncedAt,
    shopify_created_at: discount.createdAt,
    shopify_updated_at: discount.updatedAt,
    raw_shopify_payload: buildRawPayload(discountNode, discount, redeemCodes)
  });
}

/**
 * The redeem codes, as stored.
 *
 * Deliberately three fields and no more. Everything else Shopify returns per
 * code is either the discount's (and would be duplicated again) or noise, and
 * this array is repeated once per code — 600 times on the largest discount here.
 */
function mapRedeemCodes(redeemCodes) {
  return cleanJsonValue(
    redeemCodes
      .map((redeemCode) => stripUndefined({
        code: cleanTextValue(redeemCode?.code) || null,
        usage_count: integerValue(redeemCode?.asyncUsageCount),
        redeem_code_id: redeemCode?.id || null
      }))
      .filter((entry) => entry.code)
  );
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
    // The VALUES behind those type names. Without them the snapshot could say a
    // discount had a minimum requirement but never what it was — which made the
    // most common question about a rejected code ("is my basket big enough?")
    // unanswerable. Read by agent/src/retrieval/promotion-rules.mjs.
    minimum_requirement: buildMinimumRequirement(discount.minimumRequirement),
    customer_gets: buildCustomerGets(discount.customerGets),
    customer_buys: buildCustomerBuys(discount.customerBuys),
    customer_selection: buildCustomerSelection(discount.customerSelection),
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

/**
 * The threshold a basket has to clear. Normalised to one shape across both
 * Shopify variants (a quantity or a subtotal) so a consumer does not have to
 * branch on `__typename` to answer "how much more do they need to spend?".
 */
function buildMinimumRequirement(requirement) {
  if (!requirement || !requirement.__typename) {
    return null;
  }
  if (requirement.greaterThanOrEqualToQuantity !== undefined && requirement.greaterThanOrEqualToQuantity !== null) {
    return { type: 'quantity', quantity: integerValue(requirement.greaterThanOrEqualToQuantity) };
  }
  const subtotal = requirement.greaterThanOrEqualToSubtotal;
  if (subtotal) {
    return { type: 'subtotal', amount: subtotal.amount ?? null, currency: subtotal.currencyCode ?? null };
  }
  // A requirement whose shape we do not recognise is recorded as present but
  // unmeasured, so a caller reports "there is a minimum" rather than "there is
  // none".
  return { type: 'unknown' };
}

/** What the customer receives, and which items it applies to. */
function buildCustomerGets(customerGets) {
  if (!customerGets) {
    return null;
  }
  const value = customerGets.value || {};
  return stripUndefined({
    percentage: value.percentage ?? undefined,
    amount: value.amount?.amount ?? undefined,
    currency: value.amount?.currencyCode ?? undefined,
    applies_on_each_item: value.appliesOnEachItem ?? undefined,
    items: buildDiscountItems(customerGets.items)
  });
}

/** What the customer must buy first, for a buy-X-get-Y discount. */
function buildCustomerBuys(customerBuys) {
  if (!customerBuys) {
    return null;
  }
  const value = customerBuys.value || {};
  return stripUndefined({
    quantity: value.quantity ?? undefined,
    amount: value.amount ?? undefined,
    items: buildDiscountItems(customerBuys.items)
  });
}

/**
 * Which products or collections a discount is restricted to. Titles are kept
 * alongside ids: a support reply needs to name the product, and re-resolving an
 * id to a title later would be a second query for something already in hand.
 */
function buildDiscountItems(items) {
  if (!items || !items.__typename) {
    return undefined;
  }
  if (items.allItems) {
    return { scope: 'all' };
  }
  if (Array.isArray(items.products?.nodes)) {
    return {
      scope: 'products',
      products: items.products.nodes.map((node) => ({ id: node.id, title: node.title }))
    };
  }
  if (Array.isArray(items.collections?.nodes)) {
    return {
      scope: 'collections',
      collections: items.collections.nodes.map((node) => ({ id: node.id, title: node.title }))
    };
  }
  return { scope: 'unknown' };
}

/**
 * Who the code is for. `segments` is the one that matters for support: a code
 * restricted to a segment is why a perfectly valid code is rejected for someone
 * outside it, and previously nothing about that was stored at all.
 */
function buildCustomerSelection(selection) {
  if (!selection || !selection.__typename) {
    return null;
  }
  if (selection.allCustomers) {
    return { scope: 'all' };
  }
  if (Array.isArray(selection.segments)) {
    return {
      scope: 'segments',
      segments: selection.segments.map((segment) => ({ id: segment.id, name: segment.name }))
    };
  }
  if (Array.isArray(selection.customers)) {
    // Ids only, never emails or names: this is a promotion rule snapshot, not a
    // customer record.
    return { scope: 'customers', customer_count: selection.customers.length };
  }
  return { scope: 'unknown' };
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

// A sample only — see the note below.
const RAW_PAYLOAD_CODE_SAMPLE = 5;

function buildRawPayload(discountNode, discount, redeemCodes) {
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
    // Capped deliberately. This is a traceability payload, and a bulk discount
    // carries up to 600 codes whose full detail is already in the `codes`
    // column — mirroring all of them here would put the duplication straight
    // back, in the largest jsonb on the row.
    redeemCodes: (redeemCodes || []).slice(0, RAW_PAYLOAD_CODE_SAMPLE).map((redeemCode) => ({
      id: redeemCode.id,
      code: redeemCode.code,
      asyncUsageCount: redeemCode.asyncUsageCount,
      createdBy: redeemCode.createdBy ? { title: redeemCode.createdBy.title } : null
    })),
    redeemCodeCount: (redeemCodes || []).length
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
