import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createOrderContextStore, runOrderContext } from '../resolution/order-context-runner.mjs';

// Assembles tickets.resolved_context for every ticket with a confirmed order.
//
//   npm run context:build:dry-run
//   npm run context:build
//   npm run context:build -- --refresh     # rebuild after an orders sync
//
// Runs after the order-number resolver and consumes its output; a ticket is only
// eligible once shopify_order_number was CONFIRMED.

const dryRun = process.argv.includes('--dry-run');
const refresh = process.argv.includes('--refresh');

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const store = createOrderContextStore(supabase);

  console.log(`\n${dryRun ? 'DRY RUN — nothing written.' : 'Building context.'}${refresh ? ' (refreshing all)' : ''}\n`);

  const totals = await runOrderContext({
    store, shopId, logger, dryRun, refresh,
    onResult: ({ ticket, context, reason }) => {
      console.log(
        `  ${ticket.shopify_order_number} — ` +
          (context
            ? `${context.order.delivery.state}, ${context.order.items.length} item(s)` +
              `${context.signals.hasTracking ? ', tracked' : ''}`
            : `SKIPPED (${reason})`)
      );
    }
  });

  console.log('\n' + JSON.stringify(totals, null, 1));
}
