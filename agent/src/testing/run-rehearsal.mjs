import { createDraftRecord } from '../../../scripts/lib/draft-record.mjs';
import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';
import { COLUMNS, T, V } from '../../../scripts/lib/tables.mjs';

import { brandVoiceProblem } from '../drafting/brand-voice.mjs';
import { runDrafting } from '../drafting/draft-runner.mjs';
import {
  OWN_SIDE_LABELS,
  createSenderDirectoryStore,
  emptySenderDirectory
} from '../ingestion/sender-directory.mjs';
import { createSpamClassifier } from '../ingestion/spam-classifier.mjs';
import { createInvestigationStack } from '../investigation/create-investigation.mjs';
import { createCaseFileStore, runInvestigation } from '../investigation/investigation-runner.mjs';
import { allowedTools } from '../investigation/investigation-rules.mjs';
import { createOpenAIClient } from '../llm/openai-client.mjs';
import { createCategoriser } from '../pipeline/categorise.mjs';
import { runCategorisation } from '../pipeline/categorise-runner.mjs';
import { runCustomerResolution } from '../resolution/customer-resolution-runner.mjs';
import {
  createOrderContextStore,
  runOrderContext
} from '../resolution/order-context-runner.mjs';
import {
  createOrderResolutionStore,
  runOrderResolution
} from '../resolution/order-resolution-runner.mjs';
import { createCustomerLookup } from '../retrieval/customer-lookup.mjs';

import { checkArticle } from './article-check.mjs';
import { createMemoryTransport } from './memory-transport.mjs';
import { buildSyntheticTicket } from './synthetic-message.mjs';
import { createTrace, createTraceUsageSink, toolEntry, traceOpenAI } from './trace.mjs';

// One rehearsal: a message an operator typed, put through the pipeline.
//
// THE PASSES ARE THE WORKER'S OWN, unmodified and in the poll's order. What is
// substituted is the database underneath them (`memory-transport.mjs`), so the
// queue, the case files, the drafts and every Insights view are untouched, and
// the OpenAI client, which is wrapped so the calls can be shown. Nothing else
// differs — the retrieval tools read the real catalogue, the real customers and
// the real approved knowledge, because a rehearsal against fixtures would be
// testing the fixtures.
//
// THE ORDER IS COPIED VERBATIM: `customers → categorise → orders → context →
// investigate → draft`. That matters more than it sounds, and this harness is
// what proved it — the poll used to run the two order passes AFTER the
// investigation, so every first email quoting an order number was investigated as
// though no order existed. A rehearsal of a real ticket surfaced it (see
// `poll-order.test.mjs`, which now guards the ordering in both places).
//
// WHAT IS NOT RUN, and why:
//   · Gate 1 (the blocklist) — a rule about addresses that have written before,
//     which an invented one has not. Gate 2 is run, because "this would have
//     been dropped" is the most useful thing this tool can say.
//   · duplicate and related linking — both compare against the corpus, and a
//     rehearsal has no history to be a duplicate OF.
//   · forwarding and auto-close — one sends mail to a colleague, the other
//     closes tickets. Neither belongs in a rehearsal at any price.

/**
 * @param options.input          `{ name, email, subject, body, orderNumber }`
 * @param options.expectDocument the knowledge article being tested, or null
 * @param options.runGate        run Gate 2 (default true)
 * @param options.pastGate       continue even if the gate would have dropped it
 * @param options.onStep         called with every trace event as it lands, so a
 *                               caller can stream a run rather than await it
 * @returns {{ status, trace, tokens, summary, article, error }}
 */
