// The closed vocabulary between what a customer writes and what the catalogue
// is tagged with.
//
// WHY IT HAS TO EXIST BEFORE ANY RULE. « Si le client a la peau sensible,
// proposer X » is only a rule if "sensitive" is a value something resolves to.
// Without a closed list the left-hand side is a phrase the model interprets
// afresh every time, which is the non-determinism the whole policy layer exists
// to remove — and the answer to "which products do we suggest for sensitive
// skin" becomes whatever was picked that day rather than something readable.
//
// TWO SIDES, AND THEY ARE NOT THE SAME LANGUAGE. `tags` is what the catalogue
// says; `cues` is what customers say. « peaux sensibles » is a tag nobody writes
// in an email, and « ma peau tiraille » is an email nobody tags a product with.
// The concern key is the join, and it is the only thing a rule ever names.
//
// NOT A NORMALISER FOR MESSY TAGS, which is what this looked like it should be.
// Measured on this catalogue: the variant spellings are near-total overlaps
// (`peaux sèche` 56 products, all 56 also carrying `peaux sèches`), so matching
// the plural alone misses nothing. The duplicates are noise in the tag list, not
// gaps in coverage, and collapsing them buys nothing worth a mechanism.

/**
 * The concerns a rule may branch on.
 *
 * SIX, AND THEY ARE THE ONES THE CATALOGUE CAN ANSWER. A concern with no tags
 * behind it is a rule that can never return a product, so the list is bounded by
 * what the merchandising actually distinguishes rather than by what a customer
 * might mention — "j'ai des taches" is a real concern and is deliberately absent
 * until products are tagged for it.
 *
 * `cues` are matched against the customer's own words, accent-folded and
 * lowercased. They are deliberately CONSERVATIVE: a cue that also appears in an
 * adverse-reaction report would pull a cosmetovigilance ticket into product
 * advice, so « rougeurs », « brûlure » and « démangeaisons » are absent from
 * `sensitive` even though a dermatologist would list them. The subject split
 * happens upstream; this must not fight it.
 */
export const CONCERNS = {
  sensitive: {
    label: 'peau sensible ou réactive',
    tags: ['peaux sensibles'],
    cues: ['peau sensible', 'peaux sensibles', 'sensible', 'reactive', 'reactif', 'qui reagit', 'intolerante']
  },
  dry: {
    label: 'peau sèche ou déshydratée',
    tags: ['peaux sèches', 'peaux sèche'],
    // « tiraille » on its own, not « qui tiraille »: the commonest way this is
    // written is « ma peau tiraille », where the pronoun never appears.
    cues: ['peau seche', 'peaux seches', 'seche', 'deshydratee', 'deshydrate', 'tiraille', 'tiraillement']
  },
  oily: {
    label: 'peau grasse',
    tags: ['peaux grasses'],
    cues: ['peau grasse', 'peaux grasses', 'grasse', 'brillance', 'luisante', 'pores dilates', 'seborrhee']
  },
  combination: {
    label: 'peau mixte',
    tags: ['peaux mixtes', 'peaux mixte'],
    cues: ['peau mixte', 'peaux mixtes', 'mixte', 'zone t']
  },
  mature: {
    label: 'peau mature',
    tags: ['peaux matures', 'peau mature'],
    cues: ['peau mature', 'peaux matures', 'mature', 'rides', 'ridules', 'fermete', 'relachement', 'anti-age', 'anti age']
  },
  all_types: {
    // NOT A CUSTOMER CONCERN, and it is here for the catalogue side only: a
    // product tagged « tous les types de peaux » should be returnable for any
    // concern rather than for none. Nothing resolves TO it from a message.
    label: 'convient à tous les types de peaux',
    tags: ['tous les types de peaux'],
    cues: []
  }
};

export const CONCERN_KEYS = Object.keys(CONCERNS);

/** The concerns a customer can actually be read as having. */
export const READABLE_CONCERNS = CONCERN_KEYS.filter((key) => CONCERNS[key].cues.length > 0);

/** « déshydratée » and « deshydratee » are the same word to a reader. */
function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Which concerns this message mentions, in vocabulary order.
 *
 * A LIST, BECAUSE SKIN IS. « J'ai la peau mixte et très sensible » is two
 * concerns and answering only the first is answering half the question — the
 * catalogue is tagged the same way, with products carrying several.
 *
 * WORD-BOUNDED, so « mixte » does not match inside another word and, more to the
 * point, so a cue never fires on a fragment. Substring matching put `sensitive`
 * on « insensible » in testing, which is the opposite meaning.
 */
export function concernsInText(text) {
  const haystack = fold(text);
  if (!haystack.trim()) {
    return [];
  }
  return CONCERN_KEYS.filter((key) =>
    CONCERNS[key].cues.some((cue) => {
      const folded = fold(cue);
      // Escape nothing: every cue is plain letters, spaces and hyphens.
      return new RegExp(`(^|[^a-z0-9])${folded.replace(/[-]/g, '[- ]')}($|[^a-z0-9])`).test(haystack);
    })
  );
}

/**
 * Every catalogue tag that means this concern, lowercased for comparison.
 *
 * `all_types` RIDES ALONG WITH EVERY CONCERN, which is the one piece of
 * inference here and it is the merchandiser's own: a product labelled as
 * suiting all skin types suits a sensitive one. Excluding it would refuse 26
 * products to every question.
 */
export function tagsForConcern(key) {
  if (!CONCERNS[key]) {
    return [];
  }
  const tags = key === 'all_types' ? CONCERNS.all_types.tags : [...CONCERNS[key].tags, ...CONCERNS.all_types.tags];
  return tags.map((tag) => fold(tag));
}

/** Does this product's tag list place it under the concern? */
export function productMatchesConcern(tags, key) {
  const wanted = new Set(tagsForConcern(key));
  return (Array.isArray(tags) ? tags : []).some((tag) => wanted.has(fold(tag)));
}

/**
 * Tags that look like skin-type tags and belong to no concern.
 *
 * THE RECONCILE, AND IT RUNS ON WHAT THE PRODUCT SYNC ALREADY WROTE. Tags
 * arrive on every product with every sync, so there is nothing extra to fetch
 * and no second list to keep in step — a separate "all tags" table would be a
 * copy of `products.tags` free to go stale on its own.
 *
 * SCOPED TO THE FAMILY, not to every tag in the shop. This catalogue carries
 * hundreds of marketing tags — `Relaxant`, `éclat`, `routine` — and reporting
 * all of them as unclassified would be a list nobody reads. What is worth
 * seeing is a tag that looks like it belongs to this vocabulary and is not in
 * it: « peaux déshydratées » appearing next season is a concern the agent would
 * silently fail to match, and this is what makes it visible instead.
 */
export function unclassifiedSkinTags(allTags = []) {
  const known = new Set(CONCERN_KEYS.flatMap((key) => CONCERNS[key].tags.map(fold)));
  const seen = new Set();
  for (const tag of allTags) {
    const folded = fold(tag);
    // The family: anything that talks about skin. Narrow enough to be readable,
    // wide enough that a new skin-type tag cannot hide from it.
    if (!/\bpeaux?\b/.test(folded)) continue;
    if (known.has(folded)) continue;
    seen.add(String(tag));
  }
  return [...seen].sort();
}
