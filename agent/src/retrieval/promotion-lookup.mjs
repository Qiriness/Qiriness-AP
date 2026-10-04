import { promotionMechanic } from '../../../scripts/lib/promotion-mechanic.mjs';
import { supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';

import { evaluateOutcome, rewardProductIds, rewardStock } from './promotion-outcome.mjs';
import { readStockByShopifyIds } from './stock-by-id.mjs';
import { evaluateEligibility, findPromotionByCode, normaliseCode } from './promotion-rules.mjs';

// The promotion tool: everything support needs to answer "pourquoi mon code ne
// marche pas ?".
//
// Targets the largest answerable topic left in the corpus — 34 `promotions`
// tickets, 29 of them level 2, and the single biggest cluster in the whole
// inbox is the newsletter welcome code (20 messages).
//
// TWO ENTRY POINTS, because a question mentions a code in two ways: explicitly
// ("le code QIRINESS10 ne fonctionne pas") or not at all ("je n'ai pas reçu ma
// remise de 20%"). The first is a lookup; the second needs the human to supply
// the code, and the tool says so rather than guessing which of three active
// promotions was meant.

const COLUMNS = [
  'id', 'codes', 'title', 'method', 'discount_type', 'status',
  'summary', 'short_summary', 'starts_at', 'ends_at',
  'usage_limit', 'discount_usage_count',
  'applies_once_per_customer', 'discount_classes', 'combines_with', 'rule_snapshot',
  // Only codes an operator cleared may ever be named to a customer.
  'offerable_in_replies',
  // Automatic offers are describable unless an operator switched one off.
  'describable_in_replies'
].join(',');

/**
 * A stored discount row -> one candidate per redeem code.
 *
 * THE SEAM. `promotions` holds one row per DISCOUNT with its codes in a jsonb
 * array, because a bulk discount carries up to 600 of them and duplicating the
 * whole snapshot per code cost 7,512 rows and 22 MB where 324 rows do. But
 * `promotion-rules.mjs` is pure, well covered, and reasons about ONE code at a
 * time — `p.code`, `p.code_usage_count`.
 *
 * Flattening here rather than teaching every rule about the array keeps the
 * storage decision out of the logic entirely: the rules see exactly the shape
 * they always saw, and only this function knows the difference. An automatic
 * discount has no codes, so it yields itself once with a null code.
 */
function flattenPromotion(row) {
  const codes = Array.isArray(row.codes) ? row.codes : [];
  if (codes.length === 0) {
    return [{ ...row, code: null, code_usage_count: null }];
  }
  return codes.map((entry) => ({
    ...row,
    code: entry?.code ?? null,
    // Per code, and load-bearing: most of this store's codes are single-use, so
    // this is what makes "you have already used this code" answerable.
    code_usage_count: entry?.usage_count ?? null,
    shopify_redeem_code_id: entry?.redeem_code_id ?? null
  }));
}

/**
 * A backstop on how many offers one tool result may name.
 *
 * The dedup above is what actually fixes the size — this shop has ~25 distinct
 * active offers behind 3619 codes. The cap exists so that a shop with hundreds
 * of genuinely distinct promotions cannot reproduce the same failure by a
 * different route: a tool result should be bounded by construction, not by the
 * catalogue happening to be small.
 */
const MAX_ACTIVE_LISTED = 40;

/** Codes as customers write them: uppercase runs of letters/digits, 4+ long. */
const CODE_PATTERN = /\b[A-Z][A-Z0-9]{3,}\b/g;

export function createPromotionLookup({ supabase, shopId, logger }) {
  let promotionsPromise = null;
  let rowsPromise = null;

  function loadRows() {
    if (!rowsPromise) {
      rowsPromise = supabaseSelectAll(
        supabase,
        'promotions',
        { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } },
        COLUMNS
      );
    }
    return rowsPromise;
  }

  async function extractCodes(text) {
    const promotions = await loadPromotions();
    const known = new Set(promotions.map((p) => normaliseCode(p.code)).filter(Boolean));
    const seen = new Set();
    const found = [];

    for (const raw of String(text || '').match(CODE_PATTERN) || []) {
      const code = normaliseCode(raw);
      if (known.has(code) && !seen.has(code)) {
        seen.add(code);
        found.push(code);
      }
    }
    return found;
  }

  /**
   * Whether the offer's free item can be sent now: its products' stock at the
   * last product sync, read through `buildStock` so a draft or a -1 count is
   * never "in stock". A read that fails is `unknown`, never a refusal of the
   * outcome it is attached to.
   */
  async function loadRewardStock(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return { stock: rewardStock(ids), products: [] };
    }
    try {
      const products = await readStockByShopifyIds(supabase, shopId, ids);
      return { stock: rewardStock(ids, products), products };
    } catch (error) {
      logger?.warn?.('promotion.reward_stock_failed', { reason: error.message });
      return { stock: 'unknown', products: [] };
    }
  }

  /**
   * Live product membership of the collections an offer is scoped to, from
   * `advice_collections.product_ids`. A collection the sync never filled is
   * left out of the map, which `evaluateOutcome` reads as "cannot know".
   */
  async function loadMembers(collectionIds) {
    const members = new Map();
    const ids = [...new Set(collectionIds)].filter(Boolean);
    if (ids.length === 0) return members;
    const rows = await supabaseSelectAll(
      supabase,
      'advice_collections',
      {
        shop_id: shopId,
        shopify_collection_id: { operator: 'in', value: `(${ids.map((id) => `"${id}"`).join(',')})` }
      },
      'shopify_collection_id,product_ids,products_synced_at'
    );
    for (const row of rows || []) {
      if (row.products_synced_at && Array.isArray(row.product_ids)) {
        members.set(row.shopify_collection_id, new Set(row.product_ids));
      }
    }
    return members;
  }

  /**
   * How many orders used each promotion in the last `days` days: by the name
   * Shopify recorded (an automatic offer's title, or the code) and by typed
   * code. Read once per lookup. A ranking signal only — never quoted.
   */
  let usagePromise = null;
  function loadRecentUsage(now = new Date(), days = 30) {
    if (!usagePromise) {
      const since = new Date(now.getTime() - days * 86_400_000).toISOString();
      usagePromise = supabaseSelectAll(
        supabase,
        'orders',
        { shop_id: shopId, processed_at: { operator: 'gte', value: since }, deleted_at: { operator: 'is', value: 'null' } },
        'discount_applications,discount_codes'
      ).then((orders) => {
        const counts = new Map();
        const bump = (name) => {
          const key = String(name || '').trim().toLowerCase();
          if (key) counts.set(key, (counts.get(key) || 0) + 1);
        };
        for (const order of orders || []) {
          // Once per order per name, however many lines it touched.
          const names = new Set([
            ...(Array.isArray(order.discount_applications) ? order.discount_applications : []).map((a) => a?.name),
            ...(Array.isArray(order.discount_codes) ? order.discount_codes : [])
          ].map((n) => String(n || '').trim().toLowerCase()));
          for (const name of names) bump(name);
        }
        return counts;
      });
    }
    return usagePromise;
  }

  /** One candidate per redeem code — what the per-code rules expect. */
  function loadPromotions() {
    if (!promotionsPromise) {
      promotionsPromise = loadRows().then((rows) => rows.flatMap(flattenPromotion));
    }
    return promotionsPromise;
  }

  return {
    refresh() {
      promotionsPromise = null;
      // Both caches, or the flattened list rebuilds from stale rows.
      rowsPromise = null;
      usagePromise = null;
    },

    /**
     * Pulls candidate discount codes out of a message.
     *
     * Deliberately crude and deliberately verified against the real list: any
     * uppercase token could be a code, so the catch is wide and then filtered
     * to codes that actually exist. Guessing from shape alone would offer
     * "URGENT" or "RE" as discount codes.
     */
    extractCodes,

    /**
     * Full promotion detail plus every eligibility check we can actually make.
     *
     * `customer` is optional. Passing one enables the newsletter check and
     * nothing else today; without it that check reports `unknown` rather than
     * assuming anything.
     */
    async lookupPromotion(code, { customer = null, now = new Date() } = {}) {
      const promotions = await loadPromotions();
      const { promotion, suggestions } = findPromotionByCode(code, promotions);
      const eligibility = evaluateEligibility({ promotion, customer, now });

      logger?.info?.('promotion.lookup', {
        code: normaliseCode(code),
        found: Boolean(promotion),
        verdict: eligibility.verdict,
        blocking: eligibility.blocking.length,
        unknowns: eligibility.unknowns.length
      });

      return {
        found: Boolean(promotion),
        code: normaliseCode(code),
        suggestions: suggestions.map((p) => p.code),
        promotion: promotion ? summarise(promotion) : null,
        eligibility,
        promptText: renderPromotion({ promotion, suggestions, eligibility, code })
      };
    },

    /**
     * Every active promotion — for "quelles promos avez-vous en ce moment ?".
     *
     * WORKS FROM THE UNFLATTENED ROWS, and that is the whole point of this
     * function existing separately. Asked over the per-code list it answers with
     * one entry per REDEEM CODE: measured on this shop, 3619 entries and 259,874
     * characters, which is a single tool result seven times larger than the
     * model's entire per-minute token budget. The investigation failed outright
     * on a 284-character ticket because of it.
     *
     * Two things were wrong with that, and only one was cost:
     *
     * - A customer asking what offers are running wants the ~25 OFFERS, not
     *   3614 machine-generated single-use codes.
     * - Those codes are other customers' property. Putting every unredeemed
     *   single-use code in the shop into a model prompt — one turn away from a
     *   drafted reply — is a leak, and the size of it was hiding the shape.
     *
     * A code is named ONLY when the discount has exactly one, which is what a
     * shared, advertised code looks like (`QIRINESS20`). A bulk discount's codes
     * each belong to one customer and none of them is "the" code.
     *
     * THE RESIDUAL, STATED RATHER THAN GUESSED AT. On this shop 14 of 25 active
     * offers have a single code; 13 are plainly advertised (`QIRINESS20`,
     * `UKLED20`, `CRE30`) and one, `GVKRW65ZF68K`, is machine-generated — a
     * one-off comp for a single customer. Nothing in the row separates them:
     * `title` equals the code for all 14, and both are "one use per customer".
     * Telling them apart would mean guessing from the SHAPE of the string, which
     * is the kind of heuristic that works until a merchant names a campaign
     * `WRAP-V`. If one-off codes need withholding, they need marking at creation
     * — a naming convention or a Shopify tag — and that is a merchant decision,
     * not something this function can infer.
     */
    /**
     * The offerable promotions that cover ONE product, split by how narrow they
     * are.
     *
     * SPECIFIC MEANS NARROW, AND NARROW IS COUNTED RATHER THAN ASSERTED. A code
     * scoped to 94 products is a general sale wearing a product scope; naming it
     * as "an offer on your product" would be true and misleading. The line is
     * ten OTHER products: past that the promotion is about the catalogue rather
     * than about this item, and the general branch says so more honestly.
     *
     * TWO GATES, ONE PER KIND. A code must be `offerable_in_replies` — what an
     * operator cleared, the same gate the rule editor's picker uses — so a
     * partner rate or a 100%-off code never reaches a reply. An AUTOMATIC offer
     * must be `describable_in_replies`, which it is unless switched off: it is
     * advertised and applies itself, so naming it hands out nothing (2026-10-01).
     *
     * WHICH PRODUCTS AN AUTOMATIC OFFER IS « ON »: those that qualify for it
     * (the buy side of a gift or a 3+1) and the one it gives. « Le Wrap d'Or
     * est offert dès 1 € d'achat » is an offer on the Wrap d'Or AND on every
     * product that earns it; the ten-other-products line still decides whether
     * that is specific to this item.
     *
     * RANKED BY USE. Each list is ordered by how many orders used the offer in
     * the last 30 days, so the first one named is the one customers actually
     * take. The count is a ranking, never something to quote.
     */
    async offersForProduct(shopifyProductId, { now = new Date(), maxOtherProducts = 10 } = {}) {
      const rows = await loadRows();
      const live = rows.filter((row) => offerableNow(row, now));
      const members = await loadMembers(live.flatMap((row) => collectionsOf(row)));
      const usage = await loadRecentUsage(now);

      const specific = [];
      const general = [];
      for (const row of live) {
        const scope = productScope(row, members);
        const entry = { ...summarise(flattenPromotion(row)[0] ?? row), kind: row.method, recentUses: usesOf(row, usage) };
        // No product scope at all means it applies to the order, which is the
        // most general thing a promotion can be.
        if (scope === 'all') {
          general.push(entry);
          continue;
        }
        // A collection whose membership was never synced cannot say whether
        // this product is in it, so the offer is left out rather than guessed.
        if (!scope || !shopifyProductId || !scope.has(shopifyProductId)) continue;
        (scope.size - 1 > maxOtherProducts ? general : specific).push(entry);
      }
      const byUse = (a, b) => b.recentUses - a.recentUses;
      return { specific: specific.sort(byUse), general: general.sort(byUse) };
    },

    /**
     * WHICH PROMOTION THE CUSTOMER MEANS, and whether it is a code or an offer
     * that applies itself.
     *
     * Two inputs, and neither is trusted alone:
     *
     * - `codes` — what the decomposer saw typed. Kept only when the code exists in
     *   the shop AND appears in the message, which is the same double check
     *   `lookupPromotion` applies. The uppercase scan of `extractCodes` runs too,
     *   because the decomposer can miss what a regex cannot, and the decomposer
     *   catches what the regex cannot (`Newyear26`, `PANIER 10`).
     * - `offers` — what the customer DESCRIBES: free shipping, a gift, a 3+1, a
     *   percentage, a threshold. Matched against the automatic offers by what
     *   they do (promotion-mechanic.mjs), then by threshold, percentage and the
     *   gift's name. A described percentage with no automatic match is looked
     *   for among the codes: « les 20 % de la première commande » is a code the
     *   customer never typed.
     *
     * NOTHING IS GUESSED. Several offers fitting equally is `ambiguous` and says
     * which; a description matching nothing is `none`. Recently ended offers are
     * candidates too, because a complaint arrives after the offer it is about.
     */
    async identify({ text = '', codes = null, offers = [], now = new Date(), lookbackDays = 120 } = {}) {
      const rows = await loadRows();
      const flat = await loadPromotions();

      // --- codes: typed by the customer, present in the message -------------
      //
      // WHEN A READING EXISTS IT DECIDES, and the uppercase scan is only the
      // fallback for a call with no reading. Measured 2026-10-01: « WRAP ECLAT
      // commandé 3 » made the scan report the real code `WRAP` — a product
      // name that happens to be a code — on two tickets about a 3+1. The
      // decomposer reads « WRAP ECLAT » as a product; the regex cannot.
      //
      // A typed code the shop does NOT hold is kept, marked unknown: « code
      // introuvable » is an answer, and the message is still about a code.
      const typed = new Map();
      const candidates = Array.isArray(codes) ? codes : await extractCodes(text);
      for (const raw of candidates) {
        if (!appearsInText(raw, text)) continue;
        const { promotion } = findPromotionByCode(raw, flat);
        const code = normaliseCode(promotion?.code ?? raw);
        if (code && !typed.has(code)) typed.set(code, promotion ?? null);
      }
      const codeMatches = [...typed].map(([code, promotion]) =>
        promotion ? { code, known: true, ...describe(promotion) } : { code, known: false, title: code, status: null, summary: null }
      );

      // --- offers: described, matched on what they do -----------------------
      const since = new Date(now.getTime() - lookbackDays * 86_400_000);
      const live = (row) =>
        String(row.status || '').toUpperCase() === 'ACTIVE' ||
        (row.ends_at && new Date(row.ends_at) >= since && new Date(row.ends_at) <= now);
      const automatic = rows.filter((row) => row.method === 'automatic' && live(row));
      const codeRows = rows.filter((row) => row.method === 'code' && String(row.status || '').toUpperCase() === 'ACTIVE');

      const offerMatches = offers.map((mention) => {
        const pool = automatic.filter((row) => fits(mention, row));
        const ranked = rank(mention, pool, now);
        const fromCodes =
          ranked.length === 0 && (mention.percentage !== null || mention.mechanic === 'amount_off')
            ? rank(mention, codeRows.filter((row) => fits(mention, row)), now)
                .filter((r) => r.score > 0)
            : [];
        return { mention, ...settle(ranked), codeCandidates: fromCodes.map((r) => describe(r.row)) };
      });

      // THE KIND IS NOT WHICH OFFER. « Un masque offert » with five mask gifts
      // running is unmistakably an automatic gift even though which one is open:
      // the kind is settled and the offer is not, and the case file says both.
      // `ambiguous` is kept for the one doubt that changes the answer — code or
      // automatic offer — when a description fits both.
      const automaticSeen = offerMatches.some((m) => m.candidates.length > 0);
      const codeCandidates = offerMatches.flatMap((m) => m.codeCandidates);

      let kind = 'none';
      if (codeMatches.length > 0 && automaticSeen) kind = 'both';
      else if (codeMatches.length > 0) kind = 'code';
      else if (automaticSeen && codeCandidates.length > 0) kind = 'ambiguous';
      else if (automaticSeen) kind = 'automatic';
      else if (codeCandidates.length > 0) kind = 'code';
      const matched = offerMatches.filter((m) => m.match);

      logger?.info?.('promotion.identify', {
        kind,
        codes: codeMatches.length,
        mentions: offers.length,
        matched: matched.length
      });

      const result = { kind, codes: codeMatches, offers: offerMatches.map(publicMatch), codeCandidates };
      return { ...result, promptText: renderIdentification(result) };
    },

    /**
     * Why ONE identified promotion did or did not apply to a basket.
     *
     * `ref` is what identification returned — a promotion key, a code or an
     * offer's exact title. Anything that resolves to no promotion is refused
     * rather than approximated: the argument is the model's to pass, and a
     * near-miss title would evaluate an offer nobody mentioned.
     */
    async outcome({ ref, basket }) {
      const rows = await loadRows();
      const wanted = String(ref ?? '').trim();
      const asked = wanted ? resolveRef(wanted, rows) : null;
      if (wanted && !asked) {
        return { found: false, ref: wanted, promptText: `Aucune promotion « ${ref} » dans la boutique.` };
      }

      const evaluate = async (promotion) => {
        // The OTHER promotions on the basket, by the names Shopify recorded and
        // the codes typed — what this one would have had to combine with.
        const names = [...(basket?.applied || []), ...(basket?.codes || [])];
        const others = rows.filter((row) => row.id !== promotion.id && names.some((n) => resolveRef(n, [row])));
        const members = await loadMembers([promotion, ...others].flatMap((row) => collectionsOf(row)));
        return { ...evaluateOutcome({ promotion, basket, others, members }), members };
      };

      // THE ORDER NAMES THE OFFER WHEN THE CUSTOMER DID NOT. A free item that
      // was CHARGED points at the offer it is the reward of. Measured on #6452:
      // the customer quoted « dès 65 € », which is « wrap vitaminé » — applied —
      // while the line actually charged was the Wrap d'Or of « Masque Or
      // offert ». Answering "applied" there answers the wrong offer, so a
      // charged reward takes over, and the reply says which offer it is.
      const charged = basket?.source === 'order' ? chargedRewardOffers(rows, basket).filter((row) => row.id !== asked?.id) : [];

      let promotion = asked;
      let result = asked ? await evaluate(asked) : null;
      let instead = null;
      if (charged.length > 0 && (!result || result.outcome === 'applied')) {
        instead = asked ? asked.title : null;
        promotion = charged[0];
        result = await evaluate(promotion);
      }
      if (!promotion) {
        return { found: false, ref: '', promptText: 'Aucune promotion identifiée, et aucun article offert facturé sur la commande.' };
      }

      // THE FREE ITEM'S STOCK NOW, whatever the outcome: a gift missing from
      // the basket or from the parcel is put right by sending it, and whether
      // it can be sent is today's stock, not the stock on the order date.
      const { members, ...outcome } = result;
      const reward = await loadRewardStock(rewardProductIds({ promotion, basket, members }));

      logger?.info?.('promotion.outcome', { outcome: outcome.outcome, mechanic: outcome.mechanic, basket: outcome.basketSource, instead: Boolean(instead), reward: reward.stock });
      const text = renderOutcome(promotion, outcome, reward);
      return {
        found: true,
        promotion: describe(promotion),
        ...outcome,
        reward,
        instead,
        promptText: instead
          ? `L'offre « ${instead} » a bien été appliquée ; l'article facturé relève d'une autre offre.\n${text}`
          : text
      };
    },

    /**
     * NAMED ONLY WHAT A REPLY MAY USE (2026-10-01). It used to name every
     * active single-code offer, which put partner rates (50 %, 26 %) and a
     * 100 %-off code in front of the model on every promotions ticket, one
     * turn from a draft. Now: offerable codes and describable automatic offers
     * are listed, ranked by recent use; every other active code is COUNTED,
     * not named — "other codes exist" is the honest fact, the codes are not.
     */
    async listActive({ now = new Date(), limit = MAX_ACTIVE_LISTED } = {}) {
      const rows = await loadRows();
      const running = rows.filter((row) => {
        if (String(row.status || '').toUpperCase() !== 'ACTIVE') return false;
        if (row.starts_at && now < new Date(row.starts_at)) return false;
        if (row.ends_at && now > new Date(row.ends_at)) return false;
        return true;
      });
      const active = running.filter((row) => offerableNow(row, now));
      const usage = await loadRecentUsage(now);

      const listed = active
        .map((row) => {
          const codes = Array.isArray(row.codes) ? row.codes : [];
          return {
            ...summarise({ ...row, code: codes.length === 1 ? codes[0]?.code ?? null : null }),
            codeCount: codes.length,
            recentUses: usesOf(row, usage)
          };
        })
        .sort((a, b) => b.recentUses - a.recentUses)
        .slice(0, limit);

      return {
        promotions: listed,
        total: active.length,
        truncated: active.length > listed.length,
        // Running but not for replies: partner rates, one-off comps, bulk batches.
        withheld: running.length - active.length
      };
    }
  };
}

