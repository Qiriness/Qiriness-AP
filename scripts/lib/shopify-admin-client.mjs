import {
  FALLBACK_RETENTION_MONTHS,
  SYNC_WINDOW_MARGIN_MONTHS
} from './order-retention.mjs';

export const PRODUCT_VARIANT_PAGE_SIZE = 25;
// Products on a real merchandised store carry FAR more metafields than a dev
// fixture. Measured on Qiriness: 49-50 per product, with every field the support
// tools need sitting at positions 29-50 — usage_instructions at 33, faq_list at
// 49, product_ingredients at 50. At the previous cap of 25 all of them were
// silently truncated away, so 112 of 116 products looked like they had no usage
// instructions and no FAQ when in fact the data was there all along.
//
// 100 is double the observed maximum. `metafieldsTruncated` below is what stops
// this ever being silent again if a store goes past it.
export const PRODUCT_METAFIELD_PAGE_SIZE = 100;
export const METAFIELD_REFERENCE_PAGE_SIZE = 10;

/**
 * The most products one page may ask for, whatever `--page-size` says.
 *
 * WHY A CAP HERE AND NOWHERE ELSE. Shopify prices a query before running it and
 * refuses anything over 1000 points, and the price is the product of the `first`
 * values, not of the data: each product carries 25 variants, 100 metafields and
 * 10 references, so this connection costs roughly 33 points per node where a
 * customer costs about 2. Raising the shared `--page-size` to 50 for the nightly
 * therefore cost nothing on customers and orders and broke products outright —
 * `Query cost is 1003, which exceeds the single query max cost limit (1000)`,
 * which is a hard rejection, not a throttle, so no amount of waiting helps.
 *
 * MEASURED against the live shop on 2026-09-12: 30 passed, 40 and 50 were
 * refused. 25 is the cap rather than 30 because the cost is driven by the three
 * constants above — raise `PRODUCT_METAFIELD_PAGE_SIZE` again and 30 becomes the
 * next 1003.
 */
export const PRODUCT_MAX_PAGE_SIZE = 25;
export const ORDER_LINE_ITEM_PAGE_SIZE = 50;
export const ORDER_FULFILLMENT_PAGE_SIZE = 10;
export const ORDER_RETURN_PAGE_SIZE = 10;
export const DISCOUNT_CODE_PAGE_SIZE = 100;

/**
 * Collections per page, and products per collection.
 *
 * BOTH LARGE, BECAUSE THIS CONNECTION IS CHEAP. Shopify prices a query before
 * running it and refuses anything over 1000 points, and the price is the product
 * of the `first` values rather than of the data. A collection node carries a
 * handle, a title and a count, so 250 of them costs about what 8 products cost.
 * Measured on the live shop 2026-09-16: 175 collections in one page.
 *
 * WHY MEMBERSHIP IS NOT ON THE PRODUCT QUERY. The obvious build is
 * `products { collections(first: 50) }` — and it cannot be had. That query is
 * already at the ceiling (`PRODUCT_MAX_PAGE_SIZE` above: 30 passed, 40 refused),
 * and each product sits in 18-30+ collections, so asking for them would multiply
 * a 33-point node by fifty. Read from the collection side instead, where one
 * request answers one collection and only the ACTIVATED ones are ever asked for.
 */
export const COLLECTION_PAGE_SIZE = 250;
export const COLLECTION_PRODUCT_PAGE_SIZE = 250;

const METAOBJECT_DEFINITION_PAGE_SIZE = 50;
const METAOBJECT_PAGE_SIZE = 50;

const DEFAULT_METAOBJECT_DEFINITION_ALIASES = [
  'ingredients list',
  'ingredient list',
  'ingredients',
  'product faq',
  'faq'
];

const SHOP_QUERY = `#graphql
  query ShopSyncMetadata {
    shop {
      id
      name
      myshopifyDomain
      primaryDomain { url }
      customerAccountsV2 { customerAccountsVersion }
      ianaTimezone
    }
  }
`;

