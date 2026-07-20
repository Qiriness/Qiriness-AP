import { pathToFileURL } from 'node:url';

import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import {
  createShopifyClient,
  fetchOrderPage,
  fetchShop
} from './lib/shopify-admin-client.mjs';
import {
  createSupabaseClient,
  supabaseDelete,
  supabaseSelect,
  supabaseUpsert
} from './lib/supabase-rest-client.mjs';
import { syncShop } from './lib/shop-sync-service.mjs';
import { mapOrder } from './lib/shopify-sync-mappers.mjs';
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

  await runShopifyOrdersSync({
    args,
    shopify,
    supabase,
    shopRow,
    syncedAt
  });
}

export async function runShopifyOrdersSync({ args, shopify, supabase, shopRow, syncedAt, integrationEventId = null }) {
  let cursor = null;
  let totalOrders = 0;
  let deletedExpiredOrders = 0;
  const retentionRules = new Map();
  const customerIdByShopifyId = args.dryRun
    ? new Map()
    : await loadCustomerIdMap({ supabase, shopId: shopRow.id });

  do {
    const page = await fetchOrderPage(shopify, args, cursor);
    const orderRows = page.orders.nodes.map((order) => (
      mapOrder(order, shopRow.id, syncedAt, customerIdByShopifyId)
    ));

    totalOrders += orderRows.length;
    for (const order of orderRows) {
      const rule = order.retention_rule || 'unassigned';
      retentionRules.set(rule, (retentionRules.get(rule) || 0) + 1);
    }

    if (args.dryRun) {
      console.log(
        `Dry run: page contains ${orderRows.length} orders, ${formatRetentionSummary(orderRows)}.`
      );
    } else {
      await recordDataAccessEvent(supabase, {
        shop_id: shopRow.id,
        integration_event_id: integrationEventId,
        action: 'shopify_orders_sync_page',
        resource_type: 'orders',
        resource_id_hash: hashIdentifier(`${shopRow.shop_domain}:${cursor || 'first-page'}`),
        purpose: 'nightly Shopify order snapshot sync',
        metadata: {
          page_count: orderRows.length,
          dry_run: false
        }
      });
      await upsertOrderPage({ supabase, orderRows });
      console.log(`Synced ${totalOrders} orders so far.`);
    }

    cursor = page.orders.pageInfo.hasNextPage ? page.orders.pageInfo.endCursor : null;
    if (args.limit && totalOrders >= args.limit) {
      break;
    }
  } while (cursor);

  if (!args.dryRun) {
    deletedExpiredOrders = await deleteExpiredOrders({
      supabase,
      shopId: shopRow.id,
      syncedAt
    });
  }

  console.log(
    `${args.dryRun ? 'Dry run complete' : 'Sync complete'}: ${totalOrders} orders, ${formatRetentionMap(retentionRules)}.`
  );
  if (deletedExpiredOrders > 0) {
    console.log(`Deleted ${deletedExpiredOrders} local orders past retention_delete_after.`);
  }

  return {
    orders: totalOrders,
    deletedExpiredOrders,
    retentionRules: Object.fromEntries(retentionRules)
  };
}

async function loadCustomerIdMap({ supabase, shopId }) {
  const customers = await supabaseSelect(
    supabase,
    'customers',
    { shop_id: shopId },
    'id,shopify_customer_id'
  );

  return new Map(
    customers
      .filter((customer) => customer.shopify_customer_id)
      .map((customer) => [customer.shopify_customer_id, customer.id])
  );
}

async function upsertOrderPage({ supabase, orderRows }) {
  if (orderRows.length === 0) {
    return;
  }

  try {
    await supabaseUpsert(
      supabase,
      'orders',
      orderRows,
      'shop_id,shopify_order_id'
    );
  } catch (error) {
    if (!/Could not find the '(returns|order_status)' column/i.test(error.message)) {
      throw error;
    }

    console.warn('Supabase order sync warning: remote orders table is missing current order columns; retrying order upsert with the legacy-compatible shape.');
    await supabaseUpsert(
      supabase,
      'orders',
      orderRows.map(({ returns, order_status, ...row }) => row),
      'shop_id,shopify_order_id'
    );
  }
}

async function deleteExpiredOrders({ supabase, shopId, syncedAt }) {
  const deleted = await supabaseDelete(
    supabase,
    'orders',
    {
      shop_id: shopId,
      retention_delete_after: {
        operator: 'lte',
        value: syncedAt
      }
    }
  );

  return deleted.length;
}

function formatRetentionSummary(orderRows) {
  const rules = new Map();
  for (const order of orderRows) {
    const rule = order.retention_rule || 'unassigned';
    rules.set(rule, (rules.get(rule) || 0) + 1);
  }
  return formatRetentionMap(rules);
}

function formatRetentionMap(rules) {
  if (rules.size === 0) {
    return '0 retention rules';
  }

  return [...rules.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rule, count]) => `${rule}: ${count}`)
    .join(', ');
}

function isDirectRun() {
  return import.meta.url === pathToFileURL(process.argv[1] || '').href;
}
