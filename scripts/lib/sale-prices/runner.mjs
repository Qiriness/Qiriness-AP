/**
 * Sale prices: running a plan against Shopify, one product at a time. Shared by
 * the CLI and the admin page, which differ only in how they report progress
 * (a printed line and a backup file; a progress bar).
 *
 * Product by product, never in parallel: each call is all-or-nothing for its
 * product, and a run interrupted midway leaves every product either done or
 * untouched, which the markers then tell apart on the next run.
 */
import { groupByProduct } from './pricing.mjs';
import { applySalePrices, deleteSaleMarkers, restoreOriginalPrices } from './shopify-price-writer.mjs';

/**
 * changes: planApply().changes.
 * onProduct({ productId, items, ok, error, done, total }) after each product.
 * -> { applied, failed } (variant counts)
 */
export async function runApply({ graphql, changes, onProduct = (_progress) => {} }) {
  const groups = [...groupByProduct(changes)];
  const tally = { applied: 0, failed: 0 };

  for (const [index, [productId, items]] of groups.entries()) {
    const result = await applySalePrices(graphql, productId, items);
    tally[result.ok ? 'applied' : 'failed'] += items.length;
    await onProduct({ productId, items, ok: result.ok, error: result.error, done: index + 1, total: groups.length });
  }
  return tally;
}

/**
 * restores + cleanups: planRestore()'s lists. Prices first, then the markers:
 * if removing a marker fails, the variant is already back at its original
 * price and the next restore only cleans it up.
 * onProduct({ productId, items, ok, markerLeft, error, done, total })
 * -> { restored, failed, markersLeft } (variant counts)
 */
export async function runRestore({ graphql, restores, cleanups, onProduct = (_progress) => {} }) {
  const cleanupIds = new Set(cleanups.map((item) => item.variantId));
  const groups = [...groupByProduct([...restores, ...cleanups])];
  const tally = { restored: 0, failed: 0, markersLeft: 0 };

  for (const [index, [productId, items]] of groups.entries()) {
    const progress = { productId, items, done: index + 1, total: groups.length };
    const toRestore = items.filter((item) => !cleanupIds.has(item.variantId));

    if (toRestore.length > 0) {
      const result = await restoreOriginalPrices(graphql, productId, toRestore);
      if (!result.ok) {
        tally.failed += items.length;
        await onProduct({ ...progress, ok: false, markerLeft: false, error: result.error });
        continue;
      }
    }

    const cleaned = await deleteSaleMarkers(graphql, items.map((item) => item.variantId));
    tally.restored += items.length;
    if (!cleaned.ok) tally.markersLeft += items.length;
    await onProduct({ ...progress, ok: true, markerLeft: !cleaned.ok, error: cleaned.error });
  }
  return tally;
}
