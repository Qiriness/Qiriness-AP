import { TOOL_NAMES, allowedTools } from './investigation-rules.mjs';

// Binds the Phase 4 retrieval tools into something the model can call, and
// translates what they return into the case file's vocabulary.
//
// THREE JOBS, and the order matters:
//
//   1. SCOPE. `toolsFor(ticket)` hands back only the tools
//      `investigation-rules.allowedTools()` permits for this ticket's (category,
//      kind, level). The model is never shown the rest, so least privilege is a
//      data structure rather than a sentence in a prompt.
//   2. NORMALISE. Each tool has its own result shape — `{found, ambiguous}`,
//      `{eligibility: {verdict, blocking, unknowns}}`, `{verdict: 'weak'}`. This
//      is the one place that knows them. Everything downstream sees `{ outcome,
//      caveats, promptText }`, so `case-file.mjs` never has to learn how
//      `matchProduct` reports a tie.
//   3. WITHHOLD. What the model is shown is the tool's own French `promptText`,
//      not its raw row. Those renderings already enforce this codebase's data
//      minimisation (no street address, no phone, the customer's email withheld
//      unless asked), which is why the PII boundary of this agent is the tool
//      layer and not the prompt.
//
// Every tool here is a READ. There is no write to register, so "the agent cannot
// act" is a property of the codebase rather than a promise. Phase 5's
// state-changing tools arrive behind an approval gate and do not belong here.

/**
 * Tool definitions in OpenAI function-calling form.
 *
 * Descriptions are French because the whole agent prompt is (the mailbox is
 * French); names and parameters stay English because they are code. Same split
 * as the categoriser's enums.
 *
 * Several tools take no parameters at all: they act on the ticket the runner
 * already bound them to. Passing the ticket's own text back through the model
 * would let it paraphrase the customer before the lookup — the product matcher
 * is IDF-weighted over the real question, and a summarised question matches
 * worse.
 */
const NO_ARGS = { type: 'object', properties: {}, required: [], additionalProperties: false };

const DEFINITIONS = {
  [TOOL_NAMES.SEARCH_KNOWLEDGE]: {
    description:
      'Cherche dans la base de connaissances approuvée un article qui répond à ce ticket. ' +
      'Ne renvoie que des articles suffisamment proches ; sinon indique qu’aucun ne répond.',
    parameters: NO_ARGS
  },
  [TOOL_NAMES.LOOKUP_CUSTOMER]: {
    description:
      'Retrouve la fiche client correspondant à l’expéditeur du ticket : nombre de commandes, ' +
      'état du compte, inscription à la newsletter. Ne nécessite aucun numéro de commande.',
    parameters: NO_ARGS
  },
  [TOOL_NAMES.LOOKUP_PRODUCT]: {
    description:
      'Identifie le produit dont parle le message et renvoie sa fiche complète ' +
      '(description, conseils d’utilisation, ingrédients, questions fréquentes).',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Le texte du client, tel quel.' }
      },
      required: ['question'],
      additionalProperties: false
    }
  },
  [TOOL_NAMES.LOOKUP_STOCK]: {
    description: 'Disponibilité du produit dont parle le message, et rien d’autre.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Le texte du client, tel quel.' }
      },
      required: ['question'],
      additionalProperties: false
    }
  },
  [TOOL_NAMES.EXTRACT_PROMOTION_CODES]: {
    description:
      'Extrait du texte les codes promotionnels qui existent réellement dans la boutique. ' +
      'Renvoie une liste vide si le message n’en cite aucun.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    }
  },
  [TOOL_NAMES.LOOKUP_PROMOTION]: {
    description:
      'Détail d’un code promotionnel et toutes les vérifications d’éligibilité possibles ' +
      '(statut, dates, limite d’utilisation, minimum d’achat, produits concernés).',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
      additionalProperties: false
    }
  },
  [TOOL_NAMES.LIST_ACTIVE_PROMOTIONS]: {
    description: 'Liste les promotions actuellement actives dans la boutique.',
    parameters: NO_ARGS
  },
  [TOOL_NAMES.GET_ORDER_CONTEXT]: {
    description:
      'Renvoie le dossier de la commande rattachée à ce ticket : état, livraison, suivi, ' +
      'remboursements. Disponible uniquement si la commande a été confirmée.',
    parameters: NO_ARGS
  }
};

/**
 * @param clients  the Phase 4 tools, already constructed once per process
 *                 (each caches an index, so they are not per-ticket objects)
 */