const METAOBJECT_DEFINITIONS_QUERY = `#graphql
  query MetaobjectDefinitionSyncPage($first: Int!, $after: String) {
    metaobjectDefinitions(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        type
        fieldDefinitions {
          key
          name
          required
          type {
            name
          }
        }
      }
    }
  }
`;

const METAOBJECTS_BY_TYPE_QUERY = `#graphql
  query MetaobjectSyncPage($type: String!, $first: Int!, $after: String) {
    metaobjects(type: $type, first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        type
        handle
        displayName
        updatedAt
        fields {
          key
          type
          value
          jsonValue
        }
      }
    }
  }
`;

const PRODUCTS_QUERY = `#graphql
  query ProductSyncPage($first: Int!, $after: String, $variantFirst: Int!, $metafieldFirst: Int!, $referenceFirst: Int!) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        handle
        title
        status
        vendor
        productType
        tags
        description
        descriptionHtml
        createdAt
        updatedAt
        publishedAt
        variants(first: $variantFirst) {
          nodes {
            id
            title
            sku
            barcode
            price
            inventoryQuantity
            selectedOptions {
              name
              value
            }
            updatedAt
          }
        }
        metafields(first: $metafieldFirst) {
          # Truncation here cost 112 of 116 products their usage instructions and
          # FAQs, and nothing reported it because the connection returned no page
          # info. Requested so the sync can say so out loud.
          pageInfo {
            hasNextPage
          }
          nodes {
            id
            namespace
            key
            type
            value
            jsonValue
            updatedAt
            definition {
              name
            }
            reference {
              __typename
              ... on Metaobject {
                id
                type
                handle
                displayName
                updatedAt
                fields {
                  key
                  type
                  value
                  jsonValue
                }
              }
            }
            references(first: $referenceFirst) {
              nodes {
                __typename
                ... on Metaobject {
                  id
                  type
                  handle
                  displayName
                  updatedAt
                  fields {
                    key
                    type
                    value
                    jsonValue
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const CUSTOMERS_QUERY = `#graphql
  query CustomerSyncPage($first: Int!, $after: String) {
    customers(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        legacyResourceId
        displayName
        firstName
        lastName
        locale
        state
        tags
        numberOfOrders
        verifiedEmail
        createdAt
        updatedAt
        statistics {
          rfmGroup
        }
        amountSpent {
          amount
          currencyCode
        }
        defaultEmailAddress {
          emailAddress
          marketingState
          marketingOptInLevel
          marketingUpdatedAt
          validFormat
        }
        defaultPhoneNumber {
          phoneNumber
        }
        defaultAddress {
          city
          province
          country
          countryCodeV2
          formattedArea
        }
        lastOrder {
          id
          name
          createdAt
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`;

// `$query` bounds the pull to orders we will actually keep.
//
// WHY THIS EXISTS. Retention deletes an order 3 months after delivery, or 6
// months if it is unresolved, and deleteExpiredOrders runs in the same pass that
// imports. Unbounded, a real store means fetching years of orders — 5,768 on
// Qiriness, back to May 2024 — and deleting ~80% of them seconds later. That is
// the slowest possible sync, the largest throttle exposure, and it pulls two
// years of customer personal data out of Shopify purely to bin it, which is the
// opposite of what SHOPIFY_PERSONAL_DATA_PROTECTION.md item 1 asks for.
//
// FILTERED ON updated_at, NOT created_at, and that is load-bearing: an order
// placed two years ago whose return opened last month is retained SIX MONTHS
// FROM THE RETURN, so a created_at window would silently miss exactly the
// unresolved cases support gets emails about. `sortKey: UPDATED_AT` already
// paginates on the same axis.
const ORDERS_QUERY = `#graphql
  query OrderSyncPage(
    $first: Int!,
    $after: String,
    $query: String,
    $lineItemFirst: Int!,
    $fulfillmentFirst: Int!,
    $returnFirst: Int!
  ) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        legacyResourceId
        name
        number
        sourceName
        displayFinancialStatus
        displayFulfillmentStatus
        returnStatus
        cancelReason
        currencyCode
        presentmentCurrencyCode
        tags
        email
        phone
        processedAt
        cancelledAt
        closedAt
        createdAt
        updatedAt
        totalWeight
        attribution {
          displayName
          handle
        }
        customer {
          id
        }
        shippingAddress {
          city
          province
          country
          countryCodeV2
          formattedArea
        }
        subtotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalDiscountsSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalShippingPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalTaxSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalRefundedSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalOutstandingSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        lineItems(first: $lineItemFirst) {
          nodes {
            id
            name
            title
            sku
            quantity
            currentQuantity
            unfulfilledQuantity
            refundableQuantity
            requiresShipping
            vendor
            variantTitle
            discountedTotalSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            originalTotalSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            product {
              id
            }
            variant {
              id
            }
          }
        }
        fulfillments(first: $fulfillmentFirst) {
          id
          name
          status
          displayStatus
          totalQuantity
          createdAt
          updatedAt
          inTransitAt
          estimatedDeliveryAt
          deliveredAt
          trackingInfo {
            company
            number
            url
          }
        }
        returns(first: $returnFirst) {
          nodes {
            id
            name
            status
            createdAt
            closedAt
            requestApprovedAt
          }
        }
        refunds {
          id
          legacyResourceId
          createdAt
          processedAt
          updatedAt
          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          return {
            id
          }
        }
      }
    }
  }
