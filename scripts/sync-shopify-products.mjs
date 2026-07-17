import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DEFAULT_API_VERSION = '2026-07';
const DEFAULT_PAGE_SIZE = 10;
const PRODUCT_VARIANT_PAGE_SIZE = 25;
const PRODUCT_METAFIELD_PAGE_SIZE = 25;
const METAFIELD_REFERENCE_PAGE_SIZE = 10;
const METAOBJECT_DEFINITION_PAGE_SIZE = 50;
const METAOBJECT_PAGE_SIZE = 50;

const DEFAULT_METAOBJECT_DEFINITION_ALIASES = [
  'ingredients list',
  'ingredient list',
  'ingredients',
  'product faq',
  'faq'
];

const MOJIBAKE_MARKER_PATTERN = /[\u00C2\u00C3\u00C5\u00E2]/;
const WINDOWS_1252_REVERSE_BYTES = new Map([
  [0x20AC, 0x80],
  [0x201A, 0x82],
  [0x0192, 0x83],
  [0x201E, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02C6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8A],
  [0x2039, 0x8B],
  [0x0152, 0x8C],
  [0x017D, 0x8E],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201C, 0x93],
  [0x201D, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02DC, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9A],
  [0x203A, 0x9B],
  [0x0153, 0x9C],
  [0x017E, 0x9E],
  [0x0178, 0x9F]
]);

const COMMON_MOJIBAKE_REPLACEMENTS = [
  ['\u00C2\u00A0', ' '],
  ['\u00C3\u00A0', '\u00E0'],
  ['\u00C3\u00A2', '\u00E2'],
  ['\u00C3\u00A7', '\u00E7'],
  ['\u00C3\u00A8', '\u00E8'],
  ['\u00C3\u00A9', '\u00E9'],
  ['\u00C3\u00AA', '\u00EA'],
  ['\u00C3\u00AB', '\u00EB'],
  ['\u00C3\u00AE', '\u00EE'],
  ['\u00C3\u00AF', '\u00EF'],
  ['\u00C3\u00B4', '\u00F4'],
  ['\u00C3\u00B6', '\u00F6'],
  ['\u00C3\u00B9', '\u00F9'],
  ['\u00C3\u00BB', '\u00FB'],
  ['\u00C3\u00BC', '\u00FC'],
  ['\u00C3\u0080', '\u00C0'],
  ['\u00C3\u0088', '\u00C8'],
  ['\u00C3\u0089', '\u00C9'],
  ['\u00C5\u201C', '\u0153'],
  ['\u00C5\u2019', '\u0152'],
  ['\u00E2\u20AC\u2122', '\u2019'],
  ['\u00E2\u20AC\u0099', '\u2019'],
  ['\u00E2\u20AC\u0153', '\u201C'],
  ['\u00E2\u20AC\u009C', '\u201C'],
  ['\u00E2\u20AC\u009D', '\u201D'],
  ['\u00E2\u20AC\u201D', '\u201D'],
  ['\u00E2\u20AC\u201C', '\u2013'],
  ['\u00E2\u20AC\u0093', '\u2013'],
  ['\u00E2\u20AC\u0094', '\u2014'],
  ['\u00E2\u0080\u00A2', '\u2022']
];