export function createToolRegistry({
  customerLookup,
  productLookup,
  promotionLookup,
  retrieveKnowledge,
  shopId,
  logger
} = {}) {
  /**
   * Handlers, bound per ticket.
   *
   * Each returns the same envelope:
   *   promptText — what the model is shown
   *   outcome    — a one-word summary for the ledger and the logs
   *   caveats    — case-file caveat codes this result raises
   *   data       — kept for the runner (never sent to the model verbatim)
   */
  function handlersFor(ticket) {
    return {
      async [TOOL_NAMES.SEARCH_KNOWLEDGE]() {
        const result = await retrieveKnowledge(
          { subject: ticket.subject, body: ticket.text, category: ticket.category },
          { shopId }
        );
        const verdict = result.verdict || 'none';
        // Chunks travel onwards only when the best match actually clears the
        // bar. A weak chunk shown to a drafting model is text it will use.
        const chunks = verdict === 'answerable' ? result.chunks || [] : [];
        return {
          outcome: verdict,
          caveats: verdict === 'weak' ? ['knowledge_weak'] : verdict === 'none' ? ['knowledge_none'] : [],
          promptText:
            chunks.length > 0
              ? chunks.map((c) => `### ${c.title || 'Article'}\n${c.text || ''}`).join('\n\n')
              : 'Aucun article approuvé ne répond de façon fiable à cette question.',
          data: { verdict, bestSimilarity: result.bestSimilarity ?? null, chunks }
        };
      },

      async [TOOL_NAMES.LOOKUP_CUSTOMER]() {
        const result = await customerLookup.lookupCustomer({ ticket });
        return {
          outcome: result.found ? 'found' : result.reason || 'no_match',
          caveats: result.found ? [] : ['customer_unknown'],
          promptText: result.promptText,
          data: { customerId: result.customerId ?? null, account: result.account ?? null }
        };
      },

      async [TOOL_NAMES.LOOKUP_PRODUCT](args = {}) {
        const question = String(args.question || ticket.text || '');
        const result = await productLookup.lookupProduct(question);
        return {
          outcome: !result.found ? 'no_match' : result.ambiguous ? 'ambiguous' : 'found',
          caveats: result.ambiguous ? ['product_ambiguous'] : [],
          promptText: result.found ? result.promptText : 'Aucun produit du catalogue ne correspond au message.',
          data: { found: result.found, ambiguous: Boolean(result.ambiguous) }
        };
      },

      async [TOOL_NAMES.LOOKUP_STOCK](args = {}) {
        const question = String(args.question || ticket.text || '');
        const result = await productLookup.lookupStock(question);
        if (!result.found) {
          return {
            outcome: 'no_match',
            caveats: ['stock_unknown'],
            promptText: 'Aucun produit du catalogue ne correspond au message : stock inconnu.',
            data: { found: false }
          };
        }
        return {
          outcome: result.ambiguous ? 'ambiguous' : 'found',
          caveats: result.ambiguous ? ['product_ambiguous'] : [],
          promptText: result.products
            .map((p) => `- ${p.title} : ${p.purchasable ? 'disponible' : 'indisponible'}`)
            .join('\n'),
          data: { products: result.products }
        };
      },

      async [TOOL_NAMES.EXTRACT_PROMOTION_CODES](args = {}) {
        const codes = await promotionLookup.extractCodes(String(args.text || ticket.text || ''));
        return {
          outcome: codes.length > 0 ? 'found' : 'none',
          caveats: [],
          promptText:
            codes.length > 0
              ? `Codes cités dans le message et existant en boutique : ${codes.join(', ')}.`
              : 'Le message ne cite aucun code promotionnel connu de la boutique.',
          data: { codes }
        };
      },

      async [TOOL_NAMES.LOOKUP_PROMOTION](args = {}) {
        const result = await promotionLookup.lookupPromotion(String(args.code || ''), {
          customer: ticket.customer || null
        });
        const verdict = result.eligibility?.verdict || 'undetermined';
        return {
          outcome: result.found ? verdict : 'not_found',
          // The basket is structurally invisible — there are no cart tables and
          // the Admin API does not expose an in-progress cart — so every
          // promotion answer carries that prohibition, whatever the verdict.
          caveats: ['basket_unseeable', ...(verdict === 'eligible' ? [] : ['eligibility_undetermined'])],
          promptText: result.promptText,
          data: { found: result.found, verdict, code: result.code }
        };
      },

      async [TOOL_NAMES.LIST_ACTIVE_PROMOTIONS]() {
        const promotions = await promotionLookup.listActive();
        return {
          outcome: promotions.length > 0 ? 'found' : 'none',
          caveats: ['basket_unseeable'],
          promptText:
            promotions.length > 0
              ? promotions.map((p) => `- ${p.code || p.title} : ${p.summary || p.title}`).join('\n')
              : 'Aucune promotion active actuellement.',
          data: { count: promotions.length }
        };
      },

      async [TOOL_NAMES.GET_ORDER_CONTEXT]() {
        // Read from what the order-context pass already assembled and stored,
        // rather than querying: that bundle is the reviewable record of what the
        // agent was told, and re-deriving it here would produce a second,
        // divergent version of the same facts.
        const context = ticket.resolvedContext || null;
        const confirmed = Boolean(ticket.shopify_order_number) && Boolean(context?.order);
        return {
          outcome: confirmed ? 'found' : 'not_resolved',
          caveats: confirmed ? [] : ['order_unconfirmed'],
          promptText: confirmed
            ? context.promptText || JSON.stringify(context.order)
            : 'Aucune commande confirmée n’est rattachée à ce ticket.',
          data: { confirmed, orderName: ticket.shopify_order_number || null }
        };
      }
    };
  }

  return {
    /**
     * The tools this ticket's agent gets — definitions for the model, handlers
     * for the runner, and nothing outside the policy.
     */
    toolsFor(ticket = {}) {
      const names = allowedTools(ticket.category, ticket.request_kind, ticket.level ?? 1);
      const bound = handlersFor(ticket);
      const handlers = new Map();
      const definitions = [];

      for (const name of names) {
        // A policy naming a tool this registry cannot supply is a wiring bug —
        // skip it loudly rather than handing the model a function that 404s.
        if (!bound[name] || !DEFINITIONS[name]) {
          logger?.warn?.('investigation.tool_unavailable', { tool: name });
          continue;
        }
        handlers.set(name, bound[name]);
        definitions.push({
          type: 'function',
          function: { name, description: DEFINITIONS[name].description, parameters: DEFINITIONS[name].parameters }
        });
      }

      return { names: [...handlers.keys()], definitions, handlers };
    }
  };
}

/** Exported for the registry's own tests and for the wiring check in index.mjs. */
export const TOOL_DEFINITIONS = DEFINITIONS;
