import {
  createSupabaseClient,
  supabaseSelectAll,
  supabaseUpdateById
} from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createSenderDirectoryStore } from '../ingestion/sender-directory.mjs';
import { actorOf } from '../casework/actors.mjs';

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

  const rows = await supabaseSelectAll(supabase, 'ticket_messages', { shop_id: shopId }, 'id,direction,actor,from_email');
  const changes = rows
    .map((row) => ({ ...row, wanted: actorOf(row, directory, config.actorByLabel) }))
    .filter((row) => (recompute ? row.actor !== row.wanted : !row.actor));
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
