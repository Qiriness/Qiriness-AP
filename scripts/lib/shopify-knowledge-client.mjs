import { shopifyGraphql } from './shopify-admin-client.mjs';

const PAGE_SIZE = 50;
const MENU_SIZE = 50;

const PAGES_QUERY = `#graphql
  query KnowledgePages($first: Int!, $after: String) {
    pages(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        handle
        title
        body
        bodySummary
        templateSuffix
        createdAt
        updatedAt
        publishedAt
        metafields(first: 50) {
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
          }
        }
      }
    }
  }
`;

const SHOP_POLICIES_QUERY = `#graphql
  query KnowledgePolicies {
    shop {
      shopPolicies {
        id
        title
        type
        body
        url
        createdAt
        updatedAt
      }
    }
  }
`;

const MENUS_QUERY = `#graphql
  query KnowledgeMenus($first: Int!, $after: String) {
    menus(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        handle
        title
        isDefault
        items {
          ...MenuItemFields
          items {
            ...MenuItemFields
            items {
              ...MenuItemFields
            }
          }
        }
      }
    }
  }

  fragment MenuItemFields on MenuItem {
    id
    title
    type
    url
    resourceId
  }
`;

export async function fetchKnowledgePages(shopify, args) {
  const pages = [];
  let cursor = null;

  do {
    const page = await shopifyGraphql(shopify, PAGES_QUERY, {
      first: args.pageSize || PAGE_SIZE,
      after: cursor
    });

    pages.push(...page.pages.nodes);
    cursor = page.pages.pageInfo.hasNextPage ? page.pages.pageInfo.endCursor : null;
  } while (cursor && (!args.limit || pages.length < args.limit));

  return args.limit ? pages.slice(0, args.limit) : pages;
}

export async function fetchShopPolicies(shopify) {
  const data = await shopifyGraphql(shopify, SHOP_POLICIES_QUERY);
  return data.shop.shopPolicies || [];
}

export async function fetchNavigationMenus(shopify) {
  const menus = [];
  let cursor = null;

  do {
    const page = await shopifyGraphql(shopify, MENUS_QUERY, {
      first: MENU_SIZE,
      after: cursor
    });

    menus.push(...page.menus.nodes);
    cursor = page.menus.pageInfo.hasNextPage ? page.menus.pageInfo.endCursor : null;
  } while (cursor);

  return menus;
}
