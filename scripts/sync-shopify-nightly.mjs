import { pathToFileURL } from 'node:url';

import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createShopifyClient, fetchShop } from './lib/shopify-admin-client.mjs';
import { createSupabaseClient } from './lib/supabase-rest-client.mjs';
import { syncShop } from './lib/shop-sync-service.mjs';
import {
  failStaleIntegrationEvents,
  finishIntegrationEvent,
  sanitizeError,
  startIntegrationEvent
} from './lib/compliance-audit.mjs';
import { runShopifyCustomersSync } from './sync-shopify-customers.mjs';
import { runShopifyOrdersSync } from './sync-shopify-orders.mjs';
import { runShopifyProductsSync } from './sync-shopify-products.mjs';
import { runShopifyPromotionsSync } from './sync-shopify-promotions.mjs';
import { runShopifyContentCatalogSync } from './sync-shopify-content-catalog.mjs';
import { runShopifyCollectionsSync } from './sync-shopify-collections.mjs';
import { runStorefrontMonthsSync } from './lib/storefront-months-sync.mjs';
import { runKlaviyoSync } from './lib/klaviyo-sync.mjs';

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

  if (args.dryRun) {
    const counts = await runNightlySync({ args, config, shopify, supabase, shopRow, syncedAt });
    console.log(`Dry run nightly sync complete: ${JSON.stringify(counts)}`);
    return;
  }

  // BEFORE OPENING A NEW ROW, CLOSE THE ONES A KILLED RUN LEFT OPEN. A sync that
  // is killed rather than thrown writes no ending at all, so `processing` is
  // ambiguous between "running now" and "died in August" — and the freshness
  // strip resolves that ambiguity the optimistic way. Here is the one moment the
  // answer is certain: this process is the run, and the concurrency group means
  // nothing else is.
  const stale = await failStaleIntegrationEvents(supabase);
  if (stale.length > 0) {
    console.warn(
      `Closed ${stale.length} integration event(s) left on 'processing' by a killed run: ` +
      stale.map((row) => `${row.event_type} @ ${row.started_at}`).join(', ')
    );
  }

  const event = await startIntegrationEvent(supabase, {
    shop_id: shopRow.id,
    event_key: `nightly:${shopRow.shop_domain}:${syncedAt}`,
    source: 'shopify',
    event_type: 'nightly_sync',
    status: 'processing',
    idempotency_key: `nightly:${shopRow.shop_domain}:${syncedAt.slice(0, 10)}`,
    actor_type: 'system',
    metadata: {
      shop_domain: shopRow.shop_domain,
      schedule: {
        cron: config.syncCron,
        timezone: config.syncTimezone
      }
    }
  });

  try {
    const counts = await runNightlySync({
      args,
      config,
      shopify,
      supabase,
      shopRow,
      syncedAt,
      integrationEventId: event.row.id
    });
    await finishIntegrationEvent(supabase, event.row.id, {
      status: 'completed',
      counts
    });
    console.log(`Nightly sync complete: ${JSON.stringify(counts)}`);
  } catch (error) {
    await finishIntegrationEvent(supabase, event.row.id, {
      status: 'failed',
      error_summary: sanitizeError(error)
    });
    throw error;
  }
}

