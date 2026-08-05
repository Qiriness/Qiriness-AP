import { createEmbeddingsClient } from '../../../scripts/lib/embeddings/openai-embeddings-client.mjs';
import { createOpenAIClient } from '../llm/openai-client.mjs';
import { createCustomerLookup } from '../retrieval/customer-lookup.mjs';
import { createKnowledgeRetrieval } from '../retrieval/knowledge-retrieval.mjs';
import { createProductLookup } from '../retrieval/product-lookup.mjs';
import { createPromotionLookup } from '../retrieval/promotion-lookup.mjs';

import { createInvestigator } from './investigate.mjs';
import { createInvestigationStore } from './investigation-runner.mjs';
import { createToolRegistry } from './tool-registry.mjs';

// Assembles the investigation stack: six retrieval tools, the registry that
// scopes them per ticket, the agent, and its store.
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
  customerLookup = null
} = {}) {
  if (!config?.openaiApiKey) {
    return null;
  }

  const openai = createOpenAIClient({ apiKey: config.openaiApiKey });
  const embeddingsClient = createEmbeddingsClient({
    apiKey: config.openaiApiKey,
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions
  });

  const registry = createToolRegistry({
    customerLookup: customerLookup || createCustomerLookup({ supabase, shopId, logger }),
    productLookup: createProductLookup({ supabase, shopId, logger }),
    promotionLookup: createPromotionLookup({ supabase, shopId, logger }),
    retrieveKnowledge: createKnowledgeRetrieval({ supabase, embeddingsClient, logger }),
    shopId,
    logger
  });

  const { investigate } = createInvestigator(openai, registry, {
    model: config.investigatorModel,
    maxToolCalls: config.investigationMaxToolCalls,
    maxTurns: config.investigationMaxTurns,
    logger
  });

  return { investigate, store: createInvestigationStore(supabase), registry };
}
