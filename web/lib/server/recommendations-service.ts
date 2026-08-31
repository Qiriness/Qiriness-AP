/**
 * Server-only reader and writer for the one column on `products` that is ours.
 *
 * WHY CURATION RATHER THAN THE TAGS. The catalogue tags say what a product is
 * COMPATIBLE with, and they are generous by design: `peaux sensibles` is on 52
 * of the 90 sellable products and « tous les types de peaux » on 52 more. That
 * is the right answer on a product page and a useless one in a reply — "for
 * sensitive skin we suggest these 64 products" is not a recommendation. This
 * column is what support should actually put forward, which is a judgement that
 * exists nowhere else in the data.
 *
 * IT SURVIVES THE SYNC BY NOT BEING IN THE MAPPER, the same mechanism
 * `promotions.offerable_in_replies` relies on, asserted in the product mapper's
 * own test.
 *
 * Uses the SERVICE ROLE key. Never import from a client component.
 */

import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseSelectAll,
  supabaseUpdate,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import {
  CONCERNS,
  READABLE_CONCERNS,
  productMatchesConcern,
} from "../../../agent/src/retrieval/product-concerns.mjs";

import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";
import type { ConcernOption, RecommendableProduct } from "../types";

const TABLE = "products";
const COLUMNS = "id,title,short_description,product_type,tags,recommended_for_concerns";

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

export async function getShopId(): Promise<string> {
  const config = loadConfig(process.env as Record<string, string | undefined>);
  const rows = await supabaseSelectAll(getSupabaseClient(), "shops", { shop_domain: config.shopDomain }, "id");
  const id = rows?.[0]?.id;
  if (!id) throw new KnowledgeNotFoundError(`No shop record found for ${config.shopDomain}.`);
  return String(id);
}

/** The concerns a rule can branch on, with how many products each can return. */
export function concernOptions(products: RecommendableProduct[]): ConcernOption[] {
  return (READABLE_CONCERNS as string[]).map((key) => ({
    key,
    label: (CONCERNS as Record<string, { label: string }>)[key].label,
    curated: products.filter((p) => p.concerns.includes(key)).length,
  }));
}

/**
 * The sellable catalogue, with what it is tagged for and what it is curated for.
 *
 * SAMPLES AND DRAFTS ARE EXCLUDED. A recommendation is something a customer can
 * go and buy; an unlisted sample is neither, and eleven of them in the list
 * would be eleven rows somebody has to skip past every time.
 *
 * THE TAG MATCH TRAVELS AS A HINT, not as a value. It is what makes the screen
 * usable — "these are the 52 the merchandising already considers compatible" is
 * the right place to start curating from — but it is explicitly not the answer,
 * which is the whole reason this column exists.
 */
export async function listRecommendable(shopId: string): Promise<RecommendableProduct[]> {
  const rows = (await supabaseSelectAll(
    getSupabaseClient(),
    TABLE,
    { shop_id: shopId, status: "active", deleted_at: { operator: "is", value: "null" } },
    COLUMNS
  )) as Record<string, unknown>[];

  return (rows ?? [])
    .filter((row) => String(row.product_type ?? "") !== "SAMPLE PRODUCT")
    .map((row) => {
      const tags = Array.isArray(row.tags) ? (row.tags as string[]) : [];
      return {
        id: String(row.id),
        title: String(row.title ?? "").trim(),
        summary: (row.short_description as string) ?? null,
        productType: (row.product_type as string) || null,
        concerns: Array.isArray(row.recommended_for_concerns)
          ? (row.recommended_for_concerns as string[])
          : [],
        compatibleWith: (READABLE_CONCERNS as string[]).filter((key) =>
          productMatchesConcern(tags, key)
        ),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Sets the whole concern list for one product. The only write this module makes. */
export async function setProductConcerns(
  shopId: string,
  productId: string,
  concerns: string[]
): Promise<RecommendableProduct> {
  if (!productId.trim()) throw new KnowledgeValidationError("A product id is required.");

  // A concern outside the vocabulary is a rule that can never match it — refused
  // here rather than stored and discovered from a transcript.
  const wanted = [...new Set(concerns.map((c) => String(c ?? "").trim()).filter(Boolean))];
  const unknown = wanted.filter((c) => !(READABLE_CONCERNS as string[]).includes(c));
  if (unknown.length > 0) {
    throw new KnowledgeValidationError(
      `Not a skin concern the agent can read: ${unknown.join(", ")}.`
    );
  }

  const rows = (await supabaseUpdate(
    getSupabaseClient(),
    TABLE,
    { shop_id: shopId, id: productId },
    { recommended_for_concerns: wanted },
    { select: COLUMNS }
  )) as Record<string, unknown>[];

  const updated = (rows ?? [])[0];
  if (!updated) throw new KnowledgeNotFoundError(`No product found for ${productId}.`);

  const tags = Array.isArray(updated.tags) ? (updated.tags as string[]) : [];
  return {
    id: String(updated.id),
    title: String(updated.title ?? "").trim(),
    summary: (updated.short_description as string) ?? null,
    productType: (updated.product_type as string) || null,
    concerns: Array.isArray(updated.recommended_for_concerns)
      ? (updated.recommended_for_concerns as string[])
      : [],
    compatibleWith: (READABLE_CONCERNS as string[]).filter((key) => productMatchesConcern(tags, key)),
  };
}
