import { CASE_FILE_SCHEMA, MISSING_FIELDS, buildCaseFile } from './case-file.mjs';
import {
  TOOL_NAMES,
  escalationTriggers,
  openingMoves,
  requiredEvidence
} from './investigation-rules.mjs';

// The investigation agent: a categorised ticket in, a case file out.
//
// It is the first stage in this pipeline that CHOOSES what to do rather than
// being told, so it is also the first that needs a budget. The loop below is
// bounded on three axes — how many tools may run, how many times the model may
// speak, and whether the same call may be made twice — and every bound resolves
// to an OUTCOME rather than an exception. A ticket that exhausts its budget is
// handed to a human with that reason recorded, which is the same shape as the
// categoriser running out of retries: the fallback is always *towards* a person.
//
// WHAT MAKES THE LOOP SHORT. Most of the evidence for the subjects in scope is
// deterministic — a product question always needs the product matched against
// the question text, a promotions ticket always needs its codes extracted — so
// `openingMoves()` runs those before the model's first turn. The model typically
// arrives with everything it needs and spends one turn writing the case file.
// The loop exists for the cases where it does not (a code that turns out to be
// restricted to a product, an account question that needs the FAQ as well).
//
// The model is never given the customer's address, the raw database rows, or any
// tool outside its ticket's registry. It sees the email text the categoriser
// already reads, and the French renderings the tools produce.

const DEFAULT_MAX_TOOL_CALLS = 6;
const DEFAULT_MAX_TURNS = 4;

const SYSTEM_PROMPT = [
  "Tu es l'agent d'enquête du service client de Qiriness, une marque de soin de la peau.",
  '',
  "TU N'ÉCRIS JAMAIS AU CLIENT. Tu prépares un dossier qu'un autre agent, ou un humain, utilisera pour répondre.",
  "Ne rédige aucune formule de politesse, aucune phrase de réponse, aucune excuse.",
  '',
  "Ton travail : établir ce qui est vrai à l'aide des outils qui te sont fournis, et dire honnêtement ce qui ne l'est pas.",
  '',
  'Règles absolues :',
  "- Un élément n'est ÉTABLI que s'il provient d'un outil que tu as appelé. Cite l'identifiant du résultat ([t1], [t2]…) dans evidence_ids.",
  "- Ce que le client AFFIRME n'est pas un fait établi. « J'ai bien reçu le colis », « j'ai commandé la semaine dernière » : cela va dans unverified, jamais dans established.",
  "- Ce qu'aucun outil n'a pu dire va dans unverified, avec la raison, ou dans missing si c'est au client de le fournir.",
  "- N'invente jamais un montant, une date, un numéro, un délai ou une disponibilité.",
  "- Si tu n'as pas assez d'éléments et qu'aucun outil ne peut aider, conclus plutôt que d'insister.",
  '',
  'Verdicts possibles :',
  "- answerable : les éléments réunis suffisent à répondre au client.",
  "- needs_customer_input : il manque une information que SEUL le client peut fournir. Nomme-la dans missing.",
  "- needs_human : quelque chose doit être MODIFIÉ (remboursement, renvoi, geste commercial, correction), ou les éléments se contredisent, ou le dossier dépasse ce que les outils permettent d'établir.",
  '',
  `Champs possibles pour missing : ${Object.keys(MISSING_FIELDS).join(', ')}.`,
  "N'écris pas la question à poser : elle est rédigée ailleurs. Nomme seulement le champ manquant.",
  '',
  'handoff : à renseigner UNIQUEMENT si le verdict est needs_human. Décris en une phrase ce que la personne doit faire, et pourquoi. Ce texte est interne et ne sera jamais envoyé au client.',
  '',
  "Les outils dont tu disposes dépendent du sujet du ticket. S'il n'en existe pas pour ce que tu voudrais vérifier, c'est que ce n'est pas vérifiable ici : dis-le, ne le contourne pas."
].join('\n');