// --- outcome helpers ------------------------------------------------------------

/** A promotion by key, by one of its codes, or by its exact title — nothing looser. */
function resolveRef(ref, rows) {
  const wanted = String(ref ?? '').trim();
  if (!wanted) return null;
  const lower = wanted.toLowerCase();
  const code = normaliseCode(wanted);
  return (
    rows.find((row) => row.id === wanted) ||
    rows.find((row) => (Array.isArray(row.codes) ? row.codes : []).some((c) => normaliseCode(c?.code) === code)) ||
    rows.find((row) => String(row.title || '').trim().toLowerCase() === lower) ||
    null
  );
}

/**
 * Automatic gift offers, live when the order was placed, whose free item is on
 * the order and was paid for. Product-scoped rewards only: a collection-scoped
 * reward (a 3+1) cannot be told from an ordinary paid line in the collection.
 */
function chargedRewardOffers(rows, basket) {
  const at = basket.at ? new Date(basket.at) : null;
  const live = (row) =>
    (!at || !row.starts_at || new Date(row.starts_at) <= at) && (!at || !row.ends_at || new Date(row.ends_at) >= at);
  const charged = new Set(basket.lines.filter((l) => (l.paid ?? 0) > 0).map((l) => l.productId));
  return rows.filter((row) => {
    if (row.method !== 'automatic' || promotionMechanic(row) !== 'gift' || !live(row)) return false;
    const gets = row.rule_snapshot?.customer_gets?.items;
    return gets?.scope === 'products' && (gets.products || []).some((p) => charged.has(p.id));
  });
}

