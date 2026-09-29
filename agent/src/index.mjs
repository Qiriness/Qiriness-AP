import { createSupabaseClient, supabaseSelect } from '../../scripts/lib/supabase-rest-client.mjs';
import { createTicketRecord } from '../../scripts/lib/ticket-record.mjs';
import { createCaseStateRecord } from '../../scripts/lib/case-state-record.mjs';

import { loadAgentConfig, assertGraphConfig } from './config.mjs';
import { logger } from './lib/logger.mjs';
import { resolveShopId } from './lib/shop.mjs';
import { createGraphClient } from './ingestion/graph-client.mjs';
import { createSupabaseMessageStore } from './ingestion/ticket-writer.mjs';
import { createBlocklistStore } from './ingestion/blocklist-store.mjs';
import { OWN_SIDE_LABELS, createSenderDirectoryStore } from './ingestion/sender-directory.mjs';
import { actorOf, obligationOwners } from './casework/actors.mjs';
import { createCaseCurrentStore, runFold } from './casework/case-current-store.mjs';
import { createDuplicateLookup, findDuplicate } from './ingestion/duplicate-rules.mjs';
import { createRelatedLookup, findRelated } from './ingestion/related-rules.mjs';
import { exemptKnownSenders } from './ingestion/known-senders.mjs';
import { createSupabaseSpamAuditStore } from './ingestion/spam-audit.mjs';
import { CURSOR_KEYS, runDeltaPoll, createSupabaseCursorStore } from './ingestion/delta-poller.mjs';
import { T } from '../../scripts/lib/tables.mjs';
import { createOpenAIClient } from './llm/openai-client.mjs';
import { createShopUsageRecording } from './llm/usage-store.mjs';
import { createDraftRecord } from '../../scripts/lib/draft-record.mjs';
import { createBrandVoiceStore } from './drafting/brand-voice.mjs';
import { createDraftingStore, runDrafting } from './drafting/draft-runner.mjs';
import { loadDraftingContext } from './drafting/draft-context.mjs';
import { readsAsClosure } from './casework/closure.mjs';
import { createSpamClassifier } from './ingestion/spam-classifier.mjs';
import { createEmbeddingsClient } from '../../scripts/lib/embeddings/openai-embeddings-client.mjs';
import { createMessageEmbedder } from './ingestion/message-embedder.mjs';
import { createCategoriser } from './pipeline/categorise.mjs';
import { runCategorisation } from './pipeline/categorise-runner.mjs';
import { createCaseworkStore, createSituationPlanner, runCasework, runOtherMessageCasework } from './casework/case-runner.mjs';
import { shouldRecategorise } from './casework/case-manager-rules.mjs';
import { createCustomerLookup } from './retrieval/customer-lookup.mjs';
import {
  runCustomerResolution
} from './resolution/customer-resolution-runner.mjs';
import { createInvestigationStack } from './investigation/create-investigation.mjs';
import { runInvestigation } from './investigation/investigation-runner.mjs';
import { createOrderResolutionStore, runOrderResolution } from './resolution/order-resolution-runner.mjs';
import { createOrderContextStore, runOrderContext } from './resolution/order-context-runner.mjs';
import { createForwardingStore } from './routing/forwarding-store.mjs';
import { runForwarding } from './routing/forward-runner.mjs';
import { AUTO_CLOSE_EXEMPT_LEVELS, runAutoClose } from './lifecycle/auto-close.mjs';
import { resolveInternalDomains } from '../../scripts/lib/message-audience.mjs';
import { createOutlookGraphAdapter } from './mail/outlook-graph-adapter.mjs';
import { manageSubscriptions } from './mail/subscription-manager.mjs';
import { createMailJobRecord } from '../../scripts/lib/mail-job-record.mjs';
import { createMailSubscriptionRecord } from '../../scripts/lib/mail-subscription-record.mjs';
import { createOutboundRecord } from '../../scripts/lib/outbound-record.mjs';
import { createOutboundStore } from './outbound/outbound-store.mjs';
import { confirmSentActions, createAutoSendActions, runOutbound } from './outbound/outbound-runner.mjs';
import { createAdminClient } from '../../scripts/lib/dashboard-user-admin.mjs';
import { runSalesReportMail } from './reports/sales-report-mail.mjs';

