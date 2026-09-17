import { pathToFileURL } from 'node:url';

import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import {
  createShopifyClient,
  fetchCollectionPage,
  fetchCollectionProducts,
  fetchShop
} from './lib/shopify-admin-client.mjs';
import {
  createSupabaseClient,
  supabaseSelectAll,
  supabaseUpdateById,
  supabaseUpsert
} from './lib/supabase-rest-client.mjs';
import { syncShop } from './lib/shop-sync-service.mjs';
import { T } from './lib/tables.mjs';
import { mapCollectionRow } from './lib/shopify-collection-mapper.mjs';

// Mirrors Shopify's collections into `advice_collections`, and refreshes the
// membership of the ones support actually answers from.
//
// TWO PASSES, AND THE SECOND IS THE NARROW ONE. The catalogue pass writes every
// collection the shop has — 175 of them, most of which nobody will ever switch
// on — so the curation screen has something to search. The membership pass then
// asks Shopify for the products of the ACTIVE ones only, because that is the
// only membership anything reads, and because asking for all 175 would be
// fetching the Black Friday list to ignore it.
//
// WHY MEMBERSHIP IS READ FROM THE COLLECTION AND NOT THE PRODUCT. The obvious
// build is `products { collections(first: 50) }` on the existing product sync.
// Shopify prices a query before running it and refuses over 1000 points, and
// that query already sits at the ceiling (PRODUCT_MAX_PAGE_SIZE: 30 passed, 40
// refused). A product is in 18-30+ collections, so asking each 33-point node for
// fifty of them is not available at any page size worth having.
//
// THREE COLUMNS ARE NEVER WRITTEN HERE: `is_active`, `axis` and `note` belong to
// the team, not to Shopify. `mapCollectionRow` does not return them and the
// upsert merges duplicates, so a column absent from the payload is left alone —
// the same mechanism `promotions.offerable_in_replies` and
// `products.recommended_for_concerns` rely on, and its own test asserts it.

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

  await runShopifyCollectionsSync({ args, shopify, supabase, shopRow, syncedAt });
}

export async function runShopifyCollectionsSync({ args, shopify, supabase, shopRow, syncedAt }) {
  const catalogue = await syncCatalogue({ args, shopify, supabase, shopRow, syncedAt });
  const membership = await syncMembership({ args, shopify, supabase, shopRow, syncedAt });

  console.log(
    `${args.dryRun ? 'Dry run complete' : 'Sync complete'}: ${catalogue.total} collections, ` +
      `${membership.refreshed} active refreshed, ${membership.products} memberships.`
  );
  return { ...catalogue, ...membership };
}

/** Every collection the shop has, so the curation screen has something to search. */
async function syncCatalogue({ args, shopify, supabase, shopRow, syncedAt }) {
  let cursor = null;
  let total = 0;

  do {
    const page = await fetchCollectionPage(shopify, cursor);
    const nodes = page.collections.nodes || [];
    const rows = nodes.map((node) => mapCollectionRow(node, shopRow.id, syncedAt));
    total += rows.length;

    if (args.dryRun) {
      console.log(`Dry run: page contains ${rows.length} collections.`);
    } else if (rows.length > 0) {
      await supabaseUpsert(supabase, T.ADVICE_COLLECTIONS, rows, 'shop_id,shopify_collection_id');
      console.log(`Synced ${total} collections so far.`);
    }

    cursor = page.collections.pageInfo.hasNextPage ? page.collections.pageInfo.endCursor : null;
    if (args.limit && total >= args.limit) {
      break;
    }
  } while (cursor);

  return { total };
}

/**
 * The products of each ACTIVE collection.
 *
 * `status` travels with every node, and a product that is not `ACTIVE` is
 * dropped here rather than stored and filtered later: an archived product has no
 * business being one query away from a customer-facing recommendation. Measured
 * on the live shop, `Diag - Rides et ridules` holds 19 products of which 18 are
 * active.
 *
 * Nothing is written for a collection nobody has switched on, so
 * `products_synced_at` stays null there — which is the honest reading of "we
 * have never asked", as distinct from "we asked and it was empty".
 */
async function syncMembership({ args, shopify, supabase, shopRow, syncedAt }) {
  const active = await supabaseSelectAll(
    supabase,
    T.ADVICE_COLLECTIONS,
    { shop_id: shopRow.id, is_active: true, deleted_at: { operator: 'is', value: 'null' } },
    'id,shopify_collection_id,handle,title'
  );

  let refreshed = 0;
  let products = 0;

  for (const collection of active || []) {
    const ids = await collectionProductIds(shopify, collection.shopify_collection_id, collection.handle);
    refreshed += 1;
    products += ids.length;

    if (args.dryRun) {
      console.log(`Dry run: ${collection.handle} holds ${ids.length} live products.`);
      continue;
    }
    // AN UPDATE, NOT AN UPSERT, and the difference is not stylistic. PostgREST's
    // upsert is INSERT ... ON CONFLICT, so it validates the row against every
    // NOT NULL column even when the conflict target already exists — a payload
    // of just the two membership columns is rejected for a null `handle`. The
    // catalogue pass above owns the row; this one only ever refreshes it.
    await supabaseUpdateById(supabase, T.ADVICE_COLLECTIONS, collection.id, {
      product_ids: ids,
      products_synced_at: syncedAt
    });
    console.log(`Refreshed ${collection.handle}: ${ids.length} live products.`);
  }

  return { refreshed, products };
}

/** One collection's live product GIDs, paged. */
async function collectionProductIds(shopify, collectionId, handle) {
  const ids = [];
  let cursor = null;

  do {
    const page = await fetchCollectionProducts(shopify, collectionId, cursor);
    const collection = page.collection;
    if (!collection) {
      // Deleted between the catalogue pass and this one. Not an error: the next
      // catalogue pass will mark it gone, and an empty list is the truthful
      // membership of a collection that no longer exists.
      console.warn(`Collection ${handle} is no longer readable; leaving its membership empty.`);
      return [];
    }

    for (const node of collection.products.nodes || []) {
      if (String(node.status || '').toUpperCase() === 'ACTIVE') {
        ids.push(node.id);
      }
    }
    cursor = collection.products.pageInfo.hasNextPage ? collection.products.pageInfo.endCursor : null;
  } while (cursor);

  return ids;
}

function isDirectRun() {
  return import.meta.url === pathToFileURL(process.argv[1] || '').href;
}
