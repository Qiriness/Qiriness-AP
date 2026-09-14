import { createSupabaseClient, supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';

import { loadAgentConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';

// Puts named tickets back in the investigation queue, after a repair changed
// what an earlier investigation was reading.
//
//   npm run tickets:requeue:dry-run -- --ticket <uuid> [--ticket <uuid>] [--unlink-customer] [--reopen]
//   npm run tickets:requeue -- --ticket <uuid> --unlink-customer --reopen
//
// --unlink-customer  clears customer_id, so `customers:resolve` links the ticket
//                    again from its (repaired) requester. Run that next.
// --reopen           sets a non-open ticket back to `open`. Without it the
//                    investigation runs but, by rule, does not move a ticket it
//                    did not claim from the open queue — so a status set by a
//                    run against the wrong identity would stand. Use only where
//                    that status came from the agent, not from a person.
//
// NAMED TICKETS ONLY. There is deliberately no "all" switch: `investigate
// --backfill` already exists for the whole queue, and this is the scalpel.

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const unlink = args.includes('--unlink-customer');
const reopen = args.includes('--reopen');
const ticketIds = args.flatMap((arg, i) => (arg === '--ticket' && args[i + 1] ? [args[i + 1]] : []));

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  if (ticketIds.length === 0) {
    throw new Error('Name at least one ticket: --ticket <uuid>');
  }
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const record = createTicketRecord(supabase, { shopId });

  console.log(`\n${dryRun ? 'DRY RUN — nothing will be written.' : 'Requeueing.'}\n`);

  for (const id of ticketIds) {
    const [ticket] = await supabaseSelect(
      supabase,
      'tickets',
      { shop_id: shopId, id },
      'id,status,customer_id,needs_categorisation,needs_investigation'
    );
    if (!ticket) {
      console.log(`  ${id} — not found in this shop`);
      continue;
    }

    const steps = [];
    if (unlink && ticket.customer_id) steps.push('unlink customer');
    if (reopen && ticket.status !== 'open') steps.push(`reopen (was ${ticket.status})`);
    if (ticket.needs_categorisation) steps.push('still awaiting categorisation — not queued');
    else if (ticket.needs_investigation) steps.push('already queued');
    else steps.push('queue for investigation');
    console.log(`  ${id} — ${steps.join(', ')}`);

    if (dryRun) continue;

    if (unlink && ticket.customer_id) {
      await record.unlinkCustomer(id);
    }
    if (reopen && ticket.status !== 'open') {
      await record.setStatus(id, 'open');
    }
    if (!ticket.needs_categorisation && !ticket.needs_investigation) {
      // raiseFor keeps its own guards (open, categorised, live); a ticket that
      // is not open here is left unqueued, and the count says so.
      const queued = await record.raiseFor('investigation', { where: { id } });
      if (queued === 0) {
        console.log(`    not queued: ticket is not open (pass --reopen)`);
      }
    }
  }
  console.log('');
}
