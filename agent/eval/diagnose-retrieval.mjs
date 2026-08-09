import { createSupabaseClient, supabaseRpc } from '../../scripts/lib/supabase-rest-client.mjs';
import { createEmbeddingsClient } from '../../scripts/lib/embeddings/openai-embeddings-client.mjs';
import { toVectorLiteral } from '../../scripts/lib/embeddings/embed-chunks.mjs';

import { loadAgentConfig } from '../src/config.mjs';
import { resolveShopId } from '../src/lib/shop.mjs';
import { buildRetrievalQuery, categoriesToSearch, fuseByRank } from '../src/retrieval/retrieval-rules.mjs';
import { documentOf } from './score-retrieval.mjs';
import { CASES } from './retrieval-cases.mjs';

// Are the bands the problem, or is the LIBRARY the problem?
//
// Those look identical from the eval summary — both show correct answers landing
// in `weak`. They need completely different responses, and picking a threshold
// while the answer is "write the article" would bake a number in that goes wrong
// the moment the content arrives.
//
// So this reports DISTRIBUTIONS rather than a recommended threshold:
//
//   - what relevant chunks score, versus irrelevant ones
//   - how much the two overlap (if they overlap completely, no threshold exists)
//   - whether retriever AGREEMENT predicts relevance
//
// That last one matters because agreement is a RELATIVE signal. An absolute
// cosine threshold is a property of the corpus and moves as the library grows;
// "both retrievers independently ranked this near the top" does not.
//
//   npm run eval:diagnose

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const embeddingsClient = createEmbeddingsClient({
    apiKey: config.openaiApiKey,
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions
  });

  const relevant = [];
  const irrelevant = [];
  const agreementRelevant = [];
  const agreementIrrelevant = [];

  for (const testCase of CASES) {
    const query = buildRetrievalQuery({ subject: testCase.subject, body: testCase.body });
    const [vector] = await embeddingsClient.embed([query]);
    const categories = categoriesToSearch(testCase.category);

    const [dense, lexical] = await Promise.all([
      supabaseRpc(supabase, 'match_knowledge_chunks', {
        query_embedding: toVectorLiteral(vector),
        match_shop_id: shopId,
        match_categories: categories,
        match_count: 20,
        min_similarity: 0
      }),
      supabaseRpc(supabase, 'search_knowledge_chunks_text', {
        query_text: query,
        match_shop_id: shopId,
        match_categories: categories,
        match_count: 20
      })
    ]);

    const shape = (row, similarity) => ({
      chunkId: row.chunk_id,
      title: row.document_title,
      similarity
    });

    const fused = fuseByRank([
      dense.map((r) => shape(r, r.similarity)),
      lexical.map((r) => shape(r, null))
    ]);

    // Only the top few matter: those are what a model would ever see.
    for (const c of fused.slice(0, 5)) {
      const isRelevant = expectedDocs(testCase).includes(String(documentOf(c)).toLowerCase());
      if (Number.isFinite(c.similarity)) (isRelevant ? relevant : irrelevant).push(c.similarity);
      (isRelevant ? agreementRelevant : agreementIrrelevant).push(c.foundBy);
    }
  }

  console.log('\n=== cosine similarity of what came back ===');
  report('RELEVANT   ', relevant);
  report('IRRELEVANT ', irrelevant);

  const overlap = overlapRange(relevant, irrelevant);
  console.log(
    overlap
      ? `\n  OVERLAP ${overlap[0].toFixed(3)}-${overlap[1].toFixed(3)} — every chunk in that range is` +
        ' indistinguishable by score alone.'
      : '\n  No overlap: a clean threshold exists between them.'
  );

  console.log('\n=== does retriever AGREEMENT predict relevance? ===');
  const bothRel = agreementRelevant.filter((n) => n > 1).length;
  const bothIrr = agreementIrrelevant.filter((n) => n > 1).length;
  console.log(`  relevant chunks found by both retrievers:    ${bothRel}/${agreementRelevant.length}`);
  console.log(`  irrelevant chunks found by both retrievers:  ${bothIrr}/${agreementIrrelevant.length}`);
  console.log(
    '  -> agreement is ' +
      (rate(bothRel, agreementRelevant.length) > rate(bothIrr, agreementIrrelevant.length) + 0.15
        ? 'a USEFUL signal, and unlike a threshold it does not move as the library grows.'
        : 'NOT discriminating here — do not build on it yet.')
  );
}

function expectedDocs(testCase) {
  return [...(testCase.expectDocuments || []), ...(testCase.accept || [])].map((d) => d.toLowerCase());
}

function rate(n, of) {
  return of === 0 ? 0 : n / of;
}

function report(label, values) {
  if (values.length === 0) {
    console.log(`  ${label} (none)`);
    return;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  console.log(
    `  ${label} n=${String(values.length).padStart(3)}  ` +
      `min ${sorted[0].toFixed(3)}  p25 ${at(0.25).toFixed(3)}  median ${at(0.5).toFixed(3)}  ` +
      `p75 ${at(0.75).toFixed(3)}  max ${sorted[sorted.length - 1].toFixed(3)}`
  );
}

/** The range where the two populations cannot be told apart by score. */
function overlapRange(a, b) {
  if (!a.length || !b.length) return null;
  const low = Math.max(Math.min(...a), Math.min(...b));
  const high = Math.min(Math.max(...a), Math.max(...b));
  return low <= high ? [low, high] : null;
}
