// Which exemplars to search, and what counts as a match.
//
// Pure: no database, no OpenAI, no clock. Same split as retrieval-rules.mjs —
// the vector maths lives in Postgres, the embedding call lives in the service,
// and everything judgemental is here so it can be argued with and tested.

/**
 * Which subjects to search for a ticket of this subject.
 *
 * THE TICKET'S OWN SUBJECT, AND ONLY THAT — which is the opposite of the
 * knowledge policy, and the difference is worth stating.
 *
 * `categoriesToSearch()` adds `faq` and `brand_story` to every search because an
 * article written under one subject routinely answers a question filed under
 * another: the password-reset FAQ answers an `account` ticket. That is a
 * property of reference material.
 *
 * An exemplar is not reference material, it is a SITUATION, and situations do
 * not generalise across subjects — « où est ma commande » is never the answer to
 * a promotions question. Widening the filter here would only add near-misses
 * from unrelated subjects, and at this corpus size a near-miss is likelier to
 * out-rank the right answer than it is in a library of hundreds.
 *
 * An uncategorised ticket searches everything rather than nothing: no filter is
 * a weaker claim than a wrong one.
 */
export function subjectsToSearch(subject) {
  const category = String(subject || '').trim();
  return category ? [category] : null;
}

/**
 * Similarity bands.
 *
 * PROVISIONAL, AND SEPARATELY CALIBRATED FROM KNOWLEDGE ON PURPOSE. The
 * knowledge numbers (0.60 answerable, 0.50 weak) were re-derived on 2026-08-09
 * against a 61-chunk library of PROSE, scored against whole customer emails.
 * This corpus is different on both sides of the comparison: the rows are
 * questions rather than paragraphs, and the variants are real phrasings, so
 * matched pairs should score HIGHER while the floor stays wherever French
 * support boilerplate puts it.
 *
 * Reusing the knowledge numbers would therefore be a guess wearing the clothes
 * of a measurement. These are placed here, named, and deliberately conservative
 * until the sweep has been run against a labelled set — raising or lowering them
 * is then a one-line change rather than a hunt through the code.
 *
 * CALIBRATED 2026-08-11 by `npm run eval:exemplars` — 32 exemplars, 79 phrasings,
 * scored against the first inbound message of 190 real customer tickets. There is
 * no labelled set, so the relevance signal is a PROXY: whether the winning
 * exemplar's subject agrees with the subject the categoriser independently
 * assigned. Two situations under `promotions` can still be the wrong one of the
 * two, so read these as shape rather than as truth.
 *
 *   best-match distribution   min 0.334  p25 0.558  median 0.636  max 0.872
 *   AGREES     n=117  p25 0.629  median 0.692
 *   DISAGREES  n= 73  p75 0.621  median 0.558
 *
 *   threshold   kept   restraint   recall
 *      0.50      165      68%        96%
 *      0.60      123      80%        84%
 *      0.65       86      88%        65%   <- MATCHED
 *      0.70       55      95%        44%
 *
 * 0.65 IS THE KNEE: restraint climbs 80% -> 88% for the recall it costs, and
 * 0.70 buys the next 7 points at nearly half the remaining recall. The direction
 * follows the same rule the knowledge bands do — a wrong match costs more than
 * no match, because no match is simply today's behaviour, while a wrong one
 * sends the investigation to collect evidence for the wrong situation.
 *
 * Expect to REVISIT DOWNWARD. Recall is held back by two fixable things rather
 * than by the threshold: six exemplars never win a ticket at all, two of them
 * (D-07, P-18) because they have no real phrasing, and the source document
 * already flags O-09/O-10 and P-15/P-16 as merge candidates.
 */
export const MATCHED = 0.65;
export const NEAR = 0.55;

export function classifyExemplarMatch(similarity) {
  if (!Number.isFinite(similarity) || similarity < NEAR) {
    return 'none';
  }
  return similarity >= MATCHED ? 'matched' : 'near';
}

/**
 * Turns raw exemplar rows into a result the caller can act on.
 *
 * ONE EXEMPLAR OR NONE — never a ranked shortlist for something else to choose
 * from. An exemplar decides which evidence gets collected and, later, which
 * answer is selected; "probably this one, or possibly that one" is not a state
 * either of those can act on, and resolving it downstream would put the choice
 * somewhere with less information rather than more.
 *
 * The runner-up is still reported, because the GAP between first and second is
 * the honest confidence signal here. Two situations scoring 0.63 and 0.62 is a
 * corpus problem — two exemplars that should probably be merged — and it should
 * be visible as a number rather than silently resolved by sort order.
 */
export function summariseExemplarMatches(matches, { minMargin = 0 } = {}) {
  const ranked = [...(matches || [])]
    .filter((m) => Number.isFinite(m?.similarity))
    .sort((a, b) => b.similarity - a.similarity);

  const best = ranked[0] || null;
  const runnerUp = ranked[1] || null;
  const margin = best && runnerUp ? best.similarity - runnerUp.similarity : null;
  const verdict = classifyExemplarMatch(best?.similarity);

  // A tie is not a match. Below the margin the two candidates are
  // indistinguishable given how coarse these scores are, and picking the
  // higher one would be reading precision the number does not have.
  const ambiguous = verdict === 'matched' && margin !== null && margin < minMargin;

  return {
    matched: verdict === 'matched' && !ambiguous,
    verdict: ambiguous ? 'ambiguous' : verdict,
    exemplar: verdict === 'matched' && !ambiguous ? best : null,
    bestSimilarity: best ? best.similarity : null,
    margin,
    // WHO IS ACTUALLY TIED, which is not always just the runner-up: three
    // situations at 0.654 / 0.650 / 0.645 put the third inside the margin of
    // the first while `margin` only ever describes the first two. A caller that
    // reads the pair would think it had seen the whole tie.
    //
    // Reported rather than resolved, because this module cannot resolve it: it
    // knows how close the scores are and nothing about what the situations are
    // FOR. Whether a tie matters is a question about the rules that read it,
    // which live a layer up — so the tie is handed over intact and this stays
    // the same consequence-blind measurement it has always been.
    tied: ambiguous ? ranked.filter((m) => best.similarity - m.similarity < minMargin) : [],
    // Kept whatever the verdict: a near miss is the signal that a situation is
    // missing from the corpus, which is the report worth having while it fills.
    candidates: ranked.slice(0, 3)
  };
}

/**
 * The text to embed for a ticket.
 *
 * Subject plus body, matching how ticket messages were embedded in the first
 * place — the stored message vector is reusable as a query only if a freshly
 * composed one would have been identical.
 */
export function buildExemplarQuery({ subject, body } = {}, { maxChars = 2000 } = {}) {
  const parts = [String(subject || '').trim(), String(body || '').trim()].filter(Boolean);
  const text = parts.join('\n\n').replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
