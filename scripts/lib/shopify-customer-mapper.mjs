import { stripUndefined } from './collections.mjs';
import { cleanJsonValue, cleanTextValue } from './text-cleaning.mjs';

const EMAIL_MARKETING_LIST_STATE = 'SUBSCRIBED';

export function mapCustomer(customer, shopId, syncedAt) {
  const email = customer.defaultEmailAddress || null;
  const phone = customer.defaultPhoneNumber || null;
  const address = customer.defaultAddress || null;
  const lastOrder = customer.lastOrder || null;
  const amountSpent = moneyAmount(customer.amountSpent);
  const numberOfOrders = integerValue(customer.numberOfOrders) || 0;

  return stripUndefined({
    shop_id: shopId,
    shopify_customer_id: customer.id,
    legacy_resource_id: customer.legacyResourceId ? String(customer.legacyResourceId) : null,
    display_name: cleanTextValue(customer.displayName),
    first_name: cleanTextValue(customer.firstName),
    last_name: cleanTextValue(customer.lastName),
    email: cleanTextValue(email?.emailAddress),
    phone: cleanTextValue(phone?.phoneNumber),
    locale: customer.locale,
    state: customer.state,
    verified_email: customer.verifiedEmail,
    valid_email_address: email?.validFormat,
    tags: cleanJsonValue(customer.tags || []),
    email_marketing_state: email?.marketingState,
    email_marketing_opt_in_level: email?.marketingOptInLevel,
    email_marketing_consent_updated_at: email?.marketingUpdatedAt,
    default_address_city: cleanTextValue(address?.city),
    default_address_province: cleanTextValue(address?.province),
    default_address_country: cleanTextValue(address?.country),
    default_address_country_code: address?.countryCodeV2,
    default_address_formatted_area: cleanTextValue(address?.formattedArea),
    number_of_orders: numberOfOrders,
    amount_spent: amountSpent,
    amount_spent_currency: customer.amountSpent?.currencyCode,
    last_order_id: lastOrder?.id,
    last_order_name: lastOrder?.name,
    last_order_at: lastOrder?.createdAt,
    last_order_total: moneyAmount(lastOrder?.currentTotalPriceSet?.shopMoney),
    last_order_currency: lastOrder?.currentTotalPriceSet?.shopMoney?.currencyCode,
    rfm_group: customer.statistics?.rfmGroup,
    synced_at: syncedAt,
    shopify_created_at: customer.createdAt,
    shopify_updated_at: customer.updatedAt,
    // NOT WRITTEN SINCE 2026-10-06: no code read it, and every field it held is a
    // typed column. It was 39 MB on customers and 12 MB on orders of a 500 MB
    // plan. `{}` rather than null, for the column's object check.
    raw_shopify_payload: {}
  });
}

function moneyAmount(value) {
  const parsed = Number.parseFloat(value?.amount);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integerValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isOnEmailMarketingList(customerRow) {
  return customerRow.email_marketing_state === EMAIL_MARKETING_LIST_STATE;
}