/**
 * Running now and allowed in a reply: a code an operator cleared, or an
 * automatic offer nobody switched off.
 */
function offerableNow(row, now) {
  if (String(row.status || '').toUpperCase() !== 'ACTIVE') return false;
  if (row.starts_at && now < new Date(row.starts_at)) return false;
  if (row.ends_at && now > new Date(row.ends_at)) return false;
  return row.method === 'automatic' ? row.describable_in_replies !== false : row.offerable_in_replies === true;
}

/**
 * The products an offer is « on »: 'all' for the whole order, a Set of product
 * ids, or null when a collection's membership is unknown. For a buy-X-get-Y
 * both sides count — what earns it and what it gives.
 */
function productScope(row, members) {
  const rules = row.rule_snapshot || {};
  const legs = [rules.customer_buys?.items, rules.customer_gets?.items].filter(Boolean);
  if (legs.length === 0 || legs.some((items) => items.scope === 'all')) return 'all';
  const ids = new Set();
  for (const items of legs) {
    if (items.scope === 'products') for (const p of items.products || []) ids.add(p.id);
    else if (items.scope === 'collections') {
      for (const c of items.collections || []) {
        const set = members.get(c.id);
        if (!set) return null;
        for (const id of set) ids.add(id);
      }
    } else return null;
  }
  return ids;
}

