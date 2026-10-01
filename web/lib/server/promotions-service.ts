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

import { promotionMechanic } from "../../../scripts/lib/promotion-mechanic.mjs";
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseSelect,
  supabaseUpdate,
} from "../../../scripts/lib/supabase-rest-client.mjs";

import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";
import type { AutomaticOffer, OfferableCode, PromotionChoice, PromotionMechanic } from "../types";

const TABLE = "promotions";

const COLUMNS =
  "promotion_key,title,codes,short_summary,summary,status,method,starts_at,ends_at," +
  "usage_limit,discount_usage_count,applies_once_per_customer,combines_with,discount_classes," +
  "offerable_in_replies";

const AUTOMATIC_COLUMNS =
  "promotion_key,title,discount_type,discount_classes,rule_snapshot,summary,short_summary," +
  "status,ends_at,combines_with,describable_in_replies";

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

  const blocked = blockedCombinations(row);

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
    stacksWith: blocked,
    usage: { used, limit },
    offerable: row.offerable_in_replies === true,
  };
}

/** What a discount cannot be combined with, from Shopify's `combines_with`; null when nothing. */
function blockedCombinations(row: Record<string, unknown>): string[] | null {
  const combines = (row.combines_with ?? {}) as Record<string, unknown>;
  const blocked: string[] = [];
  if (combines.order_discounts === false) blocked.push("order discounts");
  if (combines.product_discounts === false) blocked.push("product discounts");
  if (combines.shipping_discounts === false) blocked.push("shipping discounts");
  return blocked.length === 0 ? null : blocked;
}

/**
 * Every active AUTOMATIC offer, each describable to customers unless switched off.
 *
 * The opposite default to codes, deliberately: an automatic offer is advertised
 * on the site and applies itself, so describing it hands nobody a key. Its
 * label comes from Shopify's structure, never its title — nobody maintains it.
 */
export async function listAutomaticOffers(shopId: string): Promise<AutomaticOffer[]> {
  const rows = (await supabaseSelect(
    getSupabaseClient(),
    TABLE,
    { shop_id: shopId, status: "ACTIVE", method: "automatic", deleted_at: { operator: "is", value: "null" } },
    AUTOMATIC_COLUMNS
  )) as Record<string, unknown>[];

  return (rows ?? []).map(toAutomaticOffer).sort((a, b) => a.title.localeCompare(b.title));
}

/** Lets support describe one automatic offer, or keeps it out of replies. */
export async function setOfferDescribable(
  shopId: string,
  promotionKey: string,
  describable: boolean
): Promise<AutomaticOffer> {
  if (!promotionKey.trim()) {
    throw new KnowledgeValidationError("A promotion key is required.");
  }

  // `method: automatic` in the filter: this switch has no meaning on a code,
  // whose offerability is `setPromotionOfferable`'s.
  const rows = (await supabaseUpdate(
    getSupabaseClient(),
    TABLE,
    { shop_id: shopId, promotion_key: promotionKey, method: "automatic" },
    { describable_in_replies: describable },
    { select: AUTOMATIC_COLUMNS }
  )) as Record<string, unknown>[];

  const updated = (rows ?? [])[0];
  if (!updated) {
    throw new KnowledgeNotFoundError(`No automatic offer found for ${promotionKey}.`);
  }
  return toAutomaticOffer(updated);
}

function toAutomaticOffer(row: Record<string, unknown>): AutomaticOffer {
  return {
    promotionKey: String(row.promotion_key),
    title: String(row.title ?? row.promotion_key),
    mechanic: promotionMechanic(row) as PromotionMechanic,
    // The long summary here, unlike codes: for an automatic offer the
    // conditions ARE the offer (« Minimum purchase of €70.00 • For France »).
    summary: String(row.summary ?? row.short_summary ?? "").trim() || null,
    endsAt: (row.ends_at as string) ?? null,
    stacksWith: blockedCombinations(row),
    // `!== false`: the column defaults to true, and so does its absence.
    describable: row.describable_in_replies !== false,
  };
}
