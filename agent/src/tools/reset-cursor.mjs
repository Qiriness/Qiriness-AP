import {
  createSupabaseClient,
  supabaseSelect,
  supabaseUpdateById
} from '../../../scripts/lib/supabase-rest-client.mjs';

import { loadAgentConfig } from '../config.mjs';
import { logger } from '../lib/logger.mjs';
import { resolveShopId } from '../lib/shop.mjs';

// Clear the mail ingestion delta cursor so the next poll re-reads the whole
// inbox from scratch. Use after wiping tickets, or to force a full re-sync.
//
//   npm run ingest:reset

async function main() {
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);

  const rows = await supabaseSelect(supabase, 'shops', { id: shopId }, 'id,sync_cursors');
  const cursors = { ...(rows[0]?.sync_cursors || {}) };
  const hadCursor = 'mail_ingest_delta_link' in cursors;
  delete cursors.mail_ingest_delta_link;

  await supabaseUpdateById(supabase, 'shops', shopId, { sync_cursors: cursors });
  logger.info('ingest.cursor_reset', { shopId, hadCursor });
}

main().catch((error) => {
  logger.error('ingest.cursor_reset_failed', { message: error.message });
  process.exitCode = 1;
});
