import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { createSenderDirectoryStore } from '../ingestion/sender-directory.mjs';
import { actorOf } from '../casework/actors.mjs';
import { createCaseCurrentStore, runFold } from '../casework/case-current-store.mjs';

// Runs the fold pass on its own: no mailbox read and no model call, unlike
// `ingest:once -- --stop-after=fold`, which runs every pass before it.
//
//   npm run fold:once                 # up to 200 stale tickets
//   npm run fold:once -- --limit 2000 # the whole backlog in one go

const args = process.argv.slice(2);
const limitAt = args.indexOf('--limit');
const limit = limitAt === -1 ? 200 : Number(args[limitAt + 1]) || 200;

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const directory = await createSenderDirectoryStore(supabase).load(shopId, { supportMailbox: config.graph.mailbox });
  const totals = await runFold({
    store: createCaseCurrentStore(supabase, { shopId }),
    shopId,
    actorFor: (message) => actorOf(message, directory, config.actorByLabel),
    limit,
    logger
  });
  console.log(`\nFolded ${totals.folded} of ${totals.considered} stale ticket(s); ${totals.versionsRaised} version(s) raised, ${totals.failed} failed.\n`);
}