// The passes a poll runs, in the order it runs them. `--stop-after=<stage>` ends
// the poll once that stage has run.
//
// SAFE TO STOP ANYWHERE, and that is a property of the pipeline rather than of
// this flag: no pass acts on "what the poll just wrote", each drains a queue
// defined by ticket state — `needs_categorisation`, `needs_investigation`, a null
// order number, an unsent forward. A stage skipped today simply finds more work
// waiting the next time it runs, with no backfill to remember and nothing to
// re-ingest.
//
// WHY IT EXISTS. Ingesting a backlog and reading it are one job; spending the
// mid tier on evidence gathering — and, at the far end, actually forwarding mail
// to colleagues — is another. Building the knowledge library wants the first
// without the second, over hundreds of old emails that nobody is waiting on:
//
//   npm run ingest:once -- --limit=500 --stop-after=categorise
//
// In that staged shape, `--limit` is shared by ingestion and categorisation:
// otherwise a "500" run would ingest 500 messages but label only the normal
// 25-ticket daemon batch, leaving the review corpus half-built.
// ORDERS AND CONTEXT SIT BEFORE INVESTIGATE, and the order of these two lines is
// a behaviour, not a listing. `getOrderContext` reads `tickets.resolved_context`
// rather than querying, so an investigation that runs before those two passes
// cannot see an order however clearly the customer quoted it.
//
// `--stop-after=categorise` is deliberately unaffected by the move: it still runs
// ingest, customers and categorise, which is what the cheap corpus-building run
// below depends on. `--stop-after=orders` changed meaning — it now stops before
// the investigation rather than after it, which is also the more useful reading
// of it.
const PIPELINE_STAGES = [
  'ingest',
  'customers',
  'casework',
  'categorise',
  'orders',
  'context',
  'investigate',
  'fold',
  'draft',
  'send',
  'forward',
  'close'
];

