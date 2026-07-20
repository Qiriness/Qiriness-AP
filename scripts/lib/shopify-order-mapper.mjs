import { stripUndefined } from './collections.mjs';
import { hashIdentifier } from './compliance-audit.mjs';
import { cleanJsonValue, cleanTextValue } from './text-cleaning.mjs';

const ACTIVE_RETURN_STATUSES = new Set(['OPEN', 'REQUESTED']);
const TERMINAL_RETURN_STATUSES = new Set(['CANCELED', 'CLOSED', 'DECLINED']);

export function mapOrder(order, shopId, syncedAt, customerIdByShopifyId = new Map()) {
  const customer = order.customer || null;
  const customerShopifyId = customer?.id || null;
  const lineItems = order.lineItems?.nodes || [];
  const fulfillments = order.fulfillments || [];
  const returns = order.returns?.nodes || [];
  const refunds = order.refunds || [];
  const retention = calculateOrderRetention(order);

  return stripUndefined({
    shop_id: shopId,
    customer_id: customerShopifyId ? customerIdByShopifyId.get(customerShopifyId) || null : null,
    shopify_order_id: order.id,
    shopify_customer_id: customerShopifyId,
    legacy_resource_id: order.legacyResourceId ? String(order.legacyResourceId) : null,
    name: order.name,
    order_number: integerValue(order.number),
    source_name: cleanTextValue(order.sourceName),
    sales_channel: cleanTextValue(order.attribution?.displayName || sourceNameDisplay(order.sourceName)),
    sales_channel_handle: cleanTextValue(order.attribution?.handle || order.sourceName),
    financial_status: order.displayFinancialStatus,
    fulfillment_status: order.displayFulfillmentStatus,
    return_status: order.returnStatus,
    order_status: deriveOrderStatus(order, retention),
    cancel_reason: order.cancelReason,
    currency_code: order.currencyCode,
    presentment_currency_code: order.presentmentCurrencyCode,
    subtotal_price: moneyAmount(order.subtotalPriceSet?.shopMoney),
    total_discounts: moneyAmount(order.totalDiscountsSet?.shopMoney),
    total_shipping_price: moneyAmount(order.totalShippingPriceSet?.shopMoney),
    total_tax: moneyAmount(order.totalTaxSet?.shopMoney),
    total_price: moneyAmount(order.totalPriceSet?.shopMoney),
    total_refunded: moneyAmount(order.totalRefundedSet?.shopMoney),
    total_outstanding: moneyAmount(order.totalOutstandingSet?.shopMoney),
    total_weight_grams: integerValue(order.totalWeight),
    tags: cleanJsonValue(order.tags || []),
    customer_email_hash: hashIdentifier(order.email),
    customer_phone_hash: hashIdentifier(order.phone),
    shipping_destination: shippingDestination(order.shippingAddress),
    line_items: cleanJsonValue(lineItems.map(mapLineItem)),
    fulfillments: cleanJsonValue(fulfillments.map(mapFulfillment)),
    returns: cleanJsonValue(returns.map(mapReturn)),
    refunds: cleanJsonValue(refunds.map(mapRefund)),
    delivered_at: retention.deliveredAt,
    return_refund_opened_at: retention.returnRefundOpenedAt,
    return_refund_completed_at: retention.returnRefundCompletedAt,
    retention_rule: retention.retentionRule,
    retention_delete_after: retention.retentionDeleteAfter,
    processed_at: order.processedAt,
    cancelled_at: order.cancelledAt,
    closed_at: order.closedAt,
    shopify_created_at: order.createdAt,
    shopify_updated_at: order.updatedAt,
    synced_at: syncedAt,
    raw_shopify_payload: buildOrderRawPayload(order)
  });
}

