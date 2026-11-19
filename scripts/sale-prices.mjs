import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import {
  createShopifyClient,
  fetchAccessScopes,
  fetchSaleCollection,
  fetchSaleMarkedProducts
} from './lib/shopify-admin-client.mjs';
import {
  SKIP_REASONS,
  campaignId,
  flattenVariants,
  fromCents,
  groupByProduct,
  parseMarker,
  parsePercent,
  planApply,
  planRestore
} from './lib/sale-prices/pricing.mjs';
import {
  applySalePrices,
  deleteSaleMarkers,
  restoreOriginalPrices
} from './lib/sale-prices/shopify-price-writer.mjs';

// Sale prices by collection, from the terminal.
//
//   npm run sale:preview -- --collection <handle> --percent 20   read-only
//   npm run sale:apply   -- --collection <handle> --percent 20   writes, after "APPLY"
//   npm run sale:status                                          what is on sale now
//   npm run sale:restore -- --collection <handle>                back to the original prices
//   npm run sale:restore -- --all                                every marked variant
//
// Flags: --include-drafts (apply/preview), --force (restore hand-edited prices
// too), --yes (skip the typed confirmation).
//
// Why the real price changes, where the original is kept and what a conflict
// is: docs/decisions/sale-prices.md. The rules themselves:
// scripts/lib/sale-prices/pricing.mjs.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_DIR = path.join(REPO_ROOT, 'sale-backups');
const COMMANDS = ['preview', 'apply', 'status', 'restore'];

if (isDirectRun()) {
  main().catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  });
}

export function parseSaleArgs(argv) {
  const args = {
    command: argv[0],
    collection: null,
    percent: null,
    includeDrafts: false,
    force: false,
    all: false,
    yes: false
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      index += 1;
      return argv[index];
    };
    if (flag === '--collection') args.collection = String(value() || '').trim();
    else if (flag === '--percent') args.percent = value();
    else if (flag === '--include-drafts') args.includeDrafts = true;
    else if (flag === '--force') args.force = true;
    else if (flag === '--all') args.all = true;
    else if (flag === '--yes') args.yes = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!COMMANDS.includes(args.command)) {
    throw new Error(`First argument must be one of: ${COMMANDS.join(', ')}.`);
  }
  if (args.command === 'preview' || args.command === 'apply') {
    if (!args.collection) throw new Error('--collection <handle> is required.');
    args.percent = parsePercent(args.percent);
  }
  if (args.command === 'restore' && !args.collection === !args.all) {
    throw new Error('restore needs exactly one of --collection <handle> or --all.');
  }
  return args;
}

async function main() {
  const args = parseSaleArgs(process.argv.slice(2));
  const config = loadConfig(loadEnv());
  const shopify = await createShopifyClient(config);

  if (args.command === 'preview') return runApply({ args, shopify, write: false });
  if (args.command === 'apply') return runApply({ args, shopify, write: true });
  if (args.command === 'status') return runStatus({ shopify });
  return runRestore({ args, shopify });
}

// --- apply / preview -----------------------------------------------------------

async function runApply({ args, shopify, write }) {
  const access = await fetchAccessScopes(shopify);
  if (write) requireWriteAccess(access);

  const found = await fetchSaleCollection(shopify, args.collection);
  if (!found) throw new Error(`No collection with the handle "${args.collection}" on ${access.shopDomain}.`);

  const appliedAt = new Date().toISOString();
  const campaign = campaignId({ handle: args.collection, percent: args.percent });
  const rows = flattenVariants(found.products);
  const { changes, skipped } = planApply(rows, {
    handle: args.collection,
    percent: args.percent,
    campaign,
    includeDrafts: args.includeDrafts,
    appliedAt
  });

  console.log(`\nShop: ${access.shopDomain}`);
  console.log(`Collection: ${found.collection.title} (${found.collection.handle}) — ${found.products.length} products, ${rows.length} variants`);
  console.log(`Sale: -${args.percent} %  ·  campaign ${campaign}\n`);

  printTable(
    `Will change (${changes.length})`,
    ['Product', 'Variant', 'Price now', 'Sale price', 'Compare-at now', 'Compare-at after'],
    changes.map((c) => [c.productTitle, c.variantTitle, money(c.priceCents), money(c.saleCents), money(c.compareCents), money(c.priceCents)])
  );
  printTable(
    `Skipped (${skipped.length})`,
    ['Product', 'Variant', 'Price', 'Compare-at', 'Why'],
    skipped.map((s) => [s.productTitle, s.variantTitle, s.price ?? '', s.compareAtPrice ?? '—', SKIP_REASONS[s.reason] || s.reason])
  );

  if (!write) {
    if (!access.scopes.includes('write_products')) {
      console.log('Note: the app cannot change prices yet (write_products not granted). See sale:apply.');
    }
    console.log('Preview only: nothing was changed.');
    return;
  }
  if (changes.length === 0) {
    console.log('Nothing to change.');
    return;
  }

  await confirm(args, 'APPLY', `${changes.length} variant prices on ${access.shopDomain} (live store) will change.`);

  // The backup is on disk BEFORE the first write.
  const backup = createBackup(`${campaign}_apply`, {
    action: 'apply',
    shop: access.shopDomain,
    campaign,
    collection: found.collection,
    percent: args.percent,
    startedAt: appliedAt,
    variants: changes.map((c) => ({
      product: c.productTitle,
      variant: c.variantTitle,
      productId: c.productId,
      variantId: c.variantId,
      originalPrice: fromCents(c.priceCents),
      originalCompareAtPrice: fromCents(c.compareCents),
      salePrice: fromCents(c.saleCents),
      status: 'pending',
      error: null
    }))
  });
  console.log(`Backup written: ${backup.jsonPath}\n`);

  const tally = { applied: 0, failed: 0 };
  for (const [productId, items] of groupByProduct(changes)) {
    const result = await applySalePrices(shopify, productId, items);
    const status = result.ok ? 'applied' : 'failed';
    tally[status] += items.length;
    backup.update(items.map((item) => item.variantId), status, result.error);
    console.log(`${result.ok ? 'OK  ' : 'FAIL'} ${items[0].productTitle} (${items.length} variant${items.length > 1 ? 's' : ''})${result.error ? ` — ${result.error}` : ''}`);
  }

  console.log(`\nDone: ${tally.applied} variants on sale, ${tally.failed} failed.`);
  if (tally.failed > 0) {
    console.log('Re-run the same command to retry the failed ones: variants already on this sale are skipped.');
    process.exitCode = 1;
  }
}

