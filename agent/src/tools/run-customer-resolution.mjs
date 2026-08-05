import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createCustomerLookup } from '../retrieval/customer-lookup.mjs';
import {
  createCustomerResolutionStore,
  runCustomerResolution
} from '../resolution/customer-resolution-runner.mjs';

// Links tickets.customer_id from the address each ticket was opened with.
//
//   npm run customers:resolve:dry-run
//   npm run customers:resolve
//
// The same pass the worker runs after every ingestion; here it is on demand, for
// the initial backfill over tickets that predate it. Nothing is printed but a
// ticket id and an outcome — the address and the customer stay out of the
// terminal, exactly as they stay out of the logs.
//
// `--dry-run` withholds the ticket writes, NOT the audit trail: a matched
// customer has been read either way, and a `data_access_events` row is what says
// so. Only the link and its metadata are held back.

const dryRun = process.argv.includes('--dry-run');

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const store = createCustomerResolutionStore(supabase);
  const lookup = createCustomerLookup({ supabase, shopId, logger });

  console.log(`\n${dryRun ? 'DRY RUN — nothing written.' : 'Resolving customers.'}\n`);

  const totals = await runCustomerResolution({
    store,
    lookup,
    shopId,
    logger,
    dryRun,
    excludedEmails: [config.graph.mailbox].filter(Boolean),
    onResult: ({ ticket, resolution }) => {
      console.log(`  ${ticket.id} — ${resolution.status}`);
    }
  });

  console.log('\n' + JSON.stringify(totals, null, 1));
}
