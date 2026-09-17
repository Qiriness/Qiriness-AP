import { createEmbeddingsClient } from '../../../scripts/lib/embeddings/openai-embeddings-client.mjs';
import { createShopifyClient } from '../../../scripts/lib/shopify-admin-client.mjs';
import { supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { T } from '../../../scripts/lib/tables.mjs';
import { toParameterMap } from '../../../scripts/lib/parameters.mjs';
import { createOpenAIClient } from '../llm/openai-client.mjs';
import { createAbandonedCheckoutLookup } from '../retrieval/abandoned-checkout.mjs';
import { createAdviceCollections } from '../retrieval/advice-collections.mjs';
import { createCustomerLookup } from '../retrieval/customer-lookup.mjs';
import { createExemplarRetrieval } from '../retrieval/exemplar-retrieval.mjs';
import { createKnowledgeRetrieval } from '../retrieval/knowledge-retrieval.mjs';
import { createProductLookup } from '../retrieval/product-lookup.mjs';
import { createPurchaseLookup } from '../retrieval/purchase-lookup.mjs';
import { buildOrderContext } from '../resolution/order-context.mjs';
import { createPromotionLookup } from '../retrieval/promotion-lookup.mjs';
import { createSituationChooser, createVariantLoader } from '../retrieval/situation-chooser.mjs';

import { answerFromRow } from './answer-selection.mjs';
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
    checkoutLookup: buildCheckoutLookup(config, logger),
    adviceCollections: createAdviceCollections({ supabase, shopId, logger }),
    shopId,
    logger
  });

  /**
   * The rules for ONE request an email carries, with the situation its own
   * wording matches.
   *
   * BUILT HERE because it needs three things the investigation must not hold: the
   * shop id, the answers loader, and the retrieval client. The investigator gets a
   * callback and stays ignorant of all three, the same way it takes a `decomposer`
   * rather than an OpenAI client.
   *
   * MATCHED ON THE REQUEST, NOT THE EMAIL. `question` is the decomposer's
   * one-sentence restatement of this half, which is the text the semantic matchers
   * already get for split tickets. Falling back to the whole email is right when
   * the second subject came from the CATEGORISER rather than the decomposer: there
   * is no sub-question to match on, and the whole text is what produced the label.
   *
   * NO EMBEDDING IS PASSED, so retrieval embeds on demand. Only the ticket-level
   * match can reuse the vector ingestion wrote; a sub-question has none.
   */
  const policyForRequest = async ({ answerSet, category, question, ticket }) => {
    const rows = await supabaseSelect(
      supabase,
      T.SUPPORT_ANSWERS,
      {
        shop_id: shopId,
        answer_set: answerSet,
        approval_status: 'approved',
        deleted_at: { operator: 'is', value: 'null' }
      },
      'answer_key,situation_key,when_conditions,answer_skeleton,route,ask,offer_code,knowledge_document_id,tones,link_url,link_label,priority,is_fallback'
    );
    const answers = (rows || []).map(answerFromRow);
    if (answers.length === 0) return null;

    let situationKey = null;
    try {
      const match = await retrieveExemplar(
        {
          subject: ticket.subject,
          body: question || ticket.text,
          category
        },
        { shopId }
      );
      situationKey = match?.exemplar?.exemplarKey ?? null;
    } catch (error) {
      // A request keeps its rules without a situation: the situation-less ones
      // still apply, and losing the match is better than losing the request.
      logger?.warn?.('investigation.request_situation_failed', {
        answerSet,
        reason: error.message
      });
    }

    // COLLECTION MODE IS NOT READ HERE, deliberately. Rule-directed collection is
    // opted in per situation for the TICKET, and a second request must not be able
    // to switch it on for the whole run.
    return { answerSet, situationKey, answers };
  };

  const { investigate } = createInvestigator(openai, registry, {
    model: config.investigatorModel,
    maxToolCalls: config.investigationMaxToolCalls,
    maxTurns: config.investigationMaxTurns,
    // Absent when the model is unset: the investigation then treats every ticket
    // as a single request, exactly as it did before decomposition existed.
    decomposer: config.decomposerModel
      ? createDecomposer(openai, { model: config.decomposerModel })
      : null,
    policyForRequest,
    plannerEnabled: config.plannerEnabled !== false,
    logger,
    onToolCall
  });

  // NOT in the registry, and that is the design. The registry holds tools the
  // MODEL may call; this one is never offered to it. It runs beside the
  // investigation so its answer stays independent of the run it is measuring.
  const retrieveExemplar = createExemplarRetrieval({ supabase, embeddingsClient, logger });

  /**
   * Settles a near miss or a tie by reading the message beside the candidates.
   *
   * NULL WHEN THE MODEL IS UNSET — the documented off switch — and the runner
   * then keeps no situation for a near miss, exactly as before this existed.
   * Its phrasings come from the table rather than the matcher's result, which
   * carries only the one phrasing that scored best.
   */
  const chooseSituation = config.situationChooserModel
    ? createSituationChooser(openai, {
        model: config.situationChooserModel,
        logger,
        loadVariants: createVariantLoader({
          selectExemplars: () =>
            supabaseSelect(
              supabase,
              T.SUPPORT_EXEMPLARS,
              { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } },
              'id,exemplar_key,canonical_question'
            ),
          // Authored phrasings only: translations sit at 100 and above.
          selectPhrasings: () =>
            supabaseSelect(
              supabase,
              T.SUPPORT_EXEMPLAR_PHRASINGS,
              { phrasing_index: { operator: 'lt', value: 100 } },
              'support_exemplar_id,phrasing_index,phrasing_kind,phrasing_text'
            )
        })
      })
    : null;

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
      'answer_key,situation_key,when_conditions,answer_skeleton,route,ask,offer_code,knowledge_document_id,tones,link_url,link_label,priority,is_fallback,approval_status'
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

  /**
   * Whether this situation lets the rules direct collection.
   *
   * A SEPARATE READ RATHER THAN A WIDER RPC. The exemplar match comes back from
   * `match_support_exemplars`, and adding a column there would mean changing a
   * SQL function to carry a flag that only matters after the match is already
   * decided. One narrow select, only on a ticket that matched a situation.
   *
   * NEVER FAILS AN INVESTIGATION. A loader that throws leaves the ticket in
   * `model` mode, which is the behaviour it would have had anyway — the same
   * contract `loadAnswers` and `lastOrderLookup` already keep.
   */
  const loadCollectionMode = async ({ shopId: shop, exemplarKey }) => {
    const rows = await supabaseSelect(
      supabase,
      T.SUPPORT_EXEMPLARS,
      { shop_id: shop, exemplar_key: exemplarKey, deleted_at: { operator: 'is', value: 'null' } },
      'collection_mode,collection_suppresses'
    );
    return {
      collectionMode: rows?.[0]?.collection_mode ?? 'model',
      suppresses: rows?.[0]?.collection_suppresses === true
    };
  };

  return {
    investigate,
    store: createCaseFileStore(supabase),
    registry,
    retrieveExemplar,
    chooseSituation,
    lastOrderLookup,
    loadAnswers,
    loadCollectionMode,
    loadParameters
  };
}