`;

const ORDERS_WITHOUT_RETURNS_QUERY = ORDERS_QUERY
  .replace(/,\n    \$returnFirst: Int!/u, '')
  .replace(`
        returns(first: $returnFirst) {
          nodes {
            id
            name
            status
            createdAt
            closedAt
            requestApprovedAt
          }
        }`, '');

const ORDERS_WITHOUT_RETURN_LINKS_QUERY = ORDERS_WITHOUT_RETURNS_QUERY
  .replace(`
          return {
            id
          }`, '');

// Discount rule fragments.
//
// These selections used to be `{ __typename }` only, which stored THAT a
// discount had a minimum requirement but never what the minimum was. Support
// could therefore say "cette promotion a un montant minimum" and nothing more —
// the single most common unanswerable question about a rejected code. The
// values are what make the eligibility checks in agent/src/retrieval real.
const DISCOUNT_ITEMS_FIELDS = `#graphql
              __typename
              ... on AllDiscountItems {
                allItems
              }
              ... on DiscountProducts {
                products(first: 20) {
                  nodes {
                    id
                    title
                  }
                }
              }
              ... on DiscountCollections {
                collections(first: 20) {
                  nodes {
                    id
                    title
                  }
                }
              }
`;

const MINIMUM_REQUIREMENT_FIELDS = `#graphql
              __typename
              ... on DiscountMinimumQuantity {
                greaterThanOrEqualToQuantity
              }
              ... on DiscountMinimumSubtotal {
                greaterThanOrEqualToSubtotal {
                  amount
                  currencyCode
                }
              }
`;

const CUSTOMER_GETS_FIELDS = `#graphql
              __typename
              appliesOnOneTimePurchase
              value {
                __typename
                ... on DiscountPercentage {
                  percentage
                }
                ... on DiscountAmount {
                  amount {
                    amount
                    currencyCode
                  }
                  appliesOnEachItem
                }
              }
              items {
                ${DISCOUNT_ITEMS_FIELDS}
              }
`;

const CUSTOMER_BUYS_FIELDS = `#graphql
              __typename
              value {
                __typename
                ... on DiscountQuantity {
                  quantity
                }
                ... on DiscountPurchaseAmount {
                  amount
                }
              }
              items {
                ${DISCOUNT_ITEMS_FIELDS}
              }
`;

// Only code discounts carry a customer selection; automatic discounts apply to
// everyone by definition.
const CUSTOMER_SELECTION_FIELDS = `#graphql
              __typename
              ... on DiscountCustomerAll {
                allCustomers
              }
              ... on DiscountCustomerSegments {
                segments {
                  id
                  name
                }
              }
              ... on DiscountCustomers {
                customers {
                  id
                }
              }
