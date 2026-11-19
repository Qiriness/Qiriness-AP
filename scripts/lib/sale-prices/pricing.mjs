/**
 * Sale prices by collection: the pure rules (no I/O).
 *
 * WHY THE REAL PRICE CHANGES. Google Merchant Center only shows a sale when
 * the product's price is below its compare-at price. A checkout discount (an
 * automatic discount, the theme's promo-X collections) leaves both untouched,
 * so Google Ads never sees the promotion. A sale therefore sets
 * price = discounted, compare-at = the price it had before.
 *
 * THE ORIGINAL PRICE IS NEVER LOST. Every reduced variant carries a marker
 * metafield (`qiriness_sale.original`) holding its original price and
 * compare-at, written in the same Shopify call as the new price. Restore reads
 * the marker, not a file, so it works from any machine. The CLI also writes a
 * local backup before any write.
 *
 * Money is handled in integer cents throughout: Shopify sends prices as
 * decimal strings ("114.90"), and floating-point arithmetic on those is how a
 * price drifts by a cent.
 */

export const SALE_MARKER = Object.freeze({
  namespace: 'qiriness_sale',
  key: 'original',
  type: 'json'
});

export const MIN_PERCENT = 1;
export const MAX_PERCENT = 90;

/** "114.90" | 114.9 | null -> 11490 | null. Throws on anything that is not a price. */
export function toCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Not a price: ${JSON.stringify(value)}`);
  }
  return Math.round(number * 100);
}

/** 11490 -> "114.90" (the string form Shopify's Money input takes). */
export function fromCents(cents) {
  if (cents === null || cents === undefined) return null;
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`Not a cent amount: ${cents}`);
  return (cents / 100).toFixed(2);
}

/**
 * The sale price: price - round(price * percent / 100), in cents.
 * The same rounding as the theme's snippets/promo-pricing.liquid, so a 20 %
 * sale lands on the same figure the site used to display.
 */
export function salePriceCents(priceCents, percent) {
  return priceCents - Math.round((priceCents * percent) / 100);
}

export function parsePercent(value) {
  const percent = Number(value);
  if (!Number.isInteger(percent) || percent < MIN_PERCENT || percent > MAX_PERCENT) {
    throw new Error(`--percent must be a whole number between ${MIN_PERCENT} and ${MAX_PERCENT}.`);
  }
  return percent;
}

/** "black-friday-20-2026-11-26": what every marker and backup is labelled with. */
export function campaignId({ handle, percent, date = new Date() }) {
  return `${handle}-${percent}-${date.toISOString().slice(0, 10)}`;
}

export function buildMarker({ campaign, handle, percent, originalCents, originalCompareCents, saleCents, appliedAt }) {
  return JSON.stringify({
    v: 1,
    campaign,
    collection: handle,
    percent,
    original_price: fromCents(originalCents),
    original_compare_at_price: fromCents(originalCompareCents),
    sale_price: fromCents(saleCents),
    applied_at: appliedAt
  });
}

/** The marker's JSON -> a checked object, or null when it cannot be trusted. */
export function parseMarker(value) {
  if (!value) return null;
  let data;
  try {
    data = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  try {
    const originalCents = toCents(data.original_price);
    const saleCents = toCents(data.sale_price);
    if (originalCents === null || saleCents === null) return null;
    return {
      campaign: String(data.campaign || ''),
      collection: String(data.collection || ''),
      percent: Number(data.percent),
      originalCents,
      originalCompareCents: toCents(data.original_compare_at_price),
      saleCents,
      appliedAt: data.applied_at || null
    };
  } catch {
    return null;
  }
}

/**
 * Flattens Shopify product nodes into one row per variant.
 * Input: [{ id, title, status, variants: [{ id, title, price, compareAtPrice, metafield }] }]
 */
export function flattenVariants(products) {
  const rows = [];
  for (const product of products) {
    for (const variant of product.variants || []) {
      rows.push({
        productId: product.id,
        productTitle: product.title,
        productStatus: product.status,
        variantId: variant.id,
        variantTitle: variant.title,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        markerId: variant.metafield?.id || null,
        markerValue: variant.metafield?.value ?? null
      });
    }
  }
  return rows;
}

export const SKIP_REASONS = Object.freeze({
  not_active: 'product is not active (draft/archived): use --include-drafts',
  invalid_price: 'price could not be read',
  zero_price: 'price is 0',
  already_reduced: 'already has a compare-at above its price (already reduced)',
  on_this_sale: 'already on this sale',
  on_other_sale: 'already on another sale',
  unreadable_marker: 'carries an unreadable sale marker: check it by hand',
  no_change: 'too cheap for this percentage to change the price'
});

/**
 * What a sale would do to each variant. Pure: same input, same plan.
 * Returns { changes, skipped }; a skipped row carries `reason` (a SKIP_REASONS key).
 */
export function planApply(rows, { handle, percent, campaign, includeDrafts = false, appliedAt }) {
  const changes = [];
  const skipped = [];

  for (const row of rows) {
    const skip = (reason) => skipped.push({ ...row, reason });

    if (row.markerValue !== null && row.markerValue !== undefined) {
      const marker = parseMarker(row.markerValue);
      if (!marker) skip('unreadable_marker');
      else if (marker.collection === handle && marker.percent === percent) skip('on_this_sale');
      else skip('on_other_sale');
      continue;
    }
    if (!includeDrafts && row.productStatus !== 'ACTIVE') {
      skip('not_active');
      continue;
    }

    let priceCents;
    let compareCents;
    try {
      priceCents = toCents(row.price);
      compareCents = toCents(row.compareAtPrice);
    } catch {
      skip('invalid_price');
      continue;
    }
    if (priceCents === null) {
      skip('invalid_price');
      continue;
    }
    if (priceCents === 0) {
      skip('zero_price');
      continue;
    }
    if (compareCents !== null && compareCents > priceCents) {
      skip('already_reduced');
      continue;
    }

    const saleCents = salePriceCents(priceCents, percent);
    if (saleCents >= priceCents || saleCents <= 0) {
      skip('no_change');
      continue;
    }

    changes.push({
      ...row,
      priceCents,
      compareCents,
      saleCents,
      marker: buildMarker({
        campaign,
        handle,
        percent,
        originalCents: priceCents,
        originalCompareCents: compareCents,
        saleCents,
        appliedAt
      })
    });
  }

  return { changes, skipped };
}

/**
 * What a restore would do to each MARKED variant (rows without a marker are ignored).
 *
 * - restores:  price still equals the sale price -> back to the original price
 *              and compare-at, marker removed. With `force`, also the conflicts.
 * - cleanups:  already back at the original price and compare-at -> only the
 *              marker is removed (a previous restore stopped between the two steps).
 * - conflicts: the price was changed by hand during the sale -> left alone.
 * - skipped:   the marker cannot be read -> never touched.
 */
export function planRestore(rows, { force = false } = {}) {
  const restores = [];
  const cleanups = [];
  const conflicts = [];
  const skipped = [];

  for (const row of rows) {
    if (row.markerValue === null || row.markerValue === undefined) continue;
    const marker = parseMarker(row.markerValue);
    if (!marker) {
      skipped.push({ ...row, reason: 'unreadable_marker' });
      continue;
    }

    let currentCents;
    let currentCompareCents;
    try {
      currentCents = toCents(row.price);
      currentCompareCents = toCents(row.compareAtPrice);
    } catch {
      skipped.push({ ...row, reason: 'invalid_price' });
      continue;
    }

    const item = {
      ...row,
      marker,
      currentCents,
      currentCompareCents,
      targetCents: marker.originalCents,
      targetCompareCents: marker.originalCompareCents
    };

    if (currentCents === marker.originalCents && currentCompareCents === marker.originalCompareCents) {
      cleanups.push(item);
    } else if (currentCents === marker.saleCents) {
      restores.push(item);
    } else if (force) {
      restores.push({ ...item, forced: true });
    } else {
      conflicts.push(item);
    }
  }

  return { restores, cleanups, conflicts, skipped };
}

/** Groups rows by productId, keeping first-seen order (one Shopify call per product). */
export function groupByProduct(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.productId)) groups.set(row.productId, []);
    groups.get(row.productId).push(row);
  }
  return groups;
}