export async function runRehearsal({
  supabase,
  shopId,
  config,
  logger,
  brandVoice = null,
  input,
  expectDocument = null,
  runGate = true,
  pastGate = false,
  onStep = null,
  now = new Date(),
  // The OpenAI client, pre-built. Every caller lets this default; the smoke test
  // passes a scripted one, because an orchestrator that has only ever been
  // reasoned about is the piece most likely to be wired wrong.
  openaiClient = null,
  // Likewise for embeddings, which retrieval and exemplar matching use.
  embeddingsClient = null
} = {}) {
  if (!openaiClient && !config?.openaiApiKey) {
    throw new Error('A rehearsal needs OPENAI_API_KEY: every pass in it is a model call.');
  }

  const trace = createTrace({ now: () => new Date() });
  const emit = (type, payload) => {
    const event = trace.step(type, payload);
    try {
      onStep?.(event);
    } catch {
      // A streaming consumer that fails must not take the run down with it.
    }
    return event;
  };

  const usageSink = createTraceUsageSink(trace);
  const openai = traceOpenAI(
    openaiClient || createOpenAIClient({ apiKey: config.openaiApiKey, usageSink })
  );
  // Model calls are attached to the step that made them. `since()` is how: take
  // the call count before a pass, slice everything after it.
  const since = () => openai.calls.length;
  const callsSince = (mark) => openai.calls.slice(mark);

  const summary = {
    gateOutcome: null,
    category: null,
    requestKind: null,
    level: null,
    language: null,
    verdict: null,
    draftBody: null,
    draftSkippedReason: null,
    draftChecksPassed: null,
    draftDisposition: null
  };

  const built = buildSyntheticTicket(input, { shopId, now });

  // The directory is loaded because an address in it changes what the pipeline
  // does — the label reaches the investigation prompt, and an own-side label
  // stops drafting entirely. Applying the same rule ingestion applies (one
  // lookup, `OWN_SIDE_LABELS` only) is what stops a rehearsal from being kinder
  // to a test address than the worker would be.
  const senderDirectory = await loadDirectory(supabase, shopId, config, logger);
  const directoryEntry = built.identity.email
    ? senderDirectory.lookup(built.identity.email)
    : null;
  if (directoryEntry && OWN_SIDE_LABELS.includes(directoryEntry.label)) {
    built.ticket.sender_label = directoryEntry.label;
  }

  emit('input', {
    subject: built.ticket.subject,
    body: built.bodyText,
    // The mask, never the address: a trace is stored.
    requester: { name: built.ticket.requester_name, masked: built.identity.masked },
    orderNumber: input?.orderNumber || null,
    // Stated because it is the one place a rehearsal shapes the input: an order
    // number typed in the field is appended to the body, so the resolver has to
    // find it exactly as it would in a real email.
    orderNumberAppended: Boolean(input?.orderNumber),
    senderDirectory: directoryEntry
      ? { label: directoryEntry.label, pattern: directoryEntry.pattern, note: directoryEntry.note }
      : null
  });

  // ---- Gate 2 -------------------------------------------------------------

  if (runGate) {
    const mark = since();
    const { triage } = createSpamClassifier(openai, { model: config.triageModel, logger });
    const verdict = await triage({ message: built.message });
    summary.gateOutcome = verdict.spam ? 'blocked' : 'kept';
    emit('gate', {
      outcome: summary.gateOutcome,
      label: verdict.label ?? null,
      reason: verdict.reason ?? null,
      failedOpen: Boolean(verdict.failedOpen),
      calls: callsSince(mark)
    });

    if (verdict.spam && !pastGate) {
      // The finding, not a failure. Stopping here is the honest report: a real
      // email judged this way never becomes a ticket, so nothing after this
      // point would have run.
      return finish('gated');
    }
  }

  // ---- the in-memory database ---------------------------------------------

  const transport = createMemoryTransport({
    [T.TICKETS]: [built.ticket],
    [T.TICKET_MESSAGES]: [built.message],
    [V.TICKET_FIRST_INBOUND]: [built.firstInbound],
    [T.TICKET_INVESTIGATIONS]: [],
    [T.TICKET_DRAFTS]: []
  });
  // The real record, on a fake database. Every filter, flag transition and
  // metadata trail below is the worker's own code.
  const record = createTicketRecord(null, { shopId, transport });
  const ticketId = built.ticket.id;

  try {
    // ---- customer resolution ----------------------------------------------

    const customerLookup = createCustomerLookup({ supabase, shopId, logger });
    let resolution = null;
    await runCustomerResolution({
      record,
      lookup: customerLookup,
      shopId,
      logger,
      excludedEmails: [config.graph?.mailbox].filter(Boolean),
      now,
      onResult: ({ resolution: result }) => {
        resolution = result;
      }
    });
    emit('identity', {
      status: resolution?.status ?? 'not_attempted',
      matchedBy: resolution?.matchedBy ?? null,
      linked: Boolean(resolution?.customerId),
      // No id and no name: which customer row it matched is not a fact the
      // transcript needs, and the mask above already says which address.
      note: resolution?.status === 'no_match'
        ? 'No customer in the shop has this address — the CRM tool will report the sender as unknown.'
        : null
    });

    // ---- categorisation ----------------------------------------------------

    const mark = since();
    const { categorise } = createCategoriser(openai, { model: config.categoriserModel });
    const categorisation = await runCategorisation({
      record, categorise, logger, limit: 1, ticketId
    });

    const labelled = transport.rows(T.TICKETS)[0];
    Object.assign(summary, {
      category: labelled.category,
      requestKind: labelled.request_kind,
      level: labelled.level,
      language: labelled.language
    });
    const tools = allowedTools(labelled.category, labelled.request_kind, labelled.level);
    emit('categorise', {
      category: labelled.category,
      requestKind: labelled.request_kind,
      secondaryCategory: labelled.secondary_category,
      secondaryRequestKind: labelled.secondary_request_kind,
      level: labelled.level,
      responsibleTeam: labelled.responsible_team,
      language: labelled.language,
      happiness: labelled.happiness,
      reason: labelled.metadata?.categorisation?.reason ?? null,
      // The consequence of the labels, stated with them: which tools this
      // subject may use is decided here and nowhere else, and it is the answer
      // to half the "why didn't it look that up" questions this tool will get.
      toolsAllowed: tools,
      // A MODEL FAILURE HERE IS NOT A RUN FAILURE, and without this line it is
      // an empty card. The pass retries across polls — three attempts before it
      // falls back to (other, problem) in front of a person — and a rehearsal is
      // one poll, so the first failure leaves the ticket unlabelled and still
      // queued. That is what the worker does; saying so is this tool's job.
      failed: categorisation.failed > 0,
      ...(categorisation.failed > 0
        ? {
            note:
              'The categoriser failed on this message. In the worker it stays queued and the next poll retries it — three attempts, then it falls back to (other, problem) at level 3 so a person sees it. A rehearsal is a single attempt, so nothing after this point had labels to work from.'
          }
        : {}),
      calls: callsSince(mark)
    });

    // Read AFTER the order passes, so it reflects the ticket they have just
    // written to rather than a snapshot taken before them.
    const categorised = (await record.claim('investigation', { limit: 1, ticketId }))[0] || null;
    if (!categorised) {
      // The investigation queue refused it: an out-of-scope subject, or a
      // categorisation that fell back. Both are real outcomes.
      emit('case_file', {
        skipped: true,
        reason: 'not_queued_for_investigation',
        note:
          'The categoriser did not hand this ticket to the investigation — either its subject is out of scope (ENABLED_SUBJECTS) or the labels are a fallback, which is never investigated.'
      });
      return finish('complete');
    }

    // ---- order resolution, then order context -------------------------------
    //
    // BEFORE THE INVESTIGATION, exactly as the poll runs them. `getOrderContext`
    // is a reader — it returns whatever these two passes stored on the ticket and
    // never queries for itself — so an investigation that ran first could not see
    // an order however clearly the customer quoted its number.

    let orderResolution = null;
    await runOrderResolution({
      store: createOrderResolutionStore(supabase),
      record,
      shopId,
      logger,
      onResult: ({ resolution: result }) => {
        orderResolution = result;
      }
    });
    emit('order_resolution', {
      status: orderResolution?.status ?? 'no_candidate',
      orderNumber: orderResolution?.orderName ?? null,
      verifiedBy: orderResolution?.verifiedBy ?? null,
      // The resolver's own sentence about what it found, which already names the
      // number and says how it failed to verify.
      detail: orderResolution?.detail ?? null,
      candidates: orderResolution?.candidates ?? [],
      // NO MODEL CALL HAPPENS HERE, which is worth saying where somebody is
      // watching a transcript full of them: the number is found by pattern, the
      // order by lookup, and the ownership by comparing two hashes of the email
      // address. A confirmed result is proof rather than an estimate.
      note:
        'Deterministic — no model call. The number is read out of the message, looked up, and matched to the sender by email hash. This runs BEFORE the investigation, so the case file below is written with the order in hand.'
    });

    let orderContext = null;
    await runOrderContext({
      store: createOrderContextStore(supabase),
      record,
      shopId,
      logger,
      now,
      onResult: ({ context }) => {
        orderContext = context;
      }
    });
    emit('order_context', {
      built: Boolean(orderContext),
      order: orderContext ? summariseOrder(orderContext) : null
    });

    // ---- investigation ------------------------------------------------------

    const investigationMark = since();
    const stack = createInvestigationStack({
      // The stack refuses to build without a key, because it would otherwise
      // construct clients that cannot call anything. A pre-built client IS the
      // key as far as it is concerned.
      supabase,
      shopId,
      config: config.openaiApiKey ? config : { ...config, openaiApiKey: 'injected' },
      logger,
      customerLookup,
      usageSink,
      // The same wrapped client, so the investigation's turns are recorded with
      // everything else rather than through a second, untraced one.
      openai,
      embeddingsClient,
      onToolCall: (entry) => {
        if (entry.kind === 'registry') {
          emit('tool', { registry: entry.tools });
          return;
        }
        emit('tool', toolEntry(entry));
      }
    });

    let caseFile = null;
    // Loaded once and shared by the investigation and the drafting pass — the
    // real numbers, like the real rules: a rehearsal using defaults would answer
    // a returns question the live agent could not.
    const parameters = await stack.loadParameters(shopId);

    const investigation = await runInvestigation({
      store: createCaseFileStore(null, { transport }),
      record,
      investigate: stack.investigate,
      shopId,
      logger,
      limit: 1,
      ticketId,
      senderDirectory,
      lastOrderLookup: stack.lastOrderLookup,
      retrieveExemplar: stack.retrieveExemplar,
      // The real rules from the real table. They are read-only reference data,
      // like products and knowledge, so a rehearsal wants the ones the worker
      // would use rather than a fixture — the transcript is worth nothing if the
      // policy it shows is not the policy.
      loadAnswers: stack.loadAnswers,
      parameters,
      onResult: ({ caseFile: result }) => {
        caseFile = result;
      }
    });

    if (!caseFile) {
      // Two different silences, and they are not the same finding: the subject
      // was out of scope, or the model call failed and the pass will retry.
      const failed = investigation.failed > 0;
      emit('case_file', {
        skipped: true,
        reason: failed ? 'investigation_failed' : 'not_investigable',
        note: failed
          ? 'The investigation failed on this ticket. In the worker it stays queued and the next poll retries it — three attempts, then it goes to a person with that reason recorded.'
          : 'This subject has no investigation tools (see ENABLED_SUBJECTS and the empty tool sets in investigation-rules.mjs), so the ticket reaches a person untouched.',
        calls: callsSince(investigationMark)
      });
    } else {
      summary.verdict = caseFile.verdict;
      emit('case_file', {
        verdict: caseFile.verdict,
        established: caseFile.established,
        unverified: caseFile.unverified,
        missing: caseFile.missing,
        doNotClaim: caseFile.doNotClaim,
        handoff: caseFile.handoff,
        droppedClaims: caseFile.droppedClaims,
        evidenceGaps: caseFile.evidenceGaps,
        knowledge: (caseFile.knowledge || []).map((chunk) => ({
          documentId: chunk?.documentId ?? null,
          title: chunk?.title ?? null,
          similarity: chunk?.similarity ?? null
        })),
        escalationReasons: caseFile.escalationReasons,
        proposedLevel: caseFile.proposedLevel,
        // The rule the evidence selected, beside the verdict it did not change.
        // A shadow record nobody can see is a shadow record nobody reviews, and
        // reviewing them is the entire point of the phase.
        policy: caseFile.policy,
        calls: callsSince(investigationMark)
      });
    }

    // ---- drafting -----------------------------------------------------------

    const problem = brandVoiceProblem(brandVoice);
    if (problem) {
      // The pass would throw. Reported as a finding, because it is one: the
      // agent cannot write anything until somebody approves the brand voice.
      emit('draft', { skipped: true, reason: 'brand_voice', note: problem });
      return finish('complete');
    }

    const draftMark = since();
    let drafted = null;
    const totals = await runDrafting({
      store: rehearsalDraftingStore(transport, { shopId }),
      draftRecord: createDraftRecord(null, { shopId, transport }),
      openai,
      brandVoice,
      shopId,
      model: config.draftingModel,
      logger,
      ticketId,
      // The same numbers the investigation used, so a rehearsal cannot quote a
      // returns window the live agent has no value for.
      parameters,
      // And the same subject gate, so a rehearsal of a reaction ticket reports
      // the auto-send answer the live pass would give rather than the default.
      cosmetovigilanceDraftOnly: config.draftOnlyCosmetovigilance,
      onDraft: (result) => {
        drafted = result;
      }
    });

    if (drafted) {
      Object.assign(summary, {
        draftBody: drafted.bodyText,
        draftChecksPassed: drafted.checksPassed,
        draftDisposition: drafted.disposition
      });
      emit('draft', {
        subject: drafted.subject,
        body: drafted.bodyText,
        disposition: drafted.disposition,
        sourceVerdict: drafted.sourceVerdict,
        language: drafted.language,
        checks: drafted.checks,
        checksPassed: drafted.checksPassed,
        failedChecks: drafted.failedChecks,
        autoSendEligible: drafted.autoSendEligible,
        promptInputs: drafted.promptInputs,
        calls: callsSince(draftMark)
      });
    } else {
      const reason = Object.keys(totals.skippedBy || {})[0] || 'no_draft';
      summary.draftSkippedReason = reason;
      emit('draft', {
        skipped: true,
        reason,
        note: DRAFT_SKIP_NOTES[reason] || null,
        calls: callsSince(draftMark)
      });
    }

    return finish('complete');
  } catch (error) {
    logger?.warn?.('rehearsal.failed', { message: error.message });
    emit('error', { message: error.message });
    return finish('failed', error);
  }

  // --------------------------------------------------------------------------

  function finish(status, error = null) {
    const article = expectDocument
      ? checkArticle({
          documentId: expectDocument.id,
          toolCalls: trace.events.filter((event) => event.type === 'tool' && event.tool),
          knowledge: trace.events.find((event) => event.type === 'case_file')?.knowledge || [],
          allowedTools:
            trace.events.find((event) => event.type === 'tool' && event.registry)?.registry || []
        })
      : null;
    if (article) {
      emit('article', { documentId: expectDocument.id, title: expectDocument.title, ...article });
    }
    return {
      status,
      trace: trace.events,
      tokens: trace.tokens,
      summary,
      article,
      error: error ? error.message : null
    };
  }
}