`;

const DISCOUNTS_QUERY = `#graphql
  query DiscountSyncPage($first: Int!, $after: String, $codeFirst: Int!) {
    discountNodes(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        discount {
          __typename
          ... on DiscountCodeBasic {
            title
            summary
            shortSummary
            status
            startsAt
            endsAt
            createdAt
            updatedAt
            usageLimit
            asyncUsageCount
            appliesOncePerCustomer
            discountClasses
            combinesWith {
              orderDiscounts
              productDiscounts
              shippingDiscounts
            }
            codes(first: $codeFirst) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                code
                asyncUsageCount
                createdBy {
                  title
                }
              }
            }
            codesCount {
              count
            }
            customerGets {
              ${CUSTOMER_GETS_FIELDS}
            }
            minimumRequirement {
              ${MINIMUM_REQUIREMENT_FIELDS}
            }
            customerSelection {
              ${CUSTOMER_SELECTION_FIELDS}
            }
          }
          ... on DiscountCodeBxgy {
            title
            summary
            status
            startsAt
            endsAt
            createdAt
            updatedAt
            usageLimit
            asyncUsageCount
            appliesOncePerCustomer
            discountClasses
            combinesWith {
              orderDiscounts
              productDiscounts
              shippingDiscounts
            }
            codes(first: $codeFirst) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                code
                asyncUsageCount
                createdBy {
                  title
                }
              }
            }
            codesCount {
              count
            }
            customerSelection {
              ${CUSTOMER_SELECTION_FIELDS}
            }
            customerBuys {
              ${CUSTOMER_BUYS_FIELDS}
            }
            customerGets {
              ${CUSTOMER_GETS_FIELDS}
            }
          }
          ... on DiscountCodeFreeShipping {
            title
            summary
            shortSummary
            status
            startsAt
            endsAt
            createdAt
            updatedAt
            usageLimit
            asyncUsageCount
            appliesOncePerCustomer
            discountClasses
            combinesWith {
              orderDiscounts
              productDiscounts
              shippingDiscounts
            }
            codes(first: $codeFirst) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                code
                asyncUsageCount
                createdBy {
                  title
                }
              }
            }
            codesCount {
              count
            }
            destinationSelection {
              __typename
            }
            minimumRequirement {
              ${MINIMUM_REQUIREMENT_FIELDS}
            }
            customerSelection {
              ${CUSTOMER_SELECTION_FIELDS}
            }
            maximumShippingPrice {
              amount
              currencyCode
            }
          }
          ... on DiscountCodeApp {
            title
            status
            startsAt
            endsAt
            createdAt
            updatedAt
            usageLimit
            asyncUsageCount
            appliesOncePerCustomer
            discountClasses
            combinesWith {
              orderDiscounts
              productDiscounts
              shippingDiscounts
            }
            codes(first: $codeFirst) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                code
                asyncUsageCount
                createdBy {
                  title
                }
              }
            }
            codesCount {
              count
            }
            appDiscountType {
              app {
                title
              }
              appKey
              functionId
              title
              description
              discountClasses
            }
          }
          ... on DiscountAutomaticBasic {
            title
            summary
            shortSummary
            status
            startsAt
            endsAt
            createdAt
            updatedAt
            asyncUsageCount
            discountClasses
            combinesWith {
              orderDiscounts
              productDiscounts
              shippingDiscounts
            }
            customerGets {
              ${CUSTOMER_GETS_FIELDS}
            }
            minimumRequirement {
              ${MINIMUM_REQUIREMENT_FIELDS}
            }
          }
          ... on DiscountAutomaticBxgy {
            title
            summary
            status
            startsAt
            endsAt
            createdAt
            updatedAt
            asyncUsageCount
            discountClasses
            combinesWith {
              orderDiscounts
              productDiscounts
              shippingDiscounts
            }
            customerBuys {
              ${CUSTOMER_BUYS_FIELDS}
            }
            customerGets {
              ${CUSTOMER_GETS_FIELDS}
            }
          }
          ... on DiscountAutomaticFreeShipping {
            title
            summary
            shortSummary
            status
            startsAt
            endsAt
            createdAt
            updatedAt
            asyncUsageCount
            discountClasses
            combinesWith {
              orderDiscounts
              productDiscounts
              shippingDiscounts
            }
            destinationSelection {
              __typename
            }
            minimumRequirement {
              ${MINIMUM_REQUIREMENT_FIELDS}
            }
            maximumShippingPrice {
              amount
              currencyCode
            }
          }
          ... on DiscountAutomaticApp {
            title
            status
            startsAt
            endsAt
            createdAt
            updatedAt
            asyncUsageCount
            discountClasses
            combinesWith {
              orderDiscounts
              productDiscounts
              shippingDiscounts
            }
            appDiscountType {
              app {
                title
              }
              appKey
              functionId
              title
              description
              discountClasses
            }
          }
        }
      }
    }
  }
