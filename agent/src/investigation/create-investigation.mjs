import { createEmbeddingsClient } from '../../../scripts/lib/embeddings/openai-embeddings-client.mjs';
import { supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';
import { toParameterMap } from '../../../scripts/lib/parameters.mjs';
import { createOpenAIClient } from '../llm/openai-client.mjs';
import { createCustomerLookup } from '../retrieval/customer-lookup.mjs';
import { createExemplarRetrieval } from '../retrieval/exemplar-retrieval.mjs';
import { createKnowledgeRetrieval } from '../retrieval/knowledge-retrieval.mjs';
import { createProductLookup } from '../retrieval/product-lookup.mjs';
import { createPurchaseLookup } from '../retrieval/purchase-lookup.mjs';
import { buildOrderContext } from '../resolution/order-context.mjs';
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
  usageSink,
  // PRE-BUILT CLIENTS, for a caller that needs to see the calls.
  //
  // The stack builds both itself by default and every existing caller lets it.
  // The test chat passes a decorated OpenAI client instead — same interface,
  // recording each call's system prompt, messages and response on the way
  // through — because a rehearsal that could not show what was sent to the model
  // would be showing the least interesting half of the run.
  //
  // Injected here rather than wrapped inside, so the worker's own path has no
  // branch in it at all.
  openai: injectedOpenAI = null,
  embeddingsClient: injectedEmbeddings = null,
  // Passed straight through to the investigator. See `investigate.mjs`.
  onToolCall = null
} = {}) {
  if (!config?.openaiApiKey) {
    return null;
  }

  const openai =
    injectedOpenAI || createOpenAIClient({ apiKey: config.openaiApiKey, usageSink });
  const embeddingsClient =
    injectedEmbeddings ||
    createEmbeddingsClient({
      apiKey: config.openaiApiKey,
      model: config.embeddingModel,
      dimensions: config.embeddingDimensions,
      usageSink
    });

  // Constructed once and shared: the purchase check borrows the product tool's
  // catalogue index, so building a second product lookup here would load and
  // tokenise all 116 titles a second time to answer the same question.
  const productLookup = createProductLookup({ supabase, shopId, logger });
  const purchaseLookup = createPurchaseLookup({ supabase, shopId, productLookup, logger });

  const registry = createToolRegistry({
    customerLookup: customerLookup || createCustomerLookup({ supabase, shopId, logger }),
    productLookup,
    purchaseLookup,
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
    logger,
    onToolCall
  });

  // NOT in the registry, and that is the design. The registry holds tools the
  // MODEL may call; this one is never offered to it. It runs beside the
  // investigation so its answer stays independent of the run it is measuring.
  const retrieveExemplar = createExemplarRetrieval({ supabase, embeddingsClient, logger });

  /**
   * The customer's most recent order, as a bundle for a HUMAN to check first.
   *
   * ONE FETCH, OWNED BY THE MODULE THAT ALREADY HAD IT. `purchaseLookup` has
   * read this exact row since Phase 4 to cross-check the product a customer
   * describes; this borrows that read rather than adding a second — the same
   * argument as the shared catalogue index above, which was already written on
   * this page when a duplicate got added four lines below it.
   *
   * OUTSIDE THE TOOL REGISTRY, and that is the other half. It used to be a
   * branch of `getOrderContext`, so it only ran when the model chose to call
   * that tool — and `product` has no order tool in `allowedTools` at all, which
   * is the subject where a reviewer most wants recent orders. Putting an order
   * tool in front of the model there would have fixed the availability and
   * invited the failure: a model shown an order tool starts asking customers
   * for order numbers.
   *
   * So the model cannot call this, is never told it ran, and never sees it.
   */
  const lastOrderLookup = async (customerId) => {
    const found = await purchaseLookup.lastOrder(customerId);
    return found ? buildOrderContext(found.order, found.customer) : null;
  };

  /**
   * The policy rules for an answer set.
   *
   * APPROVAL IS THE GATE, since the route went live. It was deliberately not one
   * during the shadow phase — filtering on `approved` while every rule was a
   * draft would have loaded nothing and measured nothing — and it became one the
   * moment a rule could move a ticket: an unapproved rule must never route
   * somebody's mail, for the same reason an unapproved knowledge article holds no
   * vector.
   *
   * Soft-deleted rows are excluded at the query, like everywhere else.
   */
  const loadAnswers = async ({ shopId: shop, answerSet }) =>
    supabaseSelect(
      supabase,
      T.SUPPORT_ANSWERS,
      {
        shop_id: shop,
        answer_set: answerSet,
        approval_status: 'approved',
        deleted_at: { operator: 'is', value: 'null' }
      },
      'answer_key,situation_key,when_conditions,answer_skeleton,route,ask,priority,is_fallback,approval_status'
    );

  /**
   * The numbers the desk runs on, as a map the readers in `parameters.mjs` take.
   *
   * NO APPROVAL GATE, unlike the rules: a parameter is a fact about the business
   * rather than a behaviour, so there is no state in which the number is decided
   * and should not yet be used. An unset one simply reads as null.
   *
   * A FAILURE HERE IS NOT AN INVESTIGATION'S PROBLEM. Without parameters the
   * states that depend on one resolve `unknown` and their tickets route to a
   * person — which is exactly what an undecided window should do — so a load
   * error degrades to the pre-parameter behaviour rather than failing a poll.
   */
  const loadParameters = async (shop) => {
    try {
      const rows = await supabaseSelect(
        supabase,
        T.SUPPORT_PARAMETERS,
        { shop_id: shop },
        'parameter_key,value'
      );
      return toParameterMap(rows);
    } catch (error) {
      logger?.warn?.('investigation.parameters_load_failed', { reason: error.message });
      return new Map();
    }
  };

  return {
    investigate,
    store: createCaseFileStore(supabase),
    registry,
    retrieveExemplar,
    lastOrderLookup,
    loadAnswers,
    loadParameters
  };
}