/** Why a draft was not written, in the operator's language. */
const DRAFT_SKIP_NOTES = {
  internal_sender:
    'The address that opened this thread is in the sender directory as one of ours, so the agent investigates it but never writes a customer reply.',
  duplicate: 'This ticket is linked as a duplicate, and a duplicate is answered with silence.',
  level_4:
    'Level 4 is never drafted: the ticket reaches a person untouched, and an automated acknowledgement on the triggers that define level 4 is worse than none.',
  nothing_to_ask:
    'The verdict asks for something from the customer, but the case file named no missing field — so there is no question to write.',
  no_case_file: 'No case file was produced, so there is nothing to draft from.',
  unknown_verdict: 'The case file carries a verdict this codebase does not issue.',
  // Not one of `draftDecision`'s reasons: the queue was empty, which on a single
  // ticket means the investigation never produced a case file at all.
  no_draft:
    'The drafting queue was empty — this ticket has no case file, so there was nothing to write a reply from.'
};

/**
 * The drafting queue, over the in-memory database.
 *
 * NOT the real `createDraftingStore`, and the difference is the queue rather
 * than the rules. That store's job is to find the newest case file per ticket
 * that has no draft, across the corpus, and merge a related thread's envelopes
 * in — questions with no meaning for a single invented ticket with one message.
 *
 * What IS reproduced, because it changes the output: the verdict filter (which
 * verdicts get drafted at all), and the reduction of `handoff` to a boolean at
 * the boundary — that is what `disposition` turns on, and the internal prose
 * behind it must not travel any further than it does live.
 */
