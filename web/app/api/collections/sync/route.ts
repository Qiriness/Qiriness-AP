import { NextResponse } from "next/server";

import { loadConfig } from "../../../../../scripts/lib/sync-config.mjs";
import { createShopifyClient, fetchShop } from "../../../../../scripts/lib/shopify-admin-client.mjs";
import { createSupabaseClient } from "../../../../../scripts/lib/supabase-rest-client.mjs";
import { syncShop } from "../../../../../scripts/lib/shop-sync-service.mjs";
import { runShopifyCollectionsSync } from "../../../../../scripts/sync-shopify-collections.mjs";

import { getShopId, listCollections } from "@/lib/server/collections-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The catalogue is one request; each ACTIVE collection is one more. Seven today,
// a couple of seconds — but it grows with what the team curates, and a sync that
// timed out halfway would leave some collections refreshed and others not.
export const maxDuration = 300;

/**
 * Runs the collections sync now, instead of waiting for the nightly.
 *
 * WHY A BUTTON AT ALL. The nightly is what keeps this current, and nothing here
 * is urgent enough to need a webhook — but a collection created in Shopify is
 * invisible on this screen until a sync runs, and "make the thing I just created
 * appear" is a reasonable thing to want without waiting until 2am.
 *
 * IT CANNOT SWITCH ANYTHING ON, and that is worth saying because a "sync" button
 * beside a list of switches invites the opposite reading. `mapCollectionRow`
 * never returns `is_active`, `axis` or `note`, and the upsert leaves absent
 * columns alone — so this refreshes titles, counts and the membership of
 * collections somebody already activated, and a new collection arrives switched
 * OFF like every other.
 *
 * THE FULL LIST COMES BACK, not the counts, because that is what the screen
 * needs to redraw: sending totals would leave it showing the state from before
 * the sync it just ran.
 */
export async function POST() {
  try {
    const config = loadConfig(process.env as Record<string, string | undefined>);
    const shopify = await createShopifyClient(config);
    const supabase = createSupabaseClient(config);

    const shop = await fetchShop(shopify);
    const shopRow = await syncShop({ args: {}, config, supabase, shop });

    const counts = await runShopifyCollectionsSync({
      args: { dryRun: false },
      shopify,
      supabase,
      shopRow,
      syncedAt: new Date().toISOString(),
    });

    return NextResponse.json({
      collections: await listCollections(await getShopId()),
      synced: {
        total: counts.total,
        refreshed: counts.refreshed,
        memberships: counts.products,
      },
    });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
