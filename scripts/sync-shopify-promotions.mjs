import { pathToFileURL } from 'node:url';

import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import {
  createShopifyClient,
  fetchDiscountRedeemCodePage,
  fetchDiscountPage,
  fetchShop
} from './lib/shopify-admin-client.mjs';
import {
  createSupabaseClient,
  supabaseDeleteWhereIn,
  supabaseSelect,
  supabaseUpsert
} from './lib/supabase-rest-client.mjs';
import { syncShop } from './lib/shop-sync-service.mjs';
import { mapPromotionRows } from './lib/shopify-sync-mappers.mjs';
import { hashIdentifier, recordDataAccessEvent } from './lib/compliance-audit.mjs';

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(loadEnv());

  const shopify = await createShopifyClient(config);
  const supabase = createSupabaseClient(config);
  const syncedAt = new Date().toISOString();

  const shop = await fetchShop(shopify);
  const shopRow = await syncShop({ args, config, supabase, shop });

  await runShopifyPromotionsSync({
    args,
    shopify,
    supabase,
    shopRow,
    syncedAt
  });
}

export async function runShopifyPromotionsSync({ args, shopify, supabase, shopRow, syncedAt, integrationEventId = null }) {
  let cursor = null;
  let totalDiscounts = 0;
  let totalPromotions = 0;
  let deletedPromotions = 0;
  const seenPromotionKeys = new Set();
  const methodCounts = new Map();
  const statusCounts = new Map();

  do {
    const page = await fetchDiscountPage(shopify, args, cursor);
    const discountNodes = await expandDiscountCodePages(shopify, page.discountNodes.nodes);
    const promotionRows = discountNodes.flatMap((node) => (
      mapPromotionRows(node, shopRow.id, syncedAt)
    ));

    totalDiscounts += discountNodes.length;
    totalPromotions += promotionRows.length;
    for (const promotion of promotionRows) {
      seenPromotionKeys.add(promotion.promotion_key);
      increment(methodCounts, promotion.method || 'unknown');
      increment(statusCounts, promotion.status || 'UNKNOWN');
    }

    if (args.dryRun) {
      console.log(
        `Dry run: page contains ${discountNodes.length} discounts and ${promotionRows.length} promotion rows.`
      );
    } else {
      await recordDataAccessEvent(supabase, {
        shop_id: shopRow.id,
        integration_event_id: integrationEventId,
        action: 'shopify_promotions_sync_page',
        resource_type: 'promotions',
        resource_id_hash: hashIdentifier(`${shopRow.shop_domain}:${cursor || 'first-page'}`),
        purpose: 'nightly Shopify promotion snapshot sync',
        metadata: {
          discount_count: discountNodes.length,
          promotion_count: promotionRows.length,
          dry_run: false
        }
      });
      await upsertPromotionPage({ supabase, promotionRows });
      console.log(`Synced ${totalPromotions} promotion rows from ${totalDiscounts} discounts so far.`);
    }

    cursor = page.discountNodes.pageInfo.hasNextPage ? page.discountNodes.pageInfo.endCursor : null;
    if (args.limit && totalDiscounts >= args.limit) {
      break;
    }
  } while (cursor);

  if (!args.dryRun && !args.limit) {
    deletedPromotions = await deletePromotionsMissingFromShopify({
      supabase,
      shopId: shopRow.id,
      seenPromotionKeys
    });
  }

  console.log(
    `${args.dryRun ? 'Dry run complete' : 'Sync complete'}: ${totalPromotions} promotion rows from ${totalDiscounts} discounts, methods ${formatMap(methodCounts)}, statuses ${formatMap(statusCounts)}.`
  );
  if (deletedPromotions > 0) {
    console.log(`Deleted ${deletedPromotions} promotions no longer returned by Shopify.`);
  }

  return {
    discounts: totalDiscounts,
    promotions: totalPromotions,
    deletedPromotions,
    methods: Object.fromEntries(methodCounts),
    statuses: Object.fromEntries(statusCounts)
  };
}

async function upsertPromotionPage({ supabase, promotionRows }) {
  if (promotionRows.length === 0) {
    return;
  }

  await supabaseUpsert(
    supabase,
    'promotions',
    promotionRows,
    'shop_id,promotion_key'
  );
}

async function expandDiscountCodePages(shopify, discountNodes) {
  const expanded = [];

  for (const discountNode of discountNodes) {
    const codes = discountNode.discount?.codes;
    if (!codes?.pageInfo?.hasNextPage) {
      expanded.push(discountNode);
      continue;
    }

    const allCodes = [...(codes.nodes || [])];
    let cursor = codes.pageInfo.endCursor;
    while (cursor) {
      const page = await fetchDiscountRedeemCodePage(shopify, discountNode.id, cursor);
      allCodes.push(...(page.nodes || []));
      cursor = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    }

    expanded.push({
      ...discountNode,
      discount: {
        ...discountNode.discount,
        codes: {
          ...codes,
          nodes: allCodes,
          pageInfo: {
            hasNextPage: false,
            endCursor: null
          }
        }
      }
    });
  }

  return expanded;
}

async function deletePromotionsMissingFromShopify({ supabase, shopId, seenPromotionKeys }) {
  const existingRows = await supabaseSelect(
    supabase,
    'promotions',
    { shop_id: shopId },
    'id,promotion_key'
  );
  const staleIds = existingRows
    .filter((row) => !seenPromotionKeys.has(row.promotion_key))
    .map((row) => row.id);

  if (staleIds.length === 0) {
    return 0;
  }

  await supabaseDeleteWhereIn(supabase, 'promotions', 'id', staleIds);
  return staleIds.length;
}

function increment(counts, key) {
  counts.set(key, (counts.get(key) || 0) + 1);
}

function formatMap(counts) {
  if (counts.size === 0) {
    return '{}';
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key}: ${count}`)
    .join(', ');
}

function isDirectRun() {
  return import.meta.url === pathToFileURL(process.argv[1] || '').href;
}
