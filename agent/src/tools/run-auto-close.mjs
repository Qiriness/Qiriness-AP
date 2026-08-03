import {
  createSupabaseClient,
  supabaseSelectAll,
  supabaseUpdateById
} from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { AUTO_CLOSE_AFTER_DAYS, createAutoCloseStore, runAutoClose } from '../lifecycle/auto-close.mjs';

// Runs the auto-close pass on its own, without a mailbox poll or any LLM call.
//
// The worker already does this at the end of every poll; this exists so the
// first one can be rehearsed. That first run is not a trickle — on the measured
// mailbox it closes 510 of 565 tickets in a single pass, because nothing had
// ever closed one before. Read the dry run before letting it write.
//
//   npm run tickets:autoclose:dry-run    # decide everything, write nothing
//   npm run tickets:autoclose            # actually close
//
// Needs no Graph credentials: this pass only reads and writes Supabase.

const dryRun = process.argv.includes('--dry-run');

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const store = createAutoCloseStore(supabase, { supabaseSelectAll, supabaseUpdateById });

  console.log(
    `\n${dryRun ? 'DRY RUN — nothing will be written.' : 'Closing for real.'}\n` +
      `inactivity window: ${AUTO_CLOSE_AFTER_DAYS} days\n` +
      'exempt: level 4 (legal threat, hospitalisation, grave danger)\n'
  );

  let shown = 0;
  const totals = await runAutoClose({
    store,
    shopId,
    logger,
    dryRun,
    onPreview: (ticket) => {
      shown += 1;
      // Only the first 20, or the first run prints 500 lines nobody reads.
      if (shown > 20) return;
      const age = Math.floor((Date.now() - Date.parse(ticket.last_message_at)) / 86400000);
      console.log(
        `  ${String(shown).padStart(3)}. [L${ticket.level ?? '-'}] idle ${String(age).padStart(3)}d  ` +
          `"${String(ticket.subject || '').replace(/\s+/g, ' ').trim().slice(0, 64)}"`
      );
    }
  });

  if (shown > 20) {
    console.log(`  … and ${shown - 20} more.`);
  }

  console.log(
    `\n${dryRun ? 'Would close' : 'Closed'} ${totals.closed} of ${totals.considered} inactive ` +
      `ticket(s); ${totals.exempt} exempt, ${totals.failed} failed.`
  );
  if (dryRun && totals.closed > 0) {
    console.log('Nothing was written. Re-run without --dry-run to close them.\n');
  }
}
