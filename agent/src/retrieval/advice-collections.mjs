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
// yeux). « un sérum pour mes rides » is one of each. The categories decide WHICH
// GROUPS of products the answer has — one per type of care asked for — and the
// concerns decide which products lead inside each group (`rankGroup`).
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
 * One group per type of care asked for, merging the model's names into the cues.
 *
 * A GROUP IS ONE THING THE CUSTOMER ASKED FOR, and it may span several
 * collections: « hydratant » is Crèmes Hydratantes, Soins Hydratants and
 * Masques hydratants on this shop, and all three are a fair answer to it. The
 * cue groups come first, in the order the customer's words were read; a
 * category the model named that no cue group already holds becomes a group of
 * its own.
 *
 * With no type of care at all, the concerns themselves are the pool — « quoi
 * pour mes rides ? » is answered from the rides collection, ranked the same way.
 *
 * @param cueGroups  `[{ label, collections }]` from `careGroupsInText`
 * @param named      collections the model named, already resolved
 * @param concerns   every concern in play, when the caller has merged the
 *                   model's with the ones read from the text; the model's alone
 *                   otherwise
 * @returns `{ groups: [{ label, collections }], concerns }`
 */
export function careGroups(cueGroups = [], named = [], concerns = null) {
  const groups = cueGroups.map((group) => ({ label: group.label, collections: [...group.collections] }));
  const held = new Set(groups.flatMap((group) => group.collections.map((c) => c.handle)));
  for (const collection of named) {
    if (collection.axis !== 'category' || held.has(collection.handle)) continue;
    groups.push({ label: collection.title, collections: [collection] });
    held.add(collection.handle);
  }
  const inPlay = concerns ?? named.filter((collection) => collection.axis !== 'category');
  if (groups.length === 0 && inPlay.length > 0) {
    groups.push({ label: null, collections: inPlay });
  }
  return { groups, concerns: inPlay };
}

/**
 * Every product in a group, best answer first.
 *
 * OVERLAP, NOT INTERSECTION. The first build intersected the type of care with
 * every concern and gave a requirement up when nothing sat in all of them. That
 * forced a winner where none was needed: « nettoyant, hydratant, protection …
 * peau très réactive » kept the cleansers, dropped sensitive skin, and never
 * looked at the Sensi Zen cream sitting in the moisturisers. A concern is now a
 * reason to put a product FIRST, never a reason to lose the group.
 *
 * Ranked by how many concerns a product meets, then by how narrow those
 * concerns are (a product in a 3-product selection says more than one in a
 * 50-product one), then by collection order. `exclude` holds what an earlier
 * group already put forward, so one product never answers two questions.
 *
 * @returns `[{ id, meets: [concern handle] }]`
 */
export function rankGroup(collections, concerns = [], { exclude = new Set() } = {}) {
  const seen = new Set();
  const pool = [];
  for (const collection of collections) {
    for (const id of collection.productIds) {
      if (seen.has(id) || exclude.has(id)) continue;
      seen.add(id);
      pool.push(id);
    }
  }
  const scored = pool.map((id, position) => {
    const met = concerns.filter((concern) => concern.productIds.includes(id));
    const narrowness = met.reduce((sum, concern) => sum + 1 / Math.max(concern.productIds.length, 1), 0);
    return { id, meets: met.map((concern) => concern.handle), narrowness, position };
  });
  scored.sort(
    (a, b) => b.meets.length - a.meets.length || b.narrowness - a.narrowness || a.position - b.position
  );
  return scored.map(({ id, meets }) => ({ id, meets }));
}

/**
 * The products a group puts forward: the best tier only, ticked first.
 *
 * THE BEST TIER ONLY. When two moisturisers are in the sensitive-skin selection,
 * a third that is not has no business beside them in a reply to somebody with
 * allergies — it would be the one they bought. Only when nothing meets a concern
 * does the group fall back to plain members of the type of care, and the caller
 * then says so.
 *
 * `ranked` must already be the LIVE products, in `rankGroup` order. A tick
 * reorders within the tier and never lifts a product into it.
 */
export function bestTier(ranked, { limit = 3, isPreferred = () => false } = {}) {
  if (ranked.length === 0) return [];
  const top = ranked[0].meets.length;
  const tier = ranked.filter((entry) => entry.meets.length === top);
  const preferred = tier.filter((entry) => isPreferred(entry));
  const rest = tier.filter((entry) => !preferred.includes(entry));
  return [...preferred, ...rest].slice(0, limit);
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