async function main() {
  const runOnce = process.argv.includes('--once');
  const limit = parseLimit(process.argv);
  const stopAfter = parseStopAfter(process.argv);
  // `--also=send` adds named stages back to a staged run: the sync-only
  // deployment (`--stop-after=ingest --also=send`) turns approved replies into
  // Outlook drafts without categorising or investigating anything.
  const also = parseAlso(process.argv);
  // Ordered membership, not a set: stopping AFTER a stage runs every stage up to
  // and including it.
  const runsThrough = (stage) =>
    stopAfter === null || PIPELINE_STAGES.indexOf(stage) <= PIPELINE_STAGES.indexOf(stopAfter) || also.has(stage);
  const config = loadAgentConfig();
  assertGraphConfig(config);

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  const graphClient = createGraphClient(config);
  // Everything that reads or writes the mailbox goes through the provider
  // contract (mail/mail-provider.mjs); only the Outlook adapter knows Graph.
  // Forwarding and the subscription manager still take the Graph client:
  // both are Outlook features with no provider-neutral shape yet.
  const provider = createOutlookGraphAdapter({ graphClient, mailbox: config.graph.mailbox });
  // The durable queue (mail_jobs) and the send path. Both are read defensively
  // below: a database without migrations 46-47 logs a warning and polls as before.
  const jobs = createMailJobRecord(supabase, { shopId });
  const outboundRecord = createOutboundRecord(supabase, { shopId });
  const outboundStore = createOutboundStore(supabase, { shopId });
  const outboundDraftRecord = createDraftRecord(supabase, { shopId });
  const subscriptions = createMailSubscriptionRecord(supabase);
  // Reads the dashboard accounts, for the sales report's recipients.
  const reportAdminClient = createAdminClient({ url: config.supabaseUrl, secretKey: config.supabaseKey });
  // ONE ticket record for the whole poll, shared by every pass below. It is the
  // only writer of `tickets` in the codebase; each pass hands it columns and it
  // owns the flags, the filters, the lifecycle timestamps and the metadata
  // trail. See scripts/lib/ticket-record.mjs.
  const record = createTicketRecord(supabase, { shopId });
  const caseStateRecord = createCaseStateRecord(supabase, { shopId });
  const store = createSupabaseMessageStore(supabase);
  const caseCurrentStore = createCaseCurrentStore(supabase, { shopId });
  const cursorStore = createSupabaseCursorStore(supabase);
  // The narrow candidate pool duplicate detection decides against: one sender's
  // recent messages, never the mailbox.
  const duplicateLookup = createDuplicateLookup({ supabase, shopId, select: supabaseSelect });
  const blocklistStore = createBlocklistStore(supabase);
  const senderDirectoryStore = createSenderDirectoryStore(supabase);
  // Records why each email passed or failed the gate, and on a drop the body
  // too. Dropped mail is never written anywhere else, so this is its only trace
  // — and a subject line alone cannot tell a reviewer whether the drop was
  // right. The body expires on its own clock; the decision row does not.
  const auditStore = createSupabaseSpamAuditStore(supabase, {
    retentionDays: config.spamAuditBodyRetentionDays
  });

  // LLM stages — enabled only when an OpenAI key is present. Without it,
  // ingestion still runs and just relies on the blocklist; tickets then stay
  // uncategorised until a key is configured, and the next poll catches them up.
  let triage;
  let categorise;
  let embedMessage;
  let investigation;
  // Built only when an OpenAI key is present, like every other model-backed
  // pass. Null means the casework stage is skipped entirely and the pipeline
  // behaves exactly as it did before this layer existed.
  let readCaseFor = null;
  // Stage 6: the drafting pass in the poll. Null unless DRAFT_IN_POLL=true and a
  // key is set, and null means the stage is skipped, as before.
  let drafting = null;
  // ONE buffer for the whole process, drained at the end of every poll. It is
  // created here, outside the `openaiApiKey` branch, so the flush at the end of
  // the poll can be unconditional: with no key there are no model calls, the
  // buffer stays empty, and the flush is a no-op rather than a special case.
  //
  // Every client below takes THIS sink. A client that built its own would be a
  // second buffer nobody drains, which is how the table came to hold 0 rows while
  // the categoriser, the decomposer and the investigation agent were all running.
  const usage = createShopUsageRecording({ supabase, shopId, logger });
  const forwardingStore = createForwardingStore(supabase);
  // One instance for the whole process: it caches a shop-wide email-hash index,
  // which the resolution pass drops itself whenever it has work to do.
  const customerLookup = createCustomerLookup({ supabase, shopId, logger });
  const orderResolutionStore = createOrderResolutionStore(supabase);
  const orderContextStore = createOrderContextStore(supabase);
  if (config.openaiApiKey) {
    const openai = createOpenAIClient({ apiKey: config.openaiApiKey, usageSink: usage.sink });
    triage = createSpamClassifier(openai, { model: config.triageModel, logger }).triage;
    categorise = createCategoriser(openai, { model: config.categoriserModel }).categorise;
    // `AGENT_CASEWORK_MODEL=` (empty) leaves this null, which turns the stage
    // off — the switch is the absence of the reader, not a flag inside it.
    readCaseFor = config.caseworkModel ? { openai, model: config.caseworkModel } : null;
    drafting = config.draftInPoll
      ? {
          openai,
          store: createDraftingStore(supabase, { caseStateStore: caseStateRecord }),
          record: createDraftRecord(supabase, { shopId }),
          brandVoice: createBrandVoiceStore(supabase)
        }
      : null;
    // Embeds each stored message inline, best-effort. `npm run embed:tickets`
    // is the reconciler behind it and the better path for any bulk backfill.
    embedMessage = createMessageEmbedder(
      createEmbeddingsClient({
        apiKey: config.openaiApiKey,
        model: config.embeddingModel,
        dimensions: config.embeddingDimensions,
        usageSink: usage.sink
      }),
      { logger }
    );
    // Shares the customer lookup with the resolution pass rather than building a
    // second one: it holds a shop-wide hash index that only needs loading once.
    investigation = createInvestigationStack({
      supabase,
      shopId,
      config,
      logger,
      customerLookup,
      usageSink: usage.sink
    });
  } else {
    logger.warn('ingest.llm_filter_disabled', { reason: 'OPENAI_API_KEY not set' });
  }

  if (stopAfter) {
    // Stated up front, not inferred from which passes are missing from the log:
    // a staged run leaves work deliberately undone, and that has to be visible.
    logger.info('ingest.staged_run', {
      stopAfter,
      also: [...also],
      skipping: PIPELINE_STAGES.slice(PIPELINE_STAGES.indexOf(stopAfter) + 1).filter((stage) => !also.has(stage))
    });
  }

  const poll = async ({ afterIngest } = {}) => {
    // CHANGE-NOTIFICATION SUBSCRIPTIONS, kept alive before the read. A no-op
    // without MAIL_WEBHOOK_URL; a failure is logged at error level and the
    // poll carries on, because a subscription is only ever a trigger.
    try {
      const subscribed = await manageSubscriptions({
        graphClient,
        subscriptions,
        shopId,
        webhookUrl: config.mailWebhookUrl,
        logger
      });
      if (subscribed.created > 0 || subscribed.renewed > 0 || subscribed.failed > 0) {
        logger.info('mail.subscriptions', { shopId, ...subscribed });
      }
    } catch (error) {
      logger.error('mail.subscription_renew_failed', { shopId, error: error.message });
    }

    // Load the blocklist each poll so newly added rules take effect immediately.
    const { gate, rulesById } = await blocklistStore.loadGate(shopId);
    // Loaded before ingestion because the related-ticket check needs it on the
    // very first message, and reloaded each poll for the same reason the
    // blocklist is: a sender labelled a retailer a minute ago must be excluded
    // now, not next time.
    const senderDirectory = await senderDirectoryStore.load(shopId, {
      supportMailbox: config.graph.mailbox
    });
    const relatedLookup = createRelatedLookup({
      supabase,
      shopId,
      select: supabaseSelect,
      senderDirectory
    });

    // A SENDER WE HAVE WRITTEN DOWN IS NEVER SPAM, applied to both gates at once.
    // Four emails from directory addresses were dropped before this existed —
    // three by the model, one by a blocklist rule — and dropped mail never
    // becomes a ticket, so the only trace was a `spam_audit` row nobody reads.
    // Wrapped here rather than taught to either gate: the directory is loaded
    // per poll, and a rule that lives in one place cannot be half-applied.
    const guarded = exemptKnownSenders({ senderDirectory, gate, triage, logger });

    const ingestOptions = {
      provider,
      store,
      record,
      cursorStore,
      shopId,
      logger,
      mailbox: config.graph.mailbox,
      spamGate: guarded.gate,
      recordSpamHits: (hits) => blocklistStore.recordHits(rulesById, hits),
      auditStore,
      triage: guarded.triage,
      embedMessage,
      // Deterministic duplicate detection: identical text from one sender inside
      // an hour, or an RFC reply chain naming a message we already hold. No
      // model, because a hit means a ticket is skipped by the drafting queue and
      // a customer who is wrongly skipped gets no reply at all.
      detectDuplicate: async (item) =>
        findDuplicate({
          candidate: { ...item.message, received_at: item.conversation?.message_at },
          priorMessages: await duplicateLookup.priorMessages({
            requesterEmailHash: item.conversation?.requester_email_hash,
            before: item.conversation?.message_at
          })
        }),
      // The weaker link, and deliberately the opposite consequence: this one
      // never suppresses a draft, it adds the fact that the customer has written
      // before — and, when we never answered, that they are still waiting.
      //
      // The directory is loaded once per poll and shared, like the blocklist: a
      // sender labelled a retailer a minute ago is excluded on this poll rather
      // than the next.
      detectRelated: async ({ ticketId, message, requesterEmailHash }) => {
        const { priorMessages, outboundAt } = await relatedLookup.priorMessages({
          requesterEmailHash,
          fromEmail: message.from_email,
          before: message.received_at
        });
        return findRelated({
          candidate: { ...message, ticket_id: ticketId },
          priorMessages,
          outboundAt
        });
      },
      // Stamped at ticket creation from the address that opened the thread.
      // Only the labels that mean "us" — a retailer or a courier is a real
      // external correspondent and their mail is real work.
      senderLabel: (fromEmail) => {
        const label = senderDirectory.lookup(fromEmail)?.label ?? null;
        return OWN_SIDE_LABELS.includes(label) ? label : null;
      },
      // A customer or a retailer may take over a requester that is one of our
      // own addresses; a courier's tracking mail may not.
      isCandidate: (fromEmail) => !senderDirectory.isNonDemand(fromEmail),
      // Who wrote each message, in the case vocabulary, through the deployment's
      // label map (AGENT_ACTOR_BY_LABEL).
      actorFor: (message) => actorOf(message, senderDirectory, config.actorByLabel),
      limit
    };
    const totals = await runDeltaPoll(ingestOptions);
    logger.info('ingest.poll', { shopId, ...totals });

    // SENT ITEMS, straight after the Inbox and before any other pass, so a poll
    // sees both halves of a thread before anything reads it
    // (codex_plans/Case_State_Plan.md, stage 2). Replies sent from the support
    // address that never came back to the Inbox: 98 of the 115 there on
    // 2026-09-26. It only joins threads that already have a ticket, and skips a
    // reply the Inbox already gave us. Its own cursor; the cutover stays the
    // Inbox's.
    const sentTotals = await runDeltaPoll({ ...ingestOptions, folder: 'sentitems' });
    logger.info('ingest.poll_sent', { shopId, ...sentTotals });
    // Both folders are read: a queued `sync_mailbox` request is satisfied.
    await afterIngest?.();

    // A REPLY WE SENT, READ BACK. Straight after Sent Items and before the
    // fold, so the fold never marks that draft superseded by our own reply.
    // Runs whatever `--stop-after` says: it only records what already happened.
    try {
      const confirmed = await confirmSentActions({
        outboundRecord,
        draftRecord: outboundDraftRecord,
        store: outboundStore,
        logger,
        shopId
      });
      if (confirmed.confirmed > 0) {
        logger.info('outbound.confirm_pass', { shopId, ...confirmed });
      }
    } catch (error) {
      logger.warn('outbound.confirm_failed', { shopId, error: error.message });
    }

    // Customer resolution runs as soon as the mail is stored, and before the
    // LLM passes: identity is something a ticket has from its first message —
    // the address it was opened with — so it does not wait on a category, an
    // order number, or an OpenAI key. Everything after it can then read
    // `customer_id` instead of resolving the sender again.
    if (runsThrough('customers')) {
      const customers = await runCustomerResolution({
        record,
        lookup: customerLookup,
        shopId,
        logger,
        // The support mailbox is not a customer, whatever the customers table says.
        excludedEmails: [config.graph.mailbox].filter(Boolean)
      });
      if (customers.considered > 0) {
        logger.info('customer.resolution.pass', { shopId, ...customers });
      }
    }

    // WHAT THE NEW MESSAGE CHANGED, read BEFORE the categoriser — because the
    // one decision it feeds is whether the labels need re-reading at all, and
    // that has to be known before the categoriser claims its batch.
    //
    // It only ever claims a ticket that ALREADY has a case file, so a
    // genuinely new case costs nothing here and reaches the classifier
    // exactly as it did before.
    const continuations = new Set();
    if (readCaseFor && runsThrough('casework')) {
      const caseworkStore = createCaseworkStore(supabase, { caseStateRecord });
      // Who may owe a check here: support always, a colleague or an operations
      // partner only when a directory label this brand uses maps to one.
      const owners = obligationOwners({
        labels: [...new Set((await supabaseSelect(supabase, T.SENDER_DIRECTORY, { shop_id: shopId }, 'label')).map((r) => r.label))],
        actorByLabel: config.actorByLabel
      });
      const casework = await runCasework({
        store: caseworkStore,
        record,
        caseStateRecord,
        openai: readCaseFor.openai,
        model: readCaseFor.model,
        shopId,
        senderDirectory,
        owners,
        logger,
        limit,
        onReading: ({ ticket, reading }) => {
          if (!shouldRecategorise(reading.caseRelationship)) continuations.add(ticket.id);
        }
      });
      if (casework.considered > 0) {
        logger.info('casework.pass', { shopId, ...casework });
      }

      // STAGE 5: our messages and the back office's, received after the
      // mailbox cutover, read in date order per ticket.
      const cursors = (await supabaseSelect(supabase, T.SHOPS, { id: shopId }, 'sync_cursors'))[0]?.sync_cursors ?? {};
      const others = await runOtherMessageCasework({
        store: caseworkStore,
        record,
        caseStateRecord,
        openai: readCaseFor.openai,
        model: readCaseFor.model,
        shopId,
        senderDirectory,
        owners,
        since: cursors[CURSOR_KEYS.cutoverAt] ?? null,
        logger
      });
      if (others.considered > 0) {
        logger.info('casework.other_pass', { shopId, ...others });
      }
    }

    // Categorisation runs after ingestion but selects on the pending flag rather
    // than on what this poll just wrote, so a ticket missed by a crashed or
    // key-less earlier poll is caught up here.
    if (categorise && runsThrough('categorise')) {
      const categorised = await runCategorisation({
        record,
        categorise,
        logger,
        limit,
        // A continuation's labels still describe the thread, so the pass
        // completes without spending a call. Empty unless casework ran.
        labelsStillValid: (ticket) => continuations.has(ticket.id)
      });
      logger.info('categorise.pass', { shopId, ...categorised });
    }

    // ORDER RESOLUTION RUNS BEFORE THE INVESTIGATION, and that placement is the
    // whole point of it. `getOrderContext` is a READER: it returns whatever this
    // pass and the one below it stored on the ticket, and never queries for
    // itself, so that the agent is shown the one reviewable bundle rather than a
    // second, divergent derivation of the same facts. Which means an order the
    // resolver has not yet confirmed does not exist as far as the agent is
    // concerned.
    //
    // It used to run AFTER the investigation, and the cost was silent: every
    // first email quoting an order number was investigated blind. Measured on a
    // rehearsal of a real one — order #5144, quoted in the message, registered to
    // the sender's own address — `getOrderContext` answered « aucune commande
    // confirmée », the case file recorded the order as unverified, and the ticket
    // went to a human. Seconds later this pass confirmed it by email hash. The
    // deterministic check had the right answer and the expensive one wrote the
    // conclusion first.
    //
    // AFTER CATEGORISATION RATHER THAN BEFORE IT, deliberately: the only real
    // constraint is "before the pass that reads its output", and moving it any
    // earlier would change what `--stop-after=categorise` runs for no gain (see
    // PIPELINE_STAGES). It needs nothing from the categoriser either way.
    if (runsThrough('orders')) {
      const resolved = await runOrderResolution({
        store: orderResolutionStore,
        record,
        shopId,
        logger
      });
      if (resolved.considered > 0) {
        logger.info('order.resolution.pass', { shopId, ...resolved });
      }
    }

    // Context assembly consumes the resolver's output in the same poll: a ticket
    // whose order number was just confirmed gets its bundle immediately, so the
    // investigation below — and later the drafting pass — reads real order facts
    // rather than waiting a cycle for them.
    if (runsThrough('context')) {
      const contexts = await runOrderContext({
        store: orderContextStore,
        record,
        shopId,
        logger
      });
      if (contexts.considered > 0) {
        logger.info('order.context.pass', { shopId, ...contexts });
      }
    }

    // Investigation runs after categorisation and after the two order passes, and
    // consumes all three in the same poll: the categoriser raises
    // `needs_investigation` as it clears its own flag, and the order passes have
    // filled `resolved_context` by the time `getOrderContext` reads it. It is
    // also the only pass that chooses what to do, which is why its budget lives
    // in config rather than in code.
    if (investigation && runsThrough('investigate')) {
      const investigated = await runInvestigation({
        store: investigation.store,
        record,
        investigate: investigation.investigate,
        shopId,
        logger,
        // Reloaded each poll, like the blocklist, so a sender labelled in the
        // table a minute ago is context on this poll rather than the next.
        senderDirectory,
        retrieveExemplar: investigation.retrieveExemplar,
        // Null when AGENT_SITUATION_CHOOSER_MODEL is empty: near misses then keep
        // no situation, as they did before the chooser existed.
        chooseSituation: investigation.chooseSituation,
        loadAnswers: investigation.loadAnswers,
        loadCollectionMode: investigation.loadCollectionMode,
        parameters: await investigation.loadParameters(shopId),
        // The customer's last order, for a HUMAN, and only where no order was
        // confirmed. It fires less often now that the resolver runs first —
        // which is the point: it is the fallback for a ticket with no order,
        // not a substitute for one.
        lastOrderLookup: investigation.lastOrderLookup,
        // Where a follow-up's situation comes from: carried from the case state,
        // or matched on the new request when the Case Manager read one. Wired
        // only while the casework pass is on — with it off there is no case state
        // to plan from, and the opening message is matched as before.
        planSituation: readCaseFor ? createSituationPlanner(supabase, { shopId, caseStateRecord, logger }) : null
      });
      if (investigated.considered > 0) {
        logger.info('investigate.pass', { shopId, ...investigated });
      }
    }

    // THE FOLD, after everything that feeds it: the messages this poll stored,
    // the Case Manager's readings and the case files just written. No model. It
    // keeps `case_current` in step (stage 4) and moves each ticket's status to
    // what its next actor asks for (stage 5c). Before auto-close, so a case
    // resolved here is not then closed for silence.
    if (runsThrough('fold')) {
      const folded = await runFold({
        store: caseCurrentStore,
        shopId,
        actorFor: (message) => actorOf(message, senderDirectory, config.actorByLabel),
        statusMap: config.caseStatusByNextActor,
        keepOpenLevels: [...AUTO_CLOSE_EXEMPT_LEVELS],
        logger
      });
      if (folded.considered > 0) {
        logger.info('fold.pass', { shopId, ...folded });
      }
    }

    // DRAFTING IN THE POLL (stage 6), after the fold so each draft is written
    // against the case version the fold just settled, and only behind
    // DRAFT_IN_POLL. The gates (`pollGate`) keep it to our turn on a customer
    // message received since the mailbox cutover. Nothing is sent: a draft waits
    // for a person on the ticket page.
    if (drafting && runsThrough('draft')) {
      try {
        const cursors = (await supabaseSelect(supabase, T.SHOPS, { id: shopId }, 'sync_cursors'))[0]?.sync_cursors ?? {};
        const drafted = await runDrafting({
          store: drafting.store,
          draftRecord: drafting.record,
          openai: drafting.openai,
          brandVoice: await drafting.brandVoice.load(shopId),
          shopId,
          model: config.draftingModel,
          ...(await loadDraftingContext(supabase, shopId, logger)),
          senderDirectory,
          closureReader: config.closureModel
            ? ({ message, ticketId, senderDirectory: directory }) =>
                readsAsClosure({ openai: drafting.openai, model: config.closureModel, message, senderDirectory: directory, ticketId, logger })
            : null,
          cosmetovigilanceDraftOnly: config.draftOnlyCosmetovigilance,
          gates: 'poll',
          cutoverAt: cursors[CURSOR_KEYS.cutoverAt] ?? null,
          limit: config.draftPollLimit,
          logger
        });
        if (drafted.considered > 0) {
          logger.info('draft.pass', { shopId, ...drafted });
        }
      } catch (error) {
        // An unapproved brand voice or a store failure stops this pass, not the poll.
        logger.warn('draft.pass_failed', { shopId, reason: error.message });
      }
    }

    // THE SEND PASS: after the fold (so the pre-send check reads the case
    // version and thread this poll brought up to date) and after drafting (so
    // an auto-send can follow its draft). Only with OUTBOUND_SEND_ENABLED;
    // auto-send additionally needs DRAFT_ONLY=false. The ONLY pass that sends
    // a reply to a customer.
    if (runsThrough('send')) {
      try {
        const autoQueued = await createAutoSendActions({
          store: outboundStore,
          outboundRecord,
          jobs,
          draftOnly: config.draftOnly,
          enabled: config.outboundSendEnabled,
          logger,
          shopId
        });
        const sent = await runOutbound({
          jobs,
          outboundRecord,
          draftRecord: outboundDraftRecord,
          store: outboundStore,
          provider,
          enabled: config.outboundSendEnabled,
          stopBeforeSend: config.outboundStopBeforeSend,
          draftOnly: config.draftOnly,
          maxAttempts: config.mailJobMaxAttempts,
          logger,
          shopId
        });
        if (autoQueued.created > 0 || sent.considered > 0) {
          logger.info('outbound.pass', { shopId, autoQueued: autoQueued.created, ...sent });
        }
      } catch (error) {
        // A send failure is counted on its job; this is the pass itself failing
        // (the database), which must not stop forwarding or auto-close.
        logger.warn('outbound.pass_failed', { shopId, error: error.message });
      }
    }

    // Forwarding runs last: it reads the category and request_kind the step
    // above assigns. Like categorisation it selects on ticket state rather than
    // on what this poll wrote, so mail that became forwardable only because an
    // address was configured today is picked up without a backfill. A no-op
    // until the address book has at least one entry.
    if (runsThrough('forward')) {
      const forwarded = await runForwarding({
        store: forwardingStore,
        graphClient,
        shopId,
        logger,
        internalDomains: resolveInternalDomains({
          supportMailbox: config.graph.mailbox,
          extra: config.internalEmailDomains
        })
      });
      if (forwarded.considered > 0) {
        logger.info('forward.pass', { shopId, ...forwarded });
      }
    }

    // Auto-close runs after everything else, and last on purpose: it must see
    // the timestamps this poll just advanced, so a thread that received a reply
    // seconds ago is never retired by the same pass that ingested it.
    if (runsThrough('close')) {
      const autoClosed = await runAutoClose({ record, shopId, logger });
      if (autoClosed.closed > 0 || autoClosed.failed > 0) {
        logger.info('lifecycle.auto_close.pass', { shopId, ...autoClosed });
      }
    }

    // Retention runs whatever `--stop-after` says. Deleting personal data on
    // time is an obligation, not a pipeline stage, and a partial run is no
    // reason to leave a body past its expiry.
    //
    // Retention for the one piece of personal data this worker keeps outside
    // tickets: the body of a dropped email. Nulled past its expiry, decision row
    // untouched. Best-effort and last — a purge failure must not fail a poll
    // that has already ingested mail, and the next poll simply retries it.
    try {
      const purged = await auditStore.purgeExpiredBodies(shopId);
      if (purged > 0) {
        logger.info('ingest.spam_audit_bodies_purged', { shopId, purged });
      }
    } catch (error) {
      logger.warn('ingest.spam_audit_purge_failed', { shopId, error: error.message });
    }

    // The monthly sales report, on the 1st. Outside `--stop-after` like
    // retention: it is a date, not a pipeline stage, and the sync-only worker
    // is the one that is always running. A no-op until SALES_REPORT_URL and
    // SALES_REPORT_SECRET are set; its own failures are recorded and retried.
    try {
      await runSalesReportMail({
        supabase,
        graphClient,
        adminClient: reportAdminClient,
        shopId,
        config: config.salesReport,
        logger
      });
    } catch (error) {
      logger.warn('sales_report.check_failed', { shopId, error: error.message });
    }

    // What this poll spent, written once at the end.
    //
    // LAST, AND OUTSIDE `--stop-after`, for the same reason retention is: the
    // calls have already been billed, so a staged run must still record them.
    // Best-effort by contract — `flush` swallows its own failure and returns 0
    // written, because an accountant that can abort the pass is worse than a gap
    // in the ledger.
    if (usage.sink.size > 0) {
      const spent = await usage.flush();
      logger.info('llm_usage.flush', { shopId, ...spent });
    }
  };

  // One poll, with the `sync_mailbox` jobs that asked for it. They are claimed
  // before the read and closed once both folders are read; if the read fails
  // they are retried with backoff. A queue that cannot be read (migration 46
  // not applied) is logged and the poll runs as it always did.
  const pollWithJobs = async () => {
    let syncJobs = [];
    try {
      syncJobs = await jobs.claim({ kinds: ['sync_mailbox'], limit: 20, leaseSeconds: 600 });
    } catch (error) {
      logger.warn('mail_jobs.claim_failed', { shopId, error: error.message });
    }
    let ingested = false;
    try {
      await poll({
        afterIngest: async () => {
          ingested = true;
          for (const job of syncJobs) await jobs.complete(job.id).catch(() => {});
        }
      });
    } catch (error) {
      if (!ingested) {
        for (const job of syncJobs) {
          await jobs.fail(job, error, { maxAttempts: config.mailJobMaxAttempts }).catch(() => {});
        }
      }
      throw error;
    }
  };

  if (runOnce) {
    await pollWithJobs();
    return;
  }

  // Between timed polls, a due job wakes the worker early. `send_outbound`
  // counts only while sending is on: otherwise its jobs wait untouched and
  // would wake every check.
  const wakeKinds = ['sync_mailbox', ...(config.outboundSendEnabled ? ['send_outbound'] : [])];
  const waitForNextPoll = async (isStopping) => {
    const deadline = Date.now() + config.pollIntervalMs;
    while (!isStopping() && Date.now() < deadline) {
      await sleep(Math.max(1, Math.min(config.jobCheckIntervalMs, deadline - Date.now())), isStopping);
      if (isStopping()) return;
      const due = await jobs.hasDue({ kinds: wakeKinds }).catch(() => false);
      if (due) {
        logger.info('ingest.woken_by_job', { shopId });
        return;
      }
    }
  };

  logger.info('ingest.start', { shopId, intervalMs: config.pollIntervalMs, draftOnly: config.draftOnly });

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info('ingest.stopping', { signal });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (!stopping) {
    try {
      await pollWithJobs();
    } catch (error) {
      // Keep the loop alive across transient Graph/Supabase errors.
      // `error`, not `message`: the logger reserves `message` for the event name
      // and strips it from caller fields, so this detail was never reaching the
      // log at all (see lib/logger.mjs).
      logger.error('ingest.poll_failed', { error: error.message });
    }
    await waitForNextPoll(() => stopping);
  }

  logger.info('ingest.stopped', {});
}

