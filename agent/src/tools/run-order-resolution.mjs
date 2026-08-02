import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createOrderResolutionStore, runOrderResolution } from '../resolution/order-resolution-runner.mjs';

// Resolves order numbers onto tickets, on its own.
//
//   npm run orders:resolve:dry-run
//   npm run orders:resolve
//
// Only a confirmed match (the order's email hash equals the ticket's) is ever
// written to `tickets.shopify_order_number`; everything else is recorded in
// `metadata.order_resolution` for a human.

const dryRun = process.argv.includes('--dry-run');
const verbose = process.argv.includes('--verbose');

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const store = createOrderResolutionStore(supabase);

  console.log(`\n${dryRun ? 'DRY RUN — nothing will be written.' : 'Writing resolutions.'}\n`);

  let shown = 0;
  const totals = await runOrderResolution({
    store,
    shopId,
    logger,
    dryRun,
    onResult: ({ ticket, resolution }) => {
      if (!verbose && resolution.status !== 'confirmed' && resolution.status !== 'mismatch') return;
      if (shown++ > 25) return;
      console.log(
        `  [${resolution.status}] ${resolution.orderName || resolution.candidates.join(',') || '-'} ` +
          `— "${String(ticket.subject || '').slice(0, 50)}"`
      );
    }
  });

  console.log('\n' + JSON.stringify(totals, null, 1));
}
