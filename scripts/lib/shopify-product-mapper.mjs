import { dedupeRows, stripUndefined } from './collections.mjs';
import { hashJson } from './hash.mjs';
import { mapMetaobject, metaobjectFieldsObject } from './shopify-metaobject-mapper.mjs';
import { cleanJsonValue, cleanTextValue } from './text-cleaning.mjs';

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

export function mapProduct(product, shopId, syncedAt) {
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
