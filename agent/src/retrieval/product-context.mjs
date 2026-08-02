import { flattenRichText } from '../../../scripts/lib/shopify-rich-text.mjs';

// Shapes a product row into the answer-shaped context a drafting agent can use.
//
// WHY SHAPING IS THE WHOLE JOB. The row is a Shopify snapshot: rich-text JSON in
// three different wrappers, merchandising copy mixed with metaobject references,
// and eight fields whose names do not say which of them answers "is it suitable
// for sensitive skin?". Handed over raw it is thousands of tokens of noise. The
// four things support is actually asked — what it is, how to use it, what is in
// it, and the questions people already asked — become four named sections here,
// so the model reads an answer sheet rather than a database row.
//
// Empty sections are omitted entirely rather than rendered as "Ingrédients:
// (none)". An absent section means "we do not hold this", and a model shown an
// empty heading tends to fill it in.

/** Structured, machine-readable. `toPromptText` renders this for a model. */
export function buildProductContext(product) {
  return {
    title: product.title,
    handle: product.handle || null,
    status: product.status || null,
    stock: buildStock(product),
    description: clean(product.short_description) || clean(product.description) || null,
    // Kept apart from `description`: the short one is marketing, the long one
    // often carries the actual detail, and collapsing them loses that.
    fullDescription: clean(product.short_description) ? clean(product.description) : null,
    usage: {
      instructions: clean(product.usage_instructions) || null,
      advice: clean(product.usage_advice) || null
    },
    ingredients: {
      actives: clean(product.active_ingredients) || null,
      notice: clean(product.ingredients_popup) || null,
      details: buildIngredientDetails(product.product_ingredients)
    },
    faqs: buildFaqs(product.product_faqs),
    variants: buildVariants(product.variants)
  };
}

/**
 * The stock tool's payload, and reused inside the full context.
 *
 * `available_stock` can be negative — Shopify allows overselling, and one real
 * row is at -1. Reporting "-1 in stock" to a customer is nonsense, so the
 * boolean is what callers should read and the raw number is kept only for a
 * human. Null means the shop does not track it, which is not the same as zero.
 */
export function buildStock(product) {
  const raw = product.available_stock;
  const tracked = raw !== null && raw !== undefined;
  return {
    tracked,
    available: tracked ? raw : null,
    inStock: tracked ? raw > 0 : null,
    // A draft or archived product is not purchasable whatever the count says.
    purchasable: (product.status || '').toLowerCase() === 'active' && tracked ? raw > 0 : false
  };
}

function buildFaqs(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((faq) => faq && faq.published !== false && faq.question)
    .map((faq) => ({
      question: clean(faq.question),
      // The answer is rich-text JSON stored as a string; unflattened it is 300
      // characters of escaped nodes.
      answer: flattenRichText(faq.answer)
    }))
    .filter((faq) => faq.question && faq.answer);
}

function buildIngredientDetails(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const fields = entry?.fields || {};
      const text = fields.ingredients_text?.json_value ?? fields.ingredients_text?.value;
      return flattenRichText(text);
    })
    .filter(Boolean);
}

/**
 * Variants matter to support only for price, size and whether that specific one
 * is buyable — never the internal ids, inventory item numbers or position.
 */
function buildVariants(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((variant) => ({
    title: clean(variant?.title) || null,
    sku: variant?.sku || null,
    price: variant?.price ?? null,
    available: variant?.available ?? variant?.available_for_sale ?? null
  }));
}

function clean(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return flattenRichText(value).replace(/[ \t]+/g, ' ').trim();
}

/**
 * Renders the context as the text a model actually receives.
 *
 * Markdown headings rather than JSON: the sections are the point, and a model
 * reads "## Ingrédients" more reliably than a nested object. Sections with no
 * content are skipped.
 */
export function toPromptText(context) {
  const parts = [`# ${context.title}`];

  if (context.stock.tracked) {
    parts.push(
      `Disponibilité : ${context.stock.purchasable ? 'en stock' : 'indisponible'}` +
        (context.status && context.status !== 'active' ? ` (statut : ${context.status})` : '')
    );
  }
  if (context.description) {
    parts.push(`## Description\n${context.description}`);
  }
  if (context.fullDescription) {
    parts.push(`## Détail\n${context.fullDescription}`);
  }

  const usage = [context.usage.instructions, context.usage.advice].filter(Boolean).join('\n\n');
  if (usage) {
    parts.push(`## Conseils d'utilisation\n${usage}`);
  }

  const ingredients = [
    context.ingredients.actives,
    ...context.ingredients.details,
    context.ingredients.notice
  ].filter(Boolean).join('\n\n');
  if (ingredients) {
    parts.push(`## Ingrédients\n${ingredients}`);
  }

  if (context.faqs.length > 0) {
    parts.push(
      `## Questions fréquentes\n` +
        context.faqs.map((faq) => `**${faq.question}**\n${faq.answer}`).join('\n\n')
    );
  }

  if (context.variants.length > 1) {
    parts.push(
      `## Déclinaisons\n` +
        context.variants
          .map((v) => `- ${v.title}${v.price ? ` — ${v.price}` : ''}${v.available === false ? ' (indisponible)' : ''}`)
          .join('\n')
    );
  }

  return parts.join('\n\n');
}