/** Orders in the window that used this promotion, by its title or any of its codes. */
function usesOf(row, usage) {
  const names = [row.title, ...(Array.isArray(row.codes) ? row.codes.map((c) => c?.code) : [])]
    .map((n) => String(n || '').trim().toLowerCase())
    .filter(Boolean);
  return Math.max(0, ...[...new Set(names)].map((n) => usage.get(n) || 0));
}

function collectionsOf(row) {
  const rules = row?.rule_snapshot || {};
  return [rules.customer_buys?.items, rules.customer_gets?.items]
    .filter((items) => items?.scope === 'collections')
    .flatMap((items) => (items.collections || []).map((c) => c.id));
}

const OUTCOME_FR = {
  applied: 'la promotion a bien été appliquée',
  expired: "l'offre n'était pas en cours au moment de ce panier",
  outside_destination: "l'adresse de livraison est hors des pays couverts par l'offre",
  not_combinable: "l'offre ne se cumule pas avec une autre promotion déjà appliquée",
  items_not_qualifying: "aucun article du panier n'est concerné par l'offre",
  below_threshold: "le montant ou le nombre d'articles requis n'est pas atteint",
  reward_not_in_basket: "l'article offert n'a pas été ajouté au panier (il faut l'ajouter soi-même)",
  conditions_met: "toutes les conditions vérifiables sont remplies et l'offre ne s'est pas appliquée : à vérifier par l'équipe",
  undetermined: 'impossible de trancher avec les données disponibles'
};

