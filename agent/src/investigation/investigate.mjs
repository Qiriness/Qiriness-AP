import { CASE_FILE_SCHEMA, MISSING_FIELDS, buildCaseFile } from './case-file.mjs';
import {
  normaliseDecomposition,
  planBudget,
  planEvidence,
  planMoves,
  planTasks
} from './decompose-rules.mjs';
import { findingsOf, resolveNeeds } from './evidence-rules.mjs';
import { needsNamedBy, selectAnswer } from './answer-selection.mjs';
import { TOOL_NAMES, escalationTriggers } from './investigation-rules.mjs';

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
    decomposer = null,
    logger,
    // Every tool result, as it is recorded — the ledger entry WHOLE, including
    // the French `promptText` the model was handed and the `data` the model
    // never sees.
    //
    // Absent by default, so the worker runs exactly as it did. It exists because
    // the stored `tool_calls` are `{id, tool, argsHash, outcome}` and that is
    // the right thing to keep for hundreds of real tickets and useless for the
    // one question the test chat asks: what did this tool actually say back.
    //
    // NEVER THROWS INTO THE RUN. An observer that failed would lose an
    // investigation to bookkeeping.
    onToolCall = null
  } = {}
) {
  /**
   * @param ticket {{ id, subject, text, category, request_kind, level,
   *                  requester_email_hash, shopify_order_number, resolvedContext }}
   * @returns the case file (see case-file.mjs)
   */
  async function investigate(ticket) {
    // The scope check runs on the TICKET, before any decomposition, so an email
    // that is out of scope costs nothing — not a decomposition call, not a
    // registry binding. Decomposing first would spend a model call on level 4
    // and on `contact`, the two things this branch exists to keep cheap.
    if (registry.toolsFor(ticket).definitions.length === 0) {
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

    // What this email is actually asking — one task normally, more when it
    // carries separate requests whose answers live in different tools.
    const decomposition = decomposer
      ? await decomposer.decompose(ticket)
      : normaliseDecomposition(null, ticket);
    // WHO SAID WHAT THIS TICKET REQUIRES.
    //
    // Normally the decomposer, per ticket. When that call FAILS it deliberately
    // returns no needs at all — `decompose.mjs` refuses to guess them from the
    // category, because fabricated requirements would corrupt the very numbers
    // the field exists to measure.
    //
    // A matched exemplar is not that guess. It is a requirement list a person
    // wrote for a situation this ticket resolved to at or above the MATCHED
    // band, so standing it in beats reporting "nobody said what this required"
    // — but ONLY when the model produced nothing. While the decomposer has
    // spoken, the two stay independent, which is the only condition under which
    // comparing them means anything.
    const needsSource = decomposition.read
      ? 'model'
      : ticket.exemplarNeeds?.length
        ? 'exemplar'
        : 'none';
    const declaredNeeds = needsSource === 'exemplar' ? ticket.exemplarNeeds : decomposition.needs;

    const plan = planTasks(ticket, decomposition.tasks);

    if (plan.tasks.length > 1 || plan.skipped.length > 0) {
      logger?.info?.('investigation.decomposed', {
        ticketId: ticket.id,
        tasks: plan.tasks.map((t) => `${t.category}/${t.request_kind}`),
        skipped: plan.skipped.map((t) => t.category)
      });
    }

    const { names, definitions, handlers } = registry.toolsFor(ticket, { tasks: plan.tasks });
    const run = createRun({
      ticket,
      handlers,
      maxToolCalls: planBudget(maxToolCalls, plan.tasks.length),
      logger,
      onToolCall
    });
    // Which tools this ticket was even offered. Reported to the observer before
    // the first call, because "the model never searched knowledge" and "there
    // was no knowledge tool in this ticket's registry" are different findings
    // and the ledger alone cannot tell them apart.
    run.observeRegistry(names);

    // Deterministic evidence first: the model starts from what is always needed
    // for these subjects rather than spending a turn asking for it.
    for (const move of planMoves(ticket, plan.tasks, decomposition.entities)) {
      await run.call(move.tool, move.args, 'opening_move');
    }

    const messages = [{ role: 'user', content: buildUserPrompt(ticket, plan, run, maxBodyChars) }];

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
        tools: definitions,
        // Every turn of the loop is its own row. Investigation is the only pass
        // that can spend more than one model call on a ticket, so a per-call row
        // is what makes "the worst single ticket" answerable at all.
        pass: 'investigate',
        ticketId: ticket.id ?? null
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
      maxTokens: 900,
      pass: 'investigate',
      ticketId: ticket.id ?? null
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
      // What answering this ticket required, against what the run actually got.
      // REPORTED, NOT ENFORCED: the verdict is untouched by it. Acting on the
      // gaps — downgrading an `answerable` that left a need open, and letting a
      // complete set end the loop early — is deliberately the next step, because
      // both depend on this vocabulary being trustworthy and nothing has yet
      // measured whether it is.
      evidenceGaps: resolveNeeds(declaredNeeds, run.ledger, names),
      needsSource,
      // WHICH POLICY RULE THIS EVIDENCE SELECTS. Computed here because this is
      // where the ledger with its tool `data` lives — the case file keeps only
      // `{id, tool, argsHash, outcome}`, so findings cannot be derived from it
      // afterwards, and the runner could not do this even if it wanted to.
      //
      // AFTER EVERYTHING ELSE, deliberately: the verdict, the needs and every
      // tool call are already settled by the time this runs. It reads them and
      // adds a reading; it cannot have changed them.
      policy: selectPolicy(ticket.policy, run.ledger, names),
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
/**
 * Which policy rule this run's evidence selects, and what it would have done.
 *
 * SHADOW ONLY, TODAY. The result is recorded and nothing reads it: the verdict
 * on the case file is the investigation's own, untouched. That is the whole
 * design of the phase — a wrong rule costs a row in a diagnostic, not a customer
 * a wrong answer, and the disagreements are the review list before it is turned
 * on.
 *
 * `wouldChangeVerdict` IS THE MEASUREMENT. "A rule matched" says almost nothing;
 * "a rule matched and would have sent this somewhere else" is the number worth
 * reading, and it has to be computed here because the comparison needs both
 * verdicts in hand at once.
 *
 * THE RULES SAY WHAT TO SCORE. `resolveNeeds` is called over the needs the rules
 * branch on rather than the ones the ticket declared — see `needsNamedBy`. It
 * reads the ledger that already exists, calls no tool and costs nothing.
 */
function selectPolicy(policy, ledger, toolNames) {
  const answers = policy?.answers || [];
  if (answers.length === 0) {
    return null;
  }

  const findings = findingsOf(resolveNeeds(needsNamedBy(answers), ledger, toolNames));
  const result = selectAnswer(answers, findings, { situationKey: policy.situationKey ?? null });

  return {
    answer_set: policy.answerSet ?? null,
    situation_key: policy.situationKey ?? null,
    verdict: result.verdict,
    answer_key: result.answer?.answerKey ?? null,
    route: result.answer?.route ?? null,
    ask: result.answer?.ask ?? null,
    // The wording guidance, carried so the drafting pass can read it back off
    // the stored row. It is the one field here that reaches a model.
    answer_skeleton: result.answer?.answerSkeleton ?? null,
    // Every rule that matched, not just the winner: two rules matching equally
    // is an authoring problem, and it is invisible if only the winner is kept.
    candidates: result.candidates.map((c) => c.answerKey),
    findings
  };
}

function createRun({ ticket, handlers, maxToolCalls, logger, onToolCall = null }) {
  const ledger = [];
  const byKey = new Map();

  /** Hand one ledger entry to the observer. Its failure is never the run's. */
  function observe(entry, source, args) {
    if (!onToolCall) return;
    try {
      onToolCall({ kind: 'call', source, args, ...entry });
    } catch {
      // Deliberately silent: an observer is not allowed to cost a ticket.
    }
  }

  async function call(tool, args = {}, source = 'model') {
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
      // Served from cache. Reported so a transcript shows the model asking
      // twice — which is a real thing to notice — without a second ledger id.
      observe({ ...byKey.get(key), cached: true }, source, args);
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
    observe(entry, source, args);
    return entry;
  }

  return {
    ledger,
    call,

    /** Which tools this ticket was offered, before any of them ran. */
    observeRegistry(tools) {
      if (!onToolCall) return;
      try {
        onToolCall({ kind: 'registry', tools });
      } catch {
        // Same rule as `observe`: an observer never costs a ticket.
      }
    },

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

function buildUserPrompt(ticket, plan, run, maxBodyChars) {
  const checklist = planEvidence(plan.tasks)
    .map((item) => `- ${item.label}`)
    .join('\n');
  const gathered = run.render();

  const lines = [
    `Sujet : ${ticket.subject || '(aucun)'}`,
    `Catégorie : ${ticket.category} / ${ticket.request_kind} — niveau ${ticket.level ?? '?'}`
  ];

  // Stated only when the sender is somebody in particular. On the ordinary
  // consumer ticket there is no line at all, rather than a line saying "client
  // ordinaire" — a fact restated on every ticket stops being read.
  const sender = describeSender(ticket.sender);
  if (sender) {
    lines.push(`Expéditeur : ${sender}`);
  }

  lines.push(
    '',
    'Message du client :',
    String(ticket.text || '').slice(0, maxBodyChars) || '(vide)'
  );

  // Stated only when the email really was split. On an ordinary one-question
  // ticket the list would just restate the message the model has above it.
  if (plan.tasks.length > 1) {
    lines.push(
      '',
      'Ce message contient plusieurs demandes distinctes. Traite-les TOUTES :',
      plan.tasks.map((task, i) => `${i + 1}. ${task.question} (${task.category})`).join('\n')
    );
  }

  if (plan.skipped.length > 0) {
    // Not silently dropped: a case file that omits half an email without saying
    // so is worse than one that never split it.
    lines.push(
      '',
      "Une partie de la demande ne peut pas être traitée ici, faute d'outils : " +
        plan.skipped.map((task) => task.question).join(' / ') +
        ". Signale-le dans unverified et conclus needs_human pour cette partie."
    );
  }

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
 * Who the sender is, in the prompt's own language.
 *
 * The domain is named because it is the useful half — "revendeur (nocibe.fr)"
 * tells the model this is a retail partner's reorder desk, not a shopper. The
 * ADDRESS never appears: a company domain is a business fact, the person at it
 * is not, and the case file this feeds is stored and re-read.
 */
const SENDER_LABELS = {
  internal: 'un collègue, pas un client',
  contractor: 'un prestataire qui travaille pour nous, pas un client',
  logistics: 'notre logisticien — courrier opérationnel',
  courier: 'un transporteur — courrier opérationnel',
  retailer: 'un revendeur (client professionnel, pas un consommateur)',
  distributor: 'un distributeur (client professionnel, pas un consommateur)',
  supplier: 'un fournisseur',
  partner: 'un partenaire commercial',
  other: 'un correspondant connu, ni consommateur ni collègue'
};

function describeSender(sender) {
  const description = SENDER_LABELS[sender?.label];
  if (!description) {
    return null;
  }
  const domain = sender.matched === 'domain' ? ` (${sender.pattern})` : '';
  return sender.note ? `${description}${domain} — ${sender.note}` : `${description}${domain}`;
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
