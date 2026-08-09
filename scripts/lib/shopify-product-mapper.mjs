import { dedupeRows, stripUndefined } from './collections.mjs';
import { hashJson } from './hash.mjs';
import { mapMetaobject, metaobjectFieldsObject } from './shopify-metaobject-mapper.mjs';
import { cleanJsonValue, cleanTextValue } from './text-cleaning.mjs';
import { htmlToText } from './html-to-text.mjs';
import { flattenRichText } from './shopify-rich-text.mjs';

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
    'actifs_ingredients',
    // The live store names this definition "Actif et ingrédients" — singular,
    // and joined with "et" rather than "&". Normalisation strips the accent but
    // not the wording, so none of the three aliases above ever matched it and
    // the column stayed null on every product that had the field.
    'actif et ingredients',
    'actifs et ingredients',
    'actif ingredients',
    'active_ingredients',
    'active ingredients'
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

/**
 * Did Shopify have more metafields than we asked for?
 *
 * Exported so the sync can report it. The support tools read usage
 * instructions, ingredients and FAQs out of metafields, and when the connection
 * truncates, those columns come back null — indistinguishable from a product
 * that genuinely has no merchandising. That is precisely how 112 of 116
 * products looked empty while the data sat in Shopify the whole time.
 */
export function metafieldsTruncated(product) {
  return Boolean(product?.metafields?.pageInfo?.hasNextPage);
}

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
    // `description` is Shopify's own plain-text rendering, so it needs no work.
    // The `descriptionHtml` FALLBACK does: it is markup, and storing it raw put
    // a literal `<p><br></p>` in the column for every product whose description
    // is visually empty — which then reads as content to anything downstream.
    description:
      cleanTextValue(product.description || htmlToText(product.descriptionHtml) || null) || null,
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

  // PASS 1 — the real definitions. Everything is archived into
  // structuredMetafields here, recognised or not, so nothing is ever lost.
  for (const metafield of metafields) {
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

    applyMetafield(result, metafield, identifyMetafieldTarget(metafield), references);
  }

  // PASS 2 — the legacy Accentuate fields, and ONLY where pass 1 found nothing.
  //
  // A separate pass rather than another alias list, because precedence has to be
  // deterministic: a product carrying both the modern definition and the legacy
  // key would otherwise be decided by whichever happened to come later in
  // Shopify's array. The definition-backed value always wins; the legacy one
  // fills a hole and never overwrites.
  for (const metafield of metafields) {
    const target = identifyLegacyTarget(metafield);
    if (target && isEmptyTarget(result[target])) {
      applyMetafield(result, metafield, target, extractMetaobjectReferences(metafield));
    }
  }

  result.metaobjects = dedupeRows(result.metaobjects, (row) => row.id);
  return result;
}

function isEmptyTarget(value) {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

function applyMetafield(result, metafield, target, references) {
  if (!target) {
    return;
  }

  if (target === 'product_ingredients') {
    result.product_ingredients = references.length > 0
      ? references.map(metaobjectToSnapshot)
      : arrayValue(metafield);
    result.product_ingredient_metaobject_ids = references.map((item) => item.id);
    result.metaobjects.push(...references);
    return;
  }

  if (target === 'product_faqs') {
    result.product_faqs = references.length > 0
      ? references.map(metaobjectToFaqSnapshot)
      : productFaqValue(metafield);
    result.product_faq_metaobject_ids = references.map((item) => item.id);
    result.metaobjects.push(...references);
    return;
  }

  result[target] = scalarValue(metafield);
}

/**
 * Legacy fields from the Accentuate Custom Fields app, matched on the FULL
 * `namespace.key` so nothing in another namespace is caught by accident.
 *
 * These predate Shopify-native metafield definitions and are still the only
 * source on a large part of the catalogue: measured on the live store,
 * `accentuate.ingredients` is on 92 products and `accentuate.how_to_tuse` on 94,
 * and roughly 40 ACTIVE products have no other source for either. Without these
 * their ingredients and usage instructions sat unreachable in structured_facts
 * and the product tool answered "no information" for a third of the catalogue.
 *
 * Both carry rich-text PROSE, so they map to the text columns — never to
 * product_ingredients, which holds metaobject snapshots and would be corrupted
 * by a string.
 */
const LEGACY_FIELD_TARGETS = {
  usage_instructions: [
    // "tuse" is a real typo in the store's data, not a mistake here. The
    // corrected spelling is listed too, so fixing it in Shopify changes nothing.
    'accentuate.how_to_tuse',
    'accentuate.how_to_use'
  ],
  active_ingredients: ['accentuate.ingredients'],
  short_description: [
    // Already matched via the bare `short_description` key, which is why that
    // column read 107 rather than the 53 the definition covers. Listed
    // explicitly so it is intentional rather than a coincidence that could
    // disappear if the key ever changed.
    'accentuate.short_description'
  ]
};

function identifyLegacyTarget(metafield) {
  const qualified = normalizeLabel(`${metafield.namespace}.${metafield.key}`);
  for (const [target, aliases] of Object.entries(LEGACY_FIELD_TARGETS)) {
    if (aliases.some((alias) => normalizeLabel(alias) === qualified)) {
      return target;
    }
  }
  return null;
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

/**
 * One column, one format: readable plain text.
 *
 * Shopify hands the same logical field over in three shapes, and this column was
 * storing all three. Measured on the live catalogue, of 101 products with usage
 * instructions, 50 held a raw rich-text JSON document, 51 held HTML with
 * undecoded entities (`apr&egrave;s`, `d&rsquo;actifs`) and none held text a
 * human or a model could read:
 *
 *   1. rich-text JSON  (a native `rich_text_field` — object, or a JSON string)
 *   2. HTML            (the legacy Accentuate fields)
 *   3. plain text
 *
 * Downstream only `flattenRichText` was applied, which parses shape 1 and
 * returns shapes 2 and 3 untouched — so the drafting model received raw `<p>`
 * tags and `&eacute;` for half the catalogue. Normalising here rather than at
 * every read means the column is trustworthy for whoever comes next, and leaves
 * the reader's own flatten as a harmless no-op.
 */
function scalarValue(metafield) {
  const source = metafield.jsonValue ?? metafield.value ?? null;
  if (source === null) {
    return null;
  }

  // Renders rich-text JSON (object or string) to text; any other string is
  // returned unchanged, which is what lets the HTML case fall through.
  const flattened = flattenRichText(source);
  const text = /<[a-z][\s\S]*>/i.test(flattened) ? htmlToText(flattened) : flattened;
  return cleanTextValue(text || null);
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
