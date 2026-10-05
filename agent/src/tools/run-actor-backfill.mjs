import {
  createSupabaseClient,
  supabaseSelectAll,
  supabaseUpdateById
} from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createSenderDirectoryStore } from '../ingestion/sender-directory.mjs';
import { AUTOMATED, actorOf } from '../casework/actors.mjs';
import { autoReplySignal } from '../ingestion/auto-reply.mjs';

// Fills `ticket_messages.actor` on rows stored before ingestion wrote it
// (migration 41). The same rule ingestion applies: outbound is support, an
// inbound sender goes through sender_directory and AGENT_ACTOR_BY_LABEL.
//
//   npm run actors:backfill:dry-run
//   npm run actors:backfill
//
// ONLY EMPTY ROWS BY DEFAULT: an actor is a fact about when the mail arrived,
// like sender_label, so a stored value is left alone. `--recompute` rewrites
// every row, for after a deliberate change to the directory or the map.
//
// THE ONE CORRECTION A DEFAULT RUN MAKES: an automatic reply filed as someone
// (before 2026-10-05 every out-of-office was `customer`). Not a relabel but a
// mis-filing, so it is fixed without `--recompute`. Rows from before the
// headers were kept are recognised by their subject only.

const dryRun = process.argv.includes('--dry-run');
const recompute = process.argv.includes('--recompute');

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const directory = await createSenderDirectoryStore(supabase).load(shopId, { supportMailbox: config.graph.mailbox });

  const rows = await supabaseSelectAll(
    supabase,
    'ticket_messages',
    { shop_id: shopId },
    'id,direction,actor,from_email,subject,auto_reply:raw_graph_payload->>autoReply'
  );
  const changes = rows
    .map((row) => {
      const autoReply = row.auto_reply || (row.direction === 'inbound' ? autoReplySignal({ subject: row.subject }) : null);
      const message = autoReply ? { ...row, raw_graph_payload: { autoReply } } : row;
      return { ...row, wanted: actorOf(message, directory, config.actorByLabel) };
    })
    .filter((row) =>
      recompute ? row.actor !== row.wanted : !row.actor || (row.wanted === AUTOMATED && row.actor !== AUTOMATED)
    );
  const byActor = changes.reduce((acc, row) => ((acc[row.wanted] = (acc[row.wanted] || 0) + 1), acc), {});

  console.log(`\n${dryRun ? 'DRY RUN — nothing will be written.' : 'Writing actors.'}`);
  console.log(`${rows.length} messages · ${changes.length} to write: ${Object.entries(byActor).map(([a, n]) => `${a} ${n}`).join(', ') || 'none'}\n`);
  if (dryRun) return;

  let failed = 0;
  for (const row of changes) {
    try {
      await supabaseUpdateById(supabase, 'ticket_messages', row.id, { actor: row.wanted });
    } catch (error) {
      failed += 1;
      console.error(`  ${row.id}: ${error.message}`);
    }
  }
  console.log(`${changes.length - failed} written, ${failed} failed.\n`);
  if (failed > 0) process.exitCode = 1;
}
