import { supabaseRpc } from '../../../scripts/lib/supabase-rest-client.mjs';
import { toVectorLiteral } from '../../../scripts/lib/embeddings/embed-chunks.mjs';

import {
  buildRetrievalQuery,
  categoriesToSearch,
  fuseByRank,
  summariseMatches
} from './retrieval-rules.mjs';

// The knowledge-retrieval tool: given a ticket, find the approved knowledge that
// answers it — or report honestly that nothing does.
//
// The second Phase 4 tool, and the one that needs no order data: it serves the
// ~45 tickets whose answer is reference material rather than a lookup (29
// `product` level 1, 9 `account`, 7 `other`).
//
// PROGRESSIVE, per AGENTS.md: one embedding call and one indexed vector query
// returning a handful of rows — never a scan of the library, and never the whole
// document when a chunk will do.
//
// NO CUSTOMER PERSONAL DATA LEAVES THIS MODULE. The text embedded is the subject
// and body the categoriser already reads; the sender's address and name are
// never part of the query.

// Candidates pulled from EACH retriever before fusion. Wide enough that a
// lexical hit is very likely to carry a cosine score too; small enough that the
// round trip stays cheap on a library of dozens.
const FUSION_POOL = 20;

export function createKnowledgeRetrieval({ supabase, embeddingsClient, logger }) {
  /**
   * @param ticket  { subject, body, category }
   * @returns { answerable, verdict, bestSimilarity, chunks[] }
   */
  return async function retrieveKnowledge(ticket, { shopId, limit = 3, minSimilarity = 0.4 } = {}) {
    const query = buildRetrievalQuery(ticket);
    if (!query) {
      return { answerable: false, verdict: 'none', bestSimilarity: null, chunks: [] };
    }

    const [vector] = await embeddingsClient.embed([query]);
    const categories = categoriesToSearch(ticket.category);

    // HYBRID: two retrievers over the same corpus, run in parallel.
    //
    // The dense pool is deliberately much wider than `limit` and its floor is
    // dropped to zero. Fusion needs candidates, not answers — and more
    // practically, a chunk the lexical side finds must also carry a cosine score
    // or it cannot be banded, so the dense list has to be generous enough to
    // cover it. The bands still do the cutting afterwards.
    const [denseRows, lexicalRows] = await Promise.all([
      supabaseRpc(supabase, 'match_knowledge_chunks', {
        query_embedding: toVectorLiteral(vector),
        match_shop_id: shopId,
        match_categories: categories,
        match_count: FUSION_POOL,
        min_similarity: 0
      }),
      supabaseRpc(supabase, 'search_knowledge_chunks_text', {
        query_text: query,
        match_shop_id: shopId,
        match_categories: categories,
        match_count: FUSION_POOL
      })
    ]);

    const shape = (row, similarity) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      title: row.document_title,
      heading: row.section_heading,
      category: row.category,
      text: row.chunk_text,
      similarity
    });

    const fused = fuseByRank([
      denseRows.map((row) => shape(row, row.similarity)),
      // No cosine score of its own — fusion carries one over when the dense side
      // found the same chunk, and leaves it null when it did not.
      lexicalRows.map((row) => shape(row, null))
    ]);

    // The floor is applied here rather than in the dense query, so it still
    // governs what a model may see while fusion gets the candidates it needs.
    const result = summariseMatches(
      fused.filter((c) => c.similarity === null || c.similarity >= minSimilarity),
      { limit }
    );

    logger?.info?.('knowledge.retrieve', {
      category: ticket.category,
      searched: categories,
      dense: denseRows.length,
      lexical: lexicalRows.length,
      // How often the two retrievers agreed — the signal fusion exists to use.
      agreed: fused.filter((c) => c.foundBy > 1).length,
      verdict: result.verdict,
      best: result.bestSimilarity === null ? null : Number(result.bestSimilarity.toFixed(3))
    });

    return result;
  };
}
