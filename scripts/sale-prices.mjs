import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createShopifyClient, shopifyGraphql } from './lib/shopify-admin-client.mjs';
import {
  SKIP_REASONS,
  UNREADABLE_SALE_KEY,
  campaignId,
  flattenVariants,
  fromCents,
  groupSales,
  parseMarker,
  parsePercent,
  planApply,
  planRestore,
  selectCollectionSaleRows
} from './lib/sale-prices/pricing.mjs';
import {
  fetchAccessScopes,
  fetchSaleCollection,
  fetchSaleMarkedProducts
} from './lib/sale-prices/shopify-sale-reads.mjs';
import { runApply, runRestore } from './lib/sale-prices/runner.mjs';

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
// is: docs/decisions/sale-prices.md. The rules, reads, writes and runner live in
// scripts/lib/sale-prices/ and are shared with the app's admin page
// (extensions/sale-prices). This CLI adds the tables, the typed confirmation
// and the local backup files.

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
  const graphql = (query, variables) => shopifyGraphql(shopify, query, variables);

  if (args.command === 'preview') return commandApply({ args, graphql, write: false });
  if (args.command === 'apply') return commandApply({ args, graphql, write: true });
  if (args.command === 'status') return commandStatus({ graphql });
  return commandRestore({ args, graphql });
}

// --- apply / preview -----------------------------------------------------------

async function commandApply({ args, graphql, write }) {
  const access = await fetchAccessScopes(graphql);
  if (write) requireWriteAccess(access);

  const found = await fetchSaleCollection(graphql, args.collection);
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

  const tally = await runApply({
    graphql,
    changes,
    onProduct: ({ items, ok, error }) => {
      backup.update(items.map((item) => item.variantId), ok ? 'applied' : 'failed', error);
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${items[0].productTitle} (${plural(items.length, 'variant')})${error ? ` — ${error}` : ''}`);
    }
  });

  console.log(`\nDone: ${tally.applied} variants on sale, ${tally.failed} failed.`);
  if (tally.failed > 0) {
    console.log('Re-run the same command to retry the failed ones: variants already on this sale are skipped.');
    process.exitCode = 1;
  }
}

// --- status --------------------------------------------------------------------

async function commandStatus({ graphql }) {
  const access = await fetchAccessScopes(graphql);
  const rows = flattenVariants(await fetchSaleMarkedProducts(graphql));
  console.log(`\nShop: ${access.shopDomain}`);
  if (rows.length === 0) {
    console.log('No variant is on sale (no sale markers found).');
    return;
  }

  // One table per sale (collection + %), however many days it was applied on.
  for (const sale of groupSales(rows)) {
    const title =
      sale.key === UNREADABLE_SALE_KEY
        ? `Unreadable markers — ${sale.rows.length} variants (check by hand)`
        : `${sale.collection} -${sale.percent} % — ${sale.rows.length} variants · applied ${datesLabel(sale)}`;
    printTable(
      title,
      ['Product', 'Variant', 'Original', 'Sale', 'Now', 'State'],
      sale.rows.map((row) => {
        const marker = parseMarker(row.markerValue);
        const now = Math.round(Number(row.price) * 100);
        const state = !marker ? 'check by hand' : now === marker.saleCents ? 'on sale' : now === marker.originalCents ? 'back at original (marker left)' : 'price edited by hand';
        return [row.productTitle, row.variantTitle, money(marker?.originalCents), money(marker?.saleCents), row.price, state];
      })
    );
  }
}

function datesLabel(sale) {
  const first = (sale.firstAppliedAt || '').slice(0, 10);
  const last = (sale.lastAppliedAt || '').slice(0, 10);
  return first === last ? first : `${first} → ${last}`;
}

// --- restore -------------------------------------------------------------------

async function commandRestore({ args, graphql }) {
  const access = await fetchAccessScopes(graphql);
  requireWriteAccess(access);

  // What to restore comes from the MARKERS, not from the collection's current
  // members: a product removed from the collection during the sale is still
  // reduced and must come back too, and a product in the collection that
  // another collection's sale reduced must be left to that sale.
  const markedRows = flattenVariants(await fetchSaleMarkedProducts(graphql));
  let rows;
  let otherSales = [];
  let scope;
  if (args.all) {
    rows = markedRows;
    scope = 'all';
  } else {
    const found = await fetchSaleCollection(graphql, args.collection);
    if (!found) console.log(`\nNote: no collection "${args.collection}" any more; restoring what its sales reduced anyway.`);
    const selected = selectCollectionSaleRows(markedRows, {
      handle: args.collection,
      collectionProductIds: found ? found.products.map((product) => product.id) : []
    });
    rows = selected.ofCollection;
    otherSales = selected.otherSales;
    scope = args.collection;
  }

  const { restores, cleanups, conflicts, skipped } = planRestore(rows, { force: args.force });
  const notes = (r) => [r.forced ? 'forced (was edited by hand)' : '', r.removedFromCollection ? 'no longer in the collection' : '']
    .filter(Boolean)
    .join('; ');

  console.log(`\nShop: ${access.shopDomain}  ·  restore: ${scope}${args.force ? '  ·  --force' : ''}\n`);
  printTable(
    `Back to the original price (${restores.length})`,
    ['Product', 'Variant', 'Now', 'Original price', 'Original compare-at', ''],
    restores.map((r) => [r.productTitle, r.variantTitle, r.price, money(r.targetCents), money(r.targetCompareCents), notes(r)])
  );
  if (otherSales.length > 0) {
    printTable(
      `In the collection but on another sale, NOT touched (${otherSales.length})`,
      ['Product', 'Variant', 'Price', 'Sale'],
      otherSales.map((r) => [r.productTitle, r.variantTitle, r.price, r.otherSale])
    );
  }
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

  const tally = await runRestore({
    graphql,
    restores,
    cleanups,
    onProduct: ({ items, ok, markerLeft, error }) => {
      const label = `${items[0].productTitle} (${plural(items.length, 'variant')})`;
      const status = !ok ? 'failed' : markerLeft ? 'restored_marker_left' : 'restored';
      backup.update(items.map((item) => item.variantId), status, error);
      if (!ok) console.log(`FAIL ${label} — ${error}`);
      else if (markerLeft) console.log(`OK   ${label} — price restored, marker not removed: ${error} (re-run restore to clean it)`);
      else console.log(`OK   ${label}`);
    }
  });

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

function plural(count, word) {
  return `${count} ${word}${count > 1 ? 's' : ''}`;
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
