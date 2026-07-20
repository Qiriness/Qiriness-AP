export const PRODUCT_VARIANT_PAGE_SIZE = 25;
export const PRODUCT_METAFIELD_PAGE_SIZE = 25;
export const METAFIELD_REFERENCE_PAGE_SIZE = 10;
export const ORDER_LINE_ITEM_PAGE_SIZE = 50;
export const ORDER_FULFILLMENT_PAGE_SIZE = 10;
export const ORDER_RETURN_PAGE_SIZE = 10;
export const DISCOUNT_CODE_PAGE_SIZE = 100;

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

const ORDERS_QUERY = `#graphql
  query OrderSyncPage(
    $first: Int!,
    $after: String,
    $lineItemFirst: Int!,
    $fulfillmentFirst: Int!,
    $returnFirst: Int!
  ) {
    orders(first: $first, after: $after, sortKey: UPDATED_AT) {
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
              __typename
            }
            minimumRequirement {
              __typename
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
            customerBuys {
              __typename
            }
            customerGets {
              __typename
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
              __typename
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
              __typename
            }
            minimumRequirement {
              __typename
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
              __typename
            }
            customerGets {
              __typename
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
              __typename
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
    first: args.pageSize,
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

export async function fetchOrderPage(shopify, args, cursor) {
  const includeReturns = !shopify.orderReturnsAccessDenied;
  const variables = {
    first: args.pageSize,
    after: cursor,
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

async function requestShopifyAccessToken(config) {
  const response = await fetch(`https://${config.shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
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

export async function shopifyGraphql(client, query, variables = {}) {
  const response = await fetch(client.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': client.token
    },
    body: JSON.stringify({ query, variables })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Shopify request failed with HTTP ${response.status}.`);
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
