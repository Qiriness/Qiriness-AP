import { createSupabaseClient, supabaseSelect } from '../../scripts/lib/supabase-rest-client.mjs';
import { createTicketRecord } from '../../scripts/lib/ticket-record.mjs';

import { loadAgentConfig, assertGraphConfig } from './config.mjs';
import { logger } from './lib/logger.mjs';
import { resolveShopId } from './lib/shop.mjs';
import { createGraphClient } from './ingestion/graph-client.mjs';
import { createSupabaseMessageStore } from './ingestion/ticket-writer.mjs';
import { createBlocklistStore } from './ingestion/blocklist-store.mjs';
import { OWN_SIDE_LABELS, createSenderDirectoryStore } from './ingestion/sender-directory.mjs';
import { createDuplicateLookup, findDuplicate } from './ingestion/duplicate-rules.mjs';
import { createRelatedLookup, findRelated } from './ingestion/related-rules.mjs';
import { exemptKnownSenders } from './ingestion/known-senders.mjs';
import { createSupabaseSpamAuditStore } from './ingestion/spam-audit.mjs';
import { runDeltaPoll, createSupabaseCursorStore } from './ingestion/delta-poller.mjs';
import { createOpenAIClient } from './llm/openai-client.mjs';
import { createShopUsageRecording } from './llm/usage-store.mjs';
import { createSpamClassifier } from './ingestion/spam-classifier.mjs';
import { createEmbeddingsClient } from '../../scripts/lib/embeddings/openai-embeddings-client.mjs';
import { createMessageEmbedder } from './ingestion/message-embedder.mjs';
import { createCategoriser } from './pipeline/categorise.mjs';
import { runCategorisation } from './pipeline/categorise-runner.mjs';
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
import { runAutoClose } from './lifecycle/auto-close.mjs';
import { resolveInternalDomains } from '../../scripts/lib/message-audience.mjs';

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
const PIPELINE_STAGES = [
  'ingest',
  'customers',
  'categorise',
  'investigate',
  'orders',
  'context',
  'forward',
  'close'
];

async function main() {
  const runOnce = process.argv.includes('--once');
  const limit = parseLimit(process.argv);
  const stopAfter = parseStopAfter(process.argv);
  // Ordered membership, not a set: stopping AFTER a stage runs every stage up to
  // and including it.
  const runsThrough = (stage) =>
    stopAfter === null || PIPELINE_STAGES.indexOf(stage) <= PIPELINE_STAGES.indexOf(stopAfter);
  const config = loadAgentConfig();
  assertGraphConfig(config);

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  const graphClient = createGraphClient(config);
  // ONE ticket record for the whole poll, shared by every pass below. It is the
  // only writer of `tickets` in the codebase; each pass hands it columns and it
  // owns the flags, the filters, the lifecycle timestamps and the metadata
  // trail. See scripts/lib/ticket-record.mjs.
  const record = createTicketRecord(supabase, { shopId });
  const store = createSupabaseMessageStore(supabase);
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
      skipping: PIPELINE_STAGES.slice(PIPELINE_STAGES.indexOf(stopAfter) + 1)
    });
  }

  const poll = async () => {
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

    const totals = await runDeltaPoll({
      graphClient,
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
      limit
    });
    logger.info('ingest.poll', { shopId, ...totals });

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

    // Categorisation runs after ingestion but selects on the pending flag rather
    // than on what this poll just wrote, so a ticket missed by a crashed or
    // key-less earlier poll is caught up here.
    if (categorise && runsThrough('categorise')) {
      const categorised = await runCategorisation({
        record,
        categorise,
        logger,
        limit
      });
      logger.info('categorise.pass', { shopId, ...categorised });
    }

    // Investigation runs immediately after categorisation and consumes its
    // output in the same poll: the categoriser raises `needs_investigation` as
    // it clears its own flag, so a ticket labelled seconds ago gets its case
    // file now rather than a poll later. It is also the only pass that chooses
    // what to do, which is why its budget lives in config rather than in code.
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
        lastOrderLookup: investigation.lastOrderLookup
      });
      if (investigated.considered > 0) {
        logger.info('investigate.pass', { shopId, ...investigated });
      }
    }

    // Order-number resolution runs after categorisation and before forwarding:
    // it needs nothing from the categoriser, but every order tool downstream
    // needs its output, and it must not delay the forwarding pass behind a
    // Shopify-shaped failure.
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

    // Context assembly consumes the resolver's output in the same poll: a
    // ticket whose order number was just confirmed gets its bundle immediately,
    // so a drafting step never has to wait a cycle for context.
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

  if (runOnce) {
    await poll();
    return;
  }

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
      await poll();
    } catch (error) {
      // Keep the loop alive across transient Graph/Supabase errors.
      // `error`, not `message`: the logger reserves `message` for the event name
      // and strips it from caller fields, so this detail was never reaching the
      // log at all (see lib/logger.mjs).
      logger.error('ingest.poll_failed', { error: error.message });
    }
    await sleep(config.pollIntervalMs, () => stopping);
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
