import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createChangeRouterStore, runChangeRouter } from '../casework/change-router-runner.mjs';

// Runs the change router on its own: no mailbox read and no model call.
// DECISIONS.md § Change router.
//
//   npm run route:once -- --dry-run   # what each open ticket would get, nothing written
//   npm run route:once                # write the drifts and queue the re-investigations
//
// Run `npm run context:build` first to rebuild the bundles the orders have
// moved past: the router compares the bundle it finds.

const dryRun = process.argv.includes('--dry-run');

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  console.log(`\n${dryRun ? 'DRY RUN — nothing written.' : 'Routing.'}\n`);

  const totals = await runChangeRouter({
    store: createChangeRouterStore(supabase, { shopId }),
    shopId,
    logger,
    dryRun,
    onResult: ({ ticket, result, written }) => {
      const moved = Object.entries(result.changed)
        .map(([state, { from, to }]) => `${state} ${from} → ${to}`)
        .join(', ');
      console.log(
        `  ${ticket.id.slice(0, 8)} ${ticket.shopify_order_number} — ${result.outcome} (${result.reason})` +
          `${moved ? `: ${moved}` : ''}${written ? ' [written]' : ''}`
      );
    }
  });

  console.log('\n' + JSON.stringify(totals, null, 1));
}
