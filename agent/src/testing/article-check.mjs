import { ANSWERABLE, WEAK, classifyMatch } from '../retrieval/retrieval-rules.mjs';
import { TOOL_NAMES } from '../investigation/investigation-rules.mjs';

// Did the article the operator approved actually get used?
//
// PURE, and the reason it is worth being pure is that the answer is a
// five-way judgement over three different pieces of evidence — whether the
// knowledge tool ran at all, what the retriever ranked, and what the band let
// through — and each of the four failures points at a DIFFERENT fix. A boolean
// "was it used" would collapse them into one shrug.
//
//   used                 a chunk of it reached the drafting model
//                        → nothing to fix
//   retrieved_withheld    found, and banded weak/none, so it was withheld
//                        → the wording, or the bands in retrieval-rules.mjs
//   outranked             found, but another article took the places available
//                        → a competing article, or this one is too thin
//   not_retrieved         no chunk of it was in the candidate pool at all
//                        → the category, the embedding, or a genuine mismatch
//   not_searched          the knowledge tool never ran for this ticket
//                        → the SUBJECT this message categorised into, which is
//                          not a knowledge problem at all
//
// THE LAST ONE IS THE ONE PEOPLE WILL HIT AND NOT EXPECT. `allowedTools` gives
// searchKnowledge to five subjects; a message that lands on `delivery` or
// `order` has no knowledge tool in its registry, so the best-written article in
// the library cannot be reached from it. Reporting that as "not retrieved" would
// send somebody off to rewrite an article that was never consulted.
//
// IT REPORTS MECHANISM, NOT QUALITY. Whether the article that came back was the
// RIGHT one is the operator's judgement — nothing here can know what they meant.

export const ARTICLE_VERDICTS = Object.freeze([
  'used',
  'retrieved_withheld',
  'outranked',
  'not_retrieved',
  'not_searched'
]);

/**
 * @param documentId      the article being tested
 * @param toolCalls       the run's ledger entries (see trace.toolEntry)
 * @param knowledge       `caseFile.knowledge` — the chunks that reached a model
 * @param allowedTools    the tool names this ticket's registry offered
 * @returns {{ verdict, best, rank, candidates, searched, offered }}
 */
export function checkArticle({
  documentId,
  toolCalls = [],
  knowledge = [],
  allowedTools = []
} = {}) {
  if (!documentId) {
    return null;
  }

  const offered = allowedTools.includes(TOOL_NAMES.SEARCH_KNOWLEDGE);
  const searches = toolCalls.filter((call) => call.tool === TOOL_NAMES.SEARCH_KNOWLEDGE);

  // Every candidate the retriever ranked, across searches, best score per chunk.
  const candidates = rankCandidates(searches);
  const mine = candidates.filter((candidate) => candidate.documentId === documentId);
  const best = mine[0] || null;

  // What actually reached the drafting model, which is the only definition of
  // "used" worth having: a chunk in the case file is a chunk in the prompt.
  const reached = knowledge.some((chunk) => chunk?.documentId === documentId);

  if (reached) {
    return result('used', { best, candidates, mine, searched: searches.length > 0, offered });
  }
  if (searches.length === 0) {
    return result('not_searched', { best, candidates, mine, searched: false, offered });
  }
  if (!best) {
    return result('not_retrieved', { best, candidates, mine, searched: true, offered });
  }
  // It was ranked. Two ways to be ranked and still not used: the band refused
  // it, or the band accepted it and three better chunks took the places.
  const band = classifyMatch(best.similarity);
  return result(band === 'none' || band === 'weak' ? 'retrieved_withheld' : 'outranked', {
    best,
    candidates,
    mine,
    searched: true,
    offered
  });
}

function result(verdict, { best, candidates, mine, searched, offered }) {
  return {
    verdict,
    searched,
    // Whether the ticket's subject even permits the tool — the difference
    // between "the model chose not to look" and "it could not have".
    offered,
    best: best
      ? {
          chunkId: best.chunkId,
          title: best.title ?? null,
          heading: best.heading ?? null,
          similarity: best.similarity,
          band: classifyMatch(best.similarity)
        }
      : null,
    // Where the article's best chunk sat in the ranking, 1-based. Null when it
    // was not ranked at all.
    rank: best ? candidates.findIndex((candidate) => candidate.chunkId === best.chunkId) + 1 : null,
    chunksRanked: mine.length,
    poolSize: candidates.length,
    // The bands in force, so a report reads without opening retrieval-rules.
    bands: { answerable: ANSWERABLE, weak: WEAK }
  };
}

/**
 * The candidate pool, flattened and ranked.
 *
 * A run can search knowledge more than once (a decomposed email with two
 * questions). Chunks are keyed so the same chunk found twice is one candidate
 * carrying its better score, rather than two rows implying two hits.
 */
function rankCandidates(searches) {
  const byChunk = new Map();
  for (const search of searches) {
    for (const candidate of search.detail?.candidates || []) {
      if (!candidate?.chunkId && !candidate?.documentId) continue;
      const key = candidate.chunkId || `${candidate.documentId}:${candidate.title}`;
      const existing = byChunk.get(key);
      if (!existing || score(candidate) > score(existing)) {
        byChunk.set(key, { chunkId: key, ...candidate });
      }
    }
  }
  return [...byChunk.values()].sort((a, b) => score(b) - score(a));
}

function score(candidate) {
  return typeof candidate?.similarity === 'number' ? candidate.similarity : -1;
}

/**
 * What is true about the article BEFORE a run: is it approved, and does it carry
 * embedded chunks in a category retrieval will search?
 *
 * Checked first because it is the cheapest and most common answer. A chunk holds
 * a vector only if its parent document is approved and is not brand voice
 * (03_knowledge.sql), so an unapproved article is unreachable no matter what the
 * operator types — and reporting that costs nothing, where discovering it after
 * a full run costs a model call per pass.
 */
export function articleReadiness({ document, chunks = [] } = {}) {
  if (!document) {
    return { ready: false, reason: 'missing', message: 'That article no longer exists.' };
  }
  if (document.approval_status !== 'approved') {
    return {
      ready: false,
      reason: 'not_approved',
      message:
        'This article is not approved for the agent, so its chunks carry no vector and retrieval cannot reach it.'
    };
  }
  if (document.core_topic === 'brand') {
    return {
      ready: false,
      reason: 'brand_voice',
      message:
        'The brand voice article is never chunked or embedded — it is the drafting system prompt, not retrievable knowledge.'
    };
  }
  const embedded = chunks.filter((chunk) => chunk.embedded).length;
  if (chunks.length === 0) {
    return {
      ready: false,
      reason: 'no_chunks',
      message: 'This article has no chunks yet. Save it once to chunk and embed it.'
    };
  }
  if (embedded === 0) {
    return {
      ready: false,
      reason: 'not_embedded',
      message: `None of its ${chunks.length} chunks carry an embedding yet, so retrieval cannot reach it. Run npm run embed:knowledge.`,
      chunks: chunks.length,
      embedded
    };
  }
  return {
    ready: true,
    reason: null,
    message: null,
    chunks: chunks.length,
    embedded,
    categories: [...new Set(chunks.map((chunk) => chunk.category).filter(Boolean))]
  };
}