`;

const DISCOUNT_CODES_QUERY = `#graphql
  query DiscountCodesPage($id: ID!, $codeFirst: Int!, $after: String) {
    discountNode(id: $id) {
      id
      discount {
        __typename
        ... on DiscountCodeBasic {
          codes(first: $codeFirst, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              code
              asyncUsageCount
              createdBy {
                title
              }
            }
          }
        }
        ... on DiscountCodeBxgy {
          codes(first: $codeFirst, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              code
              asyncUsageCount
              createdBy {
                title
              }
            }
          }
        }
        ... on DiscountCodeFreeShipping {
          codes(first: $codeFirst, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              code
              asyncUsageCount
              createdBy {
                title
              }
            }
          }
        }
        ... on DiscountCodeApp {
          codes(first: $codeFirst, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              code
              asyncUsageCount
              createdBy {
                title
              }
            }
          }
        }
      }
    }
  }
`;

export async function createShopifyClient(config) {
  const token = config.shopifyToken || await requestShopifyAccessToken(config);

  return {
    endpoint: `https://${config.shopDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`,
    token
  };
}

export async function fetchShop(shopify) {
  const data = await shopifyGraphql(shopify, SHOP_QUERY);
  return data.shop;
}

export async function fetchTargetMetaobjectDefinitions(shopify, config) {
  const definitions = [];
  let cursor = null;

  do {
    const page = await shopifyGraphql(shopify, METAOBJECT_DEFINITIONS_QUERY, {
      first: METAOBJECT_DEFINITION_PAGE_SIZE,
      after: cursor
    });

    definitions.push(...page.metaobjectDefinitions.nodes);
    cursor = page.metaobjectDefinitions.pageInfo.hasNextPage
      ? page.metaobjectDefinitions.pageInfo.endCursor
      : null;
  } while (cursor);

  if (config.shopifyMetaobjectTypes.length > 0) {
    const allowedTypes = new Set(config.shopifyMetaobjectTypes);
    return definitions.filter((definition) => allowedTypes.has(definition.type));
  }

  return definitions.filter((definition) => {
    const names = [
      definition.name,
      definition.type
    ].filter(Boolean).map(normalizeLabel);

    return names.some((name) => DEFAULT_METAOBJECT_DEFINITION_ALIASES.includes(name));
  });
}

export async function fetchMetaobjectsByType(shopify, type) {
  const metaobjects = [];
  let cursor = null;

  do {
    const page = await shopifyGraphql(shopify, METAOBJECTS_BY_TYPE_QUERY, {
      type,
      first: METAOBJECT_PAGE_SIZE,
      after: cursor
    });

    metaobjects.push(...page.metaobjects.nodes);
    cursor = page.metaobjects.pageInfo.hasNextPage ? page.metaobjects.pageInfo.endCursor : null;
  } while (cursor);

  return metaobjects;
}

export async function fetchProductPage(shopify, args, cursor) {
  return shopifyGraphql(shopify, PRODUCTS_QUERY, {
    // Clamped, not validated: a caller asking for more is asking to go faster,
    // and the honest answer to that is the largest page this query can afford,
    // not a crash halfway through a nightly run.
    first: Math.min(args.pageSize, PRODUCT_MAX_PAGE_SIZE),
    after: cursor,
    variantFirst: PRODUCT_VARIANT_PAGE_SIZE,
    metafieldFirst: PRODUCT_METAFIELD_PAGE_SIZE,
    referenceFirst: METAFIELD_REFERENCE_PAGE_SIZE
  });
}