// --- status --------------------------------------------------------------------

async function runStatus({ shopify }) {
  const access = await fetchAccessScopes(shopify);
  const rows = flattenVariants(await fetchSaleMarkedProducts(shopify));
  console.log(`\nShop: ${access.shopDomain}`);
  if (rows.length === 0) {
    console.log('No variant is on sale (no sale markers found).');
    return;
  }

  const byCampaign = new Map();
  for (const row of rows) {
    const marker = parseMarker(row.markerValue);
    const key = marker?.campaign || '(unreadable marker)';
    if (!byCampaign.has(key)) byCampaign.set(key, []);
    byCampaign.get(key).push({ row, marker });
  }

  for (const [campaign, entries] of byCampaign) {
    printTable(
      `${campaign} — ${entries.length} variants`,
      ['Product', 'Variant', 'Original', 'Sale', 'Now', 'State'],
      entries.map(({ row, marker }) => {
        const now = Math.round(Number(row.price) * 100);
        const state = !marker ? 'check by hand' : now === marker.saleCents ? 'on sale' : now === marker.originalCents ? 'back at original (marker left)' : 'price edited by hand';
        return [row.productTitle, row.variantTitle, money(marker?.originalCents), money(marker?.saleCents), row.price, state];
      })
    );
  }
}

// --- restore -------------------------------------------------------------------

