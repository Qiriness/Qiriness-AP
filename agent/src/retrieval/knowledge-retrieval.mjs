import { supabaseRpc } from '../../../scripts/lib/supabase-rest-client.mjs';
import { toVectorLiteral } from '../../../scripts/lib/embeddings/embed-chunks.mjs';

import {
  buildRetrievalQuery,
  categoriesToSearch,
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

    const rows = await supabaseRpc(supabase, 'match_knowledge_chunks', {
      query_embedding: toVectorLiteral(vector),
      match_shop_id: shopId,
      match_categories: categories,
      // Over-fetch a little: the bands below decide what is worth showing, and
      // asking for exactly `limit` would let one weak chunk crowd out a better
      // one that sorted just behind it.
      match_count: Math.max(limit * 2, 5),
      min_similarity: minSimilarity
    });

    const result = summariseMatches(
      rows.map((row) => ({
        chunkId: row.chunk_id,
        documentId: row.document_id,
        title: row.document_title,
        heading: row.section_heading,
        category: row.category,
        text: row.chunk_text,
        similarity: row.similarity
      })),
      { limit }
    );

    logger?.info?.('knowledge.retrieve', {
      category: ticket.category,
      searched: categories,
      candidates: rows.length,
      verdict: result.verdict,
      best: result.bestSimilarity === null ? null : Number(result.bestSimilarity.toFixed(3))
    });

    return result;
  };
}