/**
 * `--stop-after=<stage>` / `--stop-after <stage>`, or null for the whole pipeline.
 *
 * An unknown stage THROWS rather than defaulting to "run everything". A typo
 * (`--stop-after=categorize`) would otherwise silently run the very passes the
 * flag was reached for, which on a backlog means a model bill and, worse,
 * forwarded mail — the two things the flag exists to prevent.
 */
function parseStopAfter(argv) {
  const eq = argv.find((arg) => arg.startsWith('--stop-after='));
  const value = eq
    ? eq.slice('--stop-after='.length)
    : argv.indexOf('--stop-after') >= 0
      ? argv[argv.indexOf('--stop-after') + 1]
      : null;

  if (value === null || value === undefined) {
    return null;
  }
  const stage = String(value).trim().toLowerCase();
  if (!PIPELINE_STAGES.includes(stage)) {
    throw new Error(
      `Unknown --stop-after stage "${value}". Expected one of: ${PIPELINE_STAGES.join(', ')}.`
    );
  }
  return stage;
}

/**
 * `--also=<stage>[,<stage>]`: stages to run on top of `--stop-after`.
 *
 * Only `send` is accepted. It needs nothing from the stages it would skip: the
 * pre-send check reads the case version the last full run folded and the
 * messages this poll stored, and refuses when those have moved. Opening the
 * flag to a model stage would make a "sync-only" worker spend money, which is
 * what the flag is for avoiding. An unknown stage throws, like `--stop-after`.
 */
function parseAlso(argv) {
  const eq = argv.find((arg) => arg.startsWith('--also='));
  if (!eq) return new Set();
  const stages = eq.slice('--also='.length).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const stage of stages) {
    if (stage !== 'send') {
      throw new Error(`--also accepts only "send"; got "${stage}".`);
    }
  }
  return new Set(stages);
}

function parseLimit(argv) {
  const eq = argv.find((arg) => arg.startsWith('--limit='));
  if (eq) return toPositiveInt(eq.slice('--limit='.length));
  const i = argv.indexOf('--limit');
  if (i >= 0) return toPositiveInt(argv[i + 1]);
  return undefined;
}

function toPositiveInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function sleep(ms, isCancelled) {
  return new Promise((resolve) => {
    const step = Math.min(ms, 1000);
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += step;
      if (elapsed >= ms || isCancelled?.()) {
        clearInterval(timer);
        resolve();
      }
    }, step);
  });
}

main().catch((error) => {
  logger.error('ingest.fatal', { error: error.message });
  process.exitCode = 1;
});