export async function fetchCustomerPage(shopify, args, cursor) {
  return shopifyGraphql(shopify, CUSTOMERS_QUERY, {
    first: args.pageSize,
    after: cursor
  });
}

/**
 * How far back to pull orders, as a Shopify search filter.
 *
 * Defaults to the longest retention window (6 months) plus a month of margin,
 * so nothing is skipped that retention would have kept. `null` months means no
 * filter at all — the old unbounded behaviour, kept for a deliberate full
 * backfill rather than as the default.
 */
export function orderSyncQuery(months = ORDER_SYNC_DEFAULT_MONTHS, now = new Date()) {
  if (months === null || months === undefined) {
    return undefined;
  }
  const since = new Date(now);
  // UTC throughout. setMonth/getMonth work in LOCAL time while toISOString
  // emits UTC, so the mixed pair moved the window by a day depending on the
  // timezone of whatever ran the sync — the same window must come out on a
  // laptop in Paris and a scheduler in UTC.
  since.setUTCMonth(since.getUTCMonth() - months);
  // Month arithmetic can clamp (31 Sep -> 1 Oct), costing at most a couple of
  // days. The margin baked into ORDER_SYNC_DEFAULT_MONTHS absorbs it.
  return `updated_at:>=${since.toISOString().slice(0, 10)}`;
}

// The window a sync uses when nobody has told it the shop's retention policy —
// the fallback period plus its margin. The real window is DERIVED from the
// shop's setting by `orderSyncMonths`, because a fetch window shorter than
// retention is a table that can never fill: the setting would look broken rather
// than misconfigured. Kept as a named export because the sync logs it and the
// tests assert on it.
export const ORDER_SYNC_DEFAULT_MONTHS =
  FALLBACK_RETENTION_MONTHS + SYNC_WINDOW_MARGIN_MONTHS;

/**
 * `sinceMonths` is the window the CALLER resolved — from the shop's retention
 * setting, or from `--since-months`/`--all-orders`. It is passed in rather than
 * recomputed here because this function used to fall back to a fixed constant
 * while the caller logged a different number: the run announced one window and
 * fetched another, and raising retention changed only the message.
 *
 * `null` means no date bound at all. `undefined` keeps the old default for
 * callers that have no policy to hand.
 */
export async function fetchOrderPage(shopify, args, cursor, sinceMonths) {
  const includeReturns = !shopify.orderReturnsAccessDenied;
  const resolvedMonths = sinceMonths === undefined
    ? (args.orderSinceMonths === undefined ? ORDER_SYNC_DEFAULT_MONTHS : args.orderSinceMonths)
    : sinceMonths;
  const variables = {
    first: args.pageSize,
    after: cursor,
    // A null window means "everything", for a full backfill or a shop that keeps
    // its orders indefinitely.
    query: orderSyncQuery(resolvedMonths),
    lineItemFirst: ORDER_LINE_ITEM_PAGE_SIZE,
    fulfillmentFirst: ORDER_FULFILLMENT_PAGE_SIZE
  };

  if (includeReturns) {
    variables.returnFirst = ORDER_RETURN_PAGE_SIZE;
  }

  try {
    return await shopifyGraphql(
      shopify,
      includeReturns ? ORDERS_QUERY : ORDERS_WITHOUT_RETURN_LINKS_QUERY,
      variables
    );
  } catch (error) {
    if (!includeReturns || !/Access denied for returns field/i.test(error.message)) {
      throw error;
    }

    shopify.orderReturnsAccessDenied = true;
    console.warn('Shopify order sync warning: read_returns is not granted; syncing orders without detailed return rows.');
    return fetchOrderPage(shopify, args, cursor);
  }
}

/**
 * One order, in exactly the shape the nightly writes.
 *
 * WHY NOT MAP THE WEBHOOK PAYLOAD DIRECTLY. A webhook body is REST-shaped —
 * `id: 6997`, `line_items`, `total_price` — while `mapOrder` reads the GraphQL
 * shape: `gid://shopify/Order/…`, `lineItems.nodes`, `totalPriceSet.shopMoney`.
 * A second mapper for the second shape is a second thing to keep correct, and
 * the failure mode when it drifts is silent: half-populated rows that look
 * synced. Re-reading the order costs one API call and makes a webhook-written
 * row indistinguishable from a nightly-written one, because it IS the same
 * query and the same mapper.
 *
 * THE SEARCH FILTER, NOT `node(id:)`, so the whole selection set is reused
 * rather than restructured into a fragment. `first: 1` because an id matches at
 * most one order.
 *
 * Returns null when the order cannot be read — deleted, or belonging to another
 * shop. The caller decides what that means; for a webhook it is not an error.
 */
