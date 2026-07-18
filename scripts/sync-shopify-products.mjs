import { dedupeRows } from './lib/collections.mjs';
import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import {
  createShopifyClient,
  fetchMetaobjectsByType,
  fetchProductPage,
  fetchShop,
  fetchTargetMetaobjectDefinitions
} from './lib/shopify-admin-client.mjs';
import { createSupabaseClient, supabaseUpsert } from './lib/supabase-rest-client.mjs';
import { syncShop } from './lib/shop-sync-service.mjs';
import { mapMetaobject, mapProduct } from './lib/shopify-sync-mappers.mjs';

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(loadEnv());

  const shopify = await createShopifyClient(config);
  const supabase = createSupabaseClient(config);
  const syncedAt = new Date().toISOString();

  const shop = await fetchShop(shopify);
  const shopRow = await syncShop({ args, config, supabase, shop });

  await syncTargetMetaobjects({ args, shopify, supabase, shopId: shopRow.id, syncedAt, config });
  await syncProducts({ args, shopify, supabase, shopId: shopRow.id, syncedAt });
}

async function syncTargetMetaobjects({ args, shopify, supabase, shopId, syncedAt, config }) {
  const targetDefinitions = await fetchTargetMetaobjectDefinitions(shopify, config);
  const fullMetaobjectRows = [];

  for (const definition of targetDefinitions) {
    const metaobjects = await fetchMetaobjectsByType(shopify, definition.type);
    fullMetaobjectRows.push(
      ...metaobjects.map((metaobject) => mapMetaobject(metaobject, shopId, syncedAt, definition))
    );
  }

  if (args.dryRun) {
    console.log(
      `Dry run: would upsert ${fullMetaobjectRows.length} metaobjects from ${targetDefinitions.length} target definitions.`
    );
    return;
  }

  if (fullMetaobjectRows.length === 0) {
    return;
  }

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

async function syncProducts({ args, shopify, supabase, shopId, syncedAt }) {
  let cursor = null;
  let totalProducts = 0;
  let totalMetaobjects = 0;

  do {
    const page = await fetchProductPage(shopify, args, cursor);
    const products = page.products.nodes;
    const mapped = products.map((product) => mapProduct(product, shopId, syncedAt));
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
      await upsertProductPage({ supabase, productRows, metaobjectRows });
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

async function upsertProductPage({ supabase, productRows, metaobjectRows }) {
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
}
