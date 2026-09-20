import { containsPhrase, fold, titleHasToken } from './cue-matching.mjs';

// What is wrong with the skin, read out of the customer's own words and matched
// against the concern collections the team activated.
//
// WHY THIS EXISTS, MEASURED TWICE ON ONE TICKET (05c1b539, 2026-09-19/20). The
// model names the requirements, and across two runs of the same email it named
// one axis and dropped the other, both ways round: first « Soins Peaux
// Sensibles » and no type of care, then three types of care and no concern. The
// second run recommended a retinol cream to a customer who had written « peau
// très réactive et sujette aux allergies », and the case file called the whole
// list « adapté aux peaux très réactives » — a claim no tool had made.
//
// So the concern gets the same backstop the type of care already had. The model
// still names what it reads (« ma peau tiraille » is in no word list); this
// covers the half that is written literally, and the two are merged.
//
// THIS REVERSES A RECORDED DECISION — DECISIONS § « A concern IS a collection:
// the skin-cue path is gone » removed an earlier cue path on the grounds that
// the model naming collections covers strictly more. It covers more only when it
// names them, and measured, it does not reliably do both at once.
//
// A CUE RESOLVES TO A TOKEN, NEVER TO A HANDLE, exactly as in `care-cues`:
// activating a collection is what makes a word reachable, not an edit here.

/**
 * Customer words for a concern, and the title token each looks for.
 *
 * `label` is what the reply's product tag prints when the entry covers several
 * collections, because « [Diag - Rides et ridules / Diag - Rides légères / Diag
 * - Rides visibles] » on a product line is noise.
 *
 * REDNESS AND ALLERGY ARE IN, and `product-concerns.mjs` deliberately leaves
 * them out of its own list — the two lists answer different questions. That one
 * feeds tag reading on any subject; this one is only ever consulted by
 * `recommendProducts`, which `cosmetovigilance` cannot call at all
 * (`investigation-rules.mjs` TOOLS_BY_SUBJECT), so a reaction report cannot
 * reach it. Measured on the corpus before adding them: « rougeur » and
 * « couperose » appear in 0 tickets, « allergie » in 1 — and that one is a
 * `product` advice ticket describing a skin type.
 */
export const CONCERN_CUES = [
  {
    key: 'sensitive',
    label: 'peaux sensibles',
    tokens: ['sensible'],
    cues: [
      'peau sensible',
      'peaux sensibles',
      'sensible',
      'reactive',
      'reactif',
      'qui reagit',
      'intolerante',
      'allergique',
      'allergie',
      'allergies'
    ]
  },
  {
    key: 'redness',
    label: 'rougeurs',
    tokens: ['rougeur'],
    cues: ['rougeurs', 'rougeur', 'couperose', 'peau qui rougit']
  },
  {
    key: 'ageing',
    label: 'rides et anti-âge',
    tokens: ['ride', 'ridule', 'anti age'],
    cues: [
      'rides',
      'ridules',
      'peau mature',
      'peaux matures',
      'mature',
      'fermete',
      'relachement',
      'anti age',
      'vieillissement'
    ]
  },
  {
    key: 'spots',
    label: 'taches',
    tokens: ['tache'],
    cues: ['taches brunes', 'taches', 'tache', 'pigmentation', 'hyperpigmentation', 'melasma']
  },
  {
    key: 'blemishes',
    label: 'imperfections',
    tokens: ['imperfection'],
    cues: ['imperfections', 'imperfection', 'acne', 'points noirs', 'comedons']
  },
  {
    key: 'eye_bags',
    label: 'cernes et poches',
    tokens: ['cerne', 'poche'],
    cues: ['cernes', 'cerne', 'poches sous les yeux', 'poches', 'yeux gonfles']
  },
  {
    key: 'tired',
    label: 'teint fatigué',
    tokens: ['fatigue'],
    cues: ['teint fatigue', 'peau fatiguee', 'teint terne', 'mine terne', 'terne', 'fatigue']
  }
];

/**
 * The concerns the customer's own words describe, one entry each.
 *
 * ONE ENTRY IS ONE CONCERN even when it covers five collections. « rides » is
 * Rides légères, Rides visibles, Rides et ridules, Crèmes Anti-Âge & Anti-Rides
 * and Diag - Anti-âge here; counting those as five would make a product in three
 * of them outrank a product meeting BOTH sensitive skin and wrinkles, which is
 * the ranking upside down. Meeting any collection of the entry counts once.
 *
 * @param text         the customer's message, quoted history already removed
 * @param collections  the activated collections
 * @returns concern-shaped `[{ handle, title, productIds, collections }]`, ready
 *          for `rankGroup`
 */
export function concernsFromText(text, collections = []) {
  const haystack = fold(text);
  if (!haystack) {
    return [];
  }
  const concerns = collections.filter((collection) => collection.axis !== 'category');
  const found = [];

  for (const { key, label, tokens, cues } of CONCERN_CUES) {
    if (!cues.some((cue) => containsPhrase(haystack, fold(cue)))) {
      continue;
    }
    const hits = concerns.filter((collection) =>
      tokens.some((token) => titleHasToken(collection.title, token))
    );
    if (hits.length === 0) {
      continue;
    }
    found.push({
      handle: key,
      // One collection speaks for itself; several need the entry's own words.
      title: hits.length === 1 ? hits[0].title : label,
      productIds: [...new Set(hits.flatMap((collection) => collection.productIds))],
      collections: hits.map((collection) => collection.handle)
    });
  }
  return found;
}