export async function fetchOrderByLegacyId(shopify, legacyId) {
  const includeReturns = !shopify.orderReturnsAccessDenied;
  const variables = {
    first: 1,
    after: null,
    query: `id:${legacyId}`,
    lineItemFirst: ORDER_LINE_ITEM_PAGE_SIZE,
    fulfillmentFirst: ORDER_FULFILLMENT_PAGE_SIZE
  };

  if (includeReturns) {
    variables.returnFirst = ORDER_RETURN_PAGE_SIZE;
  }

  try {
    const data = await shopifyGraphql(
      shopify,
      includeReturns ? ORDERS_QUERY : ORDERS_WITHOUT_RETURN_LINKS_QUERY,
      variables
    );
    return data.orders?.nodes?.[0] || null;
  } catch (error) {
    // Same fallback as the paged read: a shop without read_returns must still
    // sync its orders rather than fail on every webhook.
    if (!includeReturns || !/Access denied for returns field/i.test(error.message)) {
      throw error;
    }

    shopify.orderReturnsAccessDenied = true;
    return fetchOrderByLegacyId(shopify, legacyId);
  }
}

const COLLECTIONS_QUERY = `#graphql
  query CollectionSyncPage($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: TITLE) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        handle
        title
        updatedAt
        productsCount {
          count
        }
      }
    }
  }
`;

const COLLECTION_PRODUCTS_QUERY = `#graphql
  query CollectionProducts($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      id
      handle
      title
      products(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          status
        }
      }
    }
  }
`;

/** The catalogue of collections: what the curation screen offers to activate. */
export async function fetchCollectionPage(shopify, cursor) {
  return shopifyGraphql(shopify, COLLECTIONS_QUERY, {
    first: COLLECTION_PAGE_SIZE,
    after: cursor
  });
}

/**
 * One collection's products.
 *
 * `status` travels with each node so the caller can drop what is not live
 * without a second read: a draft or archived product must never be put in front
 * of a customer, and the collection happily contains them (measured: `Diag -
 * Rides et ridules` holds 19, of which 18 are active).
 */
export async function fetchCollectionProducts(shopify, collectionId, cursor) {
  return shopifyGraphql(shopify, COLLECTION_PRODUCTS_QUERY, {
    id: collectionId,
    first: COLLECTION_PRODUCT_PAGE_SIZE,
    after: cursor
  });
}

export async function fetchDiscountPage(shopify, args, cursor) {
  return shopifyGraphql(shopify, DISCOUNTS_QUERY, {
    first: args.pageSize,
    after: cursor,
    codeFirst: DISCOUNT_CODE_PAGE_SIZE
  });
}

export async function fetchDiscountRedeemCodePage(shopify, discountNodeId, cursor) {
  const data = await shopifyGraphql(shopify, DISCOUNT_CODES_QUERY, {
    id: discountNodeId,
    after: cursor,
    codeFirst: DISCOUNT_CODE_PAGE_SIZE
  });

  return data.discountNode?.discount?.codes || {
    nodes: [],
    pageInfo: {
      hasNextPage: false,
      endCursor: null
    }
  };
}

