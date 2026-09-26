import { createSupabaseClient, supabaseSelect } from '../../scripts/lib/supabase-rest-client.mjs';
import { COLUMNS, T } from '../../scripts/lib/tables.mjs';
import { createTicketRecord } from '../../scripts/lib/ticket-record.mjs';

import { loadAgentConfig } from '../src/config.mjs';
import { resolveShopId } from '../src/lib/shop.mjs';
import { createSenderDirectoryStore } from '../src/ingestion/sender-directory.mjs';
import { actorOf } from '../src/casework/actors.mjs';
import { foldCase } from '../src/casework/case-fold.mjs';

import { CASEWORK_CASES } from './casework-cases.mjs';
import { threadUpTo } from './casework-cuts.mjs';

// Scores the fold's next actor against the labels with NO model call, so a rule
// change can be compared in seconds before \`eval:casework\` spends anything.
//
//   npm run eval:fold
//
// Deterministic: the same labels and the same database give the same numbers.
// Writes nothing.

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const record = createTicketRecord(supabase, { shopId });
  const directory = await createSenderDirectoryStore(supabase).load(shopId, { supportMailbox: config.graph.mailbox });
  const ticketIds = [...new Set(CASEWORK_CASES.map((row) => row.ticketId))];
  const inList = { operator: 'in', value: `(${ticketIds.join(',')})` };
  const investigations = await supabaseSelect(supabase, T.TICKET_INVESTIGATIONS, { shop_id: shopId, ticket_id: inList }, 'ticket_id,trigger_message_id,verdict,missing');
  const readings = await supabaseSelect(supabase, T.TICKET_CASE_STATE, { shop_id: shopId, ticket_id: inList }, 'ticket_id,trigger_message_id,pending_customer_inputs,commitments,contradictions');
  const actorFor = (message) => message.actor ?? actorOf(message, directory, config.actorByLabel);

  const tally = { agree: 0, disagree: 0 };
  const misses = {};
  for (const ticketId of ticketIds) {
    const conversation = await record.conversation(ticketId, { columns: COLUMNS.threadForDrafting });
    const position = new Map(conversation.map((message, index) => [message.id, index]));
    for (const row of CASEWORK_CASES.filter((r) => r.ticketId === ticketId)) {
      const index = position.get(row.messageId);
      if (index === undefined) continue;
      const thread = threadUpTo(conversation, index);
      const ids = new Set(thread.map((m) => m.id));
      const got = foldCase({
        messages: thread,
        caseFiles: investigations.filter((r) => r.ticket_id === ticketId && ids.has(r.trigger_message_id)),
        readings: readings.filter((r) => r.ticket_id === ticketId && ids.has(r.trigger_message_id)),
        actorFor
      }).next_actor;
      if (got === row.nextActor) tally.agree += 1;
      else {
        tally.disagree += 1;
        const key = `${row.nextActor} → ${got} (last: ${actorFor(conversation[index])})`;
        misses[key] = (misses[key] || 0) + 1;
      }
    }
  }
  console.log(`\nFold next actor: ${tally.agree} agree, ${tally.disagree} disagree, of ${tally.agree + tally.disagree} labelled cuts\n`);
  for (const [key, n] of Object.entries(misses).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), key);
}
