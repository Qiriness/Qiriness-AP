import { pathToFileURL } from 'node:url';

import { parseArgs, loadConfig, loadEnv } from './lib/sync-config.mjs';
import {
  createShopifyClient,
  fetchCustomerPage,
  fetchShop
} from './lib/shopify-admin-client.mjs';
import {
  createSupabaseClient,
  supabaseDeleteWhereIn,
  supabaseSelect,
  supabaseUpsert
} from './lib/supabase-rest-client.mjs';
import { syncShop } from './lib/shop-sync-service.mjs';
import { mapCustomer } from './lib/shopify-sync-mappers.mjs';
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

  await runShopifyCustomersSync({
    args,
    shopify,
    supabase,
    shopRow,
    syncedAt
  });
}

export async function runShopifyCustomersSync({ args, shopify, supabase, shopRow, syncedAt, integrationEventId = null }) {
  let cursor = null;
  let totalCustomers = 0;
  let deletedCustomers = 0;
  const rfmGroups = new Map();
  const seenShopifyCustomerIds = new Set();

  do {
    const page = await fetchCustomerPage(shopify, args, cursor);
    const customerRows = page.customers.nodes.map((customer) => (
      mapCustomer(customer, shopRow.id, syncedAt)
    ));

    totalCustomers += customerRows.length;
    for (const customer of customerRows) {
      const group = customer.rfm_group || 'UNASSIGNED';
      rfmGroups.set(group, (rfmGroups.get(group) || 0) + 1);
    }
    for (const customer of customerRows) {
      seenShopifyCustomerIds.add(customer.shopify_customer_id);
    }

    if (args.dryRun) {
      console.log(
        `Dry run: page contains ${customerRows.length} customers, ${formatRfmSummary(customerRows)}.`
      );
    } else {
      await recordDataAccessEvent(supabase, {
        shop_id: shopRow.id,
        integration_event_id: integrationEventId,
        action: 'shopify_customers_sync_page',
        resource_type: 'customers',
        resource_id_hash: hashIdentifier(`${shopRow.shop_domain}:${cursor || 'first-page'}`),
        purpose: 'nightly Shopify customer snapshot sync',
        metadata: {
          page_count: customerRows.length,
          dry_run: false
        }
      });
      await upsertCustomerPage({ supabase, customerRows });
      console.log(`Synced ${totalCustomers} customers so far.`);
    }

    cursor = page.customers.pageInfo.hasNextPage ? page.customers.pageInfo.endCursor : null;
    if (args.limit && totalCustomers >= args.limit) {
      break;
    }
  } while (cursor);

  if (!args.dryRun && !args.limit) {
    deletedCustomers = await deleteCustomersMissingFromShopify({
      supabase,
      shopId: shopRow.id,
      seenShopifyCustomerIds
    });
  }

  console.log(
    `${args.dryRun ? 'Dry run complete' : 'Sync complete'}: ${totalCustomers} customers, ${formatRfmMap(rfmGroups)}.`
  );
  if (deletedCustomers > 0) {
    console.log(`Deleted ${deletedCustomers} customers no longer returned by Shopify.`);
  }

  return {
    customers: totalCustomers,
    deletedCustomers,
    rfmGroups: Object.fromEntries(rfmGroups)
  };
}

async function upsertCustomerPage({ supabase, customerRows }) {
  if (customerRows.length === 0) {
    return;
  }

  await supabaseUpsert(
    supabase,
    'customers',
    customerRows,
    'shop_id,shopify_customer_id'
  );
}

async function deleteCustomersMissingFromShopify({ supabase, shopId, seenShopifyCustomerIds }) {
  const existingRows = await supabaseSelect(
    supabase,
    'customers',
    { shop_id: shopId },
    'id,shopify_customer_id'
  );
  const staleIds = existingRows
    .filter((row) => !seenShopifyCustomerIds.has(row.shopify_customer_id))
    .map((row) => row.id);

  if (staleIds.length === 0) {
    return 0;
  }

  await supabaseDeleteWhereIn(supabase, 'customers', 'id', staleIds);
  return staleIds.length;
}

function formatRfmSummary(customerRows) {
  const groups = new Map();
  for (const customer of customerRows) {
    const group = customer.rfm_group || 'UNASSIGNED';
    groups.set(group, (groups.get(group) || 0) + 1);
  }
  return formatRfmMap(groups);
}

function formatRfmMap(groups) {
  if (groups.size === 0) {
    return '0 RFM groups';
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, count]) => `${group}: ${count}`)
    .join(', ');
}

function isDirectRun() {
  return import.meta.url === pathToFileURL(process.argv[1] || '').href;
}