async function requestShopifyAccessToken(config, attempt = 1) {
  // Retried like every other call. This is the FIRST network request a sync
  // makes, so a blip here kills the run before a single row is read — and
  // because it sat outside the retried path it reported a bare `fetch failed`
  // with nothing to say which of the three services had refused.
  let response;
  try {
    response = await fetch(`https://${config.shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      // Never let a token response be replayed from Next's Data Cache.
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.shopifyClientId,
        client_secret: config.shopifyClientSecret
      })
    });
  } catch (error) {
    if (attempt >= SHOPIFY_RETRY_ATTEMPTS) {
      throw new Error(
        `Shopify token request to ${config.shopDomain} failed after ${attempt} attempts: ${error.message}`
      );
    }
    await sleepMs(SHOPIFY_RETRY_BASE_MS * 2 ** (attempt - 1));
    return requestShopifyAccessToken(config, attempt + 1);
  }

  if ((response.status === 429 || response.status >= 500) && attempt < SHOPIFY_RETRY_ATTEMPTS) {
    await sleepMs(SHOPIFY_RETRY_BASE_MS * 2 ** (attempt - 1));
    return requestShopifyAccessToken(config, attempt + 1);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.error_description || payload?.error || `HTTP ${response.status}`;
    throw new Error(`Shopify client credentials token request failed: ${detail}`);
  }
  if (!payload?.access_token) {
    throw new Error('Shopify client credentials token request did not return an access token.');
  }

  return payload.access_token;
}

// Shopify's GraphQL limit is a leaky bucket (2,000 points, refilling at 100/s
// on this shop), and an orders page with 50 line items, 10 fulfillments and 10
// returns nested per order is expensive. Unretried, the first THROTTLED reply
// ends the sync partway with no resume — which at 2,869 orders means starting
// over.
//
// Waits for the bucket to refill rather than guessing: the throttle status comes
// back in the response, so the client knows exactly how long it needs.
const SHOPIFY_RETRY_ATTEMPTS = 5;
const SHOPIFY_RETRY_BASE_MS = 1000;

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function throttleWaitMs(payload, attempt) {
  const cost = payload?.extensions?.cost;
  const status = cost?.throttleStatus;
  if (status && cost?.requestedQueryCost) {
    const deficit = cost.requestedQueryCost - status.currentlyAvailable;
    if (deficit > 0 && status.restoreRate > 0) {
      // A second of headroom, capped so a pathological cost cannot hang a sync.
      return Math.min(Math.ceil((deficit / status.restoreRate) * 1000) + 1000, 20000);
    }
  }
  return SHOPIFY_RETRY_BASE_MS * 2 ** (attempt - 1);
}

const isThrottled = (payload) =>
  (payload?.errors || []).some(
    (error) => error?.extensions?.code === 'THROTTLED' || /throttled/i.test(error?.message || '')
  );

export async function shopifyGraphql(client, query, variables = {}, attempt = 1) {
  // cache: 'no-store' for the reason spelled out in supabase-rest-client.mjs —
  // the dashboard's Route Handlers call this during import/resync, and Next's
  // Data Cache would otherwise replay the first Shopify response forever.
  let response;
  try {
    response = await fetch(client.endpoint, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': client.token
      },
      body: JSON.stringify({ query, variables })
    });
  } catch (error) {
    // No response at all — a dropped connection, not a rejected request.
    if (attempt >= SHOPIFY_RETRY_ATTEMPTS) {
      throw new Error(`Shopify request failed after ${attempt} attempts: ${error.message}`);
    }
    await sleepMs(SHOPIFY_RETRY_BASE_MS * 2 ** (attempt - 1));
    return shopifyGraphql(client, query, variables, attempt + 1);
  }

  const payload = await response.json().catch(() => null);

  // 429 and 5xx are the server asking for a pause; 4xx means the request itself
  // is wrong and retrying only fails slower.
  if ((response.status === 429 || response.status >= 500) && attempt < SHOPIFY_RETRY_ATTEMPTS) {
    await sleepMs(throttleWaitMs(payload, attempt));
    return shopifyGraphql(client, query, variables, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`Shopify request failed with HTTP ${response.status}.`);
  }

  // Shopify reports throttling as a 200 with an error body, so this cannot be
  // caught by status alone.
  if (isThrottled(payload) && attempt < SHOPIFY_RETRY_ATTEMPTS) {
    await sleepMs(throttleWaitMs(payload, attempt));
    return shopifyGraphql(client, query, variables, attempt + 1);
  }

  if (payload?.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${payload.errors.map((error) => error.message).join('; ')}`);
  }
  return payload.data;
}

function normalizeLabel(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
