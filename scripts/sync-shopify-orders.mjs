import { pathToFileURL } from 'node:url';

import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import {
  ORDER_SYNC_DEFAULT_MONTHS,
  createShopifyClient,
  fetchOrderPage,
  fetchShop,
  orderSyncQuery
} from './lib/shopify-admin-client.mjs';
import {
  createSupabaseClient,
  supabaseDelete,
  supabaseSelectAll,
  supabaseUpsert
} from './lib/supabase-rest-client.mjs';
import { syncShop } from './lib/shop-sync-service.mjs';
import { mapOrder } from './lib/shopify-sync-mappers.mjs';
import { hashIdentifier, recordDataAccessEvent } from './lib/compliance-audit.mjs';
import {
  describeRetentionPolicy,
  isIndefinite,
  orderSyncMonths,
  readRetentionPolicy
} from './lib/order-retention.mjs';

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

  // The shop's retention setting decides both how long rows live and how far
  // back this run asks Shopify. Read once, here, and carried through the mapper
  // so every row on this run is stamped under the same policy.
  const retentionPolicy = readRetentionPolicy(shopRow);
  const keepsIndefinitely = isIndefinite(retentionPolicy);

  // State what window this run covers and what it will keep. Unbounded is a real
  // choice with a real cost, so neither should ever be something you discover
  // afterwards from the order count.
  const months =
    args.orderSinceMonths === undefined ? orderSyncMonths(retentionPolicy) : args.orderSinceMonths;
  const filter = orderSyncQuery(months);
  console.log(`Retention: orders are ${describeRetentionPolicy(retentionPolicy)}.`);
  console.log(
    filter
      ? `Fetching orders updated in the last ${months} months (${filter}). Use --all-orders for the full history.`
      : keepsIndefinitely
        ? 'Fetching the FULL order history: this shop keeps orders indefinitely, so there is no window to bound it to.'
        : 'Fetching the FULL order history (--all-orders). Retention still deletes anything past its window.'
  );

  do {
    const page = await fetchOrderPage(shopify, args, cursor, months);
    const orderRows = page.orders.nodes.map((order) => (
      mapOrder(order, shopRow.id, syncedAt, customerIdByShopifyId, retentionPolicy)
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

  // SKIPPED ENTIRELY WHEN RETENTION IS INDEFINITE rather than relied on to match
  // nothing. Every row written above already carries a null delete date, so the
  // query would be a no-op — but a row stamped under a previous policy and not
  // seen by this run would still be sitting there with an old date on it, and
  // this pass would delete it. The guard is what makes raising retention safe
  // before the backfill has caught up.
  if (!args.dryRun && !keepsIndefinitely) {
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

/**
 * PAGED, and it is load-bearing. `supabaseSelect` is one request, and PostgREST
 * caps one request at `db-max-rows` (1000 on Supabase) SILENTLY — 200, no error,
 * just fewer rows. The book is 58,201 customers, so this map held the first
 * 1,000 of them, and an order whose buyer was not among that slice was written
 * with `customer_id: null`. Measured before the fix: 1 of 2,014 orders linked.
 *
 * Nothing threw, which is why it survived: the orders themselves synced fine and
 * the null only surfaced two layers away, as an order bundle with no customer
 * and a dashboard that could not say whose order it was.
 */
async function loadCustomerIdMap({ supabase, shopId }) {
  const customers = await supabaseSelectAll(
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
