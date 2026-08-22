import { createSupabaseClient, supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { hashIdentifier } from '../../../scripts/lib/compliance-audit.mjs';

import { loadAgentConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';
import { createSenderDirectoryStore } from '../ingestion/sender-directory.mjs';
import { ownSidePredicate, requesterFor } from '../ingestion/requester-repair.mjs';

// Repairs tickets whose requester is one of OUR addresses while a customer is
// on the thread.
//
//   npm run requester:repair:dry-run
//   npm run requester:repair
//
// READ THE DRY RUN. It prints the order-matching consequence per row, which is
// the only thing here that can do harm: `requester_email_hash` joins to
// `orders.customer_email_hash`, so moving it moves which order a ticket can
// resolve to.
//
// INGESTION IS UNCHANGED. This reconciles stored rows and nothing else — the
// write-once rule stays exactly as it is.

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
  const isOwnSide = ownSidePredicate(directory);

  const orders = await supabaseSelect(supabase, 'orders', { shop_id: shopId }, 'customer_email_hash');
  const orderHashes = new Set(orders.map((o) => o.customer_email_hash).filter(Boolean));

  console.log(`\n${dryRun ? 'DRY RUN — nothing will be written.' : 'Writing requester repairs.'}\n`);

  const tickets = await supabaseSelect(
    supabase,
    'tickets',
    { shop_id: shopId, deleted_at: { operator: 'is', value: 'null' } },
    'id,requester_name,requester_email_hash,shopify_order_number,sender_label',
    { order: 'first_message_at.asc' }
  );

  const totals = { considered: 0, repaired: 0, gainsOrderMatch: 0, losesOrderMatch: 0 };

  for (const ticket of tickets) {
    const messages = await supabaseSelect(
      supabase,
      'ticket_messages',
      { shop_id: shopId, ticket_id: ticket.id, direction: 'inbound' },
      'from_email,from_name,received_at'
    );
    totals.considered += 1;

    const should = requesterFor({ ticket, messages, isOwnSide });
    if (!should) {
      continue;
    }

    const nextHash = hashIdentifier(should.from_email);
    const matchedBefore = orderHashes.has(ticket.requester_email_hash);
    const matchesAfter = orderHashes.has(nextHash);
    if (!matchedBefore && matchesAfter) totals.gainsOrderMatch += 1;
    if (matchedBefore && !matchesAfter) totals.losesOrderMatch += 1;

    totals.repaired += 1;
    console.log(
      `  ${String(ticket.requester_name ?? '?').slice(0, 20).padEnd(20)} -> ` +
        `${String(should.from_name ?? should.from_email).slice(0, 24).padEnd(24)} ` +
        `${matchesAfter ? 'matches an order' : matchedBefore ? 'LOSES ITS ORDER MATCH' : 'no order either way'}`
    );

    if (!dryRun) {
      await record.setRequester(ticket.id, {
        name: should.from_name ?? null,
        emailHash: nextHash
      });
    }
  }

  console.log(
    `\nconsidered ${totals.considered} | repaired ${totals.repaired} | ` +
      `gains an order match ${totals.gainsOrderMatch} | loses one ${totals.losesOrderMatch}\n`
  );
}
