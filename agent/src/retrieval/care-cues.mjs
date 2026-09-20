import { containsPhrase, fold, phraseAt, titleHasToken } from './cue-matching.mjs';

// The type of care a customer names, read out of their own words.
//
// WHY THIS EXISTS, MEASURED. On « je voudrais un sérum ... j'ai la peau sensible
// et des rides » the model called the tool with two concerns and NO type of
// care, and the reply offered a sunscreen, a cream and a mist. The type of care
// is the one requirement the customer has already decided — it is what they came
// for — and leaving it to the model to remember is leaving the load-bearing part
// to judgement. Reading it from the text makes it a fact.
//
// IT DOES NOT REPLACE WHAT THE MODEL NAMES, it is unioned with it. Concerns
// genuinely need reading — « ma peau tiraille », « je brille en fin de journée »
// — and no cue list covers that. This covers the half that is nearly always
// written literally: a customer asking for a serum says the word « sérum ».
//
// A CUE RESOLVES TO A TOKEN, NOT TO A COLLECTION. The cues are French skincare
// words and belong here; which collections exist is the shop's, and changes
// whenever somebody curates. So a cue names a token, the token is looked up in
// the ACTIVE category titles, and a cue whose token matches nothing simply finds
// nothing — activating « Soins solaires et teintés » is what makes « spf »
// reachable, not an edit to this file.
//
// A CUE MAY LAND ON SEVERAL COLLECTIONS, and then it is one GROUP of all of
// them. « hydratant » is Crèmes Hydratantes, Soins Hydratants and Masques
// hydratants on this shop, and every one is a fair answer to it. The first build
// dropped any word matching more than one — so « nettoyant, hydratant,
// protection » read as a request for a cleanser alone (2026-09-19, owner's
// correction). Picking one of three would still be inventing; offering from all
// three is not, because the group is answered as a whole (`rankGroup`).
//
// SEVERAL CUES ARE SEVERAL GROUPS. A customer listing three types of care asked
// three questions, and each gets its own products.

/**
 * Customer words for a type of care, and the title token each looks for.
 *
 * ORDERED LONGEST-PHRASE-FIRST within a family, because « crème pour les mains »
 * must be read as hand cream rather than as the bare « crème » that resolves to
 * nothing. The scan takes the first cue that fires per entry.
 *
 * THE TOKEN IS A WORD OF THE SHOP'S OWN TITLE, and an entry whose token matches
 * no active title is dead however many cues it carries. `gommage` was exactly
 * that until 2026-09-20: the shop's collection is « Exfoliants & Lotions », so a
 * customer asking for a gommage reached nothing at all. A cue is worth adding
 * only when some activated title carries its token.
 */
export const CARE_CUES = [
  { token: 'contour', cues: ['contour des yeux', 'contour yeux', 'contour de l oeil', 'contour'] },
  // « Un soin pour les yeux » is both eye collections — it does not say contour.
  // NOT the bare « pour les yeux », which is a qualifier on another type of care:
  // « un patch pour les yeux » asks for patches, and reading it as eye care too
  // would answer a question the customer did not ask.
  { token: 'yeux', cues: ['soin pour les yeux', 'soins pour les yeux', 'soin des yeux', 'soins des yeux', 'mes yeux', 'zone des yeux'] },
  { token: 'main', cues: ['creme pour les mains', 'creme mains', 'creme main', 'pour les mains', 'mains seches', 'mes mains', 'mains'] },
  // Bare « protection » is sun care in a routine: « nettoyant, hydratant,
  // protection » is the three-step list every skincare counter writes. Only
  // read on advice tickets, where the other senses (a parcel) do not arise.
  { token: 'solaire', cues: ['spf', 'ecran solaire', 'protection solaire', 'creme solaire', 'solaire', 'protection'] },
  // DRY SKIN IS ANSWERED WITH A MOISTURISER, so « ma peau tiraille » is read as
  // a type of care rather than as a concern (owner's call, 2026-09-20). No
  // concern collection describes dryness on this shop, and the answer to it is
  // this group — a concern cue would have found nothing and lost the question.
  { token: 'hydrat', cues: ['hydratante', 'hydratant', 'hydratation', 'hydrater', 'peau seche', 'peaux seches', 'peau tres seche', 'deshydratee', 'deshydrate', 'secheresse', 'tiraille', 'tiraillement', 'peau qui tire'] },
  { token: 'serum', cues: ['serum'] },
  { token: 'patch', cues: ['patch'] },
  { token: 'masque', cues: ['masque'] },
  // « Exfoliants & Lotions » is what this shop called it; `gommage` reached no
  // title and the whole entry was dead.
  { token: 'exfoliant', cues: ['gommage', 'gommer', 'exfoliant', 'exfolier', 'exfoliation', 'peeling'] },
  { token: 'lotion', cues: ['lotion tonique', 'lotion', 'tonique'] },
  { token: 'nettoyant', cues: ['eau micellaire', 'micellaire', 'nettoyant', 'nettoyer ma peau', 'nettoyer mon visage', 'nettoyage'] },
  { token: 'demaquillant', cues: ['demaquillant', 'demaquiller', 'demaquillage', 'me demaquiller'] },
  { token: 'jour', cues: ['creme de jour', 'soin de jour'] },
  { token: 'nuit', cues: ['creme de nuit', 'soin de nuit'] },
  { token: 'levre', cues: ['levres', 'levre', 'baume a levres'] },
  { token: 'corps', cues: ['pour le corps', 'soin du corps', 'lait corps', 'sur le corps', 'corps'] }
];

/**
 * The types of care the customer's own words ask for, one group each.
 *
 * Two cues landing on the same collections are one group — « nettoyant » and
 * « démaquillant » both mean `Nettoyants & démaquillants` here, and answering it
 * twice would put the same products forward twice.
 *
 * @param text         the customer's message, quoted history already removed
 * @param collections  the activated collections
 * @returns `[{ label, collections }]` — `label` is the word the customer used —
 *          in the order the customer wrote them, because a routine is written
 *          in the order it is applied
 */
export function careGroupsInText(text, collections = []) {
  const haystack = fold(text);
  if (!haystack) {
    return [];
  }
  const categories = collections.filter((collection) => collection.axis === 'category');
  const groups = [];

  for (const { token, cues } of CARE_CUES) {
    const cue = cues.find((candidate) => containsPhrase(haystack, fold(candidate)));
    if (!cue) {
      continue;
    }
    const hits = categories.filter((collection) => titleHasToken(collection.title, token));
    if (hits.length === 0) {
      continue;
    }
    const key = hits.map((c) => c.handle).sort().join('|');
    if (groups.some((group) => group.key === key)) {
      continue;
    }
    groups.push({ key, label: cue, collections: hits, at: phraseAt(haystack, fold(cue)) });
  }
  return groups
    .sort((a, b) => a.at - b.at)
    .map(({ label, collections: hits }) => ({ label, collections: hits }));
}
