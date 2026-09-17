/**
 * Server-only reader and writer for the three columns on `advice_collections`
 * that are ours.
 *
 * EVERYTHING ELSE ON THAT TABLE COMES FROM SHOPIFY and is refreshed by
 * `sync-shopify-collections.mjs`. `is_active`, `axis` and `note` are not in
 * `mapCollectionRow`, and the upsert merges duplicates, so a column absent from
 * the payload is left alone — that omission is the whole mechanism, and
 * `shopify-collection-mapper.test.mjs` asserts it. Same arrangement as
 * `promotions.offerable_in_replies` and `products.recommended_for_concerns`.
 *
 * WHY A CURATED SET RATHER THAN "ALL COLLECTIONS". The shop has 175, and a
 * product sits in 18 to 30 of them: Black Friday (92 products), Singles day
 * (84), soldes hiver (80), the OrderlyEmails plugin's index (104), a Smart
 * Products Filter index marked "do not delete" (116), and sixty-two numbered
 * buckets belonging to the site's diagnostic quiz. Intersecting raw membership
 * returns everything, because everything is in `black-friday`. A person decides
 * once which collections may answer a customer, and the agent only ever sees
 * those.
 *
 * Uses the SERVICE ROLE key. Never import from a client component.
 */

import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseSelectAll,
  supabaseUpdate,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { T } from "../../../scripts/lib/tables.mjs";

import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";
import type { AdviceCollection, CollectionAxis } from "../types";

const COLUMNS =
  "id,shopify_collection_id,handle,title,products_count,is_active,axis,note," +
  "product_ids,products_synced_at";

/** The two axes the intersection can tell apart — the table's own check constraint. */
export const AXES: CollectionAxis[] = ["concern", "category"];

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

export async function getShopId(): Promise<string> {
  const config = loadConfig(process.env as Record<string, string | undefined>);
  const rows = await supabaseSelectAll(getSupabaseClient(), "shops", { shop_domain: config.shopDomain }, "id");
  const id = rows?.[0]?.id;
  if (!id) {
    throw new KnowledgeNotFoundError(`No shop record found for ${config.shopDomain}.`);
  }
  return String(id);
}

/**
 * Every collection the shop has, active ones first.
 *
 * READ WHOLE, NOT PAGED. 175 rows without their membership is a small read, and
 * the screen's job is to search all of them — paging a list somebody is
 * filtering would hide exactly the collection they are looking for. `product_ids`
 * is the only large column and it is populated on active rows alone.
 *
 * ACTIVE FIRST, then by title: the curated set is what the team comes back to
 * read, and the other 169 are what they came to search.
 */
export async function listCollections(shopId: string): Promise<AdviceCollection[]> {
  const rows = (await supabaseSelectAll(
    getSupabaseClient(),
    T.ADVICE_COLLECTIONS,
    { shop_id: shopId, deleted_at: { operator: "is", value: "null" } },
    COLUMNS
  )) as Record<string, unknown>[];

  return (rows ?? [])
    .map(toCollection)
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.title.localeCompare(b.title, "fr");
    });
}

/**
 * Switches one collection on or off for advice. Its own write, deliberately.
 *
 * SEPARATE FROM EVERY OTHER EDIT, for the reason `setRuleApproval` is separate
 * from saving a rule: activating a collection is what lets it reach a customer,
 * where setting its axis or its note is only bookkeeping. Sharing a handler
 * would mean correcting a typo in a note could silently switch a collection back
 * on after somebody had taken it off.
 *
 * AN AXIS IS REQUIRED TO GO LIVE. A collection with no axis cannot be relaxed
 * correctly — `chooseProducts` gives up a concern before a category — so
 * activating one without saying which it is would put a collection into the
 * intersection that the intersection cannot reason about.
 */
export async function setCollectionActive(
  shopId: string,
  id: string,
  active: boolean
): Promise<AdviceCollection> {
  const current = await readOne(shopId, id);
  if (active && !current.axis) {
    throw new KnowledgeValidationError(
      "Choose whether this is a concern or a type of care before switching it on — " +
        "the agent gives up a concern before a type of care when nothing matches both."
    );
  }
  return writeOne(shopId, id, { is_active: active });
}

/**
 * Sets the axis and the note. Never touches `is_active`.
 *
 * The axis may be cleared, but not while the collection is live: the pair
 * "active with no axis" is the one state the intersection cannot act on, and it
 * is refused from both directions rather than being possible to reach by going
 * around.
 */
export async function setCollectionDetails(
  shopId: string,
  id: string,
  { axis, note }: { axis: CollectionAxis | null; note: string | null }
): Promise<AdviceCollection> {
  if (axis !== null && !AXES.includes(axis)) {
    throw new KnowledgeValidationError(`An axis is ${AXES.join(" or ")}, or nothing yet.`);
  }
  const current = await readOne(shopId, id);
  if (axis === null && current.active) {
    throw new KnowledgeValidationError(
      "This collection is live, so it needs an axis. Switch it off first, or choose one."
    );
  }
  return writeOne(shopId, id, { axis, note: note?.trim() || null });
}

async function readOne(shopId: string, id: string): Promise<AdviceCollection> {
  if (!id.trim()) throw new KnowledgeValidationError("A collection id is required.");
  const rows = (await supabaseSelectAll(
    getSupabaseClient(),
    T.ADVICE_COLLECTIONS,
    { shop_id: shopId, id },
    COLUMNS
  )) as Record<string, unknown>[];
  const row = (rows ?? [])[0];
  if (!row) throw new KnowledgeNotFoundError(`No collection found for ${id}.`);
  return toCollection(row);
}

async function writeOne(
  shopId: string,
  id: string,
  patch: Record<string, unknown>
): Promise<AdviceCollection> {
  const rows = (await supabaseUpdate(
    getSupabaseClient(),
    T.ADVICE_COLLECTIONS,
    { shop_id: shopId, id },
    patch,
    { select: COLUMNS }
  )) as Record<string, unknown>[];
  const updated = (rows ?? [])[0];
  if (!updated) throw new KnowledgeNotFoundError(`No collection found for ${id}.`);
  return toCollection(updated);
}

/**
 * A row as the screen reads it.
 *
 * TWO COUNTS, AND THEY ARE DIFFERENT QUESTIONS. `productsCount` is Shopify's,
 * including products that are not live, and it is what helps somebody judge
 * whether a collection is worth switching on at all. `liveProducts` is what the
 * agent can actually put forward, and it is null — not zero — until the
 * membership has been fetched, which only happens for active collections.
 * Printing 0 for "never asked" would read as "this collection is empty".
 */
function toCollection(row: Record<string, unknown>): AdviceCollection {
  const synced = (row.products_synced_at as string) ?? null;
  const ids = Array.isArray(row.product_ids) ? (row.product_ids as string[]) : [];
  return {
    id: String(row.id),
    handle: String(row.handle),
    title: String(row.title),
    productsCount: row.products_count === null || row.products_count === undefined
      ? null
      : Number(row.products_count),
    liveProducts: synced ? ids.length : null,
    active: row.is_active === true,
    axis: (row.axis as CollectionAxis) ?? null,
    note: (row.note as string) ?? null,
    syncedAt: synced,
  };
}
