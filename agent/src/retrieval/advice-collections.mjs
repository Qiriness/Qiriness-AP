import { supabaseSelectAll } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';

// The collections support may answer advice from, and the intersection over them.
//
// WHY THIS IS THE UNIT OF ADVICE. The shop has 175 Shopify collections and a
// product sits in 18 to 30 of them — Black Friday, Singles day, soldes hiver,
// the OrderlyEmails plugin's index, sixty-two numbered diagnostic-quiz buckets.
// Intersecting raw membership would return everything, because everything is in
// `black-friday`. Only what somebody switched on counts, and `is_active` is the
// whole gate: there is no second list of forbidden collections, and a men's
// range or a gift set is reachable exactly when the team decided it should be.
//
// TWO AXES. A `concern` says what is wrong (rides, taches, cernes et poches); a
// `category` says what form the answer takes (sérum, crème de jour, contour des
// yeux). « un sérum pour mes rides » is one of each, and telling them apart is
// what lets `chooseProducts` relax the right one when nothing sits in both.
//
// NOTHING HERE ASKS A MODEL ANYTHING. The model names requirements; this module
// maps them onto activated collections, intersects, filters to live products and
// ranks. Everything after the naming is arithmetic.

/** Loads the activated collections, newest membership first. */
export function createAdviceCollections({ supabase, shopId, logger } = {}) {
  let cache = null;

  async function load() {
    const rows = await supabaseSelectAll(
      supabase,
      T.ADVICE_COLLECTIONS,
      { shop_id: shopId, is_active: true, deleted_at: { operator: 'is', value: 'null' } },
      'id,shopify_collection_id,handle,title,axis,product_ids,products_synced_at'
    );
    return (rows || []).map((row) => ({
      handle: String(row.handle),
      title: String(row.title),
      axis: row.axis ? String(row.axis) : null,
      productIds: Array.isArray(row.product_ids) ? row.product_ids.map(String) : [],
      syncedAt: row.products_synced_at ?? null
    }));
  }

  let snapshot = [];

  return {
    /** Cached per process, like the product index: the list changes when somebody curates. */
    async active() {
      cache = cache || load();
      snapshot = await cache;
      return snapshot;
    },
    /**
     * The last loaded list, without awaiting.
     *
     * THE TOOL DESCRIPTION NEEDS IT SYNCHRONOUSLY. What the model may name is
     * exactly what the team activated, so the titles have to be IN the schema it
     * is shown — a tool that said "name a category" without saying which would
     * be asking it to guess, and guessing is the one thing the activation list
     * exists to prevent. `toolsFor` is synchronous, so the runner primes this
     * with `active()` before building the tool set, and an unprimed snapshot is
     * empty rather than stale.
     */
    cached() {
      return snapshot;
    },
    refresh() {
      cache = null;
      snapshot = [];
    },
    logger
  };
}

/**
 * Which activated collections a set of named requirements refers to.
 *
 * RECONCILED AGAINST THE ACTIVE LIST, WHICH IS WHY IT CAN AFFORD TO BE TOLERANT.
 * The candidate set is closed — only what the team switched on — so a near miss
 * can be reconciled without ever reaching a collection nobody activated. That
 * matters, because the model does miss: measured 2026-09-16 it asked for « Diag
 * - Peaux Sensibles », inventing the prefix off the fourteen collections that
 * carry it, when the shop's is « Soins Peaux Sensibles ». Exact matching
 * reported that as uncurated, and the reply told the customer the shop had no
 * sensitive-skin selection — which was false.
 *
 * THREE PASSES, EACH NARROWER THAN THE LAST, and every one requires a UNIQUE
 * winner:
 *
 *   1. the folded handle or title, exactly;
 *   2. the collection's distinctive words all appear in the requirement
 *      (« soins peaux sensibles » minus its filler is {peaux, sensibles}, which
 *      « diag peaux sensibles » contains);
 *   3. the requirement's words all appear in the title (« peaux sensibles »
 *      inside « soins peaux sensibles »).
 *
 * TWO CANDIDATES MEANS UNKNOWN, never the first of them. « corps » sits in both
 * `Soins Corps` and `Masques et crème Corps` here; picking one would be
 * inventing the half the requirement did not say.
 *
 * A requirement that matches nothing is REPORTED, not dropped silently: it is
 * the signal that the customer asked for something the shop has not curated, and
 * a reply that ignored it would answer a question nobody asked.
 */
export function resolveRequirements(requirements, collections) {
  const matched = [];
  const unknown = [];

  for (const raw of requirements || []) {
    const needle = fold(raw);
    if (!needle) continue;
    const hit = reconcile(needle, collections);
    if (!hit) {
      unknown.push(String(raw).trim());
    } else if (!matched.some((c) => c.handle === hit.handle)) {
      matched.push(hit);
    }
  }
  return { matched, unknown };
}

/** Words that name no collection on their own — see `resolveRequirements`. */
const FILLER = new Set(['soin', 'soins', 'diag', 'de', 'du', 'des', 'la', 'le', 'les', 'et', 'aux', 'pour', 'a']);