export async function runNightlySync({
  args,
  config,
  shopify,
  supabase,
  shopRow,
  syncedAt,
  integrationEventId = null,
  runners = {
    customers: runShopifyCustomersSync,
    orders: runShopifyOrdersSync,
    products: runShopifyProductsSync,
    promotions: runShopifyPromotionsSync,
    contentCatalog: runShopifyContentCatalogSync,
    collections: runShopifyCollectionsSync,
    storefrontMonths: runStorefrontMonthsSync,
    klaviyo: runKlaviyoSync
  }
}) {
  const customerCounts = await runners.customers({
    args,
    shopify,
    supabase,
    shopRow,
    syncedAt,
    integrationEventId
  });
  const orderCounts = await runners.orders({
    args,
    shopify,
    supabase,
    shopRow,
    syncedAt,
    integrationEventId
  });
  const productCounts = await runners.products({
    args,
    config,
    shopify,
    supabase,
    shopRow,
    syncedAt
  });
  const promotionCounts = await runners.promotions({
    args,
    shopify,
    supabase,
    shopRow,
    syncedAt,
    integrationEventId
  });
  const contentCatalogCounts = await runners.contentCatalog({
    args,
    shopify,
    supabase,
    shopRow,
    syncedAt
  });
  // LAST, AND CHEAP. One request for the catalogue of collections plus one per
  // ACTIVATED collection — seven in total today, against the hundreds the order
  // and product passes make. It runs after products so a collection's membership
  // is checked against a catalogue that has just been refreshed.
  //
  // IT NEVER SWITCHES ANYTHING ON. `is_active`, `axis` and `note` are the team's
  // and are not in `mapCollectionRow`, so a collection created in Shopify arrives
  // here switched OFF and stays that way until somebody curates it on
  // /agent-setup/collections. A nightly that activated what it found would put
  // the next Black Friday list into a skincare recommendation.
  const collectionCounts = await runners.collections({
    args,
    shopify,
    supabase,
    shopRow,
    syncedAt
  });

  // AFTER EVERYTHING, AND IT CANNOT FAIL THE NIGHT. Closed months of storefront
  // sessions, so a long Insights range is not asked of ShopifyQL live. A
  // month missing from the table is read live instead, so a failure here
  // costs speed on the dashboard, never a wrong figure — which is why it is
  // recorded rather than thrown past the orders it follows.
  let storefrontMonths;
  try {
    storefrontMonths = await runners.storefrontMonths({ shopify, supabase, shopRow, dryRun: Boolean(args.dryRun) });
  } catch (error) {
    storefrontMonths = { error: error instanceof Error ? error.message : String(error) };
  }

  // KLAVIYO, LAST, AND IT CANNOT FAIL THE NIGHT EITHER. It reads another
  // company's API with a key somebody typed on /settings; a revoked key or a
  // rate limit must not mark the Shopify sync failed. A shop with no key is
  // skipped. The failure is also written on klaviyo_connections, which is
  // what Settings -> Integrations shows.
  let klaviyo;
  try {
    klaviyo = await runners.klaviyo({ supabase, shopRow, dryRun: Boolean(args.dryRun) });
  } catch (error) {
    klaviyo = { error: error instanceof Error ? error.message : String(error) };
  }

  return {
    customers: customerCounts.customers,
    deleted_customers: customerCounts.deletedCustomers,
    orders: orderCounts.orders,
    deleted_expired_orders: orderCounts.deletedExpiredOrders,
    products: productCounts.products,
    linked_metaobjects: productCounts.linkedMetaobjects,
    target_metaobjects: productCounts.targetMetaobjects,
    discounts: promotionCounts.discounts,
    promotions: promotionCounts.promotions,
    deleted_promotions: promotionCounts.deletedPromotions,
    shopify_content_sources: contentCatalogCounts.sources,
    deleted_shopify_content_sources: contentCatalogCounts.deletedSources,
    collections: collectionCounts.total,
    active_collections_refreshed: collectionCounts.refreshed,
    collection_memberships: collectionCounts.products,
    storefront_session_months: storefrontMonths.months ?? null,
    storefront_months_restated: storefrontMonths.restated ?? null,
    storefront_months_error: storefrontMonths.error ?? null,
    klaviyo_flow_days: klaviyo.flow_days ?? null,
    klaviyo_campaigns: klaviyo.campaigns ?? null,
    klaviyo_skipped: klaviyo.skipped ?? null,
    klaviyo_error: klaviyo.error ?? null
  };
}

function isDirectRun() {
  return import.meta.url === pathToFileURL(process.argv[1] || '').href;
}