const FIELD_TARGETS = {
  short_description: [
    'short_description',
    'short description',
    'description courte'
  ],
  usage_instructions: [
    'usage_instructions',
    'usage instructions'
  ],
  usage_advice: [
    "conseils d'utilisation",
    'conseils utilisation',
    'conseils_d_utilisation',
    'conseils_utilisation'
  ],
  active_ingredients: [
    'actifs & ingredients',
    'actifs ingredients',
    'actifs_ingredients'
  ],
  ingredients_popup: [
    'ingredients popup',
    'ingredients_popup',
    'ingredient popup'
  ],
  product_ingredients: [
    'product ingredients',
    'product_ingredients'
  ],
  product_faqs: [
    'faq list',
    'faq_list',
    'faqs',
    'product faqs',
    'product_faqs'
  ]
};

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

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const config = loadConfig(env);

  const shopify = await createShopifyClient(config);
  const supabase = createSupabaseClient(config);

  const shopData = await shopifyGraphql(shopify, SHOP_QUERY);
  const shop = shopData.shop;
  const shopRow = mapShop(shop, config);
  const syncedAt = new Date().toISOString();

  if (args.dryRun) {
    console.log(`Dry run: would upsert shop ${shopRow.shop_domain}`);
  } else {
    const rows = await supabaseUpsert(supabase, 'shops', [shopRow], 'shop_domain');
    shopRow.id = rows[0]?.id;
    if (!shopRow.id) {
      throw new Error('Supabase did not return a shop id after upsert.');
    }
  }

  const targetDefinitions = await fetchTargetMetaobjectDefinitions(shopify, config);
  const fullMetaobjectRows = [];
  for (const definition of targetDefinitions) {
    const metaobjects = await fetchMetaobjectsByType(shopify, definition.type);
    fullMetaobjectRows.push(
      ...metaobjects.map((metaobject) => mapMetaobject(metaobject, shopRow.id, syncedAt, definition))
    );
  }

  if (args.dryRun) {
    console.log(
      `Dry run: would upsert ${fullMetaobjectRows.length} metaobjects from ${targetDefinitions.length} target definitions.`
    );
  } else if (fullMetaobjectRows.length > 0) {
    await supabaseUpsert(
      supabase,
      'shopify_metaobjects',
      dedupeRows(fullMetaobjectRows, (row) => `${row.shop_id}:${row.shopify_metaobject_id}`),
      'shop_id,shopify_metaobject_id'
    );
    console.log(
      `Synced ${fullMetaobjectRows.length} metaobjects from ${targetDefinitions.length} target definitions.`
    );
  }

  let cursor = null;
  let totalProducts = 0;
  let totalMetaobjects = 0;

  do {
    const page = await shopifyGraphql(shopify, PRODUCTS_QUERY, {
      first: args.pageSize,
      after: cursor,
      variantFirst: PRODUCT_VARIANT_PAGE_SIZE,
      metafieldFirst: PRODUCT_METAFIELD_PAGE_SIZE,
      referenceFirst: METAFIELD_REFERENCE_PAGE_SIZE
    });

    const products = page.products.nodes;
    const mapped = products.map((product) => mapProduct(product, shopRow.id, syncedAt));
    const productRows = mapped.map((item) => item.productRow);
    const metaobjectRows = dedupeRows(
      mapped.flatMap((item) => item.metaobjectRows),
      (row) => `${row.shop_id}:${row.shopify_metaobject_id}`
    );

    if (args.dryRun) {
      totalProducts += productRows.length;
      totalMetaobjects += metaobjectRows.length;
      console.log(
        `Dry run: page contains ${productRows.length} products and ${metaobjectRows.length} linked metaobjects.`
      );
    } else {
      if (metaobjectRows.length > 0) {
        await supabaseUpsert(
          supabase,
          'shopify_metaobjects',
          metaobjectRows,
          'shop_id,shopify_metaobject_id'
        );
      }
      if (productRows.length > 0) {
        await supabaseUpsert(
          supabase,
          'products',
          productRows,
          'shop_id,shopify_product_id'
        );
      }
      totalProducts += productRows.length;
      totalMetaobjects += metaobjectRows.length;
      console.log(`Synced ${totalProducts} products so far.`);
    }

    cursor = page.products.pageInfo.hasNextPage ? page.products.pageInfo.endCursor : null;
    if (args.limit && totalProducts >= args.limit) {
      break;
    }
  } while (cursor);

  console.log(
    `${args.dryRun ? 'Dry run complete' : 'Sync complete'}: ${totalProducts} products, ${totalMetaobjects} linked metaobjects.`
  );
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    limit: null,
    pageSize: DEFAULT_PAGE_SIZE
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--limit=')) {
      args.limit = Number.parseInt(arg.slice('--limit='.length), 10);
    } else if (arg === '--limit') {
      args.limit = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg.startsWith('--page-size=')) {
      args.pageSize = Number.parseInt(arg.slice('--page-size='.length), 10);
    } else if (arg === '--page-size') {
      args.pageSize = Number.parseInt(argv[index + 1], 10);
      index += 1;
    }
  }

  if (!Number.isInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > 100) {
    throw new Error('--page-size must be an integer between 1 and 100.');
  }
  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error('--limit must be a positive integer.');
  }

  return args;
}

