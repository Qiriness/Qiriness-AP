import {
  createSupabaseClient,
  supabaseSelect,
  supabaseUpdateById
} from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { CURSOR_KEYS, withoutLinks } from '../ingestion/delta-poller.mjs';

// Clear the mail ingestion delta cursor so the next poll re-reads the whole
// inbox from scratch. Use after wiping tickets, or to force a full re-sync.
// Both links go (the saved position and a read in progress); the cutover time
// and the id type stay, because neither describes a position in the mailbox.
//
//   npm run ingest:reset

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  const rows = await supabaseSelect(supabase, 'shops', { id: shopId }, 'id,sync_cursors');
  const cursors = rows[0]?.sync_cursors || {};
  const hadCursor = CURSOR_KEYS.deltaLink in cursors;
  const hadResume = CURSOR_KEYS.resumeLink in cursors;

  await supabaseUpdateById(supabase, 'shops', shopId, { sync_cursors: withoutLinks(cursors) });
  logger.info('ingest.cursor_reset', { shopId, hadCursor, hadResume });
}

main().catch((error) => {
  logger.error('ingest.cursor_reset_failed', { message: error.message });
  process.exitCode = 1;
});