export function createInvestigator(
  openai,
  registry,
  {
    model,
    maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
    maxTurns = DEFAULT_MAX_TURNS,
    maxBodyChars = 3000,
    logger
  } = {}
) {
  /**
   * @param ticket {{ id, subject, text, category, request_kind, level,
   *                  requester_email_hash, shopify_order_number, resolvedContext }}
   * @returns the case file (see case-file.mjs)
   */
  async function investigate(ticket) {
    const { definitions, handlers } = registry.toolsFor(ticket);

    // Out of scope: no tools means no investigation, and no model call either.
    // Level 4, `contact`, cosmetovigilance and legal_privacy all land here.
    if (definitions.length === 0) {
      return buildCaseFile({
        answer: {
          verdict: 'needs_human',
          established: [],
          unverified: [],
          missing: [],
          handoff: {
            action: 'Traiter ce ticket manuellement.',
            why: "Aucun outil d'enquête n'est autorisé pour ce sujet ou ce niveau."
          }
        },
        model: null,
        contextRef: buildContextRef(ticket)
      });
    }

    const run = createRun({ ticket, handlers, maxToolCalls, logger });

    // Deterministic evidence first: the model starts from what is always needed
    // for this subject rather than spending a turn asking for it.
    for (const move of openingMoves(ticket)) {
      await run.call(move.tool, move.args);
    }

    const messages = [{ role: 'user', content: buildUserPrompt(ticket, run, maxBodyChars) }];

    // Turns before the last are the model's chance to ask for more. The final
    // turn is reserved: `tool_choice: 'none'` plus the schema, so a run always
    // ends with a case file rather than with one more request.
    for (let turn = 1; turn < maxTurns; turn += 1) {
      if (run.exhausted()) {
        break;
      }

      const response = await openai.completeWithTools({
        model,
        system: SYSTEM_PROMPT,
        messages,
        tools: definitions
      });

      if (response.toolCalls.length === 0) {
        break;
      }

      messages.push(response.message);
      for (const call of response.toolCalls) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: await run.fromModel(call)
        });
      }
    }

    const final = await openai.completeWithTools({
      model,
      system: SYSTEM_PROMPT,
      messages: [...messages, { role: 'user', content: closingPrompt(run) }],
      tools: definitions,
      toolChoice: 'none',
      schema: CASE_FILE_SCHEMA,
      schemaName: 'case_file',
      maxTokens: 900
    });

    if (!final.content) {
      throw new Error('Investigation returned no case file.');
    }

    // A parse failure throws: the runner counts the attempt and retries, exactly
    // as it does for a failed categorisation. Guessing at a case file would be
    // worse than not having one.
    const answer = JSON.parse(final.content);
    const escalation = escalationTriggers({ ticket, orderContext: ticket.resolvedContext || null });

    return buildCaseFile({
      answer,
      ledger: run.ledger,
      caveats: run.caveats(),
      knowledge: run.knowledge(),
      contextRef: buildContextRef(ticket),
      proposedLevel: escalation.level,
      escalationReasons: escalation.reasons,
      model
    });
  }

  return { investigate };
}

/**
 * One investigation's tool state: the ledger, the budget, and the cache.
 *
 * THE CACHE IS A GUARDRAIL, not an optimisation. A model that has just been told
 * "aucun produit ne correspond" will often ask the identical question again;
 * without the cache that burns the budget two calls at a time and the run ends
 * with nothing established. Served from cache, the repeat costs nothing, returns
 * the same ledger id, and the turn limit still ends the loop.
 */