export function calculateOrderRetention(order) {
  const fulfillments = order.fulfillments || [];
  const returns = order.returns?.nodes || [];
  const refunds = order.refunds || [];
  const orderAnchor = order.processedAt || order.createdAt;

  const deliveredAt = latestDate(
    fulfillments
      .filter((fulfillment) => fulfillment.deliveredAt)
      .map((fulfillment) => fulfillment.deliveredAt)
  );
  const returnRefundOpenedAt = earliestDate([
    ...returns.map((returnItem) => returnItem.createdAt),
    ...refunds.map((refund) => refund.createdAt || refund.processedAt)
  ]);
  const returnRefundCompletedAt = latestDate([
    ...returns
      .filter((returnItem) => isTerminalReturn(returnItem))
      .map((returnItem) => returnItem.closedAt || returnItem.requestApprovedAt || returnItem.createdAt),
    ...refunds.map((refund) => refund.processedAt || refund.updatedAt || refund.createdAt)
  ]);

  if (hasActiveReturnOrRefund(order, returns, refunds)) {
    return {
      deliveredAt,
      returnRefundOpenedAt,
      returnRefundCompletedAt: null,
      retentionRule: 'return_refund_open_plus_6_months',
      retentionDeleteAfter: addMonths(returnRefundOpenedAt || orderAnchor, 6)
    };
  }

  if (returnRefundCompletedAt) {
    return {
      deliveredAt,
      returnRefundOpenedAt,
      returnRefundCompletedAt,
      retentionRule: 'return_refund_completed_plus_3_months',
      retentionDeleteAfter: addMonths(returnRefundCompletedAt, 3)
    };
  }

  if (deliveredAt) {
    return {
      deliveredAt,
      returnRefundOpenedAt: null,
      returnRefundCompletedAt: null,
      retentionRule: 'delivered_plus_3_months',
      retentionDeleteAfter: addMonths(deliveredAt, 3)
    };
  }

  return {
    deliveredAt: null,
    returnRefundOpenedAt: null,
    returnRefundCompletedAt: null,
    retentionRule: 'undelivered_plus_6_months',
    retentionDeleteAfter: addMonths(orderAnchor, 6)
  };
}

export function deriveOrderStatus(order, retention = calculateOrderRetention(order)) {
  if (order.cancelledAt || order.cancelReason) {
    return 'cancelled';
  }

  if (retention.retentionRule === 'return_refund_open_plus_6_months') {
    return 'return_refund_in_progress';
  }

  if (retention.retentionRule === 'return_refund_completed_plus_3_months') {
    return 'return_refund_completed';
  }

  if (retention.deliveredAt) {
    return 'delivered';
  }

  if ((order.fulfillments || []).some((fulfillment) => fulfillment.inTransitAt)) {
    return 'in_transit';
  }

  const fulfillmentStatus = String(order.displayFulfillmentStatus || '').toUpperCase();
  if (fulfillmentStatus.includes('PARTIAL')) {
    return 'partially_fulfilled';
  }
  if (fulfillmentStatus.includes('FULFILLED')) {
    return 'fulfilled';
  }
  if (fulfillmentStatus.includes('UNFULFILLED')) {
    return 'unfulfilled';
  }

  if (order.closedAt) {
    return 'closed';
  }

  return 'open';
}

function hasActiveReturnOrRefund(order, returns, refunds) {
  if (returns.some((returnItem) => ACTIVE_RETURN_STATUSES.has(returnItem.status))) {
    return true;
  }

  if (order.returnStatus && !['NO_RETURN', 'RETURNED', 'RETURN_FAILED'].includes(order.returnStatus)) {
    return true;
  }

  return refunds.some((refund) => !refund.processedAt);
}

function isTerminalReturn(returnItem) {
  return TERMINAL_RETURN_STATUSES.has(returnItem.status) || Boolean(returnItem.closedAt);
}

function mapLineItem(lineItem) {
  return stripUndefined({
    id: lineItem.id,
    name: cleanTextValue(lineItem.name),
    title: cleanTextValue(lineItem.title),
    sku: cleanTextValue(lineItem.sku),
    quantity: lineItem.quantity,
    current_quantity: lineItem.currentQuantity,
    unfulfilled_quantity: lineItem.unfulfilledQuantity,
    refundable_quantity: lineItem.refundableQuantity,
    fulfillment_status: lineItem.fulfillmentStatus,
    requires_shipping: lineItem.requiresShipping,
    vendor: cleanTextValue(lineItem.vendor),
    variant_title: cleanTextValue(lineItem.variantTitle),
    product_id: lineItem.product?.id,
    variant_id: lineItem.variant?.id,
    discounted_total: moneyAmount(lineItem.discountedTotalSet?.shopMoney),
    original_total: moneyAmount(lineItem.originalTotalSet?.shopMoney),
    currency_code: lineItem.discountedTotalSet?.shopMoney?.currencyCode
  });
}

