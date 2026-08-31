// Resolves which product a question was about from the ARTICLE that answered it.
//
// THE MATCHER READS TITLES, AND THE WORDS PEOPLE USE ABOUT A DEVICE ARE NOT IN
// ONE. « la batterie de mon masque ne tient pas la charge », « la télécommande
// ne fonctionne plus », « il ne s'allume plus » — measured against the live
// catalogue, every one of those identifies nothing, because « batterie »,
// « télécommande » and « s'allume » appear in no product title. Reading product
// DESCRIPTIONS instead makes it worse rather than better: « batterie » is in two
// products and NEITHER is the LED mask, and « recharge » is in seven, where on a
// cosmetic it means a refill.
//
// So the identity comes from the other direction. Retrieval finds the article
// easily — those same words are what make it distinctive, appearing in almost no
// other chunk — and an operator has said which products that article is about.
// The article carries the identity the question could not.
//
// The mapping is DATA, authored in the knowledge editor. Nothing here names a
// product, so a future device works the day someone tags its article.
//
// Pure: no database, no model, no clock.

import { classifyMatch } from './retrieval-rules.mjs';

/**
 * @param match   a `matchProduct` result, or null if the matcher never ran
 * @param chunks  retrieved chunks: { documentId, productIds, similarity }
 * @returns null, or { productIds, documentIds, ambiguous }
 */
export function productFromKnowledge(match, chunks) {
  // FILLS A GAP, NEVER OVERRIDES ONE. A customer who named a product has told
  // us directly; an article tag is an inference about what they meant. When the
  // matcher resolved anything at all — one product, a range, or an honest
  // ambiguity — that answer stands and this contributes nothing.
  if (match && (match.match || match.range || match.ambiguous)) {
    return null;
  }

  // ONLY TOP-BAND CHUNKS MAY ASSERT A PRODUCT. `searchKnowledge` already drops
  // every chunk when the BEST match is weak, but a result led by an answerable
  // chunk still carries weak ones behind it, and those are exactly the chunks
  // that are related-looking rather than right. Letting one name a product would
  // turn a retrieval the bands already refused to answer from into a hard fact —
  // the confidently-wrong-product failure, arrived at by a longer route.
  const tagged = (chunks || []).filter(
    (chunk) => classifyMatch(chunk?.similarity) === 'answerable' && chunk?.productIds?.length > 0
  );
  if (tagged.length === 0) {
    return null;
  }

  // A DOCUMENT'S TAGS ARE ONE INTENT; TWO DOCUMENTS' ARE NOT.
  //
  // Several products on ONE article is deliberate — it is how a range is
  // expressed, since ranges are computed from title bigrams and have no id to
  // store. Two DIFFERENT articles pointing at different products is the same
  // situation as two titles scoring alike: an ambiguity to report, not a pick
  // to make.
  const byDocument = new Map();
  for (const chunk of tagged) {
    byDocument.set(chunk.documentId, [...new Set(chunk.productIds)].sort().join(','));
  }

  return {
    productIds: [...new Set(tagged.flatMap((chunk) => chunk.productIds))].sort(),
    documentIds: [...byDocument.keys()],
    ambiguous: new Set(byDocument.values()).size > 1
  };
}
