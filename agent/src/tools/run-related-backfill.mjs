import { createSupabaseClient, supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';
import { createSenderDirectoryStore } from '../ingestion/sender-directory.mjs';
import { createRelatedLookup, findRelated } from '../ingestion/related-rules.mjs';

// Links tickets that continue an earlier one, for mail ingested before the
// check existed.
//
//   npm run related:backfill:dry-run     # show every link it would make
//   npm run related:backfill             # write them
//
// SAFE TO RE-RUN AND SAFE TO STOP. It reads the same rules ingestion uses and
// writes the same three columns; a ticket already linked is skipped, so a
// second run costs queries and changes nothing.
//
// NOTHING HERE SUPPRESSES A DRAFT. A related link adds thread context and, when
// we never answered, turns the next reply into one that opens with an apology.
// That is why a backfill over historical mail is safe in a way the duplicate
// equivalent would not be.

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

  const senderDirectory = await createSenderDirectoryStore(supabase).load(shopId, {
    supportMailbox: config.graph.mailbox
  });
  const lookup = createRelatedLookup({
    supabase,
    shopId,
    select: supabaseSelect,
    senderDirectory
  });

  console.log(`\n${dryRun ? 'DRY RUN — nothing will be written.' : 'Writing related links.'}\n`);

  const tickets = await supabaseSelect(
    supabase,
    'tickets',
    { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } },
    'id,requester_name,requester_email_hash,related_ticket_id,related_score,first_message_at',
    { order: 'first_message_at.asc' }
  );

  const totals = { considered: 0, linked: 0, chases: 0, cleared: 0, skipped: 0 };

  for (const ticket of tickets) {
    // The ticket's own opening message is the candidate: the question is
    // whether THIS ticket continues an earlier one.
    const [candidate] = await supabaseSelect(
      supabase,
      'ticket_messages',
      { shop_id: shopId, ticket_id: ticket.id, direction: 'inbound' },
      'ticket_id,from_email,received_at,embedding',
      { order: 'received_at.asc', limit: 1 }
    );
    if (!candidate?.embedding) {
      continue;
    }
    totals.considered += 1;

    const { priorMessages, outboundAt } = await lookup.priorMessages({
      requesterEmailHash: ticket.requester_email_hash,
      fromEmail: candidate.from_email,
      before: candidate.received_at
    });
    const hit = findRelated({ candidate, priorMessages, outboundAt });

    // RECONCILE, NOT APPEND. A related link is derived, so a stored one that
    // the rule no longer produces is wrong rather than historical — and after
    // the contact-form repair corrected 52 message bodies, six of nine links
    // rested on text that no longer exists.
    if (!hit || hit.ticketId === ticket.id) {
      if (ticket.related_ticket_id) {
        totals.cleared += 1;
        console.log(
          `  CLEARED  ${String(ticket.requester_name || '?').slice(0, 24)}` +
            `   (was ${Number(ticket.related_score).toFixed(3)})`
        );
        if (!dryRun) {
          await record.clearRelated(ticket.id);
        }
      }
      continue;
    }

    if (ticket.related_ticket_id === hit.ticketId) {
      totals.skipped += 1;
      continue;
    }

    totals.linked += 1;
    if (hit.chased) {
      totals.chases += 1;
    }
    console.log(
      `  ${hit.score.toFixed(3)}  ${String((hit.gap / 86400000).toFixed(1) + 'd').padStart(6)}  ` +
        `${hit.chased ? 'CHASE ' : '      '}  ${String(ticket.requester_name || '?').slice(0, 24)}`
    );

    if (!dryRun) {
      await record.linkRelated(ticket.id, { toTicketId: hit.ticketId, score: hit.score });
    }
  }

  console.log(
    `\nconsidered ${totals.considered} | linked ${totals.linked} | ` +
      `of which unanswered chases ${totals.chases} | already linked ${totals.skipped}\n`
  );
}
