import {
  FINALIZE_TOOL,
  FINALIZE_TOOL_NAME,
  MISSING_FIELDS,
  buildCaseFile
} from './case-file.mjs';
import {
  normaliseDecomposition,
  planBudget,
  planEvidence,
  planMoves,
  planTasks
} from './decompose-rules.mjs';
import {
  NEED_KEYS,
  fieldsAlreadyAnswered,
  findingsOf,
  reactionReportFrom,
  resolveNeeds,
  responseComplete
} from './evidence-rules.mjs';
import { liveAnswers, needsNamedBy, selectAnswer } from './answer-selection.mjs';
import { normaliseTones } from '../../../scripts/lib/reply-tones.mjs';
import { collectableNeeds, collectedFindings, proposeCollection } from './collection-planner.mjs';
import { TOOL_NAMES, answerSetFor, escalationTriggers } from './investigation-rules.mjs';

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

// CALLS THE PLANNER MAY NOT SPEND. Whatever the rules want, the model keeps a
// guaranteed remainder — because the planner only ever speaks for the situation
// that matched, and a decomposed email can carry a second request the rules have
// nothing to say about. Two is the smallest number that leaves the fallback able
// to look something up AND still write a case file.
const PLANNER_MODEL_RESERVE = 2;
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
    // Loads the rules for ONE request: its answer set, and the situation its own
    // wording matches. Supplied by the runner, which owns the shop id and the
    // retrieval client; absent means an email is ruled on as one request, exactly
    // as it was before.
    policyForRequest = null,
    // THE GLOBAL OFF SWITCH for rule-directed collection, beside the per-situation
    // `collection_mode` column. Two levels on purpose: one bad situation is turned
    // off by a person in the dashboard, and the whole layer is turned off by an
    // env flag without a deploy.
    plannerEnabled = true,
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
    // Anything `toolsFor` needs synchronously, loaded once per run. Today that
    // is the activated collections, which go INTO the recommendation tool's
    // schema as the only values its `requirements` argument may take — so the
    // model is told what it may name instead of guessing. Optional: a registry
    // without them builds the same tools, minus that list.
    await registry.ready?.();

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

    // THE TOOL ARRAY THE MODEL SEES, identical on every turn of this run —
    // which is the whole point. `definitions` stays the registry's answer to
    // "what can this ticket look up"; `modelTools` adds the case-file tool that
    // replaces `response_format` on the closing call. Appending it here rather
    // than in the registry keeps the empty-tool-set guard above, and the
    // registry's own scope tests, reading the real tools only.
    const modelTools = [...definitions, FINALIZE_TOOL];
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
    // THE RULES GET FIRST REFUSAL ON EACH TURN, when this situation is opted in.
    //
    // ADDITIVE ONLY. A proposal ADDS a call; nothing here ends the loop, skips a
    // model turn that would otherwise happen, or changes a verdict. The model
    // still gets every turn it would have had — the planner spends its own
    // reserve, and when that is gone the run proceeds exactly as today.
    //
    // OFF UNLESS THREE THINGS HOLD: a situation matched, that situation is
    // `rule_directed`, and its set loaded approved rules. Any one missing and
    // this block never runs, which is what makes the change inert on delivery
    // until somebody opts a situation in.
    const ruleDirected =
      plannerEnabled &&
      ticket.policy?.collectionMode === 'rule_directed' &&
      Boolean(ticket.policy?.situationKey) &&
      (ticket.policy?.answers?.length ?? 0) > 0;

    for (let turn = 1; turn < maxTurns; turn += 1) {
      if (run.exhausted()) {
        break;
      }

      // BUDGET IS RESERVED, NOT SHARED. The model keeps a guaranteed remainder,
      // so a chatty planner cannot starve the fallback on exactly the tickets
      // that need it — a multi-task email where the rules only speak to one half.
      while (ruleDirected && run.remaining() > PLANNER_MODEL_RESERVE) {
        // RESOLVED OVER THE PREREQUISITES TOO, not just the needs the rules name.
        // `collectableNeeds` is the same set the planner ranks over, and scoring a
        // narrower one hides the state of exactly the needs the dependency walk
        // reaches: P-18's rules name only `promotion_validity`, so scoring that
        // alone leaves `promotion_identity` with no state, the planner reads it
        // as uncollected, and proposes a tool the opening moves already ran.
        const proposal = proposeCollection(
          ticket.policy.answers,
          resolveNeeds(collectableNeeds(ticket.policy.answers), run.ledger, names),
          {
            situationKey: ticket.policy.situationKey,
            ticket,
            ledger: run.ledger,
            allowedTools: names
          }
        );
        if (!proposal) break;

        // THE LEDGER MUST GROW OR THE PLANNER STOPS, and this is a correctness
        // guard rather than a belt-and-braces one. `run.call` serves a repeat
        // from cache and returns the ORIGINAL entry — truthy, with no new id and
        // no new row. A planner that read that as success would re-derive the
        // same findings, propose the same need, and spin without ever spending
        // budget. Measured: it hangs the run.
        //
        // A cache hit also means the evidence is already in hand, so there is
        // nothing this proposal could add even if the loop were safe.
        const before = run.ledger.length;
        const entry = await run.call(proposal.tool, proposal.args, 'planner');
        if (!entry || run.ledger.length === before) break;
        logger?.info?.('investigation.planner_called', {
          ticketId: ticket.id,
          situation: ticket.policy.situationKey,
          need: proposal.need,
          tool: proposal.tool
        });
      }

      if (run.exhausted()) {
        break;
      }

      // COLLECTION MAY STOP HERE, and only where a person has said it may.
      //
      // TWO CONDITIONS, NEVER ONE. `nextNeed` returning null means THE RULE IS
      // DECIDED, which is not the same as the investigation being done: a rule
      // branches only on what changes the routing, and a reply rests on facts
      // that change nothing about which answer is selected. Measured across 90
      // runs -- 58 had the rule decided, and 50 of those still produced
      // established facts. Stopping on the rule alone would have dropped the
      // collection behind 115 claims.
      //
      // OFF EVERYWHERE UNTIL THE REPLAY SAYS OTHERWISE.
      // `report:collection-replay` scores what stopping early would have cost,
      // per situation; today it says 13 calls saved against 7 established facts
      // lost, so no situation carries this flag.
      if (ruleDirected && ticket.policy?.suppresses === true) {
        const resolved = resolveNeeds(NEED_KEYS, run.ledger, names);
        const decided =
          liveAnswers(ticket.policy.answers, collectedFindings(resolved), {
            situationKey: ticket.policy.situationKey
          }).length <= 1;
        if (decided && responseComplete(ticket.category, resolved)) {
          logger?.info?.('investigation.collection_suppressed', {
            ticketId: ticket.id,
            situation: ticket.policy.situationKey,
            afterCalls: run.ledger.length
          });
          break;
        }
      }

      const response = await openai.completeWithTools({
        model,
        system: SYSTEM_PROMPT,
        messages,
        tools: modelTools,
        // Every turn of the loop is its own row. Investigation is the only pass
        // that can spend more than one model call on a ticket, so a per-call row
        // is what makes "the worst single ticket" answerable at all.
        pass: 'investigate',
        ticketId: ticket.id ?? null
      });

      // THE MODEL SAYING IT IS DONE, in either of the two ways it can say it.
      //
      // `finalize_investigation` is offered on every turn (it has to be, or the
      // tool array would differ between the loop and the closing call and the
      // cache partition would split again — which is the bug this whole change
      // fixes). So the model can reach for it mid-loop, and it does.
      //
      // DELIBERATELY NOT AN EARLY EXIT. Its arguments are a complete case file
      // and using them here would skip the closing call entirely — one model
      // call saved per ticket. That is exactly the suppression trade measured in
      // DECISIONS.md and reversed: stopping collection when the MODEL feels
      // finished cost established facts. So this is mapped onto the existing
      // "no tool calls" signal instead — stop collecting, then close as usual.
      // Behaviour is unchanged from before this tool existed; only the cache
      // partition moved.
      const collectable = response.toolCalls.filter((call) => call.name !== FINALIZE_TOOL_NAME);
      const finalised = collectable.length < response.toolCalls.length;
      if (finalised) {
        logger?.info?.('investigation.model_finalised_in_loop', {
          ticketId: ticket.id,
          afterCalls: run.ledger.length,
          alongsideLookups: collectable.length
        });
      }
      if (collectable.length === 0) {
        break;
      }

      // A finalise asked for ALONGSIDE a real lookup is dropped from the message
      // that travels on: every tool_call in an assistant message must be
      // answered by a tool result, and this one has no handler to answer it.
      // The lookup is kept — the model wanting to finish is not a reason to
      // throw away the call it made in the same breath.
      messages.push(
        finalised
          ? {
              ...response.message,
              tool_calls: (response.message.tool_calls || []).filter(
                (call) => call.function?.name !== FINALIZE_TOOL_NAME
              )
            }
          : response.message
      );
      for (const call of collectable) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: await run.fromModel(call)
        });
      }
    }

    // EVERY REQUEST THIS EMAIL CARRIES, each with its own rulebook and situation.
    // Resolved after the loop for the same reason the policy is selected there:
    // nothing about collection depends on it, so it cannot have steered the run.
    const requests = await resolveRequests({ ticket, plan, policyForRequest, logger });

    const final = await openai.completeWithTools({
      model,
      system: SYSTEM_PROMPT,
      messages: [...messages, { role: 'user', content: closingPrompt(run) }],
      tools: modelTools,
      // THE CASE FILE COMES BACK AS A FORCED TOOL CALL, not as `response_format`.
      // Forcing the tool gives the same guarantee `tool_choice: 'none'` plus a
      // schema gave — the model cannot spend this turn asking for another lookup
      // — while keeping the request in the same prompt-cache partition as the
      // loop turns before it. Measured: 0% cached before, 96% after.
      toolChoice: { type: 'function', function: { name: FINALIZE_TOOL_NAME } },
      maxTokens: 900,
      pass: 'investigate',
      ticketId: ticket.id ?? null
    });

    // The case file now arrives as the forced tool call's arguments. The client
    // has already JSON-parsed them; `argsError` is how it reports arguments the
    // model truncated or malformed, which for this call is the same failure the
    // old `JSON.parse(final.content)` threw on.
    //
    // A failure throws: the runner counts the attempt and retries, exactly as it
    // does for a failed categorisation. Guessing at a case file would be worse
    // than not having one.
    const finalCall = final.toolCalls.find((call) => call.name === FINALIZE_TOOL_NAME);
    if (!finalCall) {
      throw new Error('Investigation returned no case file.');
    }
    if (finalCall.argsError) {
      throw new Error(`Investigation case file was unparseable: ${finalCall.argsError}`);
    }
    const answer = finalCall.args;
    const escalation = escalationTriggers({ ticket, orderContext: ticket.resolvedContext || null });

    return buildCaseFile({
      answer,
      ledger: run.ledger,
      caveats: run.caveats(),
      knowledge: run.knowledge(),
      recommendations: run.recommendations(),
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
      policy: selectPolicyForRequests(requests, run.ledger, names),
      // WHAT THE DOSSIER ALREADY ANSWERS, so a rule cannot put a question to a
      // customer that our own tools have settled. Derived from the same ledger
      // everything else here reads, and handed over as plain keys because
      // `case-file.mjs` imports nothing.
      answeredFields: [
        ...fieldsAlreadyAnswered(findingsOf(resolveNeeds(declaredNeeds, run.ledger, names)))
      ],
      // An anonymous marketplace buyer has no record under any address, so
      // asking which one they used can only stall the reply.
      unaskableFields: ticket.orderBuyerAnonymous ? ['purchase_email', 'account_email'] : [],
      // THE SAME REASON `policy` IS COMPUTED HERE: the ledger still carries each
      // tool's `data` at this point and the stored case file will not. Null on
      // every ticket where the reaction tool did not run, which is all of them
      // outside cosmetovigilance.
      reactionReport: reactionReportFrom(run.ledger),
      // WHAT WAS KNOWN AFTER EACH CALL, so a run can be replayed once it is
      // stored. Third field on this list computed here for the one reason all
      // three share: the ledger still carries each tool's `data`, and the case
      // file will not.
      findingsTrace: traceFindings(run.ledger, names),
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
 * The requests an email carries, each paired with the rulebook that answers it.
 *
 * TWO SOURCES, AND THE SECOND IS THE ONE THAT WAS BEING THROWN AWAY. The
 * decomposer names a category per task; the CATEGORISER already recorded a
 * `secondary_category` on the ticket and nothing downstream ever read it. When
 * the decomposer is absent or collapses to one task,
 * `normaliseDecomposition` falls back to the ticket's own category alone — so
 * without the second source the extra request disappears on exactly the runs
 * least able to afford it.
 *
 * DEDUPLICATED BY ANSWER SET, because two tasks in one family are one selection:
 * the rulebook is the same and the findings are the same, so selecting twice
 * would just double the skeleton.
 *
 * THE TICKET'S OWN POLICY IS ALWAYS FIRST and is never re-derived — it was
 * loaded and situation-matched by the runner, and re-matching it here would spend
 * an embedding to reach the same answer less accurately.
 */
async function resolveRequests({ ticket, plan, policyForRequest, logger }) {
  const primary = ticket.policy ?? null;
  const requests = primary ? [{ ...primary, question: null }] : [];
  if (!policyForRequest) return requests;

  const seen = new Set(requests.map((request) => request.answerSet).filter(Boolean));
  const candidates = [
    ...plan.tasks.map((task) => ({ category: task.category, question: task.question })),
    // The categoriser's second axis, with the whole email as its text: there is no
    // sub-question to match on when the decomposer did not produce one.
    { category: ticket.secondary_category, question: null }
  ];

  for (const candidate of candidates) {
    const answerSet = answerSetFor(candidate.category);
    if (!answerSet || seen.has(answerSet)) continue;
    seen.add(answerSet);
    try {
      const loaded = await policyForRequest({
        answerSet,
        category: candidate.category,
        question: candidate.question,
        ticket
      });
      if (loaded?.answers?.length) {
        requests.push({ ...loaded, question: candidate.question });
      }
    } catch (error) {
      // NEVER FAILS AN INVESTIGATION over a second rulebook, the same contract
      // `loadPolicy` and `lastOrderLookup` already keep.
      logger?.warn?.('investigation.request_policy_failed', {
        ticketId: ticket.id,
        answerSet,
        reason: error.message
      });
    }
  }

  return requests;
}

/**
 * Which rules this run selects — one per REQUEST the email carries.
 *
 * AN EMAIL CAN ASK TWO THINGS AND THE RULES USED TO ANSWER ONE. The rulebook is
 * opened by subject, and a ticket has one subject, so a mask-specification email
 * that also asks for a discount code selected a `products` rule and nothing else
 * — while the promotion it asked about sat established in the same case file.
 * Measured: 66 of 309 investigable tickets (21%) carry a secondary subject that
 * opens a different rulebook.
 *
 * ONE REQUEST STILL PRODUCES EXACTLY TODAY’S OBJECT, byte for byte. That is the
 * safety property and the regression test: 79% of tickets must not move, and the
 * combining branch below cannot run for them.
 */
function selectPolicyForRequests(requests, ledger, toolNames) {
  const selections = [];
  for (const request of requests) {
    const selected = selectOnePolicy(request, ledger, toolNames);
    if (selected) selections.push({ ...selected, question: request.question ?? null });
  }
  if (selections.length === 0) return null;
  if (selections.length === 1) {
    const { question, ...only } = selections[0];
    return only;
  }
  return combinePolicies(selections);
}

/**
 * Several requests, one ticket, one verdict.
 *
 * THE STRICTEST ROUTE WINS, and that is what keeps tighten-only intact for free:
 * the strictest of several tightenings is still a tightening, and a request whose
 * rule wants to answer can never clear one whose rule wants a person.
 *
 * SKELETONS CONCATENATE, EACH LABELLED WITH ITS QUESTION, because the failure
 * being fixed is a reply that answers one half well and improvises the other. A
 * merged instruction that named neither would be no better.
 *
 * ONE OFFER AND ONE ARTICLE AT MOST. Two rules each handing out a different
 * discount code is an authoring problem, not something to resolve by picking; the
 * first is taken and every selection is recorded in `per_request` so the clash is
 * visible rather than silently settled.
 *
 * TONES UNION, as `ask` does. Each request's rule chose how its half should land,
 * and one reply carries both halves. Catalogue order, so the result reads the
 * same whichever request came first.
 */
function combinePolicies(selections) {
  const RANK = { answerable: 0, needs_customer_input: 1, needs_human: 2 };
  const routed = selections.filter((s) => s.route);
  const route =
    routed.length > 0
      ? routed.reduce((worst, s) => (RANK[s.route] > RANK[worst.route] ? s : worst)).route
      : null;

  const ask = [];
  for (const selection of selections) {
    for (const field of selection.ask || []) if (!ask.includes(field)) ask.push(field);
  }

  const tones = normaliseTones(selections.flatMap((s) => s.tones || []));

  const skeleton = selections
    .filter((s) => s.answer_skeleton)
    .map((s) => (s.question ? `« ${s.question} »\n${s.answer_skeleton}` : s.answer_skeleton))
    .join('\n\n');

  const primary = selections[0];
  return {
    answer_set: primary.answer_set,
    situation_key: primary.situation_key,
    verdict: selections.some((s) => s.verdict === 'selected') ? 'selected' : primary.verdict,
    answer_key: primary.answer_key,
    route,
    ask,
    offer_code: selections.find((s) => s.offer_code)?.offer_code ?? null,
    knowledge_document_id: selections.find((s) => s.knowledge_document_id)?.knowledge_document_id ?? null,
    tones,
    // One link per reply, like the code: the first is taken, per_request shows any clash.
    link: selections.find((s) => s.link)?.link ?? null,
    answer_skeleton: skeleton || null,
    candidates: [...new Set(selections.flatMap((s) => s.candidates))],
    // The findings are one map for the whole ticket, so any selection’s copy is
    // the same map. See DECISIONS for why they are not scoped per request.
    findings: primary.findings,
    // WHAT EACH REQUEST SELECTED, so a stored run reads back and a report can
    // tell a combined selection from a single one.
    per_request: selections.map((s) => ({
      question: s.question,
      answer_set: s.answer_set,
      situation_key: s.situation_key,
      answer_key: s.answer_key,
      route: s.route,
      tones: s.tones ?? [],
      link: s.link ?? null
    }))
  };
}

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
function selectOnePolicy(policy, ledger, toolNames) {
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
    ask: result.answer?.ask ?? [],
    // The code the rule offers. Recorded rather than resolved here: whether it
    // is still live is a drafting-time question, and the case file must record
    // what the rule SAID so a stored run can be read back.
    offer_code: result.answer?.offerCode ?? null,
    // The article the rule pins, recorded rather than resolved for the reason
    // above it: the drafting pass re-checks that the document is still approved
    // and drops it if not, and a stored run has to say which one was chosen.
    knowledge_document_id: result.answer?.knowledgeDocumentId ?? null,
    // The tones the rule sets for its reply, read back by the drafting pass by
    // name. Always a list; empty is the Brand voice alone.
    tones: result.answer?.tones ?? [],
    // The link the rule offers, as { url, label }. Recorded whole so a stored run
    // reads back which page was offered; drafting gives the model only the label.
    link: result.answer?.link ?? null,
    // The wording guidance, carried so the drafting pass can read it back off
    // the stored row. It is the one field here that reaches a model.
    answer_skeleton: result.answer?.answerSkeleton ?? null,
    // Every rule that matched, not just the winner: two rules matching equally
    // is an authoring problem, and it is invisible if only the winner is kept.
    candidates: result.candidates.map((c) => c.answerKey),
    findings
  };
}

/**
 * What was established after each tool call, in call order.
 *
 * WHY IT IS STORED AT ALL. Neither existing store can replay a run. `tool_calls`
 * keeps `{id, tool, argsHash, outcome}` and drops every tool's `data` on
 * purpose — but 8 of the finding derivations READ that data, which is the whole
 * discriminator for promotions and for accounts. A replay over `tool_calls`
 * would score those findings as absent, fire fewer rules and stop earlier: it
 * would flatter rule-guided collection exactly where it is most likely to
 * under-collect. Findings are a closed enum carrying no personal data, which is
 * why they are safe to keep where `data` was correctly dropped.
 *
 * A FOLD OVER PREFIXES, NOT AN INSTRUMENTED LOOP. `resolveNeeds` is pure over
 * its entries, so scoring `ledger.slice(0, n)` after the fact gives exactly what
 * snapshotting live would have — and cannot perturb the run it measures.
 *
 * THE WHOLE VOCABULARY, not this ticket's declared needs and not the ones the
 * loaded rules branch on. It costs nothing (findings do not depend on the tool
 * registry — only `state` does, and that is discarded here) and the row can
 * never be recomputed: a trace scoped to today's needs could not answer a
 * question about a rule set authored next month. `findingsOf` drops the two
 * needs with no derivation.
 *
 * FULL SNAPSHOTS, NOT DELTAS. A delta is derivable from these; a snapshot is not
 * recoverable from deltas if the reconstruction is wrong, and this store exists
 * precisely because the recompute path is gone.
 */
function traceFindings(ledger = [], toolNames = []) {
  const entries = Array.isArray(ledger) ? ledger : [];
  return entries.map((entry, index) => ({
    // The ledger id, so a snapshot can be read beside the call that produced it.
    call: entry?.id ?? null,
    tool: entry?.tool ?? null,
    findings: findingsOf(resolveNeeds(NEED_KEYS, entries.slice(0, index + 1), toolNames))
  }));
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

    /** Calls still available. Read by the planner, which spends a reserve. */
    remaining() {
      return Math.max(0, maxToolCalls - ledger.length);
    },

    caveats() {
      return [...new Set(ledger.flatMap((entry) => entry.caveats || []))];
    },

    knowledge() {
      return ledger
        .filter((entry) => entry.tool === TOOL_NAMES.SEARCH_KNOWLEDGE)
        .flatMap((entry) => entry.data?.chunks || []);
    },

    // WHAT THE SHOP PUT FORWARD, AS THE TOOL WROTE IT — the same treatment
    // `knowledge()` gives an approved article, and for the same reason. Every
    // other fact in a case file is the model's restatement of a tool result;
    // measured on ticket 05c1b539, three retellings of one product list lost
    // which product suited which skin, then invented a benefit for each name it
    // could no longer describe. A list a reply quotes almost verbatim has no
    // business being paraphrased twice on the way there.
    recommendations() {
      return ledger
        .filter((entry) => entry.tool === TOOL_NAMES.RECOMMEND_PRODUCTS)
        .flatMap((entry) => entry.data?.groups || []);
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
