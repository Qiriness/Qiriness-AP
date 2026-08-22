import { createSupabaseClient, supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';
import { createDuplicateLookup, findDuplicate } from '../ingestion/duplicate-rules.mjs';

// Links tickets that duplicate an earlier one, for mail ingested before the
// check existed.
//
//   npm run duplicate:backfill:dry-run     # show every link it would make
//   npm run duplicate:backfill             # write them
//
// READ THE DRY RUN. THIS ONE SUPPRESSES REPLIES. Unlike the related backfill,
// a link written here removes a ticket from the drafting AND investigation
// queues — that is the point, and it is also the whole risk: a ticket linked
// wrongly gets no reply at all. Every line of the dry run is a customer who
// will not be answered on that thread.
//
// STRICTLY BACKWARDS. `findDuplicate`'s body rule compares absolute elapsed
// time, because at ingestion the candidate is by definition the newer message
// and order cannot be wrong. Replaying over stored history has no such
// guarantee — Graph's delta does not return messages in order, so a naive
// replay can link the OLDER ticket to the newer one and suppress the original
// instead of the copy. The pool is therefore filtered to messages strictly
// earlier than the candidate, which also makes cycles impossible.
//
// AN EXISTING DRAFT IS NOT DELETED, and is reported instead. A draft written
// before the link is still in the review queue; the dialog now warns on it, but
// somebody should know it is there.

const dryRun = process.argv.includes('--dry-run');

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const record = createTicketRecord(supabase, { shopId });
  const lookup = createDuplicateLookup({ supabase, shopId, select: supabaseSelect });

  console.log(
    `\n${dryRun ? 'DRY RUN — nothing will be written.' : 'Writing duplicate links.'}\n` +
      'Each line is a ticket that will STOP receiving a drafted reply.\n'
  );

  const tickets = await supabaseSelect(
    supabase,
    'tickets',
    { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } },
    'id,requester_name,requester_email_hash,duplicate_of_ticket_id,first_message_at',
    { order: 'first_message_at.asc' }
  );
  const nameById = new Map(tickets.map((t) => [t.id, t.requester_name || '?']));

  const totals = { considered: 0, linked: 0, withDraft: 0, alreadyLinked: 0 };

  for (const ticket of tickets) {
    if (ticket.duplicate_of_ticket_id) {
      totals.alreadyLinked += 1;
      continue;
    }
    const [candidate] = await supabaseSelect(
      supabase,
      'ticket_messages',
      { shop_id: shopId, ticket_id: ticket.id, direction: 'inbound' },
      'ticket_id,internet_message_id,in_reply_to,reference_ids,body_text,received_at',
      { order: 'received_at.asc', limit: 1 }
    );
    if (!candidate) {
      continue;
    }
    totals.considered += 1;

    const pool = await lookup.priorMessages({
      requesterEmailHash: ticket.requester_email_hash,
      before: candidate.received_at
    });
    // Strictly earlier, and never this ticket's own messages.
    const at = Date.parse(candidate.received_at);
    const priorMessages = pool.filter(
      (m) => m.ticket_id !== ticket.id && Date.parse(m.received_at) < at
    );

    const hit = findDuplicate({ candidate, priorMessages });
    if (!hit?.ticketId || hit.ticketId === ticket.id) {
      continue;
    }

    const drafts = await supabaseSelect(
      supabase,
      'ticket_drafts',
      { shop_id: shopId, ticket_id: ticket.id },
      'id',
      { limit: 1 }
    );

    totals.linked += 1;
    if (drafts.length > 0) {
      totals.withDraft += 1;
    }
    console.log(
      `  ${hit.reason.padEnd(14)} ${String(ticket.requester_name || '?').slice(0, 22).padEnd(22)} ` +
        `-> ${nameById.get(hit.ticketId)?.slice(0, 22) ?? hit.ticketId.slice(0, 8)}` +
        `${drafts.length > 0 ? '   [HAS A DRAFT ALREADY]' : ''}`
    );

    if (!dryRun) {
      await record.linkDuplicate(ticket.id, { ofTicketId: hit.ticketId, reason: hit.reason });
    }
  }

  console.log(
    `\nconsidered ${totals.considered} | linked ${totals.linked} | ` +
      `of which already hold a draft ${totals.withDraft} | already linked ${totals.alreadyLinked}\n`
  );
}