function reconcile(needle, collections) {
  const exact = collections.filter((c) => fold(c.handle) === needle || fold(c.title) === needle);
  if (exact.length === 1) return exact[0];

  const words = new Set(needle.split(' ').filter(Boolean));

  // The collection's distinctive words, all present in what was asked for.
  const byTitleWords = collections.filter((c) => {
    const distinctive = fold(c.title).split(' ').filter((w) => w && !FILLER.has(w));
    return distinctive.length > 0 && distinctive.every((w) => words.has(w));
  });
  if (byTitleWords.length === 1) return byTitleWords[0];

  // The other direction: everything asked for appears in the title.
  const asked = [...words].filter((w) => !FILLER.has(w));
  if (asked.length === 0) return null;
  const byNeedleWords = collections.filter((c) => {
    const title = new Set(fold(c.title).split(' '));
    return asked.every((w) => title.has(w));
  });
  return byNeedleWords.length === 1 ? byNeedleWords[0] : null;
}

/**
 * The products that satisfy every named collection, relaxing one at a time.
 *
 * THE DROP IS REPORTED, ALWAYS. Without that, a product matching one of three
 * requirements reads in a reply exactly like a product matching all three, and
 * the reply claims something nobody checked.
 *
 * THE TYPE OF CARE IS NEVER GIVEN UP while a concern is still standing, and this
 * is a rule rather than a preference. It is the thing the customer actually
 * asked for: « une crème pour les mains » answered with a serum is not a
 * narrower answer, it is the wrong product. A concern is a reason to prefer one
 * hand cream over another, so dropping it still answers the question asked.
 *
 * Only concerns are therefore candidates while any category remains. Ordering
 * within them: each is tried and the first whose removal leaves something
 * standing is the one dropped, so a requirement is never given up while it was
 * not the thing in the way; ties go to the broadest, the collection holding the
 * most products, because it is the one committing to least.
 */
export function chooseProducts(collections, { limit = 3 } = {}) {
  if (collections.length === 0) {
    return { products: [], matchedOn: [], dropped: [], relaxed: false };
  }

  let kept = [...collections];
  const dropped = [];

  for (;;) {
    const ids = intersect(kept.map((c) => c.productIds));
    if (ids.length > 0) {
      return {
        products: ids.slice(0, limit),
        matchedOn: kept.map((c) => c.handle),
        dropped: dropped.map((c) => c.handle),
        relaxed: dropped.length > 0
      };
    }
    if (kept.length <= 1) {
      return {
        products: [],
        matchedOn: [],
        dropped: dropped.map((c) => c.handle),
        relaxed: dropped.length > 0
      };
    }

    // THE DROP THAT ACTUALLY UNBLOCKS, not simply the next one in order. Dropping
    // blindly loses requirements it never needed to: « un sérum pour mes rides et
    // mes taches » has no product in all three, but removing `taches` leaves two
    // anti-wrinkle serums while removing `rides` leaves nothing and forces a
    // second drop — answering with plain serums, both concerns gone. So each
    // candidate is tried, in relaxation order, and the first that leaves
    // something standing is the one that goes.
    // ONLY CONCERNS ARE DROPPABLE while a category is standing. Without this the
    // search would happily give up « Crèmes Mains » to satisfy two concerns that
    // overlap somewhere else in the catalogue, and answer a hand-cream question
    // with a face serum that happens to suit sensitive mature skin.
    const order = relaxationOrder(kept);
    const candidates = order.some((c) => c.axis === 'category')
      ? order.filter((c) => c.axis !== 'category')
      : order;
    if (candidates.length === 0) {
      // Every remaining requirement is a category and they do not overlap —
      // « un sérum ET une crème » is two answers, not one product, and this
      // module has no way to say so. Report the failure rather than pick.
      return {
        products: [],
        matchedOn: [],
        dropped: dropped.map((c) => c.handle),
        relaxed: dropped.length > 0
      };
    }
    const unblocks = candidates.find((candidate) => {
      const rest = kept.filter((c) => c !== candidate);
      return intersect(rest.map((c) => c.productIds)).length > 0;
    });
    const next = unblocks ?? candidates[0];
    kept = kept.filter((c) => c !== next);
    dropped.push(next);
  }
}

/** Concerns first, broadest within each axis — see `chooseProducts`. */
function relaxationOrder(collections) {
  return [...collections].sort((a, b) => {
    const axis = rank(a.axis) - rank(b.axis);
    if (axis !== 0) return axis;
    return b.productIds.length - a.productIds.length;
  });
}

/** A concern is dropped before a category — see `chooseProducts`. */
function rank(axis) {
  return axis === 'category' ? 1 : 0;
}

function intersect(lists) {
  if (lists.length === 0) return [];
  return lists.reduce((kept, list) => {
    const set = new Set(list);
    return kept.filter((id) => set.has(id));
  });
}

/** Case- and accent-insensitive, like every other product search in this codebase. */
function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