function createRun({ ticket, handlers, maxToolCalls, logger }) {
  const ledger = [];
  const byKey = new Map();

  async function call(tool, args = {}) {
    const handler = handlers.get(tool);
    if (!handler) {
      // Unreachable through the model (it is only offered the registry's tools),
      // but reachable through a bad opening move — a policy naming a tool this
      // ticket is not allowed. Recorded rather than thrown.
      logger?.warn?.('investigation.tool_not_allowed', { ticketId: ticket.id, tool });
      return null;
    }

    const key = `${tool}:${stableArgs(args)}`;
    if (byKey.has(key)) {
      return byKey.get(key);
    }
    if (ledger.length >= maxToolCalls) {
      return null;
    }

    const id = `t${ledger.length + 1}`;
    let entry;
    try {
      const result = await handler(args);
      entry = { id, tool, argsHash: stableArgs(args), ...result };
    } catch (error) {
      // A failing tool must not lose the investigation: the other evidence still
      // stands, and the model can conclude that this part is unknown.
      logger?.warn?.('investigation.tool_failed', { ticketId: ticket.id, tool, message: error.message });
      entry = {
        id,
        tool,
        argsHash: stableArgs(args),
        outcome: 'error',
        caveats: [],
        promptText: `L'outil ${tool} a échoué : cette information n'a pas pu être vérifiée.`,
        data: {}
      };
    }

    ledger.push(entry);
    byKey.set(key, entry);
    return entry;
  }

  return {
    ledger,
    call,

    /** The model's own request, rendered back as the tool message it will read. */
    async fromModel(toolCall) {
      if (toolCall.args === null) {
        return `Arguments invalides (${toolCall.argsError}). Réessaie avec un objet JSON valide.`;
      }
      const entry = await call(toolCall.name, toolCall.args);
      if (!entry) {
        return ledger.length >= maxToolCalls
          ? "Budget d'outils épuisé. Conclus avec les éléments déjà réunis."
          : `L'outil ${toolCall.name} n'est pas disponible pour ce ticket.`;
      }
      return `[${entry.id}] ${entry.promptText}`;
    },

    exhausted() {
      return ledger.length >= maxToolCalls;
    },

    caveats() {
      return [...new Set(ledger.flatMap((entry) => entry.caveats || []))];
    },

    knowledge() {
      return ledger
        .filter((entry) => entry.tool === TOOL_NAMES.SEARCH_KNOWLEDGE)
        .flatMap((entry) => entry.data?.chunks || []);
    },

    render() {
      return ledger.map((entry) => `[${entry.id}] ${entry.tool} → ${entry.outcome}\n${entry.promptText}`);
    }
  };
}

function buildUserPrompt(ticket, run, maxBodyChars) {
  const checklist = requiredEvidence(ticket.category)
    .map((item) => `- ${item.label}`)
    .join('\n');
  const gathered = run.render();

  const lines = [
    `Sujet : ${ticket.subject || '(aucun)'}`,
    `Catégorie : ${ticket.category} / ${ticket.request_kind} — niveau ${ticket.level ?? '?'}`,
    '',
    'Message du client :',
    String(ticket.text || '').slice(0, maxBodyChars) || '(vide)'
  ];

  if (checklist) {
    lines.push('', 'Ce qu’un dossier complet établit pour ce type de demande :', checklist);
  }

  lines.push(
    '',
    gathered.length > 0
      ? `Éléments déjà recueillis automatiquement :\n\n${gathered.join('\n\n')}`
      : 'Aucun élément n’a encore été recueilli.'
  );

  lines.push(
    '',
    'Appelle les outils qui manquent, puis produis le dossier. Si tout est déjà là, produis-le directement.'
  );

  return lines.join('\n');
}

/**
 * The instruction on the final turn.
 *
 * States the budget position plainly: a model told only "conclude" while it
 * still wanted a lookup tends to conclude *as if* it had made it.
 */
function closingPrompt(run) {
  return run.exhausted()
    ? "Le budget d'outils est épuisé. Produis le dossier à partir des seuls éléments ci-dessus, sans rien supposer de ce que tu n'as pas pu vérifier."
    : 'Produis maintenant le dossier à partir des éléments ci-dessus.';
}

function buildContextRef(ticket) {
  return {
    hasOrderContext: Boolean(ticket.resolvedContext?.order),
    orderName: ticket.shopify_order_number || null,
    customerId: ticket.customer_id || null
  };
}

/** Stable key for the cache: argument order must not make one call look like two. */
function stableArgs(args) {
  if (!args || typeof args !== 'object') {
    return '';
  }
  return JSON.stringify(
    Object.keys(args)
      .sort()
      .map((key) => [key, args[key]])
  );
}
