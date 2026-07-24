import { createSupabaseClient, supabaseSelect } from '../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig, assertGraphConfig } from './config.mjs';
import { logger } from './lib/logger.mjs';
import { createGraphClient } from './ingestion/graph-client.mjs';
import { createSupabaseTicketStore } from './ingestion/ticket-writer.mjs';
import { runDeltaPoll, createSupabaseCursorStore } from './ingestion/delta-poller.mjs';

async function resolveShopId(supabase, shopDomain) {
  const rows = await supabaseSelect(supabase, 'shops', { shop_domain: shopDomain }, 'id,shop_domain');
  if (rows.length === 0) {
    throw new Error(`No shops row for domain ${shopDomain}. Run the Shopify sync first.`);
  }
  return rows[0].id;
}

async function main() {
  const runOnce = process.argv.includes('--once');
  const config = loadAgentConfig();
  assertGraphConfig(config);

  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  const graphClient = createGraphClient(config);
  const store = createSupabaseTicketStore(supabase);
  const cursorStore = createSupabaseCursorStore(supabase);

  const poll = async () => {
    const totals = await runDeltaPoll({ graphClient, store, cursorStore, shopId, logger });
    logger.info('ingest.poll', { shopId, ...totals });
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
