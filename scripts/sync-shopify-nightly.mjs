import { pathToFileURL } from 'node:url';

import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createShopifyClient, fetchShop } from './lib/shopify-admin-client.mjs';
import { createSupabaseClient } from './lib/supabase-rest-client.mjs';
import { syncShop } from './lib/shop-sync-service.mjs';
import {
  finishIntegrationEvent,
  sanitizeError,
  startIntegrationEvent
} from './lib/compliance-audit.mjs';
import { runShopifyCustomersSync } from './sync-shopify-customers.mjs';
import { runShopifyOrdersSync } from './sync-shopify-orders.mjs';
import { runShopifyProductsSync } from './sync-shopify-products.mjs';
import { runShopifyKnowledgeSync } from './sync-shopify-knowledge.mjs';

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
    knowledge: runShopifyKnowledgeSync
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
  const knowledgeCounts = await runners.knowledge({
    args,
    config,
    shopify,
    supabase,
    shopRow,
    syncedAt
  });

  return {
    customers: customerCounts.customers,
    deleted_customers: customerCounts.deletedCustomers,
    orders: orderCounts.orders,
    deleted_expired_orders: orderCounts.deletedExpiredOrders,
    products: productCounts.products,
    linked_metaobjects: productCounts.linkedMetaobjects,
    target_metaobjects: productCounts.targetMetaobjects,
    knowledge_documents: knowledgeCounts.documents,
    knowledge_chunks: knowledgeCounts.chunks,
    unresolved_knowledge_sources: knowledgeCounts.unresolvedSources
  };
}

function isDirectRun() {
  return import.meta.url === pathToFileURL(process.argv[1] || '').href;
}
