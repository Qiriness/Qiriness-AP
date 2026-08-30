import { days } from '../../../scripts/lib/parameters.mjs';
import { orderStates, toOrderContextText } from '../resolution/order-context.mjs';

import { toPromptText as photoPromptText } from './photo-evidence.mjs';

import { planToolNames } from './decompose-rules.mjs';
import { STALE_TRANSIT_DAYS, TOOL_NAMES, allowedTools } from './investigation-rules.mjs';

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
  },
  [TOOL_NAMES.VERIFY_PURCHASE]: {
    description:
      'Vérifie si l’expéditeur est un client connu ayant déjà commandé en ligne, et compare ' +
      'le produit évoqué dans le message aux produits de sa dernière commande. ' +
      'Répond aussi « non vérifiable » : un achat en boutique physique n’apparaît jamais ici.',
    parameters: NO_ARGS
  },
  [TOOL_NAMES.CHECK_PHOTO_EVIDENCE]: {
    description:
      'Indique si le client a joint une photo, ou s’il en mentionne une sans l’avoir jointe. ' +
      'À utiliser pour toute casse, détérioration ou dysfonctionnement.',
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
  purchaseLookup,
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
    const handlers = {
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
          // `candidates` is the whole ranking, chunks the band let through.
          // Both live in `data`, which the model never sees — `fromModel` sends
          // `promptText` and nothing else — so this reports what retrieval found
          // without widening what it may answer from.
          data: {
            verdict,
            bestSimilarity: result.bestSimilarity ?? null,
            chunks,
            candidates: result.candidates || []
          }
        };
      },

      async [TOOL_NAMES.LOOKUP_CUSTOMER]() {
        const result = await customerLookup.lookupCustomer({ ticket });
        return {
          outcome: result.found ? 'found' : result.reason || 'no_match',
          caveats: result.found ? [] : ['customer_unknown'],
          promptText: result.promptText,
          data: {
            customerId: result.customerId ?? null,
            account: result.account ?? null,
            // NAMED FIELDS, not the whole context. `result.customer` also holds
            // the email, the city and the last order — this feeds a stored
            // diagnostic a person reads, and withholding is this layer's job.
            profile: result.customer
              ? {
                  name: result.customer.name ?? null,
                  rfmGroup: result.customer.rfmGroup ?? null,
                  ordersCount: result.customer.ordersCount ?? null
                }
              : null
          }
        };
      },

      async [TOOL_NAMES.LOOKUP_PRODUCT](args = {}) {
        const question = String(args.question || ticket.text || '');
        const result = await productLookup.lookupProduct(question);
        return {
          outcome: !result.found ? 'no_match' : result.ambiguous ? 'ambiguous' : 'found',
          caveats: result.ambiguous ? ['product_ambiguous'] : [],
          promptText: result.found ? result.promptText : 'Aucun produit du catalogue ne correspond au message.',
          // TITLES TRAVEL IN `data`, WHICH THE MODEL NEVER SEES — `fromModel`
          // sends `promptText` and nothing else. They are here so a person can be
          // shown WHICH products the agent matched, which is the whole content of
          // an `ambiguous` outcome: "it could be one of these three" is only
          // useful with the three named.
          data: {
            found: result.found,
            ambiguous: Boolean(result.ambiguous),
            titles: (result.products || []).map((p) => p?.title).filter(Boolean),
            // Near-misses on a no-match, which is what tells a reviewer whether
            // the catalogue lacks the product or the matcher simply missed it.
            candidates: result.candidates || []
          }
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
        // THE CODE MUST BE THE CUSTOMER'S, not the model's.
        //
        // Measured: on a product ticket the model called this with
        // `MASQUELEDVISAGE` — « votre Masque LED visage » from the customer's own
        // sentence, uppercased and joined. The message contains no all-caps run
        // at all, so `extractPromotionCodes` correctly found nothing; the
        // argument was composed. The tool then reported `not_found`, which
        // `evidence-rules` recorded as promotion_validity SATISFIED: a settled
        // finding about a code nobody ever quoted, and a branch an answer set
        // could select on ("your code does not exist") for someone who never
        // mentioned one.
        //
        // This module already says a missing code should make the tool "say so
        // rather than guess which of three active promotions was meant". That
        // held on the tool's side of the boundary and not on the model's.
        // Refusing the argument closes it for every future tool call at once,
        // where tightening the extraction pattern would have fixed nothing —
        // the pattern never matched this string.
        //
        // `listActivePromotions` stays the honest path for "is there another
        // offer I could give this customer", which is a real support move.
        const code = String(args.code || '');
        const result = await promotionLookup.lookupPromotion(code, {
          customer: ticket.customer || null
        });

        // ONLY THE `not_found` CASE IS REINTERPRETED, which is what makes the
        // rule safe. A code the shop really has resolves regardless of how the
        // customer punctuated it, and a genuine typo the customer typed still
        // reports `not_found` with suggestions — the useful answer. What is
        // refused is a string that exists in neither the shop NOR the message,
        // which is the only shape a fabricated argument can take.
        if (!result.found && code && !appearsAsToken(code, ticket.text)) {
          return {
            outcome: 'no_code_in_message',
            caveats: ['basket_unseeable'],
            promptText:
              `Le code « ${code} » n'existe pas et n'apparaît pas dans le message du client. ` +
              'Demande-lui le code exact, ou consulte les promotions actives.',
            data: { found: false, verdict: 'undetermined', code: null, checks: [], rejected: code }
          };
        }
        const verdict = result.eligibility?.verdict || 'undetermined';
        return {
          outcome: result.found ? verdict : 'not_found',
          // The basket is structurally invisible — there are no cart tables and
          // the Admin API does not expose an in-progress cart — so every
          // promotion answer carries that prohibition, whatever the verdict.
          caveats: ['basket_unseeable', ...(verdict === 'eligible' ? [] : ['eligibility_undetermined'])],
          promptText: result.promptText,
          // `checks` travels as {id, status, reason} ONLY — never the `detail`
          // sentences. `evidence-rules.mjs` derives promotion_validity from the
          // window and status reasons, and giving it the prose instead would mean
          // deriving a machine value by matching French. The details stay in
          // `promptText`, which is the half the model reads.
          data: {
            found: result.found,
            verdict,
            code: result.code,
            checks: (result.eligibility?.checks || []).map((c) => ({
              id: c.id,
              status: c.status,
              reason: c.reason ?? null
            }))
          }
        };
      },

      async [TOOL_NAMES.LIST_ACTIVE_PROMOTIONS]() {
        const { promotions, total, truncated } = await promotionLookup.listActive();
        // A discount with many codes has no single code to name — each belongs
        // to one customer. Say how many exist instead, which is the fact that
        // actually answers "why can't you just give me one?".
        const line = (p) =>
          p.code
            ? `- ${p.code} : ${p.summary || p.title}`
            : `- ${p.title} : ${p.summary || p.title}` +
              (p.codeCount > 1 ? ` (code personnel, ${p.codeCount} générés)` : '');

        return {
          outcome: promotions.length > 0 ? 'found' : 'none',
          caveats: ['basket_unseeable'],
          promptText:
            promotions.length > 0
              ? promotions.map(line).join('\n') +
                (truncated ? `\n(…${total - promotions.length} autres offres actives non listées)` : '')
              : 'Aucune promotion active actuellement.',
          data: { count: promotions.length, total }
        };
      },

      async [TOOL_NAMES.GET_ORDER_CONTEXT]() {
        // Read from what the order-context pass already assembled and stored,
        // rather than querying: that bundle is the reviewable record of what the
        // agent was told, and re-deriving it here would produce a second,
        // divergent version of the same facts.
        const context = ticket.resolvedContext || null;
        const confirmed = Boolean(ticket.shopify_order_number) && Boolean(context?.order);
        // `toOrderContextText` is the model's projection of the bundle, owned by
        // the module that builds it. It used to be `JSON.stringify(context.order)`,
        // which meant nobody had decided what the agent is told about an order —
        // whatever the builder last wrote reached the prompt, and so would the
        // next field added to it.
        //
        // A dispatched parcel with no carrier scan is the one place this tool
        // knows something the model must not describe. It travels as a
        // prohibition, never as a sentence — see `delivery_unscanned`.
        const unscanned = Boolean(confirmed && context?.signals?.awaitingCarrierScan);

        return {
          outcome: confirmed ? 'found' : 'not_resolved',
          caveats: [
            ...(confirmed ? [] : ['order_unconfirmed']),
            ...(unscanned ? ['delivery_unscanned'] : [])
          ],
          promptText: confirmed
            ? toOrderContextText(context)
            : 'Aucune commande confirmée n’est rattachée à ce ticket.',
          // THE STATES TRAVEL IN `data`, NEVER IN `promptText`. A finding is
          // derived from structure and never from prose (see evidence-rules), so
          // a policy rule branching on "has it shipped" needs the answer as a
          // value here — the French sentence above is free to be reworded and
          // must not become something code parses.
          //
          // Derived by the module that owns the bundle, so this is a projection
          // of the same reading the prompt got rather than a second one.
          data: {
            confirmed,
            orderName: ticket.shopify_order_number || null,
            states: confirmed
              ? orderStates(context, {
                  staleTransitDays: STALE_TRANSIT_DAYS,
                  // FROM THE MERCHANT, NOT FROM CODE. The stale-transit
                  // threshold above is a measurement this codebase made; the
                  // returns window is a policy only the shop can state, and its
                  // two approved articles disagree about it. Undecided arrives
                  // here as null and resolves `unknown`, never a default.
                  returnsWindowDays: days(ticket.parameters, 'returns_window_days')
                })
              : null
          }
        };
      },

      async [TOOL_NAMES.VERIFY_PURCHASE]() {
        const result = await purchaseLookup.verify({ ticket });
        // THE OUTCOME IS THE STATE ITSELF, all three of them, because
        // `evidence-rules` satisfies `purchase_verified` on `known_buyer` alone.
        // Folding the two unverified states into one `no_match` would make a
        // known customer with no orders indistinguishable from a stranger, which
        // is the distinction this tool was built for.
        return {
          outcome: result.state,
          caveats: result.verified ? [] : ['purchase_unverified'],
          promptText: purchaseLookup.toPromptText(result),
          data: {
            state: result.state,
            verified: result.verified,
            lastOrderName: result.lastOrder?.name ?? null,
            // Titles for a person reading the diagnostic, not for the model —
            // `fromModel` sends promptText only.
            lastOrderProducts: (result.lastOrder?.products ?? []).map((item) => item.title),
            productVerdict: result.product?.verdict ?? null,
            productMatched: result.product?.matched ?? null
          }
        };
      },

      async [TOOL_NAMES.CHECK_PHOTO_EVIDENCE]() {
        // READ, NOT RE-DERIVED. The runner computed this from the ticket's own
        // messages before the model was called — it is a pure function of text
        // and metadata the investigation already holds, so recomputing it here
        // would be a second answer to the same question with no new input.
        const evidence = ticket.photoEvidence ?? null;
        return {
          outcome: evidence?.outcome ?? 'none',
          caveats: evidence && !evidence.attachmentsKnown ? ['attachments_unrecorded'] : [],
          promptText: photoPromptText(evidence),
          data: {
            outcome: evidence?.outcome ?? 'none',
            mentioned: evidence?.mentioned ?? false,
            matchedTerm: evidence?.matchedTerm ?? null,
            images: evidence?.images ?? 0,
            nonImages: evidence?.nonImages ?? 0,
            attachmentsKnown: evidence?.attachmentsKnown ?? true
          }
        };
      }
    };

    // A tool whose client was never constructed is dropped here rather than left
    // to fail at call time. `toolsFor` then logs `tool_unavailable` and does not
    // offer it to the model — the same "skip it loudly" rule this file already
    // applies to a policy naming a tool with no definition. Handing the model a
    // function that throws would spend a tool call to learn about our wiring.
    if (!purchaseLookup) {
      delete handlers[TOOL_NAMES.VERIFY_PURCHASE];
    }

    return handlers;
  }

  return {
    /**
     * The tools this ticket's agent gets — definitions for the model, handlers
     * for the runner, and nothing outside the policy.
     *
     * `tasks` is the decomposition, when there is one: the tools are then the
     * UNION of what each task is allowed. The union is computed here rather than
     * taken from the caller so that the guardrail stays a property of this
     * module — a task list can only ever name (category, kind) pairs, never a
     * tool, so no caller can widen the set by asking.
     */
    toolsFor(ticket = {}, { tasks = null } = {}) {
      const names =
        Array.isArray(tasks) && tasks.length > 0
          ? planToolNames(ticket, tasks)
          : allowedTools(ticket.category, ticket.request_kind, ticket.level ?? 1);
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

/**
 * Does this code appear as ONE WORD the customer actually typed?
 *
 * PER TOKEN, NOT ACROSS THE WHOLE TEXT, and the difference is the entire guard.
 * The first version flattened both sides and asked whether the message contained
 * the code — which passes `MASQUELEDVISAGE` against « votre Masque LED visage »,
 * because with the spaces removed that IS the string. Any multi-word product
 * name collapses into exactly the sort of code a model would invent from it.
 *
 * Comparing token by token keeps the leniency that matters — `qiriness-20` and
 * `Qiriness20` are one word each and still match `QIRINESS20`, so a customer's
 * punctuation is never held against them — while a three-word product name is
 * three tokens and matches nothing.
 *
 * An empty ticket text refuses nothing: with no message to check against, the
 * guard has no opinion.
 */
function appearsAsToken(code, text) {
  const haystack = String(text || '');
  if (!haystack.trim()) {
    return true;
  }
  const flatten = (value) => String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const needle = flatten(code);
  if (needle.length === 0) {
    return false;
  }
  return haystack.split(/\s+/).some((token) => flatten(token) === needle);
}
