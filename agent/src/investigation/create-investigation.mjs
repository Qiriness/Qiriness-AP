import { createEmbeddingsClient } from '../../../scripts/lib/embeddings/openai-embeddings-client.mjs';
import { createOpenAIClient } from '../llm/openai-client.mjs';
import { createCustomerLookup } from '../retrieval/customer-lookup.mjs';
import { createExemplarRetrieval } from '../retrieval/exemplar-retrieval.mjs';
import { createKnowledgeRetrieval } from '../retrieval/knowledge-retrieval.mjs';
import { createProductLookup } from '../retrieval/product-lookup.mjs';
import { createPurchaseLookup } from '../retrieval/purchase-lookup.mjs';
import { createPromotionLookup } from '../retrieval/promotion-lookup.mjs';

import { createDecomposer } from './decompose.mjs';
import { createInvestigator } from './investigate.mjs';
import { createCaseFileStore } from './investigation-runner.mjs';
import { createToolRegistry } from './tool-registry.mjs';

// Assembles the investigation stack: six retrieval tools, the registry that
// scopes them per ticket, the agent, and its case-file store.
//
// The TICKET record is not built here: it is one per shop, shared by every pass,
// and the caller already holds it.
//
// It exists because the worker and the CLI must build the SAME agent. Wired
// twice by hand, they would drift — a tool present in one and missing in the
// other means a dry run that cannot reproduce what the worker did, which is the
// one thing a dry run is for.
//
// Every client is constructed ONCE per process and shared across tickets. Each
// caches an index (customer email hashes, product titles, the promotions list),
// so building them per ticket would turn a cached map lookup back into a scan.
// `customerLookup` is passed in rather than created here when the caller already
// has one — the customer-resolution pass owns that instance and refreshes its
// index on its own schedule.
export function createInvestigationStack({
  supabase,
  shopId,
  config,
  logger,
  customerLookup = null,
  // Threaded in rather than created here, because it must be the SAME buffer the
  // rest of the poll writes into — the stack builds its own OpenAI and
  // embeddings clients, and a sink of its own would be a second buffer nobody
  // drains. Left undefined, both clients fall back to their own no-op defaults.
  usageSink
} = {}) {
  if (!config?.openaiApiKey) {
    return null;
  }

  const openai = createOpenAIClient({ apiKey: config.openaiApiKey, usageSink });
  const embeddingsClient = createEmbeddingsClient({
    apiKey: config.openaiApiKey,
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions,
    usageSink
  });

  // Constructed once and shared: the purchase check borrows the product tool's
  // catalogue index, so building a second product lookup here would load and
  // tokenise all 116 titles a second time to answer the same question.
  const productLookup = createProductLookup({ supabase, shopId, logger });

  const registry = createToolRegistry({
    customerLookup: customerLookup || createCustomerLookup({ supabase, shopId, logger }),
    productLookup,
    purchaseLookup: createPurchaseLookup({ supabase, shopId, productLookup, logger }),
    promotionLookup: createPromotionLookup({ supabase, shopId, logger }),
    retrieveKnowledge: createKnowledgeRetrieval({ supabase, embeddingsClient, logger }),
    shopId,
    logger
  });

  const { investigate } = createInvestigator(openai, registry, {
    model: config.investigatorModel,
    maxToolCalls: config.investigationMaxToolCalls,
    maxTurns: config.investigationMaxTurns,
    // Absent when the model is unset: the investigation then treats every ticket
    // as a single request, exactly as it did before decomposition existed.
    decomposer: config.decomposerModel
      ? createDecomposer(openai, { model: config.decomposerModel })
      : null,
    logger
  });

  // NOT in the registry, and that is the design. The registry holds tools the
  // MODEL may call; this one is never offered to it. It runs beside the
  // investigation so its answer stays independent of the run it is measuring.
  const retrieveExemplar = createExemplarRetrieval({ supabase, embeddingsClient, logger });

  return {
    investigate,
    store: createCaseFileStore(supabase),
    registry,
    retrieveExemplar
  };
}