/**
 * For the model: the verdict first, then the facts behind it, then — on their
 * own line — what could not be checked. A doubt is never folded into a fact.
 */
function renderOutcome(promotion, result, reward = null) {
  const lines = [`# « ${promotion.title} » — ${OUTCOME_FR[result.outcome] || result.outcome}`];
  lines.push(
    result.basketSource === 'order'
      ? 'Vérifié sur la commande.'
      : result.basketSource === 'checkout'
        ? 'Vérifié sur le dernier panier abandonné (instantané, pas forcément le panier actuel).'
        : 'Aucun panier ni commande disponible.'
  );
  for (const c of result.checks) {
    if (c.id === 'threshold' && c.status === 'fail' && c.gap !== undefined) {
      lines.push(`- Seuil : ${c.required} € requis, ${c.spend} € d'articles concernés (il manque ${c.gap} €).`);
    } else if (c.id === 'threshold' && c.status === 'fail' && c.units !== undefined) {
      lines.push(`- ${c.units} article(s) concerné(s), ${c.required} requis.`);
    } else if (c.id === 'destination' && c.status === 'fail') {
      lines.push(`- Livraison vers ${c.country} ; l'offre couvre : ${c.allowed.join(', ')}.`);
    } else if (c.id === 'reward' && c.status === 'fail') {
      lines.push(
        c.units !== undefined
          ? `- ${c.units} article(s) concerné(s) dans le panier ; il en faut ${c.required} pour que le dernier soit offert.`
          : "- L'article offert ne figure pas dans le panier."
      );
    } else if (c.id === 'reward' && c.status === 'pass' && c.charged) {
      lines.push("- L'article offert est dans le panier mais a été facturé.");
    } else if (c.id === 'combination' && c.status === 'fail') {
      lines.push(`- Ne se cumule pas avec « ${c.with} », déjà appliquée.`);
    }
  }
  if (reward && reward.stock !== 'no_reward') lines.push(renderRewardStock(reward));
  const unknown = result.checks.filter((c) => c.status === 'unknown').map((c) => CHECK_FR[c.id] || c.id);
  if (unknown.length > 0) lines.push(`Non vérifiable : ${unknown.join(', ')}.`);
  return lines.join('\n');
}