async function runRestore({ args, shopify }) {
  const access = await fetchAccessScopes(shopify);
  requireWriteAccess(access);

  let products;
  let scope;
  if (args.all) {
    products = await fetchSaleMarkedProducts(shopify);
    scope = 'all';
  } else {
    const found = await fetchSaleCollection(shopify, args.collection);
    if (!found) throw new Error(`No collection with the handle "${args.collection}" on ${access.shopDomain}.`);
    products = found.products;
    scope = args.collection;
  }

  const { restores, cleanups, conflicts, skipped } = planRestore(flattenVariants(products), { force: args.force });

  console.log(`\nShop: ${access.shopDomain}  ·  restore: ${scope}${args.force ? '  ·  --force' : ''}\n`);
  printTable(
    `Back to the original price (${restores.length})`,
    ['Product', 'Variant', 'Now', 'Original price', 'Original compare-at', ''],
    restores.map((r) => [r.productTitle, r.variantTitle, r.price, money(r.targetCents), money(r.targetCompareCents), r.forced ? 'forced (was edited by hand)' : ''])
  );
  printTable(
    `Already at the original price, only the marker is removed (${cleanups.length})`,
    ['Product', 'Variant', 'Price'],
    cleanups.map((r) => [r.productTitle, r.variantTitle, r.price])
  );
  printTable(
    `Conflicts: price changed by hand during the sale, NOT touched (${conflicts.length})`,
    ['Product', 'Variant', 'Original', 'Sale', 'Now'],
    conflicts.map((r) => [r.productTitle, r.variantTitle, money(r.marker.originalCents), money(r.marker.saleCents), r.price])
  );
  printTable(
    `Skipped (${skipped.length})`,
    ['Product', 'Variant', 'Why'],
    skipped.map((r) => [r.productTitle, r.variantTitle, SKIP_REASONS[r.reason] || r.reason])
  );

  if (restores.length + cleanups.length === 0) {
    console.log('Nothing to restore.');
    if (conflicts.length > 0) console.log('Use --force to restore the conflicts to their original price anyway.');
    return;
  }

  await confirm(args, 'RESTORE', `${restores.length} variant prices on ${access.shopDomain} (live store) will go back to their original price.`);

  const startedAt = new Date().toISOString();
  const backup = createBackup(`restore_${scope}_${startedAt.slice(0, 10)}`, {
    action: 'restore',
    shop: access.shopDomain,
    scope,
    force: args.force,
    startedAt,
    variants: [...restores, ...cleanups].map((r) => ({
      product: r.productTitle,
      variant: r.variantTitle,
      productId: r.productId,
      variantId: r.variantId,
      campaign: r.marker.campaign,
      priceBefore: r.price,
      compareAtBefore: r.compareAtPrice,
      originalPrice: fromCents(r.targetCents),
      originalCompareAtPrice: fromCents(r.targetCompareCents),
      status: 'pending',
      error: null
    }))
  });
  console.log(`Backup written: ${backup.jsonPath}\n`);

  const tally = { restored: 0, failed: 0 };
  const cleanupsByProduct = groupByProduct(cleanups);
  for (const [productId, items] of groupByProduct([...restores, ...cleanups])) {
    const toRestore = items.filter((item) => !cleanupsByProduct.get(productId)?.includes(item));
    const label = `${items[0].productTitle} (${items.length} variant${items.length > 1 ? 's' : ''})`;

    if (toRestore.length > 0) {
      const result = await restoreOriginalPrices(shopify, productId, toRestore);
      if (!result.ok) {
        tally.failed += items.length;
        backup.update(items.map((item) => item.variantId), 'failed', result.error);
        console.log(`FAIL ${label} — ${result.error}`);
        continue;
      }
    }

    // Prices are back; now the markers. If this step fails the variant is
    // already at its original price, and the next restore only cleans up.
    const cleaned = await deleteSaleMarkers(shopify, items.map((item) => item.variantId));
    const status = cleaned.ok ? 'restored' : 'restored_marker_left';
    tally.restored += items.length;
    backup.update(items.map((item) => item.variantId), status, cleaned.error);
    console.log(`OK   ${label}${cleaned.ok ? '' : ` — price restored, marker not removed: ${cleaned.error} (re-run restore to clean it)`}`);
  }

  console.log(`\nDone: ${tally.restored} variants restored, ${tally.failed} failed, ${conflicts.length} conflicts left alone.`);
  console.log('Check with: npm run sale:status');
  if (tally.failed > 0) process.exitCode = 1;
}

// --- helpers -------------------------------------------------------------------

function requireWriteAccess(access) {
  if (access.scopes.includes('write_products')) return;
  throw new Error(
    'The app is not allowed to change prices yet: the write_products permission is not granted.\n' +
      '1. Add write_products to `scopes` in shopify.app.toml\n' +
      '2. Run `shopify app deploy`\n' +
      '3. The store owner approves the new permission in Shopify Admin > Apps.'
  );
}

async function confirm(args, word, message) {
  console.log(`\n${message}`);
  if (args.yes) return;
  if (!process.stdin.isTTY) throw new Error(`Not an interactive terminal: re-run with --yes to confirm.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Type ${word} to continue: `);
  rl.close();
  if (answer.trim() !== word) throw new Error('Cancelled: nothing was changed.');
}

/**
 * A JSON backup (rewritten after every product, via a temp file + rename so an
 * interruption never leaves half a file) and a CSV copy written once up front.
 */
function createBackup(name, data) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(BACKUP_DIR, `${name}_${stamp}`);
  const jsonPath = `${base}.json`;

  const save = () => {
    const tmp = `${jsonPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, jsonPath);
  };
  save();

  const columns = Object.keys(data.variants[0] || {}).filter((key) => key !== 'status' && key !== 'error');
  const csv = [columns.join(';'), ...data.variants.map((v) => columns.map((key) => csvCell(v[key])).join(';'))].join('\n');
  fs.writeFileSync(`${base}.csv`, `﻿${csv}\n`);

  return {
    jsonPath,
    update(variantIds, status, error) {
      const ids = new Set(variantIds);
      for (const variant of data.variants) {
        if (ids.has(variant.variantId)) {
          variant.status = status;
          variant.error = error || null;
        }
      }
      data.updatedAt = new Date().toISOString();
      save();
    }
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function money(cents) {
  return cents === null || cents === undefined ? '—' : fromCents(cents);
}

function printTable(title, headers, rows) {
  console.log(`${title}`);
  if (rows.length === 0) {
    console.log('  (none)\n');
    return;
  }
  const cells = [headers, ...rows].map((row) => row.map((cell) => String(cell ?? '')));
  const widths = headers.map((_, column) => Math.min(42, Math.max(...cells.map((row) => row[column].length))));
  const line = (row) => `  ${row.map((cell, column) => cell.slice(0, widths[column]).padEnd(widths[column])).join('  ')}`.trimEnd();
  console.log(line(cells[0]));
  console.log(`  ${widths.map((width) => '-'.repeat(width)).join('  ')}`);
  for (const row of cells.slice(1)) console.log(line(row));
  console.log('');
}

function isDirectRun() {
  return import.meta.url === pathToFileURL(process.argv[1] || '').href;
}