function rehearsalDraftingStore(transport, { shopId }) {
  return {
    async claimable() {
      const investigations = await transport.select(
        null,
        T.TICKET_INVESTIGATIONS,
        {
          shop_id: shopId,
          verdict: { operator: 'in', value: '(answerable,needs_customer_input,needs_human)' }
        },
        COLUMNS.investigationForDrafting,
        { order: 'investigated_at.desc' }
      );
      if (investigations.length === 0) {
        return [];
      }

      const [tickets, messages, envelopes] = await Promise.all([
        transport.select(null, T.TICKETS, { shop_id: shopId }, COLUMNS.ticketForDrafting),
        transport.select(null, T.TICKET_MESSAGES, {}, COLUMNS.messageForDrafting),
        transport.select(null, T.TICKET_MESSAGES, {}, COLUMNS.messageEnvelopesForDrafting)
      ]);
      const ticketById = new Map(tickets.map((row) => [row.id, row]));
      const messageById = new Map(messages.map((row) => [row.id, row]));

      return investigations
        .map((investigation) => ({
          // Boolean, at the boundary: the disposition needs to know WHETHER a
          // human owes an action; the text of what they owe is internal.
          investigation: { ...investigation, handoff: Boolean(investigation.handoff) },
          ticket: ticketById.get(investigation.ticket_id),
          message: messageById.get(investigation.trigger_message_id),
          orderContext: ticketById.get(investigation.ticket_id)?.resolved_context || null,
          thread: envelopes.filter((row) => row.ticket_id === investigation.ticket_id)
        }))
        .filter((candidate) => candidate.ticket && candidate.message);
    }
  };
}