function loadEnv() {
  const env = { ...process.env };

  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) {
      continue;
    }

    const text = readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) {
        continue;
      }

      const [, key, rawValue] = match;
      if (env[key] !== undefined) {
        continue;
      }
      env[key] = stripEnvQuotes(rawValue.trim());
    }
  }

  return env;
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadConfig(env) {
  const required = [
    'SHOPIFY_STORE_DOMAIN',
    'SUPABASE_URL',
    'SUPABASE_SECRET_KEY'
  ];

  if (!env.SHOPIFY_ADMIN_API_ACCESS_TOKEN && (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET)) {
    required.push('SHOPIFY_ADMIN_API_ACCESS_TOKEN or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET');
  }

  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  return {
    shopDomain: env.SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    shopifyToken: env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
    shopifyClientId: env.SHOPIFY_CLIENT_ID,
    shopifyClientSecret: env.SHOPIFY_CLIENT_SECRET,
    shopifyApiVersion: env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION,
    shopifyMetaobjectTypes: splitCsv(env.SHOPIFY_METAOBJECT_TYPES),
    supabaseUrl: env.SUPABASE_URL.replace(/\/$/, ''),
    supabaseKey: env.SUPABASE_SECRET_KEY,
    appEnv: env.APP_ENV || 'development'
  };
}