function mapFulfillment(fulfillment) {
  return stripUndefined({
    id: fulfillment.id,
    name: cleanTextValue(fulfillment.name),
    status: fulfillment.status,
    display_status: fulfillment.displayStatus,
    total_quantity: fulfillment.totalQuantity,
    created_at: fulfillment.createdAt,
    updated_at: fulfillment.updatedAt,
    in_transit_at: fulfillment.inTransitAt,
    estimated_delivery_at: fulfillment.estimatedDeliveryAt,
    delivered_at: fulfillment.deliveredAt,
    tracking_info: (fulfillment.trackingInfo || []).map((tracking) => stripUndefined({
      company: cleanTextValue(tracking.company),
      number: cleanTextValue(tracking.number),
      url: tracking.url
    }))
  });
}

function mapReturn(returnItem) {
  return stripUndefined({
    id: returnItem.id,
    name: cleanTextValue(returnItem.name),
    status: returnItem.status,
    created_at: returnItem.createdAt,
    closed_at: returnItem.closedAt,
    request_approved_at: returnItem.requestApprovedAt
  });
}

function mapRefund(refund) {
  return stripUndefined({
    id: refund.id,
    legacy_resource_id: refund.legacyResourceId ? String(refund.legacyResourceId) : null,
    created_at: refund.createdAt,
    processed_at: refund.processedAt,
    updated_at: refund.updatedAt,
    total_refunded: moneyAmount(refund.totalRefundedSet?.shopMoney),
    currency_code: refund.totalRefundedSet?.shopMoney?.currencyCode,
    return_id: refund.return?.id
  });
}

function shippingDestination(address) {
  if (!address) {
    return {};
  }

  return cleanJsonValue(stripUndefined({
    city: address.city,
    province: address.province,
    country: address.country,
    country_code: address.countryCodeV2,
    formatted_area: address.formattedArea
  }));
}

function buildOrderRawPayload(order) {
  return cleanJsonValue(stripUndefined({
    id: order.id,
    legacyResourceId: order.legacyResourceId,
    name: order.name,
    number: order.number,
    sourceName: order.sourceName,
    attribution: order.attribution,
    displayFinancialStatus: order.displayFinancialStatus,
    displayFulfillmentStatus: order.displayFulfillmentStatus,
    returnStatus: order.returnStatus,
    cancelReason: order.cancelReason,
    currencyCode: order.currencyCode,
    presentmentCurrencyCode: order.presentmentCurrencyCode,
    tags: order.tags,
    processedAt: order.processedAt,
    cancelledAt: order.cancelledAt,
    closedAt: order.closedAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    customer: order.customer ? { id: order.customer.id } : null,
    shippingAddress: shippingDestination(order.shippingAddress),
    totals: {
      subtotalPriceSet: order.subtotalPriceSet,
      totalDiscountsSet: order.totalDiscountsSet,
      totalShippingPriceSet: order.totalShippingPriceSet,
      totalTaxSet: order.totalTaxSet,
      totalPriceSet: order.totalPriceSet,
      totalRefundedSet: order.totalRefundedSet,
      totalOutstandingSet: order.totalOutstandingSet,
      totalWeight: order.totalWeight
    },
    lineItems: (order.lineItems?.nodes || []).map(mapLineItem),
    fulfillments: (order.fulfillments || []).map(mapFulfillment),
    returns: (order.returns?.nodes || []).map(mapReturn),
    refunds: (order.refunds || []).map(mapRefund)
  }));
}

function sourceNameDisplay(sourceName) {
  const normalized = normalizeSourceName(sourceName);
  const labels = {
    web: 'Online Store',
    pos: 'POS',
    shopify_draft_order: 'Draft Order',
    iphone: 'Mobile App',
    android: 'Mobile App',
    mobile_app: 'Mobile App'
  };
  return labels[normalized] || cleanTextValue(sourceName);
}

function normalizeSourceName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function moneyAmount(value) {
  const parsed = Number.parseFloat(value?.amount);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function earliestDate(values) {
  return selectDate(values, (left, right) => left < right);
}

function latestDate(values) {
  return selectDate(values, (left, right) => left > right);
}

function selectDate(values, compare) {
  let selected = null;

  for (const value of values) {
    if (!value) {
      continue;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      continue;
    }
    if (!selected || compare(date, selected)) {
      selected = date;
    }
  }

  return selected ? selected.toISOString() : null;
}

function addMonths(value, months) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString();
}