/**
 * The abandoned-checkout lookup, or null.
 *
 * THE ONLY TOOL IN THE STACK THAT LEAVES OUR OWN DATABASE. Every other one reads
 * Supabase; this one calls the Shopify Admin API live, because a cart is not
 * synced and cannot be — abandoned checkouts are transient and carry a whole
 * basket, so mirroring them would mean storing the shopping of everyone who ever
 * bounced (see abandoned-checkout.mjs).
 *
 * NULL WHEN THE SHOP HAS NO ADMIN CREDENTIALS, and that is the safe direction:
 * the registry then never binds the tool, `toolsFor` drops it with a warning,
 * and `checkout_state` resolves `unavailable` — exactly what it resolved before
 * the tool was wired. A half-configured deployment loses a branch rather than
 * answering from a failed call.
 *
 * THE CLIENT IS BUILT ON FIRST USE. `createShopifyClient` is async (it can
 * exchange client credentials for a token) and the stack is built synchronously
 * by every caller, so constructing it eagerly would make the whole stack async
 * for a tool most tickets never call. Built once and kept.
 */
function buildCheckoutLookup(config, logger) {
  const configured =
    Boolean(config?.shopDomain) &&
    Boolean(config.shopifyToken || (config.shopifyClientId && config.shopifyClientSecret));
  if (!configured) {
    logger?.info?.('investigation.checkout_lookup_unconfigured');
    return null;
  }

  let lookupPromise = null;
  const build = async () => {
    const shopify = await createShopifyClient(config);
    return createAbandonedCheckoutLookup({ shopify, logger });
  };

  return async (args) => {
    lookupPromise = lookupPromise || build();
    return (await lookupPromise)(args);
  };
}