/**
 * The order bundle, reduced to what a transcript should show.
 *
 * IT READ A SHAPE THE BUNDLE DOES NOT HAVE. `buildOrderContext` returns
 * `{ order: { delivery: { tracking: [...] } } }` and there is no top-level
 * `fulfilments` anywhere in it, so both counts were `?? 0` on every run ever
 * recorded — a transcript said "0 parcels" for an order that had one. Nothing
 * caught it because a count of zero is also the correct answer for most orders.
 *
 * THE PARCELS ARE CARRIED, NOT COUNTED, because the transcript links them. The
 * URL is Shopify's own fulfilment URL — the same one the customer already got in
 * their dispatch mail, and the one `TicketDetailPanel` has always linked — so
 * showing it here reveals nothing the customer does not hold. Carrier and number
 * come with it so a reader can see which parcel a link belongs to.
 */
function summariseOrder(context) {
  const tracking = context?.order?.delivery?.tracking || [];
  return {
    name: context?.order?.name ?? null,
    status: context?.order?.status ?? null,
    placedAt: context?.order?.placedAt ?? null,
    // Renamed from `fulfilments`, which claimed to count something this bundle
    // does not carry. Runs recorded before this hold the old key and a numeric
    // `tracking`; the transcript reads both shapes rather than rewriting them.
    parcels: tracking.filter((parcel) => parcel?.number).length,
    tracking: tracking
      .filter((parcel) => parcel?.number)
      .map((parcel) => ({
        number: parcel.number,
        carrier: parcel.carrier ?? null,
        url: parcel.url ?? null
      }))
  };
}

async function loadDirectory(supabase, shopId, config, logger) {
  try {
    return await createSenderDirectoryStore(supabase).load(shopId, {
      supportMailbox: config?.graph?.mailbox ?? null
    });
  } catch (error) {
    // A directory that fails to load must not fail a rehearsal: an unlisted
    // sender is the ordinary case, and that is exactly what the empty one says.
    logger?.warn?.('rehearsal.sender_directory_failed', { message: error.message });
    return emptySenderDirectory;
  }
}