/** Today's stock of the free item — what decides whether it can be sent. */
function renderRewardStock(reward) {
  if (reward.stock === 'unknown' || reward.products.length === 0) {
    return "Stock actuel de l'article offert : impossible à établir.";
  }
  const items = reward.products.map((p) => `« ${p.title} » ${p.purchasable ? 'en stock' : 'indisponible'}`);
  return `Stock actuel de l'article offert : ${items.join(', ')}.`;
}

const CHECK_FR = {
  basket: 'le panier',
  window: "les dates de l'offre",
  destination: 'le pays de livraison',
  items: 'les articles concernés',
  threshold: 'le seuil (selon que les remises comptent ou non)',
  reward: "la présence de l'article offert"
};

// --- identification helpers ---------------------------------------------------

/**
 * Which stored mechanics a customer's description can refer to. The customer
 * cannot see whether a percentage is order- or product-level, so `percent_off`
 * and `amount_off` cover both; `unclear` matches any automatic offer.
 */
const DESCRIBED_MECHANICS = {
  free_shipping: ['free_shipping'],
  gift: ['gift'],
  multi_buy: ['multi_buy'],
  percent_off: ['order_discount', 'product_discount'],
  amount_off: ['order_discount', 'product_discount'],
  unclear: null
};

export const DESCRIBED_MECHANIC_KEYS = Object.freeze(Object.keys(DESCRIBED_MECHANICS));

/**
 * Whether a stored promotion can be the one described. The mechanic must fit;
 * a stated PERCENTAGE must match exactly, because it is the advertised number —
 * « -20 % » is never the 25 % offer. A stated threshold is NOT a filter:
 * customers misquote it (« dès 49 € » for a 70 € offer), and the mismatch is
 * reported instead.
 */
function fits(mention, row) {
  if (!mechanicFits(mention.mechanic, promotionMechanic(row))) return false;
  const pct = percentageOf(row);
  return mention.percentage === null || pct === null || pct === Math.round(mention.percentage);
}

