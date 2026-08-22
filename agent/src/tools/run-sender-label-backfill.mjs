import { createSupabaseClient, supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';
import { OWN_SIDE_LABELS, createSenderDirectoryStore } from '../ingestion/sender-directory.mjs';

// Stamps `tickets.sender_label` for threads opened by one of our own addresses,
// for mail ingested before the column existed.
//
//   npm run sender-label:backfill:dry-run
//   npm run sender-label:backfill
//
// THE OPENING MESSAGE DECIDES, exactly as it does at ingestion: a thread a
// colleague started stays theirs even after a customer is cc'd onto it. Graph's
// delta is not chronological, so "opening" is the earliest inbound message by
// received_at rather than whichever arrived first.
//
// A stamped ticket stops receiving drafted replies. Investigation is untouched:
// a colleague chasing a real order still needs the facts gathered.

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
  const directory = await createSenderDirectoryStore(supabase).load(shopId, {
    supportMailbox: config.graph.mailbox
  });

  console.log(
    `\n${dryRun ? 'DRY RUN — nothing will be written.' : 'Writing sender labels.'}\n` +
      'Each line is a ticket that will STOP receiving a drafted reply.\n'
  );

  const tickets = await supabaseSelect(
    supabase,
    'tickets',
    { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } },
    'id,subject,category,sender_label,first_message_at',
    { order: 'first_message_at.asc' }
  );

  const totals = { considered: 0, labelled: 0, withDraft: 0, alreadyLabelled: 0 };

  for (const ticket of tickets) {
    if (ticket.sender_label) {
      totals.alreadyLabelled += 1;
      continue;
    }
    const [opening] = await supabaseSelect(
      supabase,
      'ticket_messages',
      { shop_id: shopId, ticket_id: ticket.id, direction: 'inbound' },
      'from_email,subject,received_at',
      { order: 'received_at.asc', limit: 1 }
    );
    if (!opening) {
      continue;
    }
    totals.considered += 1;

    const label = directory.lookup(opening.from_email)?.label ?? null;
    if (!OWN_SIDE_LABELS.includes(label)) {
      continue;
    }

    const drafts = await supabaseSelect(
      supabase,
      'ticket_drafts',
      { shop_id: shopId, ticket_id: ticket.id },
      'id',
      { limit: 1 }
    );

    totals.labelled += 1;
    if (drafts.length > 0) {
      totals.withDraft += 1;
    }
    console.log(
      `  ${label.padEnd(10)} ${String(opening.from_email).padEnd(30)} ` +
        `${String(ticket.category ?? '?').padEnd(16)} ${String(ticket.subject ?? '').slice(0, 34)}` +
        `${drafts.length > 0 ? '   [HAS A DRAFT]' : ''}`
    );

    if (!dryRun) {
      await record.setSenderLabel(ticket.id, label);
    }
  }

  console.log(
    `\nconsidered ${totals.considered} | labelled ${totals.labelled} | ` +
      `of which already hold a draft ${totals.withDraft} | already labelled ${totals.alreadyLabelled}\n`
  );
}
