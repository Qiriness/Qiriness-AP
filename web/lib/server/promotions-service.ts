/**
 * Server-only reader and writer for the one column on `promotions` that is ours.
 *
 * EVERYTHING ELSE ON THAT TABLE COMES FROM SHOPIFY and is overwritten by the
 * sync. `offerable_in_replies` is not in `mapPromotionRow`, and the upsert merges
 * duplicates, so a column absent from the payload is left alone — that omission
 * is the whole mechanism, and `shopify-promotion-mapper.test.mjs` asserts it.
 *
 * WHY A CURATED SET RATHER THAN "ALL ACTIVE". Of the 14 active single-code
 * promotions on this shop, one is 100% off a product and two are partner rates
 * of 50% and 26%; six more carry 600 one-time bulk codes each. Offering the
 * active list to a support screen puts a free order one mis-click away, so a
 * person decides once which codes may leave the building and the reply screen
 * only ever sees those.
 *
 * Uses the SERVICE ROLE key. Never import from a client component.
 */

import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseSelect,
  supabaseUpdate,
} from "../../../scripts/lib/supabase-rest-client.mjs";

import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";
import type { OfferableCode, PromotionChoice } from "../types";

const TABLE = "promotions";

const COLUMNS =
  "promotion_key,title,codes,short_summary,summary,status,method,starts_at,ends_at," +
  "usage_limit,discount_usage_count,applies_once_per_customer,combines_with,discount_classes," +
  "offerable_in_replies";

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

export async function getShopId(): Promise<string> {
  const config = loadConfig(process.env as Record<string, string | undefined>);
  const rows = await supabaseSelect(getSupabaseClient(), "shops", { shop_domain: config.shopDomain }, "id");
  const id = rows?.[0]?.id;
  if (!id) {
    throw new KnowledgeNotFoundError(`No shop record found for ${config.shopDomain}.`);
  }
  return String(id);
}

/**
 * How many codes a promotion may carry and still be a thing a person offers.
 *
 * The bulk promotions on this shop hold 600 single-use codes each — a gift-card
 * batch rather than an offer. Naming one in a reply would hand out somebody
 * else's code, and listing 600 of them makes the screen unreadable either way.
 */
const MAX_CODES_TO_OFFER = 3;

/**
 * Every active code promotion a person could choose to make offerable.
 *
 * ACTIVE AND CODE-BASED ONLY. An automatic discount has no code to quote, and an
 * expired one is the thing customers are already writing in about.
 */
export async function listPromotionChoices(shopId: string): Promise<PromotionChoice[]> {
  const rows = (await supabaseSelect(
    getSupabaseClient(),
    TABLE,
    { shop_id: shopId, status: "ACTIVE", method: "code", deleted_at: { operator: "is", value: "null" } },
    COLUMNS
  )) as Record<string, unknown>[];

  return (rows ?? [])
    .map(toChoice)
    .filter((choice): choice is PromotionChoice => choice !== null)
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** The curated subset, as the reply screen sees it. */
export async function listOfferableCodes(shopId: string): Promise<OfferableCode[]> {
  const choices = await listPromotionChoices(shopId);
  return choices
    .filter((choice) => choice.offerable)
    .map(({ code, title, summary, endsAt, oncePerCustomer, stacksWith, usage }) => ({
      code,
      title,
      summary,
      endsAt,
      oncePerCustomer,
      stacksWith,
      usage,
    }));
}

/** Flips one promotion's offerability. The only write this module makes. */
export async function setPromotionOfferable(
  shopId: string,
  promotionKey: string,
  offerable: boolean
): Promise<PromotionChoice> {
  if (!promotionKey.trim()) {
    throw new KnowledgeValidationError("A promotion key is required.");
  }

  const rows = (await supabaseUpdate(
    getSupabaseClient(),
    TABLE,
    { shop_id: shopId, promotion_key: promotionKey },
    { offerable_in_replies: offerable },
    { select: COLUMNS }
  )) as Record<string, unknown>[];

  const updated = (rows ?? [])[0];
  if (!updated) {
    throw new KnowledgeNotFoundError(`No promotion found for ${promotionKey}.`);
  }
  const choice = toChoice(updated);
  if (!choice) {
    throw new KnowledgeValidationError(
      `${promotionKey} cannot be offered in a reply — it carries no single code.`
    );
  }
  return choice;
}

/**
 * A row as the screens read it, or null when it is not offerable in principle.
 *
 * `stacksWith` REPORTS WHAT IS BLOCKED, not what is allowed, because that is the
 * sentence support actually needs: "this one cannot be combined with a product
 * discount" is the commonest reason a code appears not to work. Shopify's
 * `combines_with` is the source, so nothing here is inferred from the discount
 * type or guessed from the title.
 */
function toChoice(row: Record<string, unknown>): PromotionChoice | null {
  const codes = Array.isArray(row.codes) ? (row.codes as Record<string, unknown>[]) : [];
  if (codes.length === 0 || codes.length > MAX_CODES_TO_OFFER) {
    return null;
  }
  const code = String(codes[0]?.code ?? "").trim();
  if (!code) {
    return null;
  }

  const combines = (row.combines_with ?? {}) as Record<string, unknown>;
  const blocked: string[] = [];
  if (combines.order_discounts === false) blocked.push("order discounts");
  if (combines.product_discounts === false) blocked.push("product discounts");
  if (combines.shipping_discounts === false) blocked.push("shipping discounts");

  const limit = row.usage_limit === null || row.usage_limit === undefined ? null : Number(row.usage_limit);
  const used = Number(row.discount_usage_count ?? 0);

  return {
    promotionKey: String(row.promotion_key),
    code,
    title: String(row.title ?? code),
    // `short_summary` is Shopify's own one-liner ("20% off 94 products"); the
    // long one repeats it with the conditions appended, which the screen has no
    // room for and the reply gets from the tool instead.
    summary: String(row.short_summary ?? row.summary ?? "").trim() || null,
    endsAt: (row.ends_at as string) ?? null,
    oncePerCustomer: row.applies_once_per_customer === true,
    stacksWith: blocked.length === 0 ? null : blocked,
    usage: { used, limit },
    offerable: row.offerable_in_replies === true,
  };
}
