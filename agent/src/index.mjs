import { createSupabaseClient } from '../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig, assertGraphConfig } from './config.mjs';
import { logger } from './lib/logger.mjs';
import { resolveShopId } from './lib/shop.mjs';
import { createGraphClient } from './ingestion/graph-client.mjs';
import { createSupabaseTicketStore } from './ingestion/ticket-writer.mjs';
import { createBlocklistStore } from './ingestion/blocklist-store.mjs';
import { createSupabaseSpamAuditStore } from './ingestion/spam-audit.mjs';
import { runDeltaPoll, createSupabaseCursorStore } from './ingestion/delta-poller.mjs';
import { createOpenAIClient } from './llm/openai-client.mjs';
import { createSpamClassifier } from './ingestion/spam-classifier.mjs';
import { createCategoriser } from './pipeline/categorise.mjs';
import { runCategorisation, createSupabaseCategoriserStore } from './pipeline/categorise-runner.mjs';

async function main() {
  const runOnce = process.argv.includes('--once');
  const limit = parseLimit(process.argv);
  const config = loadAgentConfig();
  assertGraphConfig(config);

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  const graphClient = createGraphClient(config);
  const store = createSupabaseTicketStore(supabase);
  const cursorStore = createSupabaseCursorStore(supabase);
  const blocklistStore = createBlocklistStore(supabase);
  // Records why each email passed or failed the gate. Dropped mail is never
  // written anywhere else, so this is its only trace.
  const auditStore = createSupabaseSpamAuditStore(supabase);

  // LLM stages — enabled only when an OpenAI key is present. Without it,
  // ingestion still runs and just relies on the blocklist; tickets then stay
  // uncategorised until a key is configured, and the next poll catches them up.
  let triage;
  let categorise;
  const categoriserStore = createSupabaseCategoriserStore(supabase);
  if (config.openaiApiKey) {
    const openai = createOpenAIClient({ apiKey: config.openaiApiKey });
    triage = createSpamClassifier(openai, { model: config.triageModel, logger }).triage;
    categorise = createCategoriser(openai, { model: config.categoriserModel }).categorise;
  } else {
    logger.warn('ingest.llm_filter_disabled', { reason: 'OPENAI_API_KEY not set' });
  }

  const poll = async () => {
    // Load the blocklist each poll so newly added rules take effect immediately.
    const { gate, rulesById } = await blocklistStore.loadGate(shopId);
    const totals = await runDeltaPoll({
      graphClient,
      store,
      cursorStore,
      shopId,
      logger,
      spamGate: gate,
      recordSpamHits: (hits) => blocklistStore.recordHits(rulesById, hits),
      auditStore,
      triage,
      limit
    });
    logger.info('ingest.poll', { shopId, ...totals });

    // Categorisation runs after ingestion but selects on "category is null"
    // rather than on what this poll just wrote, so a ticket missed by a crashed
    // or key-less earlier poll is caught up here.
    if (categorise) {
      const categorised = await runCategorisation({
        store: categoriserStore,
        categorise,
        shopId,
        logger
      });
      logger.info('categorise.pass', { shopId, ...categorised });
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
      logger.error('ingest.poll_failed', { message: error.message });
    }
    await sleep(config.pollIntervalMs, () => stopping);
  }

  logger.info('ingest.stopped', {});
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
  logger.error('ingest.fatal', { message: error.message });
  process.exitCode = 1;
});
