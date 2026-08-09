import { createSupabaseClient, supabaseSelectAll } from '../../scripts/lib/supabase-rest-client.mjs';
import { createEmbeddingsClient } from '../../scripts/lib/embeddings/openai-embeddings-client.mjs';

import { loadAgentConfig } from '../src/config.mjs';
import { resolveShopId } from '../src/lib/shop.mjs';
import { createKnowledgeRetrieval } from '../src/retrieval/knowledge-retrieval.mjs';
import { shopifyOrderCandidates } from '../src/resolution/order-number-parser.mjs';
import { buildProductIndex, matchProduct } from '../src/retrieval/product-matching.mjs';

import { CASES } from './retrieval-cases.mjs';
import { pct, scoreCase, scoreEntities, summarise, summariseEntities } from './score-retrieval.mjs';

// Runs the REAL retrieval stack over the labelled set and scores it.
//
//   npm run eval:retrieval              # the whole set
//   npm run eval:retrieval -- --show    # plus what came back per case
//
// Read-only: one embedding call and one indexed RPC per case, plus the existing
// entity extractors. Writes nothing.
//
// WHAT THE NUMBERS ARE FOR. Every retrieval change — hybrid search, query
// rewriting, reranking — moves the score distribution, which silently
// invalidates the ANSWERABLE/WEAK thresholds those changes are judged against.
// This is the instrument that makes such a change falsifiable rather than a
// matter of opinion.

const show = process.argv.includes('--show');

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  if (!config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required: retrieval needs to embed each query.');
  }

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const embeddingsClient = createEmbeddingsClient({
    apiKey: config.openaiApiKey,
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions
  });
  const retrieve = createKnowledgeRetrieval({ supabase, embeddingsClient });

  // The catalogue the product matcher scores against, loaded once.
  const products = await supabaseSelectAll(
    supabase,
    'products',
    { shop_id: shopId, deleted_at: { operator: 'is', value: null } },
    'id,title,status'
  );
  const productIndex = buildProductIndex(products.filter((p) => p.status === 'active'));

  // Context for reading the result: an empty library cannot answer anything, and
  // that is a content gap rather than a retrieval failure.
  const [{ approved, total } = {}] = [await libraryState(supabase, shopId)];
  console.log(
    `\nlibrary: ${approved} approved of ${total} documents` +
      (approved === 0 ? '  <-- nothing is embedded, so every answerable case WILL miss' : '')
  );

  const scores = [];
  const entityScores = [];

  for (const testCase of CASES) {
    const result = await retrieve(
      { subject: testCase.subject, body: testCase.body, category: testCase.category },
      { shopId }
    );

    const score = scoreCase(testCase, result);
    scores.push(score);
    entityScores.push(scoreEntities(testCase.entities || {}, extractEntities(testCase, productIndex)));

    const mark = score.correct ? 'ok  ' : 'MISS';
    console.log(
      `  ${mark} ${testCase.id.padEnd(28)} verdict=${String(score.verdict).padEnd(11)}` +
        `returned=${score.returned}` +
        (score.bandCorrect === false ? '  band!' : '')
    );
    if (show && result.chunks.length) {
      for (const c of result.chunks) {
        console.log(`         ${c.similarity.toFixed(3)}  ${c.title} / ${c.heading || '-'}`);
      }
    }
  }

  const s = summarise(scores);
  console.log('\n  --- retrieval ---');
  console.log(`  cases            ${s.cases}`);
  console.log(`  recall@3         ${pct(s.recall)}    did the right document come back at all`);
  console.log(`  precision@3      ${pct(s.precision)}    of what was shown, how much was right`);
  console.log(`  MRR              ${pct(s.mrr)}    how far down the first correct one was`);
  console.log(`  restraint        ${pct(s.restraint)}    correctly returned NOTHING (${s.restraintCases} cases)`);
  console.log(`  band accuracy    ${pct(s.bandAccuracy)}    answerable/weak/none agreed with a human`);

  console.log('\n  --- entity extraction ---');
  const totals = summariseEntities(entityScores);
  if (Object.keys(totals).length === 0) {
    console.log('  (no entities labelled)');
  }
  for (const [type, t] of Object.entries(totals)) {
    console.log(
      `  ${type.padEnd(14)} P ${pct(t.precision)}  R ${pct(t.recall)}  F1 ${pct(t.f1)}` +
        `   (+${t.truePositives} / invented ${t.falsePositives} / missed ${t.falseNegatives})`
    );
  }
  console.log('');
}

/**
 * The entities the CURRENT extractors find. Deliberately the real ones rather
 * than a bespoke parser: the point is to measure what the pipeline actually
 * does today, so a later rewriter can be compared against it.
 */
function extractEntities(testCase, productIndex) {
  const text = `${testCase.subject}\n${testCase.body}`;
  const found = {};

  if (testCase.entities?.orderNumbers) {
    found.orderNumbers = shopifyOrderCandidates(text).map((c) => String(c.orderNumber ?? c));
  }
  if (testCase.entities?.products) {
    const match = matchProduct(text, productIndex);
    found.products = (match?.candidates || []).map((c) => c.title);
  }
  if (testCase.entities?.codes) {
    // The promotion tool's extractor needs the live code list, which the eval
    // does not load; the pattern below is the same first-pass filter it uses.
    found.codes = [...new Set(text.toUpperCase().match(/\b[A-Z][A-Z0-9]{3,}\b/g) || [])];
  }
  return found;
}

async function libraryState(supabase, shopId) {
  const docs = await supabaseSelectAll(
    supabase,
    'knowledge_documents',
    { shop_id: shopId, deleted_at: { operator: 'is', value: null } },
    'id,approval_status'
  );
  return {
    total: docs.length,
    approved: docs.filter((d) => d.approval_status === 'approved').length
  };
}
