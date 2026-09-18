import { isShopNotificationSubject } from '../../../scripts/lib/embeddings/embedding-input.mjs';

// What to search, what to send to the model, and what counts as an answer.
//
// Pure: no database, no OpenAI, no clock. The vector maths lives in Postgres and
// the embedding call lives in the service; everything judgemental is here, so it
// can be argued with and tested.

/**
 * Which categories are worth searching for a ticket of this subject.
 *
 * The ticket's own subject, plus `faq`. The subject comes first because the
 * taxonomy is deliberately shared between tickets and articles — a `product`
 * ticket filters straight into `product` chunks with no mapping. `faq` is added
 * because it is the one knowledge-only category that answers across subjects: an
 * account-login question is answered by the password-reset FAQ, measured at
 * 0.62, and a strict subject filter would have hidden it.
 *
 * This is also why the SQL takes a list. Today every embedded chunk in the
 * library is `faq`, so filtering to the subject alone would return nothing for
 * the 29 `product` tickets this tool exists to serve. That is a property of an
 * unfinished library, not of the design, and it will stop being true as content
 * is written — which is exactly why the policy is here and not in the migration.
 *
 * `brand_story` IS searched, and the rule that excluded it was wrong twice over.
 *
 * It claimed the embedding pipeline never vectorised those chunks. It does — the
 * gate is `core_topic !== 'brand'`, not `category !== 'brand_story'` — so the
 * exclusion left real vectors permanently unreachable rather than never written.
 *
 * And it conflated two different things. The concern was always the drafting
 * VOICE: the singleton `core_topic = 'brand'` row, which is always-included
 * context for how the agent should sound and is correctly never chunked or
 * embedded. The `brand_story` CATEGORY is ordinary knowledge — "La Marque",
 * "Inspiration Hanbang", "Le Rituel Qi" — and a customer asking what Hanbang is,
 * or what makes the brand different, is asking a question those articles answer.
 * Brand voice now has its own mechanism (voice_profile + the brand workspace),
 * so the category no longer has to stand in for it.
 *
 * Searched for every subject, like `faq`, because a brand question arrives under
 * whatever subject the categoriser gave the surrounding email.
 *
 * `other` JOINED THEM 2026-08-31, AND THE REASON IS WHAT THE CATEGORY MEANS.
 * The taxonomy defines it as « rien de ce qui précède » — so an article filed
 * there is by definition one whose subject the taxonomy could not name, and
 * restricting it to tickets the categoriser also gave up on is the narrowest
 * possible audience for the broadest possible content.
 *
 * FOUND BY A REAL MISS. « Nos Points de Vente » — eight embedded chunks listing
 * the shops that stock the brand — sat in `other` while « où puis-je acheter
 * votre crème à Paris ? » arrived as `product`, so the one article that answered
 * it was the one the filter hid. That article has since been recategorised, and
 * this is the guard against the next one: a mis-filed article should cost
 * relevance, not reachability.
 *
 * IT COSTS NOTHING TODAY. `other` holds one empty draft, so the list is longer
 * and the result set is not — and an unembedded draft is unreachable anyway.
 */
export function categoriesToSearch(subject) {
  const category = String(subject || '').trim();
  const always = ['faq', 'brand_story', 'other'];
  if (!category || always.includes(category)) {
    return always;
  }
  return [category, ...always];
}

/**
 * Similarity bands, three of them rather than a boolean.
 *
 * Calibrated on what the corpus actually produced against the current library: a
 * genuinely correct match scored 0.62, while topics with no article at all still
 * scored 0.38-0.48 — cosine over French support mail sharing heavy boilerplate
 * has a high floor, so "not zero" means nothing. Anything between is reported as
 * `weak`, never presented as an answer.
 *
 * ANSWERING IS THE HIGH BAR ON PURPOSE. A wrong confident answer to a customer
 * costs more than no answer: no answer routes to a human, who was going to
 * handle it anyway. These numbers are provisional until the library is real, and
 * they are here — one place, named — so raising them later is a one-line change
 * rather than a hunt through the code.
 */
// RE-DERIVED 2026-08-09 against the labelled retrieval set (npm run eval:diagnose),
// on a 61-chunk library, replacing numbers calibrated on 11 chunks of a single
// document. Measured distribution of what retrieval actually returned:
//
//              min    p25    median   p75    max
//   RELEVANT   0.298  0.409  0.517    0.601  0.662
//   IRRELEVANT 0.171  0.382  0.424    0.458  0.578
//
// ANSWERABLE 0.60 SURVIVED UNCHANGED and is well placed: no irrelevant chunk in
// the whole run reached it. Anything clearing 0.60 has been correct so far, so
// the bar is precise — just conservative, which is the intended direction.
//
// WEAK MOVED 0.45 -> 0.50, because 0.45 sat below the irrelevant p75: a quarter
// of the noise cleared the floor and reached a model. Swept against the set:
//
//   0.45  recall 100%  restraint 30%  band 44%
//   0.50  recall 100%  restraint 70%  band 69%   <- chosen
//   0.55  recall  83%  restraint 90%  band 81%
//
// 0.55 scores better on restraint but loses a real answer, and the library is
// still general — mostly policies and brand pages, with no delivery or
// promotions article yet. Relevant scores should RISE as specific content is
// written, so 0.55 is worth revisiting then; giving up recall today would be
// paying for a problem that content is about to fix.
//
// SIXTEEN CASES IS A SMALL SET. These are the best numbers the evidence
// supports, not a settled answer — re-run the sweep whenever the library grows.
export const ANSWERABLE = 0.6;
export const WEAK = 0.5;

