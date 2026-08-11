import { supabaseRpc } from '../../../scripts/lib/supabase-rest-client.mjs';
import { toVectorLiteral } from '../../../scripts/lib/embeddings/embed-chunks.mjs';
import { normaliseNeeds } from '../investigation/evidence-rules.mjs';

import {
  buildExemplarQuery,
  subjectsToSearch,
  summariseExemplarMatches
} from './exemplar-rules.mjs';

// Which recurring situation is this ticket? — the retrieval half of the exemplar
// layer.
//
// PROGRESSIVE, per AGENTS.md: at most one embedding call and one indexed vector
// query returning a handful of rows. Never a scan of the corpus.
//
// THE EMBEDDING CALL IS USUALLY FREE, and that is the point of accepting a
// pre-computed vector. Ingestion already embeds every stored message with the
// same model and dimensions, so a ticket normally arrives carrying the exact
// vector this would otherwise pay to compute. `embed()` is the fallback for the
// case that write did not happen — it is best-effort at ingestion, so the vector
// can legitimately be missing.
//
// NO CUSTOMER PERSONAL DATA LEAVES THIS MODULE. The text embedded is the subject
// and body the categoriser already reads; the sender's address and name are
// never part of the query.

/**
 * How much better the winner must be than the runner-up.
 *
 * Not a similarity threshold — a SEPARATION one. Two situations scoring 0.63 and
 * 0.62 are indistinguishable at the precision these numbers actually carry, and
 * committing to the higher would be inventing confidence.
 *
 * MEASURED, AND MUCH SMALLER THAN IT LOOKS IT SHOULD BE. Over 190 real tickets
 * the median margin is 0.037, so the 0.03 this started at would have called 45%
 * of all matches ambiguous — rejecting good matches wholesale. The sweep:
 *
 *   below 0.01   19% ambiguous      below 0.03   45% ambiguous
 *   below 0.02   39% ambiguous      below 0.05   58% ambiguous
 *
 * 0.01 catches genuine coin-flips and little else. The remaining 19% is a CORPUS
 * problem rather than a threshold one — 32 situations in one narrow domain sit
 * close together, and the source document already names O-09/O-10 and P-15/P-16
 * as merge candidates. Merging those should raise the margins rather than
 * needing this number moved again.
 *
 * Measured on an UNFILTERED search, which is pessimistic: production filters by
 * subject first, so the real candidate pool is a handful of same-subject
 * exemplars rather than all 32.
 */
const DEFAULT_MIN_MARGIN = 0.01;

/** Candidates pulled before banding. Small: the corpus is dozens, not thousands. */
const CANDIDATE_POOL = 5;

export function createExemplarRetrieval({ supabase, embeddingsClient, logger }) {
  /**
   * @param ticket  { subject, body, category, embedding? }
   * @returns { matched, verdict, exemplar, bestSimilarity, margin, candidates[] }
   */
  return async function retrieveExemplar(ticket, { shopId, minMargin = DEFAULT_MIN_MARGIN } = {}) {
    const vector = await resolveVector(ticket, embeddingsClient);
    if (!vector) {
      return empty();
    }

    const subjects = subjectsToSearch(ticket.category);

    const rows = await supabaseRpc(supabase, 'match_support_exemplars', {
      query_embedding: toVectorLiteral(vector),
      match_shop_id: shopId,
      match_categories: subjects,
      match_count: CANDIDATE_POOL,
      // Banding happens in `exemplar-rules.mjs`, so the query floor stays at
      // zero: a near miss is the signal that a situation is missing from the
      // corpus, and filtering it out in SQL would throw away that report.
      min_similarity: 0
    });

    const result = summariseExemplarMatches(rows.map(shape), { minMargin });

    logger?.info?.('exemplar.retrieve', {
      category: ticket.category,
      searched: subjects,
      candidates: rows.length,
      verdict: result.verdict,
      exemplar: result.exemplar?.exemplarKey ?? null,
      best: round(result.bestSimilarity),
      margin: round(result.margin),
      // Reused the stored message vector, or paid for one.
      embedded: !ticket.embedding
    });

    return result;
  };
}

/**
 * The stored message vector if there is one, otherwise a fresh embedding.
 *
 * A stored vector is used ONLY because it was composed the same way this query
 * would be — subject then body, same model, same dimensions. If those ever
 * diverge, this shortcut silently compares two different things, which is why
 * `buildExemplarQuery` and `buildMessageEmbeddingInput` have to stay in step.
 */
async function resolveVector(ticket, embeddingsClient) {
  if (ticket.embedding) {
    return ticket.embedding;
  }
  const query = buildExemplarQuery(ticket);
  if (!query) {
    return null;
  }
  const [vector] = await embeddingsClient.embed([query]);
  return vector ?? null;
}

/**
 * The row as the rest of the agent reads it.
 *
 * `requirementNeeds` is passed through `normaliseNeeds` rather than trusted:
 * the column has a check constraint, but a need retired from the vocabulary
 * would still sit in old rows, and a requirement nothing can score is worse
 * than one that was never declared.
 */
function shape(row) {
  return {
    exemplarId: row.exemplar_id,
    exemplarKey: row.exemplar_key,
    question: row.canonical_question,
    category: row.category,
    requestKind: row.request_kind,
    requirementNeeds: normaliseNeeds(row.requirement_needs),
    matchedPhrasing: row.matched_phrasing,
    matchedPhrasingKind: row.matched_phrasing_kind,
    similarity: row.similarity
  };
}

function empty() {
  return {
    matched: false,
    verdict: 'none',
    exemplar: null,
    bestSimilarity: null,
    margin: null,
    candidates: []
  };
}

function round(value) {
  return value === null || value === undefined ? null : Number(value.toFixed(3));
}