function mechanicFits(described, stored) {
  const fits = DESCRIBED_MECHANICS[described];
  return fits === undefined ? false : fits === null ? true : fits.includes(stored);
}

/** The spend an offer asks for: a minimum subtotal, or a buy-X-get-Y's « dès 65 € ». */
function thresholdOf(row) {
  const rules = row?.rule_snapshot || {};
  const amount =
    (rules.minimum_requirement?.type === 'subtotal' ? rules.minimum_requirement.amount : null) ??
    rules.customer_buys?.amount ??
    null;
  return amount === null || amount === undefined ? null : Number(amount);
}

/** As the customer would say it: 20, not Shopify's 0.2. */
function percentageOf(row) {
  const pct = row?.rule_snapshot?.customer_gets?.percentage;
  return pct === null || pct === undefined ? null : Math.round(Number(pct) * 100);
}

/** What a customer could call the offer: its advertised name and the products it gives. */
function namesOf(row) {
  const gets = row?.rule_snapshot?.customer_gets?.items;
  const items = [...(gets?.products || []), ...(gets?.collections || [])].map((i) => i?.title || '');
  return [row?.title || '', ...items].join(' ');
}

function tokens(value) {
  return new Set(
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2)
  );
}

/**
 * Scores each candidate against one description.
 *
 * THE NAME IS WEIGHTED BY HOW RARE EACH WORD IS ACROSS THE CANDIDATES, so the
 * words every gift shares (« masque », « offert ») count for nothing and « or »
 * picks « Masque Or offert » out of five mask gifts. No stop-word list, so no
 * language is assumed.
 */
function rank(mention, pool, now) {
  const named = tokens(mention.product);
  const docs = pool.map((row) => tokens(namesOf(row)));
  const df = new Map();
  for (const doc of docs) for (const t of doc) df.set(t, (df.get(t) || 0) + 1);

  return pool
    .map((row, i) => {
      let score = 0;
      const threshold = thresholdOf(row);
      if (mention.threshold !== null && threshold !== null && Math.abs(threshold - mention.threshold) < 0.5) score += 2;
      const pct = percentageOf(row);
      if (mention.percentage !== null && pct !== null && pct === Math.round(mention.percentage)) score += 2;
      for (const t of named) {
        if (docs[i].has(t)) score += Math.log(pool.length / df.get(t));
      }
      // A live offer outranks an ended one only when nothing else separates them.
      if (String(row.status || '').toUpperCase() === 'ACTIVE') score += 0.01;
      return { row, score, thresholdNote: thresholdNote(mention, threshold) };
    })
    .sort((a, b) => b.score - a.score);
}

function thresholdNote(mention, threshold) {
  if (mention.threshold === null || threshold === null) return null;
  return Math.abs(threshold - mention.threshold) < 0.5 ? null : { said: mention.threshold, actual: threshold };
}

/** One clear winner, several tied, or nothing — never a coin toss. */
function settle(ranked) {
  if (ranked.length === 0) return { match: null, candidates: [] };
  if (ranked.length === 1 || ranked[0].score - ranked[1].score >= 0.5) {
    return { match: ranked[0], candidates: [ranked[0]] };
  }
  const top = ranked.filter((r) => ranked[0].score - r.score < 0.5);
  return { match: null, candidates: top };
}

function describe(row) {
  if (!row) return null;
  return {
    promotionKey: row.id ?? null,
    ...summarise(flattenPromotion(row)[0] ?? row),
    threshold: thresholdOf(row),
    // An automatic offer an operator kept out of replies is identified all the
    // same — the person reading the case file needs it — but flagged.
    describable: row.method !== 'automatic' || row.describable_in_replies !== false
  };
}

function publicMatch({ mention, match, candidates, codeCandidates }) {
  return {
    mention,
    match: match ? { ...describe(match.row), thresholdNote: match.thresholdNote } : null,
    candidates: candidates.length > 1 ? candidates.map((c) => describe(c.row)) : [],
    codeCandidates
  };
}

/**
 * Whether a code is in the message as a WORD, or two adjacent words
 * (« PANIER 10 »). Never a substring of the flattened text, which finds a code
 * inside any longer word and was how a fabricated argument could pass.
 */
function appearsInText(code, text) {
  const flatten = (value) => String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const needle = flatten(code);
  if (!needle) return false;
  const words = String(text || '').split(/\s+/).map(flatten).filter(Boolean);
  return words.some((w, i) => w === needle || (i + 1 < words.length && w + words[i + 1] === needle));
}

const MECHANIC_FR = {
  free_shipping: 'livraison offerte',
  gift: 'cadeau dès un montant',
  multi_buy: 'achat multiple',
  order_discount: 'remise sur la commande',
  product_discount: 'remise sur des produits',
  app: "remise d'application",
  unknown: 'offre'
};

/**
 * For the model. What was typed, which offer each description is, and — kept in
 * its own line — what is NOT settled, so a doubt is never read as a fact.
 */