export function classifyMatch(similarity) {
  if (!Number.isFinite(similarity) || similarity < WEAK) {
    return 'none';
  }
  return similarity >= ANSWERABLE ? 'answerable' : 'weak';
}

/**
 * Turns raw matches into a retrieval result the caller can act on without
 * re-deriving anything.
 *
 * `answerable` is true only if the BEST match clears the bar. Deliberately not
 * "any match clears it": a pile of weak chunks is not evidence, and averaging
 * them would let three vague matches outvote the absence of a real one.
 */
export function summariseMatches(matches, { limit = 3 } = {}) {
  const ranked = [...(matches || [])]
    .filter((m) => Number.isFinite(m?.similarity))
    .sort((a, b) => b.similarity - a.similarity);

  const best = ranked[0] || null;
  const verdict = classifyMatch(best?.similarity);

  return {
    answerable: verdict === 'answerable',
    verdict,
    bestSimilarity: best ? best.similarity : null,
    // Only chunks worth putting in front of a model. A `none`-band chunk is
    // noise, and passing it as context invites the model to answer from it.
    chunks: ranked.filter((m) => classifyMatch(m.similarity) !== 'none').slice(0, limit),
    // THE WHOLE RANKING, for a reader rather than for a model.
    //
    // `chunks` above answers "what may be used". This answers "what was found",
    // and the two are different questions the moment a band refuses something:
    // an article that scored 0.52 is absent from `chunks` in exactly the same
    // way as an article that scored nothing at all, and those two want opposite
    // fixes — one is a wording problem, the other a category or embedding
    // problem. Nothing in the pipeline reads this; the test chat does, and it is
    // the only way `retrieved_withheld` can be told from `not_retrieved`.
    //
    // Capped, because a fusion pool is 20 candidates per retriever and a stored
    // trace does not need the tail.
    candidates: ranked.slice(0, CANDIDATE_REPORT).map((m) => ({
      chunkId: m.chunkId,
      documentId: m.documentId,
      title: m.title,
      heading: m.heading,
      similarity: m.similarity
    }))
  };
}

/** How much of the ranking `summariseMatches` reports. Diagnostic only. */
const CANDIDATE_REPORT = 10;

/**
 * Reciprocal Rank Fusion of the dense and lexical result lists.
 *
 * RANK-BASED, NOT SCORE-BASED, and that is the whole reason to use it. Cosine
 * similarity lands in 0.45-0.60 on this corpus while ts_rank_cd runs from 0.1 to
 * 4.6 — two scales with no common meaning, and normalising them would invent a
 * relationship that does not exist. RRF only asks "how near the top of its own
 * list did each retriever put this?", which is comparable by construction.
 *
 * `k` damps the advantage of rank 1 over rank 2. The conventional 60 is a very
 * flat curve; 20 is used here because the lists are short (a handful of chunks
 * from a library of dozens, not thousands) and being first should count for more
 * than it would over a web-scale index.
 *
 * A chunk found by BOTH retrievers accumulates both contributions, which is the
 * property that matters: agreement between two different notions of relevance is
 * the strongest signal either can give.
 */
export const RRF_K = 20;

export function fuseByRank(lists, { k = RRF_K, limit = 10 } = {}) {
  const byId = new Map();

  for (const list of lists) {
    (list || []).forEach((item, index) => {
      const id = item?.chunkId;
      if (!id) return;
      const existing = byId.get(id);
      const contribution = 1 / (k + index + 1);
      if (existing) {
        existing.fusedScore += contribution;
        existing.foundBy += 1;
        // Keep whichever copy carries a similarity: the bands are still read off
        // the dense score, and the lexical row has none.
        if (existing.similarity === null && Number.isFinite(item.similarity)) {
          existing.similarity = item.similarity;
        }
      } else {
        byId.set(id, {
          ...item,
          similarity: Number.isFinite(item.similarity) ? item.similarity : null,
          fusedScore: contribution,
          foundBy: 1
        });
      }
    });
  }

  return [...byId.values()]
    .sort((a, b) => b.fusedScore - a.fusedScore || (b.similarity ?? 0) - (a.similarity ?? 0))
    .slice(0, limit);
}

/**
 * The text to embed for a ticket.
 *
 * Subject plus the customer's message, matching how ticket messages were
 * embedded in the first place — comparing a differently-composed query against
 * those vectors would be comparing two different things. Truncated because a
 * long quoted thread drowns the actual question, and the quoted-reply stripper
 * has already removed the worst of it upstream.
 */
export function buildRetrievalQuery({ subject, body } = {}, { maxChars = 2000 } = {}) {
  // OUR OWN SUBJECT IS NOT PART OF THE QUESTION. « Nouveau message de client le
  // 12 septembre 2026 à 18:22 » is a timestamp the contact form wrote, and it is
  // a large share of a short query: ticket 809c9ae1 asked whether the aromatic
  // pebbles may go in a steam appliance, the FAQ answering exactly that ranked
  // first, and the pair scored 0.577 against a 0.60 bar — 0.656 without the
  // subject.
  //
  // THE SAME STRIPPER THE MESSAGE EMBEDDINGS ALREADY USE, on the one query side
  // that never had it (see `SHOP_NOTIFICATION_SUBJECTS`). Measured here over the
  // 77 tickets carrying one: 1 crossed into `answerable`, 0 fell out.
  const heading = isShopNotificationSubject(subject) ? '' : String(subject || '').trim();
  const parts = [heading, String(body || '').trim()].filter(Boolean);
  const text = parts.join('\n\n').replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
