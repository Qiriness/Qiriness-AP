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
 * `brand_story` is never searched: it is drafting voice, not an answer to
 * anything, and the embedding pipeline does not vectorise it at all.
 */
export function categoriesToSearch(subject) {
  const category = String(subject || '').trim();
  if (!category || category === 'faq') {
    return ['faq'];
  }
  return [category, 'faq'];
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
export const ANSWERABLE = 0.6;
export const WEAK = 0.45;

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
    chunks: ranked.filter((m) => classifyMatch(m.similarity) !== 'none').slice(0, limit)
  };
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
  const parts = [String(subject || '').trim(), String(body || '').trim()].filter(Boolean);
  const text = parts.join('\n\n').replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