async function createShopifyClient(config) {
  const token = config.shopifyToken || await requestShopifyAccessToken(config);

  return {
    endpoint: `https://${config.shopDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`,
    token
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

function createSupabaseClient(config) {
  return {
    baseUrl: `${config.supabaseUrl}/rest/v1`,
    key: config.supabaseKey
  };
}

async function fetchTargetMetaobjectDefinitions(shopify, config) {
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

async function fetchMetaobjectsByType(shopify, type) {
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

async function shopifyGraphql(client, query, variables = {}) {
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

async function supabaseUpsert(client, table, rows, onConflict) {
  const response = await fetch(
    `${client.baseUrl}/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
    {
      method: 'POST',
      headers: {
        apikey: client.key,
        Authorization: `Bearer ${client.key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(rows)
    }
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message || payload?.details || `HTTP ${response.status}`;
    throw new Error(`Supabase upsert into ${table} failed: ${detail}`);
  }
  return payload;
}

function mapShop(shop, config) {
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

function mapProduct(product, shopId, syncedAt) {
  const metafields = product.metafields?.nodes || [];
  const extracted = extractProductMetafields(metafields);

  const productRow = stripUndefined({
    shop_id: shopId,
    shopify_product_id: product.id,
    handle: product.handle,
    title: cleanTextValue(product.title),
    status: product.status?.toLowerCase(),
    vendor: cleanTextValue(product.vendor),
    product_type: cleanTextValue(product.productType),
    tags: cleanJsonValue(product.tags || []),
    description: cleanTextValue(product.description || product.descriptionHtml || null),
    short_description: extracted.short_description,
    usage_instructions: extracted.usage_instructions,
    usage_advice: extracted.usage_advice,
    active_ingredients: extracted.active_ingredients,
    ingredients_popup: extracted.ingredients_popup,
    product_ingredients: extracted.product_ingredients,
    available_stock: sumAvailableStock(product.variants?.nodes || []),
    product_ingredient_metaobject_ids: extracted.product_ingredient_metaobject_ids,
    product_faqs: extracted.product_faqs,
    product_faq_metaobject_ids: extracted.product_faq_metaobject_ids,
    structured_facts: {
      metafields: extracted.structuredMetafields
    },
    variants: (product.variants?.nodes || []).map(mapVariant),
    published_at: product.publishedAt,
    shopify_created_at: product.createdAt,
    shopify_updated_at: product.updatedAt,
    synced_at: syncedAt,
    raw_shopify_payload: buildProductRawPayload(product, metafields)
  });

  const metaobjectRows = extracted.metaobjects.map((metaobject) => mapMetaobject(metaobject, shopId, syncedAt));

  return { productRow, metaobjectRows };
}

function mapVariant(variant) {
  return stripUndefined({
    id: variant.id,
    title: variant.title,
    sku: variant.sku,
    barcode: variant.barcode,
    price: variant.price,
    inventory_quantity: variant.inventoryQuantity,
    selected_options: variant.selectedOptions || [],
    updated_at: variant.updatedAt
  });
}

function sumAvailableStock(variants) {
  let hasInventoryQuantity = false;
  let total = 0;

  for (const variant of variants) {
    if (typeof variant.inventoryQuantity !== 'number') {
      continue;
    }
    hasInventoryQuantity = true;
    total += variant.inventoryQuantity;
  }

  return hasInventoryQuantity ? total : null;
}

function extractProductMetafields(metafields) {
  const result = {
    short_description: null,
    usage_instructions: null,
    usage_advice: null,
    active_ingredients: null,
    ingredients_popup: null,
    product_ingredients: [],
    product_ingredient_metaobject_ids: [],
    product_faqs: [],
    product_faq_metaobject_ids: [],
    structuredMetafields: {},
    metaobjects: []
  };

  for (const metafield of metafields) {
    const target = identifyMetafieldTarget(metafield);
    const references = extractMetaobjectReferences(metafield);

    result.structuredMetafields[`${metafield.namespace}.${metafield.key}`] = stripUndefined({
      id: metafield.id,
      namespace: metafield.namespace,
      key: metafield.key,
      definition_name: cleanTextValue(metafield.definition?.name),
      type: metafield.type,
      value: cleanTextValue(metafield.value),
      json_value: cleanJsonValue(metafield.jsonValue),
      updated_at: metafield.updatedAt,
      reference_ids: references.map((item) => item.id)
    });

    if (!target) {
      continue;
    }

    if (target === 'product_ingredients') {
      result.product_ingredients = references.length > 0
        ? references.map(metaobjectToSnapshot)
        : arrayValue(metafield);
      result.product_ingredient_metaobject_ids = references.map((item) => item.id);
      result.metaobjects.push(...references);
      continue;
    }

    if (target === 'product_faqs') {
      result.product_faqs = references.length > 0
        ? references.map(metaobjectToFaqSnapshot)
        : productFaqValue(metafield);
      result.product_faq_metaobject_ids = references.map((item) => item.id);
      result.metaobjects.push(...references);
      continue;
    }

    result[target] = scalarValue(metafield);
  }

  result.metaobjects = dedupeRows(result.metaobjects, (row) => row.id);
  return result;
}

function identifyMetafieldTarget(metafield) {
  const candidates = [
    metafield.key,
    metafield.definition?.name,
    `${metafield.namespace}.${metafield.key}`
  ].filter(Boolean);

  for (const [target, aliases] of Object.entries(FIELD_TARGETS)) {
    if (candidates.some((candidate) => aliases.includes(normalizeLabel(candidate)))) {
      return target;
    }
  }

  return null;
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

function extractMetaobjectReferences(metafield) {
  const references = [];
  if (metafield.reference?.__typename === 'Metaobject') {
    references.push(metafield.reference);
  }

  for (const node of metafield.references?.nodes || []) {
    if (node?.__typename === 'Metaobject') {
      references.push(node);
    }
  }

  return dedupeRows(references, (row) => row.id);
}

function scalarValue(metafield) {
  if (typeof metafield.jsonValue === 'string') {
    return cleanTextValue(metafield.jsonValue);
  }
  if (metafield.jsonValue !== null && metafield.jsonValue !== undefined) {
    return JSON.stringify(cleanJsonValue(metafield.jsonValue));
  }
  return cleanTextValue(metafield.value || null);
}

function arrayValue(metafield) {
  if (Array.isArray(metafield.jsonValue)) {
    return cleanJsonValue(metafield.jsonValue);
  }
  if (!metafield.value) {
    return [];
  }
  try {
    const parsed = JSON.parse(metafield.value);
    return cleanJsonValue(Array.isArray(parsed) ? parsed : [parsed]);
  } catch {
    return [cleanTextValue(metafield.value)];
  }
}

function productFaqValue(metafield) {
  const values = arrayValue(metafield);
  return values.map((value, index) => {
    if (typeof value === 'object' && value !== null) {
      return cleanJsonValue(value);
    }
    return {
      faq_id: `${metafield.id}:${index}`,
      question: cleanTextValue(String(value)),
      answer: '',
      source: {
        metafield_id: metafield.id,
        namespace: metafield.namespace,
        key: metafield.key
      },
      content_hash: hashJson(value),
      updated_at: metafield.updatedAt,
      published: true
    };
  });
}

function metaobjectToSnapshot(metaobject) {
  return stripUndefined({
    id: metaobject.id,
    type: metaobject.type,
    handle: metaobject.handle,
    display_name: cleanTextValue(metaobject.displayName),
    fields: metaobjectFieldsObject(metaobject)
  });
}

function metaobjectToFaqSnapshot(metaobject) {
  const fields = metaobjectFieldsObject(metaobject);
  return {
    faq_id: metaobject.id,
    question: firstFieldValue(fields, ['question', 'title', 'name']) || cleanTextValue(metaobject.displayName) || metaobject.handle,
    answer: firstFieldValue(fields, ['answer', 'response', 'body', 'content']) || '',
    source: {
      type: 'shopify_metaobject',
      id: metaobject.id,
      handle: metaobject.handle,
      metaobject_type: metaobject.type
    },
    content_hash: hashJson(fields),
    updated_at: metaobject.updatedAt,
    published: true
  };
}

function mapMetaobject(metaobject, shopId, syncedAt, definition = null) {
  const fields = metaobjectFieldsObject(metaobject);
  return stripUndefined({
    shop_id: shopId,
    shopify_metaobject_id: metaobject.id,
    metaobject_type: metaobject.type,
    definition_name: cleanTextValue(definition?.name),
    definition_fields: definition?.fieldDefinitions?.map(mapMetaobjectDefinitionField),
    handle: metaobject.handle,
    display_name: cleanTextValue(metaobject.displayName),
    status: null,
    fields,
    content_hash: hashJson(fields),
    synced_at: syncedAt,
    raw_shopify_payload: stripUndefined({
      id: metaobject.id,
      type: metaobject.type,
      handle: metaobject.handle,
      displayName: metaobject.displayName,
      updatedAt: metaobject.updatedAt,
      fields: metaobject.fields
    })
  });
}

function mapMetaobjectDefinitionField(field) {
  return stripUndefined({
    key: field.key,
    name: cleanTextValue(field.name),
    required: field.required,
    type: field.type?.name
  });
}

function metaobjectFieldsObject(metaobject) {
  const fields = {};
  for (const field of metaobject.fields || []) {
    fields[field.key] = stripUndefined({
      type: field.type,
      value: cleanTextValue(field.value),
      json_value: cleanJsonValue(field.jsonValue)
    });
  }
  return fields;
}

function firstFieldValue(fields, keys) {
  for (const key of keys) {
    const field = fields[key];
    if (!field) {
      continue;
    }
    if (typeof field.json_value === 'string') {
      return cleanTextValue(field.json_value);
    }
    if (field.value) {
      return cleanTextValue(field.value);
    }
  }
  return null;
}

function buildProductRawPayload(product, metafields) {
  return stripUndefined({
    id: product.id,
    handle: product.handle,
    title: product.title,
    status: product.status,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    publishedAt: product.publishedAt,
    metafields: metafields.map((metafield) => stripUndefined({
      id: metafield.id,
      namespace: metafield.namespace,
      key: metafield.key,
      definitionName: metafield.definition?.name,
      type: metafield.type,
      value: metafield.value,
      jsonValue: metafield.jsonValue,
      updatedAt: metafield.updatedAt,
      referenceIds: extractMetaobjectReferences(metafield).map((item) => item.id)
    }))
  });
}

function dedupeRows(rows, keyFn) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = keyFn(row);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function stripUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

function cleanJsonValue(value) {
  if (typeof value === 'string') {
    return cleanTextValue(value);
  }
  if (Array.isArray(value)) {
    return value.map(cleanJsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cleanJsonValue(entry)])
    );
  }
  return value;
}

function cleanTextValue(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.replace(/\u00A0/g, ' ').normalize('NFC');
  if (!MOJIBAKE_MARKER_PATTERN.test(normalized)) {
    return normalized;
  }

  return repairUtf8DecodedAsWindows1252(normalized).replace(/\u00A0/g, ' ').normalize('NFC');
}

function repairUtf8DecodedAsWindows1252(value) {
  const bytes = [];

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0xFF) {
      bytes.push(codePoint);
      continue;
    }

    const byte = WINDOWS_1252_REVERSE_BYTES.get(codePoint);
    if (byte === undefined) {
      return repairCommonMojibakeSequences(value);
    }
    bytes.push(byte);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return repairCommonMojibakeSequences(value);
  }
}

function repairCommonMojibakeSequences(value) {
  let repaired = value;
  for (const [broken, fixed] of COMMON_MOJIBAKE_REPLACEMENTS) {
    repaired = repaired.replaceAll(broken, fixed);
  }
  return repaired;
}

function splitCsv(value) {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