function renderIdentification({ kind, codes, offers, codeCandidates }) {
  const lines = [];
  for (const c of codes) {
    lines.push(
      c.known
        ? `Code saisi par le client : ${c.code} — ${c.summary || c.title} (statut : ${c.status}).`
        : `Code saisi par le client : ${c.code} — ce code n'existe pas dans la boutique.`
    );
  }
  for (const o of offers) {
    if (o.match) {
      const m = o.match;
      lines.push(
        `Offre automatique concernée (${MECHANIC_FR[m.mechanic] || 'offre'}, s'applique seule, sans code) : ` +
          `« ${m.title} » — ${m.summary || ''} (statut : ${m.status}).` +
          (m.describable ? '' : ' Offre exclue des réponses : ne pas la décrire au client.')
      );
      if (m.thresholdNote) {
        lines.push(
          `Le client évoque un seuil de ${m.thresholdNote.said} € ; le seuil réel de cette offre est ${m.thresholdNote.actual} €.`
        );
      }
    } else if (o.candidates.length > 1) {
      lines.push(
        `Offre automatique (s'applique seule, sans code), mais plusieurs correspondent à ce que décrit le client, sans pouvoir trancher : ` +
          o.candidates.map((c) => `« ${c.title} »`).join(', ') + '.'
      );
    } else if (o.codeCandidates.length === 0) {
      lines.push(`Aucune offre de la boutique ne correspond à ce que décrit le client (${MECHANIC_FR[o.mention.mechanic] || o.mention.mechanic}).`);
    }
  }
  if (codeCandidates.length > 0 && codes.length === 0) {
    lines.push(
      `Le client parle d'une remise sans citer de code ; codes actifs de ce montant : ` +
        codeCandidates.map((c) => c.code || `« ${c.title} »`).join(', ') + '. Ne pas supposer lequel.'
    );
  }
  if (lines.length === 0) {
    lines.push('Le message ne cite aucun code et ne décrit aucune offre identifiable.');
  }
  return [`Type : ${kind}`, ...lines].join('\n');
}

function summarise(promotion) {
  return {
    code: promotion.code || null,
    title: promotion.title,
    method: promotion.method,
    // What it does, from Shopify's structure — see promotion-mechanic.mjs.
    mechanic: promotionMechanic(promotion),
    type: promotion.discount_type,
    status: promotion.status,
    summary: promotion.summary || promotion.short_summary || null,
    startsAt: promotion.starts_at || null,
    endsAt: promotion.ends_at || null,
    usageLimit: promotion.usage_limit ?? null,
    used: promotion.code_usage_count ?? promotion.discount_usage_count ?? null,
    oncePerCustomer: Boolean(promotion.applies_once_per_customer),
    combinesWith: promotion.combines_with || {},
    appliesTo: promotion.discount_classes || []
  };
}

/**
 * Renders for a drafting model.
 *
 * Blocking reasons and unknowns are kept in SEPARATE sections on purpose. Merged
 * into one list a model treats them alike and writes "votre code a expiré et
 * votre panier est insuffisant" when only the first was established. The
 * headings are the guardrail: one section is what we know, the other is what
 * must be asked.
 */
function renderPromotion({ promotion, suggestions, eligibility, code }) {
  if (!promotion) {
    const base = `Le code « ${normaliseCode(code)} » n'existe pas dans la boutique.`;
    return suggestions.length > 0
      ? `${base}\nCodes proches : ${suggestions.map((p) => p.code).join(', ')} — demander confirmation au client.`
      : base;
  }

  const s = summarise(promotion);
  const parts = [`# Code ${s.code || s.title}`];
  if (s.summary) parts.push(s.summary);

  // ONLY THE LIMITS THAT BIND ARE STATED. "Pas de date d'expiration" and "Pas de
  // limite d'utilisation" were facts here, and the model repeated them to a
  // customer (ticket 1f8b4f0a): « ce code n'a pas de date d'expiration ni de
  // limite d'utilisation » — an open invitation to pass the code around, and a
  // promise the shop never made. The absence of a limit is operational, not
  // customer-facing; what a reply legitimately needs is the date it ends, the
  // one-per-customer rule, and how far a capped code has been used.
  const facts = [
    `Statut : ${s.status}`,
    s.endsAt ? `Expire le : ${s.endsAt.slice(0, 10)}` : null,
    s.usageLimit === null ? null : `Utilisations : ${s.used}/${s.usageLimit}`,
    s.oncePerCustomer ? 'Une seule utilisation par client' : null,
    `S'applique à : ${s.appliesTo.join(', ') || 'non précisé'}`
  ].filter(Boolean);
  parts.push(`## Détails\n${facts.map((f) => `- ${f}`).join('\n')}`);

  if (eligibility.blocking.length > 0) {
    parts.push(
      `## Cause identifiée\n${eligibility.blocking.map((r) => `- ${r}`).join('\n')}`
    );
  }
  if (eligibility.unknowns.length > 0) {
    parts.push(
      `## À vérifier avec le client (non vérifiable depuis le support)\n` +
        eligibility.unknowns.map((r) => `- ${r}`).join('\n')
    );
  }
  if (eligibility.blocking.length === 0 && eligibility.unknowns.length === 0) {
    parts.push('## Cause identifiée\n- Aucune : le code semble valable.');
  }

  return parts.join('\n\n');
}
