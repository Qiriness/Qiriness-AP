import {
  createSupabaseClient,
  supabaseSelectAll,
  supabaseUpdateById
} from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { OWN_SIDE_LABELS, createSenderDirectoryStore } from '../ingestion/sender-directory.mjs';
import { actorOf } from '../casework/actors.mjs';
import { directionFor } from '../ingestion/ticket-writer.mjs';

// Re-files, as `outbound`, the stored replies a colleague sent the customer
// from a personal inbox. Ingestion does this for new mail since 2026-09-26
// (`isStaffReplyToCustomer`); this applies the same rule to what was stored
// before.
//
//   npm run staff-replies:backfill:dry-run
//   npm run staff-replies:backfill
//
// ONLY THE DIRECTION MOVES. Reopens and re-categorisations these messages
// caused in the past are history and are not undone: nothing records which
// status a ticket had before, and guessing would overwrite a person's decision.
//
// RUN IT AFTER ANY FULL READ STILL IN PROGRESS WITH OLDER CODE: the message
// upsert rewrites `direction`, so an older writer would file them inbound again.

const dryRun = process.argv.includes('--dry-run');

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const directory = await createSenderDirectoryStore(supabase).load(shopId, {
    supportMailbox: config.graph.mailbox
  });
  // The same labeller the worker passes the writer (index.mjs).
  const senderLabel = (fromEmail) => {
    const label = directory.lookup(fromEmail)?.label ?? null;
    return OWN_SIDE_LABELS.includes(label) ? label : null;
  };

  console.log(`\n${dryRun ? 'DRY RUN — nothing will be written.' : 'Re-filing staff replies as outbound.'}\n`);

  const tickets = new Map(
    (await supabaseSelectAll(supabase, 'tickets', { shop_id: shopId }, 'id,requester_email_hash,sender_label')).map(
      (ticket) => [ticket.id, ticket]
    )
  );
  // RECONCILES BOTH WAYS. Every message from a staff address other than the
  // support mailbox itself (which is outbound by the mapper's own rule) is set
  // to what the rule says today. A thread labelled after a message was
  // re-filed — the 125 labels restored on 2026-09-26 — sends its colleague
  // messages back to inbound.
  const mailbox = String(config.graph.mailbox || '').toLowerCase();
  const staff = (
    await supabaseSelectAll(supabase, 'ticket_messages', { shop_id: shopId }, 'id,ticket_id,direction,from_email,to_emails,cc_emails')
  ).filter((m) => senderLabel(m.from_email) === 'internal' && String(m.from_email).toLowerCase() !== mailbox);

  const changes = [];
  for (const message of staff) {
    const wanted = directionFor(message, tickets.get(message.ticket_id), senderLabel, config.graph.mailbox);
    if (wanted !== message.direction) changes.push({ ...message, wanted });
  }
  const toOutbound = changes.filter((c) => c.wanted === 'outbound');
  const toInbound = changes.filter((c) => c.wanted === 'inbound');
  console.log(
    `${staff.length} messages from staff addresses · ${toOutbound.length} to file as outbound ` +
      `(${new Set(toOutbound.map((m) => m.ticket_id)).size} tickets) · ${toInbound.length} back to inbound ` +
      `(${new Set(toInbound.map((m) => m.ticket_id)).size} tickets).`
  );

  if (dryRun) {
    console.log('\nNothing was written. Re-run without --dry-run to apply.\n');
    return;
  }

  let failed = 0;
  for (const change of changes) {
    try {
      await supabaseUpdateById(supabase, 'ticket_messages', change.id, {
        direction: change.wanted,
        actor: actorOf({ ...change, direction: change.wanted }, directory, config.actorByLabel)
      });
    } catch (error) {
      failed += 1;
      console.error(`  ${change.id}: ${error.message}`);
    }
  }
  console.log(`\n${changes.length - failed} updated, ${failed} failed.\n`);
  if (failed > 0) process.exitCode = 1;
}
